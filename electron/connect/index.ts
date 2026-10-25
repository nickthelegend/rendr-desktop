// Rendr Connect: every way an agent can reach Rendr, behind one IPC surface.
//
// - Local MCP (127.0.0.1:19790), with one-click setup for the clients people use
// - A stdio bridge, for clients that only launch commands
// - REST, OpenAPI and tool schemas in OpenAI / Anthropic / Gemini shapes
// - The `rendr` command, for agents that only have a shell
// - Remote access over a tunnel, for claude.ai, ChatGPT and cloud agents

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrowserWindow, ipcMain } from "electron";

import { MCP_PATH, MCP_PORT } from "../mcp/httpServer";
import { type ConnectTarget, installClient, listClients } from "./clients";
import { bridgeScriptPath, cliScriptPath, nodeCommand } from "./paths";
import { RemoteAccess, type RemoteState } from "./remote";

export const CONNECT_CHANNELS = {
	state: "rendr-connect:state",
	install: "rendr-connect:install",
	installCli: "rendr-connect:install-cli",
	remoteStart: "rendr-connect:remote-start",
	remoteStop: "rendr-connect:remote-stop",
	rotateToken: "rendr-connect:rotate-token",
	changed: "rendr-connect:changed",
} as const;

/** Cloud agents that take a connector URL. Rendr can't configure these; it can say how. */
export const CLOUD_CLIENTS = [
	{
		id: "claude-ai",
		label: "Claude (claude.ai, desktop and mobile)",
		steps: "Settings → Connectors → Add custom connector → paste the URL. Leave OAuth empty.",
	},
	{
		id: "chatgpt",
		label: "ChatGPT",
		steps: "Settings → Apps & Connectors → Advanced → turn on Developer mode, then Create → paste the URL, Authentication: No authentication.",
	},
	{
		id: "custom-gpt",
		label: "Custom GPT (Actions)",
		steps: "Configure → Create new action → Import from URL → paste the OpenAPI URL. Authentication: None (the token is in the URL).",
	},
	{
		id: "le-chat",
		label: "Mistral Le Chat",
		steps: "Intelligence → Connectors → Add connector → Custom MCP → paste the URL.",
	},
	{
		id: "any-remote",
		label: "Any remote MCP client or agent platform",
		steps: "Use the URL as a streamable-HTTP MCP endpoint, or send the token as Authorization: Bearer to the bare /mcp path.",
	},
];

let remote: RemoteAccess | null = null;

function localTarget(): ConnectTarget {
	return {
		url: `http://127.0.0.1:${MCP_PORT}${MCP_PATH}`,
		stdio: nodeCommand(bridgeScriptPath()),
	};
}

function remoteTarget(state: RemoteState): ConnectTarget | null {
	if (!state.connectorUrl) return null;
	const bridge = nodeCommand(bridgeScriptPath());
	return {
		url: state.connectorUrl,
		stdio: { ...bridge, env: { ...bridge.env, RENDR_MCP_URL: state.connectorUrl } },
	};
}

/** Where the `rendr` shim goes: the first of these that exists, else ~/.local/bin. */
function cliInstallPath(): string {
	const home = os.homedir();
	if (process.platform === "win32")
		return path.join(home, "AppData", "Local", "Microsoft", "WindowsApps", "rendr.cmd");
	return path.join(home, ".local", "bin", "rendr");
}

function cliShim(): string {
	const { command, args } = nodeCommand(cliScriptPath());
	if (process.platform === "win32") {
		return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${command}" "${args[0]}" %*\r\n`;
	}
	return `#!/bin/sh\n# Installed by Rendr. Runs Rendr's command-line client with Rendr's own runtime.\nELECTRON_RUN_AS_NODE=1 exec "${command}" "${args[0]}" "$@"\n`;
}

function cliInstalled(): boolean {
	const file = cliInstallPath();
	return existsSync(file) && readFileSync(file, "utf8").includes("Rendr");
}

function state() {
	const remoteState = remote?.snapshot() ?? null;
	const local = localTarget();
	const remoteClientTarget = remoteState ? remoteTarget(remoteState) : null;
	const localBase = `http://127.0.0.1:${MCP_PORT}`;
	return {
		local: {
			mcpUrl: local.url,
			restBase: localBase,
			openApiUrl: `${localBase}/openapi.json`,
			toolsUrl: `${localBase}/v1/tools`,
			llmsUrl: `${localBase}/llms.txt`,
			stdio: local.stdio,
		},
		remote: remoteState
			? {
					...remoteState,
					openApiUrl: remoteState.restBase
						? `${remoteState.restBase}/openapi.json`
						: null,
					manualOrigin: remote?.manualOrigin ?? null,
					stdio: remoteClientTarget?.stdio ?? null,
				}
			: null,
		clients: listClients(local),
		cloudClients: CLOUD_CLIENTS,
		cli: { installed: cliInstalled(), path: cliInstallPath() },
	};
}

export type ConnectState = ReturnType<typeof state>;

function broadcast(): void {
	const payload = state();
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(CONNECT_CHANNELS.changed, payload);
	}
}

export function registerConnect(): void {
	remote = new RemoteAccess(() => broadcast());

	ipcMain.handle(CONNECT_CHANNELS.state, () => state());

	ipcMain.handle(CONNECT_CHANNELS.install, async (_event, clientId: string) => {
		try {
			await installClient(String(clientId), localTarget());
			return { ok: true, state: state() };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				state: state(),
			};
		}
	});

	ipcMain.handle(CONNECT_CHANNELS.installCli, () => {
		try {
			const file = cliInstallPath();
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, cliShim());
			if (process.platform !== "win32") chmodSync(file, 0o755);
			return { ok: true, state: state() };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				state: state(),
			};
		}
	});

	ipcMain.handle(
		CONNECT_CHANNELS.remoteStart,
		async (_event, options: { mode?: string; origin?: string } = {}) => {
			if (!remote) return state();
			if (options.mode === "manual") await remote.startManual(String(options.origin ?? ""));
			else await remote.startTunnel();
			return state();
		},
	);

	ipcMain.handle(CONNECT_CHANNELS.remoteStop, async () => {
		await remote?.stop();
		return state();
	});

	ipcMain.handle(CONNECT_CHANNELS.rotateToken, () => {
		remote?.rotateToken();
		return state();
	});
}

export function stopConnect(): void {
	void remote?.stop();
}
