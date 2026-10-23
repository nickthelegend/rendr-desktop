// The agent panel's connection to whichever agent the user brings.
//
// Rendr holds no model of its own. It drives the user's Claude Code or Codex
// install, any ACP agent (Gemini CLI, OpenCode, Goose, …), or an API key they
// paste — each pointed back at Rendr's tools, so the model that answers is the
// same one that edits the timeline.

import { useCallback, useEffect, useRef, useState } from "react";

import type {
	AgentCatalog,
	AgentEvent,
	AgentSettingsPatch,
	AgentSettingsView,
	ProviderId,
} from "./agentTypes";
import type { EditorApi } from "./state";

export interface AgentStatus {
	provider: ProviderId | null;
	available: boolean;
	version?: string;
	reason?: string;
	/** What the header calls the agent: "Claude", "Codex", "OpenCode", … */
	label?: string;
	/** False while the probe is still running. */
	checked: boolean;
}

export function useAgent(api: EditorApi) {
	const { logAgent, patch } = api;
	const [status, setStatus] = useState<AgentStatus>({
		provider: null,
		available: false,
		checked: false,
	});
	const [settings, setSettings] = useState<AgentSettingsView | null>(null);
	const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
	const [thinking, setThinking] = useState(false);
	// Streamed text arrives in fragments; they are merged into one message
	// rather than logged separately, or the panel fills with slivers.
	const streamIdRef = useRef<string | null>(null);

	const probe = useCallback(() => {
		const bridge = window.electronAPI;
		if (!bridge?.agentStatus) {
			setStatus({
				provider: null,
				available: false,
				checked: true,
				reason: "Agents run through the desktop app's bridge — they aren't reachable from a browser tab.",
			});
			return;
		}
		setStatus((current) => ({ ...current, checked: false }));
		// A missing CLI can reject rather than resolve {available:false}, and an
		// uncaught rejection would leave the panel at checked:false forever —
		// spinning, with nothing on screen saying why.
		void bridge
			.agentStatus()
			.then((result) => setStatus({ ...result, checked: true }))
			.catch((error: unknown) =>
				setStatus({
					provider: null,
					available: false,
					checked: true,
					reason: `Couldn't reach the agent: ${error instanceof Error ? error.message : String(error)}`,
				}),
			);
	}, []);

	useEffect(() => {
		probe();
		const bridge = window.electronAPI;
		void bridge
			?.agentGetSettings?.()
			.then(setSettings)
			.catch(() => undefined);
		void bridge
			?.agentCatalog?.()
			.then(setCatalog)
			.catch(() => undefined);
	}, [probe]);

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.onAgentEvent) return;

		return bridge.onAgentEvent((raw) => {
			const event = raw as AgentEvent;
			if (event.kind === "text") {
				const id = streamIdRef.current ?? `agent-${Date.now()}`;
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
						text: `The agent started but couldn't reach Rendr's tools (${event.status}), so it can chat but not edit the timeline.`,
					});
				}
				return;
			}
			if (event.kind === "tool") {
				// The receipt itself comes from the MCP bridge, which knows whether
				// the call worked; logging it here too would show every call twice.
				// It still breaks the text stream: what the agent says after a tool
				// call is a new message, not a continuation of the last.
				streamIdRef.current = null;
				return;
			}
			if (event.kind === "error") {
				logAgent({ kind: "assistant", id: `agent-err-${Date.now()}`, text: event.message });
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
			if (!bridge?.agentSend || !status.available) {
				logAgent({
					kind: "assistant",
					id: `a-${Date.now()}`,
					text:
						status.reason ??
						"No agent is set up. Pick one in the agent settings, or connect any MCP client to Rendr — its calls still show up here.",
				});
				return;
			}
			setThinking(true);
			streamIdRef.current = null;
			bridge.agentSend(trimmed);
		},
		[logAgent, status],
	);

	const cancel = useCallback(() => {
		window.electronAPI?.agentCancel?.();
		setThinking(false);
		streamIdRef.current = null;
	}, []);

	/** Starts a fresh conversation with the same agent. */
	const reset = useCallback(() => {
		window.electronAPI?.agentReset?.();
		streamIdRef.current = null;
	}, []);

	const updateSettings = useCallback(
		async (next: AgentSettingsPatch) => {
			const bridge = window.electronAPI;
			if (!bridge?.agentSetSettings) return;
			setSettings(await bridge.agentSetSettings(next));
			probe();
		},
		[probe],
	);

	const setApiKey = useCallback(
		async (key: string) => {
			const bridge = window.electronAPI;
			if (!bridge?.agentSetKey) return;
			setSettings(await bridge.agentSetKey(key));
			probe();
		},
		[probe],
	);

	return {
		status,
		thinking,
		send,
		cancel,
		reset,
		settings,
		catalog,
		updateSettings,
		setApiKey,
		refresh: probe,
	};
}
