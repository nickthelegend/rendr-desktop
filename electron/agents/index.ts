// The agent panel's brain, whichever one the user brings.
//
// One IPC surface for the renderer; behind it, a provider per kind of agent:
// a subscription CLI (Claude Code, Codex), any ACP agent (Gemini CLI, OpenCode,
// Goose, Qwen, …), or a bare API key. All of them reach the same tools — the
// CLIs and ACP agents over Rendr's MCP server, the API loop in-process.

import { mkdirSync } from "node:fs";
import path from "node:path";

import { app, type BrowserWindow, ipcMain } from "electron";

import { bridgeScriptPath, nodeCommand } from "../connect/paths";
import { FULL_INSTRUCTIONS } from "../mcp/agentInstructions";
import { MCP_PATH, MCP_PORT } from "../mcp/httpServer";
import { dispatchTool } from "../mcp/index";
import { ACP_PRESETS, acpProvider, stopAcp } from "./acp";
import { API_PRESETS, apiProvider } from "./apiAgent";
import { claudeCodeProvider } from "./claudeCode";
import { codexProvider } from "./codex";
import { loadSettings, publicSettings, readApiKey, saveSettings, writeApiKey } from "./settings";
import type { AgentEvent, AgentProvider, AgentSettings, ProviderId, RunContext } from "./types";

export const AGENT_CHAT_CHANNELS = {
	catalog: "rendr-agent-chat:catalog",
	status: "rendr-agent-chat:status",
	getSettings: "rendr-agent-chat:get-settings",
	setSettings: "rendr-agent-chat:set-settings",
	setKey: "rendr-agent-chat:set-key",
	send: "rendr-agent-chat:send",
	cancel: "rendr-agent-chat:cancel",
	reset: "rendr-agent-chat:reset",
	event: "rendr-agent-chat:event",
} as const;

const PROVIDERS: Record<ProviderId, AgentProvider> = {
	"claude-code": claudeCodeProvider,
	codex: codexProvider,
	acp: acpProvider,
	api: apiProvider,
};

/** What the settings UI offers. Labels only — nothing here is a secret. */
export const PROVIDER_CATALOG = {
	providers: [
		{
			id: "claude-code",
			label: "Claude Code",
			detail: "Your Claude Pro, Max or Team plan, through the claude CLI",
		},
		{ id: "codex", label: "Codex", detail: "Your ChatGPT plan, through the codex CLI" },
		{
			id: "acp",
			label: "ACP agent",
			detail: "Gemini CLI, OpenCode, Goose, Qwen Code, or any agent that speaks ACP",
		},
		{
			id: "api",
			label: "API key / local model",
			detail: "OpenAI, Anthropic, OpenRouter, Groq, Gemini, Ollama, LM Studio, …",
		},
	],
	acpPresets: ACP_PRESETS,
	apiPresets: API_PRESETS,
};

/** The briefing a CLI or ACP agent gets on its first turn. MCP carries the full manual. */
const AGENT_PREAMBLE = `You are the assistant inside Rendr, a desktop app that records and edits screen video. You are connected to Rendr through the MCP server named "rendr"; use its tools to inspect and change the user's project (call get_timeline first). Do not run shell commands or edit files — everything you need is a rendr tool. Reply in one or two short sentences, leading with the outcome.`;

let running = false;

function workDir(): string {
	// An empty folder of Rendr's own, so no agent mistakes the user's home
	// directory or a code project for its workspace.
	const dir = path.join(app.getPath("userData"), "agent-workspace");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function context(emit: (event: AgentEvent) => void, settings: AgentSettings): RunContext {
	return {
		emit,
		settings,
		mcpUrl: `http://127.0.0.1:${MCP_PORT}${MCP_PATH}`,
		stdioBridge: nodeCommand(bridgeScriptPath()),
		workDir: workDir(),
		dispatch: dispatchTool,
		apiKey: readApiKey(),
		// The API loop has no MCP handshake to deliver the manual, so it gets it whole.
		instructions: settings.provider === "api" ? FULL_INSTRUCTIONS : AGENT_PREAMBLE,
	};
}

export function registerAgentChat(getWindow: () => BrowserWindow | null): void {
	const emit = (event: AgentEvent) => {
		const window = getWindow();
		if (window && !window.isDestroyed())
			window.webContents.send(AGENT_CHAT_CHANNELS.event, event);
	};

	ipcMain.handle(AGENT_CHAT_CHANNELS.catalog, () => PROVIDER_CATALOG);
	ipcMain.handle(AGENT_CHAT_CHANNELS.getSettings, () => publicSettings());

	ipcMain.handle(AGENT_CHAT_CHANNELS.status, async () => {
		const settings = loadSettings();
		return {
			provider: settings.provider,
			...(await PROVIDERS[settings.provider].probe(settings)),
		};
	});

	ipcMain.handle(AGENT_CHAT_CHANNELS.setSettings, (_event, patch: Partial<AgentSettings>) => {
		const before = loadSettings();
		const after = saveSettings(patch ?? {});
		// A different agent, command or model is a different conversation.
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			for (const provider of Object.values(PROVIDERS)) {
				provider.cancel();
				provider.reset();
			}
			running = false;
		}
		return publicSettings();
	});

	ipcMain.handle(AGENT_CHAT_CHANNELS.setKey, (_event, key: string) => {
		writeApiKey(typeof key === "string" ? key : "");
		return publicSettings();
	});

	ipcMain.on(AGENT_CHAT_CHANNELS.send, (_event, prompt: string) => {
		if (running) {
			emit({ kind: "error", message: "Still answering. Cancel first." });
			return;
		}
		const settings = loadSettings();
		running = true;
		void Promise.resolve()
			.then(() => PROVIDERS[settings.provider].run(prompt, context(emit, settings)))
			.catch((error: unknown) => {
				emit({
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				});
				emit({ kind: "done", sessionId: null });
			})
			.finally(() => {
				running = false;
			});
	});

	ipcMain.on(AGENT_CHAT_CHANNELS.cancel, () => {
		PROVIDERS[loadSettings().provider].cancel();
	});

	ipcMain.on(AGENT_CHAT_CHANNELS.reset, () => {
		for (const provider of Object.values(PROVIDERS)) provider.reset();
	});
}

/** Called on quit so no agent process outlives the app. */
export function stopAgentChat(): void {
	for (const provider of Object.values(PROVIDERS)) provider.cancel();
	stopAcp();
}
