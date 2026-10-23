// Claude in the agent panel, driven by the `claude` CLI.
//
// Rendr doesn't hold an API key or talk to Anthropic directly. It shells out to
// the user's own Claude Code install, which already has their auth (Pro, Max,
// Team or an API key), and points it at Rendr's MCP server. So the model that
// answers in the panel is the same one that can call Rendr's tools.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { agentEnv, resolveBinary } from "./binaries";
import { parseJson, probeVersion, readLines } from "./jsonl";
import { type AgentProvider, bareToolName, type RunContext, summarizeInput } from "./types";

let active: ChildProcessWithoutNullStreams | null = null;
let sessionId: string | null = null;

/**
 * Parses one line of `--output-format stream-json`.
 *
 * The CLI emits one JSON object per line: assistant messages, tool calls, and
 * a final result. Anything unrecognised is ignored rather than shown raw.
 */
function handleLine(line: string, context: RunContext): void {
	const message = parseJson(line);
	if (!message) return;
	const { emit } = context;

	if (typeof message.session_id === "string") sessionId = message.session_id;

	// The init frame lists the MCP servers the CLI attached. If ours failed the
	// model can still chat but can't touch the timeline, and the panel should
	// say so rather than leaving the user guessing why nothing happened.
	if (message.type === "system" && message.subtype === "init") {
		const servers = Array.isArray(message.mcp_servers)
			? (message.mcp_servers as Array<{ name?: string; status?: string }>)
			: [];
		const rendr = servers.find((server) => server.name === "rendr");
		// Servers attach lazily, so "pending" at init is normal — only a server
		// that is missing outright or has actually failed is worth reporting.
		const status = rendr?.status ?? "missing";
		emit({ kind: "mcp", connected: status === "connected" || status === "pending", status });
		return;
	}

	if (message.type === "assistant") {
		const content = (message.message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) return;
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === "text" && typeof block.text === "string") {
				emit({ kind: "text", text: block.text });
			}
			if (block.type === "tool_use" && typeof block.name === "string") {
				// Tool receipts are the point of the panel; surface every one.
				emit({
					kind: "tool",
					tool: bareToolName(block.name),
					detail: summarizeInput(block.input),
				});
			}
		}
		return;
	}

	if (message.type === "result" && message.is_error) {
		const reported = typeof message.result === "string" ? message.result : "";
		emit({
			kind: "error",
			// The CLI's own login prompt is terminal advice; translate it for
			// someone who is looking at an app, not a shell.
			message: /not logged in/i.test(reported)
				? "Claude Code isn't signed in. Run `claude` in a terminal and log in, then try again."
				: reported || "Claude returned an error.",
		});
	}
}

export const claudeCodeProvider: AgentProvider = {
	id: "claude-code",

	async probe() {
		const binary = resolveBinary("claude");
		// `--version` is the cheapest proof the binary actually runs.
		const result = await probeVersion(binary, agentEnv());
		if (result.missing) {
			return {
				available: false,
				label: "Claude",
				reason: "The Claude CLI isn't installed or isn't on PATH. Install Claude Code, then reopen this panel.",
			};
		}
		return result.ok
			? { available: true, label: "Claude", version: result.output }
			: {
					available: false,
					label: "Claude",
					reason: `The Claude CLI exited with code ${result.code}.`,
				};
	},

	run(prompt, context) {
		return new Promise<void>((resolve) => {
			const { emit } = context;
			if (active) {
				emit({ kind: "error", message: "Claude is still answering. Cancel first." });
				resolve();
				return;
			}

			const args = [
				"--print",
				"--output-format",
				"stream-json",
				"--verbose",
				// Point the CLI back at this app so the model can drive the timeline.
				"--mcp-config",
				JSON.stringify({ mcpServers: { rendr: { type: "http", url: context.mcpUrl } } }),
				"--allowed-tools",
				"mcp__rendr",
			];
			const model = context.settings.models["claude-code"]?.trim();
			if (model) args.push("--model", model);
			// Continuing keeps the conversation coherent across turns.
			if (sessionId) args.push("--resume", sessionId);
			// The prompt goes on stdin, not as a trailing argument: --allowed-tools
			// takes a list, so a trailing prompt is swallowed as another tool name
			// and the CLI exits with "Input must be provided".

			let child: ChildProcessWithoutNullStreams;
			try {
				child = spawn(resolveBinary("claude"), args, {
					env: agentEnv(),
					cwd: context.workDir,
					stdio: ["pipe", "pipe", "pipe"],
				});
				child.stdin.write(prompt);
				child.stdin.end();
			} catch (error) {
				emit({
					kind: "error",
					message: `Couldn't start the Claude CLI: ${error instanceof Error ? error.message : String(error)}`,
				});
				emit({ kind: "done", sessionId });
				resolve();
				return;
			}

			active = child;
			let stderr = "";
			readLines(child.stdout, (line) => handleLine(line, context));
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});

			child.on("error", (error) => {
				emit({
					kind: "error",
					message:
						error.message.includes("ENOENT") || error.message.includes("spawn")
							? "The Claude CLI isn't installed or isn't on PATH. Install Claude Code and try again."
							: error.message,
				});
			});

			child.on("close", (code) => {
				if (active === child) active = null;
				if (code !== 0 && code !== null && stderr.trim()) {
					emit({ kind: "error", message: stderr.trim() });
				}
				emit({ kind: "done", sessionId });
				resolve();
			});
		});
	},

	cancel() {
		active?.kill("SIGTERM");
		active = null;
	},

	reset() {
		sessionId = null;
	},
};
