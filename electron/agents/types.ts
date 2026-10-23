// The contract every agent provider meets.
//
// The agent panel doesn't care which model answers. A provider takes a prompt,
// streams back text and tool receipts in one vocabulary, and finishes with
// `done`. Subscription CLIs (Claude Code, Codex), ACP agents (Gemini, OpenCode,
// Goose, …) and raw API keys all look the same from the renderer.

import type { ToolCallResult } from "../mcp/httpServer";

export type ProviderId = "claude-code" | "codex" | "acp" | "api";

/** Streamed to the renderer as a provider produces it. */
export type AgentEvent =
	| { kind: "text"; text: string }
	| { kind: "tool"; tool: string; detail: string }
	| { kind: "done"; sessionId: string | null }
	| { kind: "error"; message: string }
	/** Whether the agent managed to reach Rendr's own tools. */
	| { kind: "mcp"; connected: boolean; status: string };

export interface ProviderStatus {
	available: boolean;
	version?: string;
	reason?: string;
	/** What the panel header calls this agent, e.g. "Claude", "OpenCode". */
	label?: string;
}

export type AcpPreset =
	| "gemini"
	| "opencode"
	| "goose"
	| "qwen"
	| "claude-acp"
	| "codex-acp"
	| "custom";

export type ApiFlavor = "openai" | "anthropic";

export interface AgentSettings {
	provider: ProviderId;
	/** Per-provider model override. Empty means "whatever the agent defaults to". */
	models: Partial<Record<ProviderId, string>>;
	acp: { preset: AcpPreset; command: string };
	api: { flavor: ApiFlavor; baseUrl: string; model: string };
}

/** Settings as the renderer sees them: the key itself never leaves the main process. */
export interface PublicAgentSettings extends AgentSettings {
	apiKeySet: boolean;
}

export type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

export interface RunContext {
	emit: (event: AgentEvent) => void;
	settings: AgentSettings;
	/** Where Rendr's MCP server answers, for agents that attach to it themselves. */
	mcpUrl: string;
	/** A stdio bridge to the same server, for agents that only speak stdio MCP. */
	stdioBridge: { command: string; args: string[]; env: Record<string, string> };
	/** An empty directory the agent may treat as its workspace. Never the user's files. */
	workDir: string;
	/** In-process tool calls, for providers Rendr drives itself. */
	dispatch: ToolDispatch;
	apiKey: string | null;
	instructions: string;
}

export interface AgentProvider {
	id: ProviderId;
	probe(settings: AgentSettings): Promise<ProviderStatus>;
	/** Runs one turn. Resolves once `done` has been emitted. */
	run(prompt: string, context: RunContext): Promise<void>;
	cancel(): void;
	/** Forget the conversation so the next turn starts fresh. */
	reset(): void;
}

/** A short, readable summary of a tool call's arguments. */
export function summarizeInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const record = input as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 0) return "";
	const first = keys[0];
	const value = record[first];
	if (Array.isArray(value)) return `${first}: ${value.length}`;
	if (typeof value === "string") return value.length > 30 ? `${value.slice(0, 30)}…` : value;
	if (typeof value === "number" || typeof value === "boolean") return `${first}: ${value}`;
	return first;
}

/**
 * Agents name MCP tools in their own dialects — `mcp__rendr__add_clips`,
 * `rendr_add_clips`, `rendr/add_clips`, `rendr.add_clips`. Receipts show the bare name.
 */
export function bareToolName(name: string): string {
	return name.replace(/^mcp__rendr__/, "").replace(/^rendr[_./:]{1,2}/, "");
}
