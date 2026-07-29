// Claude in the agent panel, driven by the `claude` CLI.
//
// Rendr doesn't hold an API key or talk to Anthropic directly. It shells out to
// the user's own Claude Code install, which already has their auth, and points
// it at Rendr's MCP server. So the model that answers in the panel is the same
// one that can call Rendr's tools — the chat and the editing are one session,
// not two systems that happen to sit next to each other.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { app, type BrowserWindow, ipcMain } from "electron";

import { MCP_PATH, MCP_PORT } from "./mcp";

export const CLAUDE_REQUEST_CHANNEL = "rendr-claude:send";
export const CLAUDE_CANCEL_CHANNEL = "rendr-claude:cancel";
export const CLAUDE_EVENT_CHANNEL = "rendr-claude:event";
export const CLAUDE_STATUS_CHANNEL = "rendr-claude:status";

/** Streamed back to the renderer as the CLI produces it. */
export type ClaudeEvent =
	| { kind: "text"; text: string }
	| { kind: "tool"; tool: string; detail: string }
	| { kind: "done"; sessionId: string | null }
	| { kind: "error"; message: string }
	/** Whether the CLI managed to reach Rendr's own MCP server. */
	| { kind: "mcp"; connected: boolean; status: string };

/** Where the CLI usually lives when it isn't on the app's inherited PATH. */
const LIKELY_PATHS = [
	path.join(process.env.HOME ?? "", ".local/bin/claude"),
	path.join(process.env.HOME ?? "", ".claude/local/claude"),
	"/opt/homebrew/bin/claude",
	"/usr/local/bin/claude",
];

export function resolveClaudeBinary(): string | null {
	for (const candidate of LIKELY_PATHS) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	// Fall back to PATH resolution and let spawn report if it isn't there.
	return "claude";
}

/**
 * An MCP config pointing the CLI back at this app, so the model it runs can
 * read and edit the timeline it is talking about.
 */
function mcpConfig(): string {
	return JSON.stringify({
		mcpServers: {
			rendr: {
				type: "http",
				url: `http://127.0.0.1:${MCP_PORT}${MCP_PATH}`,
			},
		},
	});
}

let active: ChildProcessWithoutNullStreams | null = null;
let sessionId: string | null = null;

function send(window: BrowserWindow | null, event: ClaudeEvent): void {
	if (window && !window.isDestroyed()) window.webContents.send(CLAUDE_EVENT_CHANNEL, event);
}

/**
 * Parses one line of `--output-format stream-json`.
 *
 * The CLI emits one JSON object per line: assistant messages, tool calls, and
 * a final result. Anything unrecognised is ignored rather than shown raw.
 */
function handleLine(line: string, window: BrowserWindow | null): void {
	let message: Record<string, unknown>;
	try {
		message = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}

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
		send(window, {
			kind: "mcp",
			connected: status === "connected" || status === "pending",
			status,
		});
		return;
	}

	if (message.type === "assistant") {
		const content = (message.message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) return;
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === "text" && typeof block.text === "string") {
				send(window, { kind: "text", text: block.text });
			}
			if (block.type === "tool_use" && typeof block.name === "string") {
				// Tool receipts are the point of the panel; surface every one.
				const input = block.input as Record<string, unknown> | undefined;
				const detail = input ? summarizeInput(input) : "";
				send(window, { kind: "tool", tool: block.name, detail });
			}
		}
		return;
	}

	if (message.type === "result") {
		if (message.is_error) {
			const reported = typeof message.result === "string" ? message.result : "";
			send(window, {
				kind: "error",
				// The CLI's own login prompt is terminal advice; translate it for
				// someone who is looking at an app, not a shell.
				message: /not logged in/i.test(reported)
					? "Claude Code isn't signed in. Run `claude` in a terminal and log in, then try again."
					: reported || "Claude returned an error.",
			});
		}
		send(window, { kind: "done", sessionId });
	}
}

/** A short, readable summary of a tool call's arguments. */
function summarizeInput(input: Record<string, unknown>): string {
	const keys = Object.keys(input);
	if (keys.length === 0) return "";
	const first = keys[0];
	const value = input[first];
	if (Array.isArray(value)) return `${first}: ${value.length}`;
	if (typeof value === "string") return value.length > 30 ? `${value.slice(0, 30)}…` : value;
	if (typeof value === "number" || typeof value === "boolean") return `${first}: ${value}`;
	return first;
}

export function registerClaudeCli(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(CLAUDE_STATUS_CHANNEL, async () => {
		const binary = resolveClaudeBinary();
		if (!binary) return { available: false, reason: "The Claude CLI wasn't found." };

		// `--version` is the cheapest proof the binary actually runs.
		return await new Promise((resolve) => {
			const probe = spawn(binary, ["--version"], { env: process.env });
			let output = "";
			probe.stdout.on("data", (chunk) => {
				output += String(chunk);
			});
			probe.on("error", () =>
				resolve({
					available: false,
					reason: "The Claude CLI isn't installed or isn't on PATH. Install Claude Code, then reopen this panel.",
				}),
			);
			probe.on("close", (code) =>
				resolve(
					code === 0
						? { available: true, version: output.trim() }
						: { available: false, reason: `The Claude CLI exited with code ${code}.` },
				),
			);
		});
	});

	ipcMain.on(CLAUDE_REQUEST_CHANNEL, (_event, prompt: string) => {
		const window = getWindow();
		if (active) {
			send(window, { kind: "error", message: "Claude is still answering. Cancel first." });
			return;
		}

		const binary = resolveClaudeBinary();
		if (!binary) {
			send(window, { kind: "error", message: "The Claude CLI wasn't found." });
			return;
		}

		const args = [
			"--print",
			"--output-format",
			"stream-json",
			"--verbose",
			// Point the CLI back at this app so the model can drive the timeline.
			"--mcp-config",
			mcpConfig(),
			"--allowed-tools",
			"mcp__rendr",
		];
		// Continuing keeps the conversation coherent across turns.
		if (sessionId) args.push("--resume", sessionId);
		// The prompt goes on stdin, not as a trailing argument: --allowed-tools
		// takes a list, so a trailing prompt is swallowed as another tool name
		// and the CLI exits with "Input must be provided".

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(binary, args, {
				env: { ...process.env },
				cwd: app.getPath("userData"),
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdin.write(prompt);
			child.stdin.end();
		} catch (error) {
			send(window, {
				kind: "error",
				message: `Couldn't start the Claude CLI: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		active = child;
		let buffer = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline: number;
			// biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitting loop
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) handleLine(line, window);
			}
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (error) => {
			active = null;
			send(window, {
				kind: "error",
				message:
					error.message.includes("ENOENT") || error.message.includes("spawn")
						? "The Claude CLI isn't installed or isn't on PATH. Install Claude Code and try again."
						: error.message,
			});
		});

		child.on("close", (code) => {
			active = null;
			if (code !== 0 && code !== null) {
				send(window, {
					kind: "error",
					message: stderr.trim() || `The Claude CLI exited with code ${code}.`,
				});
			}
			send(window, { kind: "done", sessionId });
		});
	});

	ipcMain.on(CLAUDE_CANCEL_CHANNEL, () => {
		active?.kill("SIGTERM");
		active = null;
	});
}

/** Called on quit so a running CLI doesn't outlive the app. */
export function stopClaudeCli(): void {
	active?.kill("SIGTERM");
	active = null;
}
