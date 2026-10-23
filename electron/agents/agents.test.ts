import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acpCommand, acpProvider, choosePermission, isRendrToolCall } from "./acp";
import { apiProvider } from "./apiAgent";
import { splitCommandLine } from "./binaries";
import { codexArgs, friendlyCodexError } from "./codex";
import type { AgentEvent, AgentSettings, RunContext } from "./types";
import { bareToolName } from "./types";

// Every provider is driven for real here — a fake ACP agent process and fake
// OpenAI / Anthropic servers — because the parsing of each wire format is the
// part that breaks, and mocks of it would only test the mocks.

const BASE_SETTINGS: AgentSettings = {
	provider: "acp",
	models: {},
	acp: { preset: "custom", command: "" },
	api: { flavor: "openai", baseUrl: "", model: "test-model" },
};

function makeContext(overrides: Partial<RunContext> = {}): {
	context: RunContext;
	events: AgentEvent[];
	calls: string[];
} {
	const events: AgentEvent[] = [];
	const calls: string[] = [];
	const context: RunContext = {
		emit: (event) => events.push(event),
		settings: BASE_SETTINGS,
		mcpUrl: "http://127.0.0.1:1/mcp",
		stdioBridge: { command: "node", args: ["bridge.cjs"], env: {} },
		workDir: os.tmpdir(),
		dispatch: async (name, args) => {
			calls.push(`${name}:${JSON.stringify(args)}`);
			return { content: [{ type: "text", text: `ran ${name}` }] };
		},
		apiKey: "test-key",
		instructions: "be terse",
		...overrides,
	};
	return { context, events, calls };
}

describe("command lines", () => {
	it("splits quoted arguments the way a shell would", () => {
		expect(splitCommandLine(`npx -y "@scope/agent acp" --flag='a b'`)).toEqual([
			"npx",
			"-y",
			"@scope/agent acp",
			"--flag=a b",
		]);
		expect(splitCommandLine("  gemini   --acp ")).toEqual(["gemini", "--acp"]);
		expect(splitCommandLine(`a "" b`)).toEqual(["a", "", "b"]);
	});

	it("uses a preset's command unless the user overrides it", () => {
		expect(
			acpCommand({ ...BASE_SETTINGS, acp: { preset: "gemini", command: "" } }).argv,
		).toEqual(["gemini", "--acp"]);
		expect(
			acpCommand({
				...BASE_SETTINGS,
				acp: { preset: "gemini", command: "/opt/gemini --acp" },
			}).argv[0],
		).toBe("/opt/gemini");
		expect(
			acpCommand({ ...BASE_SETTINGS, acp: { preset: "custom", command: "" } }).argv,
		).toEqual([]);
	});

	it("names tools the same whatever dialect the agent uses", () => {
		for (const name of [
			"mcp__rendr__add_clips",
			"rendr_add_clips",
			"rendr/add_clips",
			"rendr.add_clips",
			"add_clips",
		]) {
			expect(bareToolName(name)).toBe("add_clips");
		}
	});
});

describe("ACP permissions", () => {
	const options = [
		{ optionId: "yes", kind: "allow_once" },
		{ optionId: "no", kind: "reject_once" },
	];

	it("approves Rendr's own tools", () => {
		for (const title of [
			"rendr_get_media",
			"mcp__rendr__add_clips",
			"get_media (rendr MCP Server)",
		]) {
			expect(isRendrToolCall({ title })).toBe(true);
			expect(choosePermission({ options, toolCall: { title } })).toEqual({
				outcome: { outcome: "selected", optionId: "yes" },
			});
		}
	});

	it("refuses everything else — including a shell command that only mentions rendr", () => {
		for (const toolCall of [
			{ title: "bash", rawInput: { command: "rm -rf ~/rendr" } },
			{ title: "Run: curl rendr.evil" },
			{ title: "edit file", rawInput: { path: "rendr_notes.md" } },
		]) {
			expect(isRendrToolCall(toolCall)).toBe(false);
			expect(choosePermission({ options, toolCall })).toEqual({
				outcome: { outcome: "selected", optionId: "no" },
			});
		}
	});

	it("cancels when there is no option it can pick", () => {
		expect(choosePermission({ options: [], toolCall: { title: "bash" } })).toEqual({
			outcome: { outcome: "cancelled" },
		});
	});
});

// A minimal ACP agent: answers initialize and session/new, and on a prompt
// asks permission for a Rendr tool and a shell command, then streams text.
const FAKE_AGENT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let nextId = 1000; const waiting = new Map(); let sawMcp = null;
const ask = (method, params) => new Promise((r) => { const id = ++nextId; waiting.set(id, r); send({ jsonrpc: "2.0", id, method, params }); });
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); return; }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } });
  if (m.method === "session/new") { sawMcp = m.params.mcpServers; return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } }); }
  if (m.method === "session/prompt") {
    const sid = m.params.sessionId;
    const upd = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update } });
    const okRendr = await ask("session/request_permission", { sessionId: sid, toolCall: { title: "rendr_get_timeline" }, options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] });
    const okShell = await ask("session/request_permission", { sessionId: sid, toolCall: { title: "bash", rawInput: { command: "echo rendr" } }, options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] });
    upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "rendr_get_timeline", rawInput: { verbose: true } });
    const prompt = m.params.prompt[0].text;
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rendr=" + okRendr.outcome.optionId + " shell=" + okShell.outcome.optionId } });
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " mcp=" + sawMcp[0].type + ":" + sawMcp[0].url + " first=" + prompt.startsWith("be terse") } });
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
`;

describe("ACP provider", () => {
	afterEach(() => acpProvider.reset());

	it("hands Rendr's MCP server to the agent, approves only Rendr tools, and streams the reply", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "rendr-acp-"));
		const script = path.join(dir, "agent.cjs");
		writeFileSync(script, FAKE_AGENT);
		const settings = {
			...BASE_SETTINGS,
			acp: { preset: "custom" as const, command: `"${process.execPath}" "${script}"` },
		};
		const { context, events } = makeContext({ settings, mcpUrl: "http://127.0.0.1:19790/mcp" });

		await acpProvider.run("hello", context);

		const text = events
			.filter((event) => event.kind === "text")
			.map((event) => (event as { text: string }).text)
			.join("");
		expect(text).toBe("rendr=a shell=r mcp=http:http://127.0.0.1:19790/mcp first=true");
		expect(events).toContainEqual({
			kind: "tool",
			tool: "get_timeline",
			detail: "verbose: true",
		});
		expect(events.at(-1)).toEqual({ kind: "done", sessionId: "s1" });

		// The second turn reuses the session and isn't re-briefed.
		const second = makeContext({ settings });
		await acpProvider.run("again", second.context);
		const secondText = second.events
			.filter((event) => event.kind === "text")
			.map((event) => (event as { text: string }).text)
			.join("");
		expect(secondText).toContain("first=false");
	});

	it("reports an agent that isn't installed instead of hanging", async () => {
		const settings = {
			...BASE_SETTINGS,
			acp: { preset: "custom" as const, command: "definitely-not-an-agent-xyz --acp" },
		};
		const { context, events } = makeContext({ settings });
		await acpProvider.run("hello", context);
		expect(events.some((event) => event.kind === "error")).toBe(true);
		expect(events.at(-1)?.kind).toBe("done");
	});
});

describe("Codex provider", () => {
	it("points codex at Rendr's server and resumes the thread", () => {
		const context = {
			mcpUrl: "http://127.0.0.1:19790/mcp",
			settings: { ...BASE_SETTINGS, models: { codex: "gpt-5" } },
		};
		const fresh = codexArgs(context, null);
		expect(fresh).toContain('mcp_servers.rendr.url="http://127.0.0.1:19790/mcp"');
		expect(fresh).toContain("--json");
		expect(fresh.slice(-1)).toEqual(["-"]);
		expect(fresh).toEqual(expect.arrayContaining(["--model", "gpt-5"]));
		expect(codexArgs(context, "thread-1").slice(-3)).toEqual(["resume", "thread-1", "-"]);
	});

	it("unwraps the API error Codex nests in its own message", () => {
		const raw =
			'{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported when using Codex with a ChatGPT account."}}';
		expect(friendlyCodexError(raw)).toMatch(
			/^The 'x' model is not supported.*Set a different model/,
		);
	});
});

// ── API provider against fake servers ────────────────────────────────────

let fake: http.Server | null = null;

afterEach(async () => {
	apiProvider.reset();
	await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
	fake = null;
});

async function serve(
	handler: (body: Record<string, unknown>, req: http.IncomingMessage) => unknown,
): Promise<string> {
	fake = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const reply = handler(JSON.parse(body || "{}") as Record<string, unknown>, req);
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
		});
	});
	await new Promise<void>((resolve) => fake?.listen(0, "127.0.0.1", () => resolve()));
	const address = fake.address() as { port: number };
	return `http://127.0.0.1:${address.port}`;
}

describe("API provider", () => {
	it("runs the OpenAI tool loop: call, feed the result back, answer", async () => {
		const requests: Array<Record<string, unknown>> = [];
		let auth = "";
		const base = await serve((body, req) => {
			requests.push(body);
			auth = String(req.headers.authorization);
			if (requests.length === 1) {
				return {
					choices: [
						{
							message: {
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "c1",
										type: "function",
										function: { name: "get_timeline", arguments: '{"x":1}' },
									},
								],
							},
						},
					],
				};
			}
			return { choices: [{ message: { role: "assistant", content: "All set." } }] };
		});
		const { context, events, calls } = makeContext({
			settings: {
				...BASE_SETTINGS,
				provider: "api",
				api: { flavor: "openai", baseUrl: `${base}/v1`, model: "m" },
			},
		});

		await apiProvider.run("tighten it", context);

		expect(calls).toEqual(['get_timeline:{"x":1}']);
		expect(auth).toBe("Bearer test-key");
		const second = requests[1].messages as Array<Record<string, unknown>>;
		expect(second[0]).toEqual({ role: "system", content: "be terse" });
		expect(second.at(-1)).toEqual({
			role: "tool",
			tool_call_id: "c1",
			content: "ran get_timeline",
		});
		expect((requests[0].tools as unknown[]).length).toBeGreaterThan(50);
		expect(events).toContainEqual({ kind: "text", text: "All set." });
		expect(events).toContainEqual({ kind: "tool", tool: "get_timeline", detail: "x: 1" });
		expect(events.at(-1)?.kind).toBe("done");
	});

	it("runs the Anthropic tool loop with tool_result blocks", async () => {
		const requests: Array<Record<string, unknown>> = [];
		let key = "";
		const base = await serve((body, req) => {
			requests.push(body);
			key = String(req.headers["x-api-key"]);
			if (requests.length === 1) {
				return {
					content: [{ type: "tool_use", id: "u1", name: "undo", input: {} }],
					stop_reason: "tool_use",
				};
			}
			return { content: [{ type: "text", text: "Undone." }], stop_reason: "end_turn" };
		});
		const { context, events, calls } = makeContext({
			settings: {
				...BASE_SETTINGS,
				provider: "api",
				api: { flavor: "anthropic", baseUrl: base, model: "claude" },
			},
		});

		await apiProvider.run("undo that", context);

		expect(calls).toEqual(["undo:{}"]);
		expect(key).toBe("test-key");
		expect(requests[0].system).toBe("be terse");
		const last = (requests[1].messages as Array<{ content: unknown }>).at(-1)?.content as Array<
			Record<string, unknown>
		>;
		expect(last[0]).toMatchObject({ type: "tool_result", tool_use_id: "u1", is_error: false });
		expect(events).toContainEqual({ kind: "text", text: "Undone." });
	});

	it("reports a provider error and leaves the conversation sendable", async () => {
		fake = http.createServer((_req, res) => {
			res.writeHead(401, { "Content-Type": "application/json" }).end(
				'{"error":{"message":"bad key"}}',
			);
		});
		await new Promise<void>((resolve) => fake?.listen(0, "127.0.0.1", () => resolve()));
		const port = (fake.address() as { port: number }).port;
		const { context, events } = makeContext({
			settings: {
				...BASE_SETTINGS,
				provider: "api",
				api: { flavor: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, model: "m" },
			},
		});
		await apiProvider.run("hi", context);
		expect(events).toContainEqual({ kind: "error", message: "401 bad key" });
		expect(events.at(-1)?.kind).toBe("done");
	});
});
