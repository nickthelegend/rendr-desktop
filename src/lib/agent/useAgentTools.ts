// Wires the renderer into the main-process MCP server. Mount once, from whichever
// component owns both the editor state and the recorder.

import { useEffect, useRef } from "react";

import { type AgentRuntime, dispatchAgentTool } from "./registry";
import type { AgentToolCall } from "./types";

export function useAgentTools(runtime: AgentRuntime): void {
	// Keep the latest runtime in a ref so the IPC listener is registered once but
	// always reads current editor/recorder state.
	const runtimeRef = useRef(runtime);
	runtimeRef.current = runtime;

	useEffect(() => {
		const api = window.electronAPI;
		if (!api?.onAgentToolCall) return;

		const unsubscribe = api.onAgentToolCall((call: AgentToolCall) => {
			dispatchAgentTool(call.name, call.args ?? {}, runtimeRef.current)
				.then((result) => {
					api.respondAgentToolCall({ callId: call.callId, result });
				})
				.catch((error: unknown) => {
					api.respondAgentToolCall({
						callId: call.callId,
						error: error instanceof Error ? error.message : String(error),
					});
				});
		});

		return unsubscribe;
	}, []);
}
