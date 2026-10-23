// OpenAI Codex in the agent panel, driven by the `codex` CLI.
//
// Same shape as the Claude Code provider: the user's own install, signed in
// with their ChatGPT plan or an API key, pointed back at Rendr's MCP server.
// `codex exec --json` prints one event per line; a thread id from the first
// turn resumes the conversation on the next.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { agentEnv, resolveBinary } from "./binaries";
import { parseJson, probeVersion, readLines } from "./jsonl";
import { type AgentProvider, bareToolName, type RunContext, summarizeInput } from "./types";

let active: ChildProcessWithoutNullStreams | null = null;
let threadId: string | null = null;

/** TOML string literal, for `-c key=value` overrides. */
function toml(value: string): string {
	return JSON.stringify(value);
}

export function codexArgs(
	context: Pick<RunContext, "mcpUrl" | "settings">,
	resumeId: string | null,
): string[] {
	const args = [
		"exec",
		"--json",
		"--skip-git-repo-check",
		// Codex never needs to touch the filesystem to edit a Rendr timeline.
		"--sandbox",
		"read-only",
		"-c",
		`mcp_servers.rendr.url=${toml(context.mcpUrl)}`,
		// Non-interactive: nobody is there to approve a tool call.
		"-c",
		`approval_policy=${toml("never")}`,
	];
	const model = context.settings.models.codex?.trim();
	if (model) args.push("--model", model);
	if (resumeId) args.push("resume", resumeId, "-");
	else args.push("-");
	return args;
}

function handleLine(line: string, context: RunContext): void {
	const event = parseJson(line);
	if (!event) return;
	const { emit } = context;

	if (event.type === "thread.started" && typeof event.thread_id === "string") {
		threadId = event.thread_id;
		return;
	}

	const item = event.item as Record<string, unknown> | undefined;
	if (item && (event.type === "item.started" || event.type === "item.completed")) {
		if (item.type === "mcp_tool_call" && event.type === "item.started") {
			const server = typeof item.server === "string" ? item.server : "";
			if (server === "rendr") emit({ kind: "mcp", connected: true, status: "connected" });
			emit({
				kind: "tool",
				tool: bareToolName(String(item.tool ?? "tool")),
				detail: summarizeInput(item.arguments),
			});
			return;
		}
		if (
			item.type === "agent_message" &&
			event.type === "item.completed" &&
			typeof item.text === "string"
		) {
			emit({ kind: "text", text: item.text });
		}
		return;
	}

	if (event.type === "turn.failed" || event.type === "error") {
		const raw =
			typeof event.message === "string"
				? event.message
				: String(
						(event.error as { message?: unknown } | undefined)?.message ??
							"Codex returned an error.",
					);
		// turn.failed repeats the error event that precedes it; report it once.
		if (event.type === "turn.failed") return;
		emit({ kind: "error", message: friendlyCodexError(raw) });
	}
}

export function friendlyCodexError(raw: string): string {
	// Codex nests the API's JSON error inside its own message.
	const nested = raw.match(/"message"\s*:\s*"([^"]+)"/);
	const message = nested?.[1] ?? raw;
	if (/not (logged|signed) in|login/i.test(message) && !/usage limit/i.test(message)) {
		return "Codex isn't signed in. Run `codex login` in a terminal, then try again.";
	}
	if (/model .* not supported/i.test(message)) {
		return `${message} Set a different model for Codex in the agent settings.`;
	}
	return message;
}

export const codexProvider: AgentProvider = {
	id: "codex",

	async probe() {
		const result = await probeVersion(resolveBinary("codex"), agentEnv());
		if (result.missing) {
			return {
				available: false,
				label: "Codex",
				reason: "The Codex CLI isn't installed. Install it (npm i -g @openai/codex), run `codex login`, then reopen this panel.",
			};
		}
		return result.ok
			? { available: true, label: "Codex", version: result.output }
			: {
					available: false,
					label: "Codex",
					reason: `The Codex CLI exited with code ${result.code}.`,
				};
	},

	run(prompt, context) {
		return new Promise<void>((resolve) => {
			const { emit } = context;
			if (active) {
				emit({ kind: "error", message: "Codex is still answering. Cancel first." });
				resolve();
				return;
			}
			const prefixed = threadId ? prompt : `${context.instructions}\n\n---\n\n${prompt}`;

			let child: ChildProcessWithoutNullStreams;
			try {
				child = spawn(resolveBinary("codex"), codexArgs(context, threadId), {
					env: agentEnv(),
					cwd: context.workDir,
					stdio: ["pipe", "pipe", "pipe"],
				});
				child.stdin.write(prefixed);
				child.stdin.end();
			} catch (error) {
				emit({
					kind: "error",
					message: `Couldn't start Codex: ${error instanceof Error ? error.message : String(error)}`,
				});
				emit({ kind: "done", sessionId: threadId });
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
					message: error.message.includes("ENOENT")
						? "The Codex CLI isn't installed or isn't on PATH."
						: error.message,
				});
			});
			child.on("close", (code) => {
				if (active === child) active = null;
				if (code !== 0 && code !== null) {
					// Codex logs skill and config warnings to stderr on every run;
					// only the last line is ever the reason it stopped.
					const last = stderr.trim().split("\n").filter(Boolean).pop();
					if (last && !/ WARN | INFO /.test(last)) emit({ kind: "error", message: last });
				}
				emit({ kind: "done", sessionId: threadId });
				resolve();
			});
		});
	},

	cancel() {
		active?.kill("SIGTERM");
		active = null;
	},

	reset() {
		threadId = null;
	},
};
