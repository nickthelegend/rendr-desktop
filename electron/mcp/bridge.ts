// Correlated request/response between the MCP server (main process) and the editor
// (renderer, which owns project state, the timeline, and the recording state machine).
//
// Palmier Pro does not need this layer — its tools call into the same Swift process.
// Rendr's editor lives in a renderer, so every tool call is a round trip.

import { BrowserWindow, ipcMain } from "electron";

import type { ToolCallResult } from "./httpServer";

export const AGENT_REQUEST_CHANNEL = "rendr-agent:request";
export const AGENT_RESPONSE_CHANNEL = "rendr-agent:response";

/** Long enough for a transcription or a composited-frame render; short enough to not hang a client. */
const DEFAULT_TIMEOUT_MS = 120_000;

interface PendingCall {
	resolve: (result: ToolCallResult) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface AgentBridgeResponse {
	callId: string;
	result?: ToolCallResult;
	error?: string;
}

/**
 * Recording lives in the launch/HUD window and the timeline lives in the editor
 * window — two separate renderers. Route by tool so a call always reaches the
 * window that can actually serve it.
 */
const RECORDER_HOSTED_TOOLS = new Set([
	"list_capture_sources",
	"start_recording",
	"stop_recording",
	"get_recording_status",
]);

export interface AgentWindows {
	editor: () => BrowserWindow | null;
	recorder: () => BrowserWindow | null;
}

let pending = new Map<string, PendingCall>();
let nextCallId = 0;
let listening = false;
let windows: AgentWindows | null = null;

export function initAgentBridge(agentWindows: AgentWindows): void {
	windows = agentWindows;
	if (listening) return;
	listening = true;

	ipcMain.on(AGENT_RESPONSE_CHANNEL, (_event, response: AgentBridgeResponse) => {
		const call = pending.get(response.callId);
		if (!call) return; // already timed out
		pending.delete(response.callId);
		clearTimeout(call.timer);
		if (response.error !== undefined) {
			call.reject(new Error(response.error));
			return;
		}
		if (!response.result) {
			call.reject(new Error("Editor returned an empty response"));
			return;
		}
		call.resolve(response.result);
	});
}

export function shutdownAgentBridge(): void {
	for (const call of pending.values()) {
		clearTimeout(call.timer);
		call.reject(new Error("Rendr is shutting down"));
	}
	pending = new Map();
}

/**
 * Forward a tool call to the editor window. Rejects — rather than returning a
 * success-shaped result — when no editor is open, when the renderer never answers,
 * or when the renderer reports a failure. A tool must never look like it worked.
 */
export function callEditor(
	name: string,
	args: Record<string, unknown>,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ToolCallResult> {
	const wantsRecorder = RECORDER_HOSTED_TOOLS.has(name);
	const window = (wantsRecorder ? windows?.recorder() : windows?.editor()) ?? null;
	if (!window || window.isDestroyed()) {
		return Promise.reject(
			new Error(
				wantsRecorder
					? "Rendr's recording window is not open, so capture cannot be controlled. Ask the user to bring Rendr to the front, then retry."
					: "No Rendr editor window is open, so there is no project to act on. Ask the user to open or create a project, then retry.",
			),
		);
	}

	const callId = `mcp-${++nextCallId}`;
	return new Promise<ToolCallResult>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(callId);
			reject(
				new Error(
					`Editor did not respond to '${name}' within ${Math.round(timeoutMs / 1000)}s`,
				),
			);
		}, timeoutMs);

		pending.set(callId, { resolve, reject, timer });
		window.webContents.send(AGENT_REQUEST_CHANNEL, { callId, name, args });
	});
}
