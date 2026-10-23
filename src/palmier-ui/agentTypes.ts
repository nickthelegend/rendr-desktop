// Shapes the agent panel and the Connect sheet receive from the main process.
// Mirrors electron/agents/types.ts and electron/connect/*, so the renderer can
// name them without importing main-process code (as mcpStatus.ts does for the port).

export type ProviderId = "claude-code" | "codex" | "acp" | "api";
export type AcpPreset =
	| "gemini"
	| "opencode"
	| "goose"
	| "qwen"
	| "claude-acp"
	| "codex-acp"
	| "custom";
export type ApiFlavor = "openai" | "anthropic";

export type AgentEvent =
	| { kind: "text"; text: string }
	| { kind: "tool"; tool: string; detail: string }
	| { kind: "done"; sessionId: string | null }
	| { kind: "error"; message: string }
	| { kind: "mcp"; connected: boolean; status: string };

export interface AgentStatusInfo {
	provider: ProviderId;
	available: boolean;
	version?: string;
	reason?: string;
	label?: string;
}

export interface AgentSettingsView {
	provider: ProviderId;
	models: Partial<Record<ProviderId, string>>;
	acp: { preset: AcpPreset; command: string };
	api: { flavor: ApiFlavor; baseUrl: string; model: string };
	apiKeySet: boolean;
}

export type AgentSettingsPatch = Partial<{
	provider: ProviderId;
	models: Partial<Record<ProviderId, string>>;
	acp: Partial<AgentSettingsView["acp"]>;
	api: Partial<AgentSettingsView["api"]>;
}>;

export interface AgentCatalog {
	providers: Array<{ id: ProviderId; label: string; detail: string }>;
	acpPresets: Array<{ id: AcpPreset; label: string; command: string; signIn: string }>;
	apiPresets: Array<{
		id: string;
		label: string;
		flavor: ApiFlavor;
		baseUrl: string;
		model: string;
		needsKey: boolean;
		keyUrl?: string;
	}>;
}

export interface ConnectClient {
	id: string;
	label: string;
	detected: boolean;
	connected: boolean;
	canInstall: boolean;
	snippet: string;
	configPath?: string;
	note?: string;
}

export interface StdioCommand {
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface ConnectStateView {
	local: {
		mcpUrl: string;
		restBase: string;
		openApiUrl: string;
		toolsUrl: string;
		llmsUrl: string;
		stdio: StdioCommand;
	};
	remote: {
		status: "off" | "starting" | "on" | "error";
		mode: "cloudflared" | "manual";
		publicOrigin: string | null;
		connectorUrl: string | null;
		restBase: string | null;
		openApiUrl: string | null;
		token: string;
		localPort: number;
		cloudflaredInstalled: boolean;
		manualOrigin: string | null;
		error: string | null;
		stdio: StdioCommand | null;
	} | null;
	clients: ConnectClient[];
	cloudClients: Array<{ id: string; label: string; steps: string }>;
	cli: { installed: boolean; path: string };
}

export interface ConnectActionResult {
	ok: boolean;
	error?: string;
	state: ConnectStateView;
}
