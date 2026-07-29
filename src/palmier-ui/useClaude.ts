// The agent panel's connection to Claude.
//
// Rendr shells out to the user's own Claude Code install rather than holding an
// API key. The CLI is pointed back at Rendr's MCP server, so the model that
// answers is the same one that can call Rendr's tools.

import { useCallback, useEffect, useRef, useState } from "react";

import type { EditorApi } from "./state";

type ClaudeEvent =
	| { kind: "text"; text: string }
	| { kind: "tool"; tool: string; detail: string }
	| { kind: "done"; sessionId: string | null }
	| { kind: "error"; message: string }
	| { kind: "mcp"; connected: boolean; status: string };

export interface ClaudeStatus {
	available: boolean;
	version?: string;
	reason?: string;
	/** Null while the probe is still running. */
	checked: boolean;
}

export function useClaude(api: EditorApi) {
	const { logAgent, patch } = api;
	const [status, setStatus] = useState<ClaudeStatus>({ available: false, checked: false });
	const [thinking, setThinking] = useState(false);
	// Streamed text arrives in fragments; they are merged into one message
	// rather than logged separately, or the panel fills with slivers.
	const streamIdRef = useRef<string | null>(null);

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.claudeStatus) {
			setStatus({
				available: false,
				checked: true,
				reason: "Claude runs through the desktop app's CLI bridge — it isn't reachable from a browser tab.",
			});
			return;
		}
		// A missing CLI rejects rather than resolving {available:false}, and an
		// uncaught rejection left the panel at checked:false forever — spinning,
		// with nothing on screen saying why.
		void bridge
			.claudeStatus()
			.then((result) => setStatus({ ...result, checked: true }))
			.catch((error: unknown) =>
				setStatus({
					available: false,
					checked: true,
					reason: `Couldn't reach the Claude CLI: ${
						error instanceof Error ? error.message : String(error)
					}`,
				}),
			);
	}, []);

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.onClaudeEvent) return;

		return bridge.onClaudeEvent((raw) => {
			const event = raw as ClaudeEvent;
			if (event.kind === "text") {
				const id = streamIdRef.current ?? `claude-${Date.now()}`;
				streamIdRef.current = id;
				api.appendAssistantText(id, event.text);
				patch({ agentConnected: true });
				return;
			}
			if (event.kind === "mcp") {
				patch({ agentConnected: event.connected });
				if (!event.connected) {
					logAgent({
						kind: "assistant",
						id: `mcp-${Date.now()}`,
						text: `Claude started but couldn't reach Rendr's tools (${event.status}), so it can chat but not edit the timeline.`,
					});
				}
				return;
			}
			if (event.kind === "tool") {
				logAgent({
					kind: "tool",
					id: `claude-tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					tool: event.tool.replace(/^mcp__rendr__/, ""),
					status: "ok",
					detail: event.detail,
				});
				return;
			}
			if (event.kind === "error") {
				logAgent({
					kind: "assistant",
					id: `claude-err-${Date.now()}`,
					text: event.message,
				});
				setThinking(false);
				streamIdRef.current = null;
				return;
			}
			setThinking(false);
			streamIdRef.current = null;
		});
	}, [api, logAgent, patch]);

	const send = useCallback(
		(prompt: string) => {
			const trimmed = prompt.trim();
			if (!trimmed) return;
			logAgent({ kind: "user", id: `u-${Date.now()}`, text: trimmed });

			const bridge = window.electronAPI;
			if (!bridge?.claudeSend || !status.available) {
				logAgent({
					kind: "assistant",
					id: `a-${Date.now()}`,
					text:
						status.reason ??
						"Claude Code isn't available. Install it, or point any MCP client at 127.0.0.1:19790 — its calls still show up here.",
				});
				return;
			}
			setThinking(true);
			bridge.claudeSend(trimmed);
		},
		[logAgent, status],
	);

	const cancel = useCallback(() => {
		window.electronAPI?.claudeCancel?.();
		setThinking(false);
		streamIdRef.current = null;
	}, []);

	return { status, thinking, send, cancel };
}
