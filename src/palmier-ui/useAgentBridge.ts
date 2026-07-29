// Connects this editor to the MCP server running in the main process.
//
// The bridge is the same channel Recordly's editor uses; what differs is who
// answers. Tools land on the handlers in agentTools.ts, which go through the
// same reducers the panels do, and every call is logged as a receipt so a human
// can see what an agent changed.

import { useEffect, useRef } from "react";

import { createAgentTools, type ToolResult } from "./agentTools";
import type { EditorApi } from "./state";

interface AgentToolCall {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

/** Short, human-readable summary of what a tool returned, for the receipt row. */
function summarize(name: string, result: ToolResult): string {
	const images = result.content.filter((part) => part.type === "image").length;
	// A rendered result's payload is the picture; the JSON is just its caption.
	if (images > 0) return `${images} frame${images === 1 ? "" : "s"}`;
	const text = result.content.find((part) => part.type === "text")?.text ?? "";
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		if (parsed.error) return String(parsed.error);
		if (typeof parsed.added === "number") return `${parsed.added} added`;
		if (Array.isArray(parsed.removedClipIds)) return `${parsed.removedClipIds.length} removed`;
		if (Array.isArray(parsed.clips)) return `${parsed.clips.length} clips`;
		if (Array.isArray(parsed.tracks)) return `${parsed.tracks.length} tracks`;
		if (Array.isArray(parsed.assets)) return `${parsed.assets.length} assets`;
		if (parsed.changed === false) return "no change";
		if (typeof parsed.totalFrames === "number") return `${parsed.totalFrames} frames`;
	} catch {
		// A non-JSON payload is still worth showing as "ok".
	}
	return name.startsWith("get_") ? "read" : "ok";
}

export function useAgentBridge(api: EditorApi): void {
	// The handlers close over the current editor, so they are rebuilt each
	// render and read through a ref — the IPC listener registers once.
	const toolsRef = useRef(createAgentTools(api));
	toolsRef.current = createAgentTools(api);
	const apiRef = useRef(api);
	apiRef.current = api;

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.onAgentToolCall) return;

		const unsubscribe = bridge.onAgentToolCall(async (call: AgentToolCall) => {
			const { logAgent, patch, state } = apiRef.current;
			// The first call from a client is what proves a session exists.
			if (!state.agentConnected) patch({ agentConnected: true });

			const handler = toolsRef.current[call.name];
			if (!handler) {
				// Unknown here means "declared but not built" — registry.ts owns
				// that message, so pass it through rather than inventing one.
				bridge.respondAgentToolCall({
					callId: call.callId,
					error: `'${call.name}' is declared by Rendr's MCP server but not implemented yet.`,
				});
				logAgent({
					kind: "tool",
					id: `t-${call.callId}`,
					tool: call.name,
					status: "error",
					detail: "not implemented",
				});
				return;
			}

			try {
				// Tools that render or decode a frame are async; awaiting a
				// synchronous one costs a microtask and nothing else.
				const result = await handler(call.args ?? {});
				logAgent({
					kind: "tool",
					id: `t-${call.callId}`,
					tool: call.name,
					status: result.isError ? "error" : "ok",
					detail: summarize(call.name, result),
				});
				bridge.respondAgentToolCall({ callId: call.callId, result });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logAgent({
					kind: "tool",
					id: `t-${call.callId}`,
					tool: call.name,
					status: "error",
					detail: message,
				});
				bridge.respondAgentToolCall({ callId: call.callId, error: message });
			}
		});

		return unsubscribe;
	}, []);
}
