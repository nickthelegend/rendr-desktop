// Any ACP agent in the agent panel.
//
// The Agent Client Protocol (agentclientprotocol.com) is JSON-RPC over stdio
// between an editor and a coding agent. Gemini CLI, OpenCode, Goose, Qwen Code
// and the Claude Code / Codex adapters all speak it, and every one of them
// accepts MCP servers in `session/new` — so Rendr hands its own server over and
// the agent's model drives the timeline. One client, every ACP agent.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { TOOLS_BY_NAME } from "../mcp/toolDefinitions";
import { agentEnv, resolveBinary, splitCommandLine } from "./binaries";
import { parseJson, probeVersion, readLines } from "./jsonl";
import {
	type AcpPreset,
	type AgentProvider,
	type AgentSettings,
	bareToolName,
	type RunContext,
	summarizeInput,
} from "./types";

export interface AcpPresetInfo {
	id: AcpPreset;
	label: string;
	command: string;
	/** What signs the user in, shown when the agent refuses to start a session. */
	signIn: string;
}

export const ACP_PRESETS: AcpPresetInfo[] = [
	{
		id: "gemini",
		label: "Gemini CLI",
		command: "gemini --acp",
		signIn: "Run `gemini` in a terminal and sign in, or set GEMINI_API_KEY.",
	},
	{
		id: "opencode",
		label: "OpenCode",
		command: "opencode acp",
		signIn: "Run `opencode auth login` in a terminal.",
	},
	{
		id: "goose",
		label: "Goose",
		command: "goose acp",
		signIn: "Run `goose configure` in a terminal.",
	},
	{
		id: "qwen",
		label: "Qwen Code",
		command: "qwen --acp",
		signIn: "Run `qwen` in a terminal and sign in.",
	},
	{
		id: "claude-acp",
		label: "Claude Code (ACP)",
		command: "npx -y @zed-industries/claude-code-acp",
		signIn: "Run `claude` in a terminal and log in.",
	},
	{
		id: "codex-acp",
		label: "Codex (ACP)",
		command: "npx -y @zed-industries/codex-acp",
		signIn: "Run `codex login` in a terminal.",
	},
	{
		id: "custom",
		label: "Custom ACP agent",
		command: "",
		signIn: "Sign the agent in from a terminal.",
	},
];

export function acpCommand(settings: AgentSettings): {
	argv: string[];
	label: string;
	signIn: string;
} {
	const preset = ACP_PRESETS.find((entry) => entry.id === settings.acp.preset) ?? ACP_PRESETS[0];
	const line =
		preset.id === "custom"
			? settings.acp.command
			: settings.acp.command.trim() || preset.command;
	const argv = splitCommandLine(line);
	const label = preset.id === "custom" ? (argv[0] ?? "ACP agent") : preset.label;
	return { argv, label, signIn: preset.signIn };
}

type Json = Record<string, unknown>;

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

class AcpError extends Error {
	constructor(readonly rpc: JsonRpcError) {
		super(rpc.message);
	}
}

/** One running ACP agent process and the session Rendr opened on it. */
class AcpConnection {
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private nextId = 0;
	private stderrTail = "";
	exited = false;
	sessionId: string | null = null;
	agentCapabilities: Json = {};
	onNotification: (method: string, params: Json) => void = () => undefined;
	onRequest: (method: string, params: Json) => Promise<unknown> = async () => {
		throw new AcpError({ code: -32601, message: "Method not supported by Rendr" });
	};
	onExit: (reason: string) => void = () => undefined;

	constructor(
		readonly key: string,
		private readonly child: ChildProcessWithoutNullStreams,
	) {
		readLines(child.stdout, (line) => this.handle(line));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4000);
		});
		const fail = (reason: string) => {
			if (this.exited) return;
			this.exited = true;
			for (const call of this.pending.values()) call.reject(new Error(reason));
			this.pending.clear();
			this.onExit(reason);
		};
		child.on("error", (error) => fail(error.message));
		child.on("close", (code) =>
			fail(this.lastStderrLine() || `The agent exited with code ${code}.`),
		);
	}

	lastStderrLine(): string {
		return this.stderrTail.trim().split("\n").filter(Boolean).pop() ?? "";
	}

	request<T = Json>(method: string, params: Json, timeoutMs = 0): Promise<T> {
		if (this.exited) return Promise.reject(new Error("The agent is not running."));
		const id = ++this.nextId;
		this.write({ jsonrpc: "2.0", id, method, params });
		return new Promise<T>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							if (!this.pending.delete(id)) return;
							reject(
								new Error(
									`The agent didn't answer ${method} within ${Math.round(timeoutMs / 1000)}s.`,
								),
							);
						}, timeoutMs)
					: null;
			this.pending.set(id, {
				resolve: (value) => {
					if (timer) clearTimeout(timer);
					(resolve as (value: unknown) => void)(value);
				},
				reject: (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	notify(method: string, params: Json): void {
		if (!this.exited) this.write({ jsonrpc: "2.0", method, params });
	}

	kill(): void {
		// Settle everything in flight first: a prompt left pending would keep
		// the provider "still answering" forever, since the close handler
		// ignores a process that was already marked as gone.
		const reason = "The agent was stopped.";
		this.exited = true;
		for (const call of this.pending.values()) call.reject(new Error(reason));
		this.pending.clear();
		this.child.kill("SIGTERM");
	}

	private write(message: Json): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handle(line: string): void {
		const message = parseJson(line);
		if (!message) return;
		const id = message.id as number | string | undefined;
		const method = typeof message.method === "string" ? message.method : null;

		if (method === null && id !== undefined) {
			const call = this.pending.get(id as number);
			if (!call) return;
			this.pending.delete(id as number);
			if (message.error) call.reject(new AcpError(message.error as JsonRpcError));
			else call.resolve(message.result);
			return;
		}
		if (!method) return;
		const params = (message.params ?? {}) as Json;
		if (id === undefined) {
			this.onNotification(method, params);
			return;
		}
		this.onRequest(method, params).then(
			(result) => this.write({ jsonrpc: "2.0", id, result }),
			(error: unknown) =>
				this.write({
					jsonrpc: "2.0",
					id,
					error:
						error instanceof AcpError
							? error.rpc
							: {
									code: -32603,
									message: error instanceof Error ? error.message : String(error),
								},
				}),
		);
	}
}

let connection: AcpConnection | null = null;
let running: { context: RunContext } | null = null;

/** A permission request is approved only when it is for one of Rendr's own tools. */
/** Tool kinds ACP agents use for things Rendr never needs: never approved, whatever the title says. */
const REFUSED_KINDS = new Set(["execute", "edit", "delete", "move", "fetch"]);

/**
 * A permission request is approved only for one of Rendr's own tools.
 *
 * The title is written by the agent and, through it, by the model — so it is
 * matched whole, against Rendr's real tool names, in the exact shapes agents
 * use for MCP tools ("rendr_add_clips", "mcp__rendr__add_clips",
 * "add_clips (rendr MCP Server)"). A prefix or suffix match would wave through
 * "curl … | sh (rendr)". A tool whose kind is a shell, an edit or a fetch is
 * refused outright, title or not.
 */
export function isRendrToolCall(toolCall: unknown): boolean {
	if (!toolCall || typeof toolCall !== "object") return false;
	const record = toolCall as Json;
	if (typeof record.kind === "string" && REFUSED_KINDS.has(record.kind)) return false;
	const title = String(record.title ?? "").trim();
	const named =
		title.match(/^(?:mcp__rendr__|rendr(?:__|[_./:]))([a-z][a-z0-9_]*)$/i)?.[1] ??
		title.match(/^([a-z][a-z0-9_]*) \(rendr(?: MCP Server)?\)$/i)?.[1] ??
		null;
	return named !== null && TOOLS_BY_NAME.has(named.toLowerCase());
}

export function choosePermission(params: Json): Json {
	const options = Array.isArray(params.options) ? (params.options as Json[]) : [];
	const allowed = isRendrToolCall(params.toolCall);
	const preferred = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
	const option = preferred
		.map((kind) => options.find((entry) => entry.kind === kind))
		.find(Boolean);
	if (!option) return { outcome: { outcome: "cancelled" } };
	return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function handleUpdate(params: Json): void {
	const context = running?.context;
	if (!context || params.sessionId !== connection?.sessionId) return;
	const update = (params.update ?? {}) as Json;
	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const content = update.content as Json | undefined;
			if (content?.type === "text" && typeof content.text === "string") {
				context.emit({ kind: "text", text: content.text });
			}
			return;
		}
		case "tool_call": {
			const title = typeof update.title === "string" ? update.title : "tool";
			if (/rendr/i.test(title))
				context.emit({ kind: "mcp", connected: true, status: "connected" });
			context.emit({
				kind: "tool",
				tool: bareToolName(title),
				detail: summarizeInput(update.rawInput),
			});
			return;
		}
		default:
			return;
	}
}

async function connect(context: RunContext): Promise<AcpConnection> {
	const { argv } = acpCommand(context.settings);
	const model = context.settings.models.acp?.trim() ?? "";
	const key = JSON.stringify([argv, model]);
	if (connection && !connection.exited && connection.key === key && connection.sessionId)
		return connection;
	connection?.kill();
	connection = null;

	if (argv.length === 0)
		throw new Error("Set the command that starts your ACP agent in the agent settings.");
	const [command, ...args] = argv;
	const child = spawn(resolveBinary(command), args, {
		env: agentEnv(),
		cwd: context.workDir,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const next = new AcpConnection(key, child);
	connection = next;
	next.onNotification = (method, params) => {
		if (method === "session/update") handleUpdate(params);
	};
	next.onRequest = async (method, params) => {
		if (method === "session/request_permission") return choosePermission(params);
		// Rendr advertises no filesystem or terminal capability, so a well-behaved
		// agent never asks; one that does is told no rather than left hanging.
		throw new AcpError({ code: -32601, message: `Rendr does not provide ${method}` });
	};
	next.onExit = (reason) => {
		if (connection === next) connection = null;
		if (running) running.context.emit({ kind: "error", message: reason });
	};

	// The handshake gets a deadline (generous: an npx adapter may download on
	// first run); a prompt doesn't, since a long edit is legitimately long.
	const HANDSHAKE_MS = 180_000;
	const init = await next.request<Json>(
		"initialize",
		{
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: { name: "rendr", title: "Rendr", version: "0.1.0" },
		},
		HANDSHAKE_MS,
	);
	next.agentCapabilities = (init.agentCapabilities ?? {}) as Json;
	const mcpCapabilities = (next.agentCapabilities.mcpCapabilities ?? {}) as Json;
	// HTTP when the agent can take it; otherwise the stdio bridge to the same server.
	const rendrServer = mcpCapabilities.http
		? { type: "http", name: "rendr", url: context.mcpUrl, headers: [] }
		: {
				name: "rendr",
				command: context.stdioBridge.command,
				args: context.stdioBridge.args,
				env: Object.entries(context.stdioBridge.env).map(([name, value]) => ({
					name,
					value,
				})),
			};

	const session = await next.request<Json>(
		"session/new",
		{
			cwd: context.workDir,
			mcpServers: [rendrServer],
		},
		HANDSHAKE_MS,
	);
	if (typeof session.sessionId !== "string") throw new Error("The agent did not open a session.");
	next.sessionId = session.sessionId;
	if (model) await applyModel(next, session, model);
	return next;
}

/** Selects a model through whichever of ACP's two model APIs the agent offers. */
async function applyModel(target: AcpConnection, session: Json, model: string): Promise<void> {
	const options = Array.isArray(session.configOptions) ? (session.configOptions as Json[]) : [];
	const modelOption = options.find(
		(option) => option.category === "model" || option.id === "model",
	);
	if (modelOption) {
		await target.request("session/set_config_option", {
			sessionId: target.sessionId,
			configId: modelOption.id,
			value: model,
		});
		return;
	}
	if (session.models) {
		await target.request("session/set_model", { sessionId: target.sessionId, modelId: model });
	}
}

export function friendlyAcpError(error: unknown, signIn: string): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/ENOENT|spawn/i.test(message)) return "That agent isn't installed or isn't on PATH.";
	if (
		error instanceof AcpError &&
		(error.rpc.code === -32000 || /auth/i.test(error.rpc.message))
	) {
		return `${message} ${signIn}`;
	}
	return message;
}

export const acpProvider: AgentProvider = {
	id: "acp",

	async probe(settings) {
		const { argv, label } = acpCommand(settings);
		if (argv.length === 0) {
			return {
				available: false,
				label,
				reason: "Set the command that starts your ACP agent in the agent settings.",
			};
		}
		// `npx` adapters download on first run; checking for npx itself is enough.
		const binary = resolveBinary(argv[0]);
		if (argv[0] === "npx") {
			const npx = await probeVersion(binary, agentEnv());
			return npx.ok
				? {
						available: true,
						label,
						version: argv
							.slice(1)
							.filter((arg) => !arg.startsWith("-"))
							.join(" "),
					}
				: {
						available: false,
						label,
						reason: "npx isn't available. Install Node.js to use this adapter.",
					};
		}
		const result = await probeVersion(binary, agentEnv());
		if (result.missing)
			return {
				available: false,
				label,
				reason: `${label} isn't installed or isn't on PATH.`,
			};
		return { available: true, label, version: result.output.split("\n")[0] };
	},

	async run(prompt, context) {
		const { emit } = context;
		if (running) {
			emit({ kind: "error", message: "The agent is still answering. Cancel first." });
			return;
		}
		const { signIn } = acpCommand(context.settings);
		running = { context };
		try {
			const fresh = !connection || connection.exited;
			const active = await connect(context);
			const text = fresh ? `${context.instructions}\n\n---\n\n${prompt}` : prompt;
			const result = await active.request<Json>("session/prompt", {
				sessionId: active.sessionId,
				prompt: [{ type: "text", text }],
			});
			if (result.stopReason === "refusal")
				emit({ kind: "error", message: "The agent refused that request." });
			if (result.stopReason === "max_tokens")
				emit({ kind: "error", message: "The agent ran out of output tokens." });
		} catch (error) {
			emit({ kind: "error", message: friendlyAcpError(error, signIn) });
		} finally {
			running = null;
			emit({ kind: "done", sessionId: connection?.sessionId ?? null });
		}
	},

	cancel() {
		if (connection?.sessionId)
			connection.notify("session/cancel", { sessionId: connection.sessionId });
	},

	reset() {
		connection?.kill();
		connection = null;
	},
};

/** Called on quit so an agent process doesn't outlive the app. */
export function stopAcp(): void {
	connection?.kill();
	connection = null;
}
