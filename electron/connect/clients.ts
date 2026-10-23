// One-click setup for the MCP clients people already use.
//
// Each entry knows where its client keeps MCP servers and how to add Rendr:
// through the client's own CLI when it has one (that CLI knows its config
// format better than Rendr does), otherwise by merging one key into its JSON
// config. A file Rendr can't parse is never rewritten — the user gets the
// snippet to paste instead, because a "fixed" config that drops their other
// servers is worse than one more manual step.

import { execFile } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentEnv, hasBinary, resolveBinary } from "../agents/binaries";

export interface ConnectTarget {
	/** Streamable-HTTP MCP endpoint. */
	url: string;
	/** A stdio command that bridges to the same endpoint, for stdio-only clients. */
	stdio: { command: string; args: string[]; env: Record<string, string> };
	home?: string;
	platform?: NodeJS.Platform;
}

export interface ClientInfo {
	id: string;
	label: string;
	/** Whether the client appears to be installed on this machine. */
	detected: boolean;
	/** Whether Rendr is already configured in it. */
	connected: boolean;
	/** Whether Rendr can add itself, or only show the snippet. */
	canInstall: boolean;
	/** The command or config fragment that connects it by hand. */
	snippet: string;
	/** Where the setting lives, when it is a file. */
	configPath?: string;
	note?: string;
}

interface ClientDefinition {
	id: string;
	label: string;
	note?: string;
	describe(target: ConnectTarget): Omit<ClientInfo, "id" | "label" | "note">;
	install?(target: ConnectTarget): Promise<void>;
}

const SERVER_NAME = "rendr";

function homeOf(target: ConnectTarget): string {
	return target.home ?? os.homedir();
}

function platformOf(target: ConnectTarget): NodeJS.Platform {
	return target.platform ?? process.platform;
}

/** The per-user application-support directory on each platform. */
function appData(target: ConnectTarget): string {
	const home = homeOf(target);
	const platform = platformOf(target);
	if (platform === "darwin") return path.join(home, "Library", "Application Support");
	if (platform === "win32") return process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
	return process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
}

export class UnparseableConfigError extends Error {}

function readJson(file: string): Record<string, unknown> {
	if (!existsSync(file)) return {};
	const text = readFileSync(file, "utf8");
	if (!text.trim()) return {};
	try {
		const value = JSON.parse(text) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("not an object");
		return value as Record<string, unknown>;
	} catch {
		throw new UnparseableConfigError(
			`${file} isn't plain JSON (it may contain comments), so Rendr won't rewrite it. Add the snippet by hand.`,
		);
	}
}

/**
 * Sets `config[container][name] = entry` and writes the file back, keeping a
 * one-time backup of what was there. Every other key is preserved.
 */
export function mergeJsonServer(file: string, container: string, entry: unknown): void {
	const config = readJson(file);
	const servers = (
		config[container] && typeof config[container] === "object" ? config[container] : {}
	) as Record<string, unknown>;
	config[container] = { ...servers, [SERVER_NAME]: entry };
	mkdirSync(path.dirname(file), { recursive: true });
	// Write through a symlink (dotfile managers keep configs in a repo and link
	// them in) rather than replacing the link with a plain file, and keep the
	// file's mode — a config holding other servers' secrets may be 0600.
	const target = existsSync(file) ? realpathSync(file) : file;
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
	const backup = `${file}.rendr-backup`;
	if (existsSync(target) && !existsSync(backup)) copyFileSync(target, backup);
	const temp = `${target}.rendr-tmp`;
	writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode });
	chmodSync(temp, mode);
	renameSync(temp, target);
}

function jsonHas(file: string, container: string): boolean {
	try {
		const config = readJson(file);
		const servers = config[container] as Record<string, unknown> | undefined;
		return Boolean(servers && typeof servers === "object" && SERVER_NAME in servers);
	} catch {
		return false;
	}
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			resolveBinary(command),
			args,
			{ env: agentEnv(), timeout: 60_000 },
			(error, _stdout, stderr) => {
				if (error) reject(new Error(String(stderr).trim() || error.message));
				else resolve();
			},
		);
	});
}

function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A client configured by one key in one JSON file. */
function jsonClient(options: {
	id: string;
	label: string;
	file: (target: ConnectTarget) => string;
	container: string;
	entry: (target: ConnectTarget) => unknown;
	detect: (target: ConnectTarget) => boolean;
	note?: string;
}): ClientDefinition {
	return {
		id: options.id,
		label: options.label,
		note: options.note,
		describe(target) {
			const file = options.file(target);
			return {
				detected: options.detect(target),
				connected: jsonHas(file, options.container),
				canInstall: true,
				configPath: file,
				snippet: JSON.stringify(
					{ [options.container]: { [SERVER_NAME]: options.entry(target) } },
					null,
					2,
				),
			};
		},
		async install(target) {
			mergeJsonServer(options.file(target), options.container, options.entry(target));
		},
	};
}

const VSCODE_APP = "/Applications/Visual Studio Code.app";

export const CLIENTS: ClientDefinition[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		describe(target) {
			const file = path.join(homeOf(target), ".claude.json");
			return {
				detected: hasBinary("claude"),
				connected: jsonHas(file, "mcpServers"),
				canInstall: hasBinary("claude"),
				configPath: file,
				snippet: `claude mcp add --transport http --scope user ${SERVER_NAME} ${target.url}`,
			};
		},
		install: (target) =>
			run("claude", [
				"mcp",
				"add",
				"--transport",
				"http",
				"--scope",
				"user",
				SERVER_NAME,
				target.url,
			]),
	},
	{
		id: "codex",
		label: "Codex",
		describe(target) {
			const file = path.join(homeOf(target), ".codex", "config.toml");
			const toml = existsSync(file) ? readFileSync(file, "utf8") : "";
			return {
				detected: hasBinary("codex"),
				connected: /^\s*\[mcp_servers\.rendr\]/m.test(toml),
				canInstall: hasBinary("codex"),
				configPath: file,
				snippet: `codex mcp add ${SERVER_NAME} --url ${target.url}`,
			};
		},
		install: (target) => run("codex", ["mcp", "add", SERVER_NAME, "--url", target.url]),
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		describe(target) {
			const file = path.join(homeOf(target), ".gemini", "settings.json");
			return {
				detected: hasBinary("gemini"),
				connected: jsonHas(file, "mcpServers"),
				canInstall: hasBinary("gemini"),
				configPath: file,
				snippet: `gemini mcp add --scope user --transport http --trust ${SERVER_NAME} ${target.url}`,
			};
		},
		install: (target) =>
			run("gemini", [
				"mcp",
				"add",
				"--scope",
				"user",
				"--transport",
				"http",
				"--trust",
				SERVER_NAME,
				target.url,
			]),
	},
	jsonClient({
		id: "opencode",
		label: "OpenCode",
		file: (target) => path.join(homeOf(target), ".config", "opencode", "opencode.json"),
		container: "mcp",
		entry: (target) => ({ type: "remote", url: target.url, enabled: true }),
		detect: (target) =>
			hasBinary("opencode") || existsSync(path.join(homeOf(target), ".config", "opencode")),
	}),
	jsonClient({
		id: "cursor",
		label: "Cursor",
		file: (target) => path.join(homeOf(target), ".cursor", "mcp.json"),
		container: "mcpServers",
		entry: (target) => ({ url: target.url }),
		detect: (target) =>
			existsSync(path.join(homeOf(target), ".cursor")) ||
			existsSync("/Applications/Cursor.app"),
	}),
	jsonClient({
		id: "vscode",
		label: "VS Code (Copilot)",
		file: (target) => path.join(appData(target), "Code", "User", "mcp.json"),
		container: "servers",
		entry: (target) => ({ type: "http", url: target.url }),
		detect: (target) =>
			existsSync(path.join(appData(target), "Code")) || existsSync(VSCODE_APP),
	}),
	jsonClient({
		id: "windsurf",
		label: "Windsurf",
		file: (target) => path.join(homeOf(target), ".codeium", "windsurf", "mcp_config.json"),
		container: "mcpServers",
		entry: (target) => ({ serverUrl: target.url }),
		detect: (target) =>
			existsSync(path.join(homeOf(target), ".codeium", "windsurf")) ||
			existsSync("/Applications/Windsurf.app"),
	}),
	jsonClient({
		id: "claude-desktop",
		label: "Claude Desktop",
		// Claude Desktop launches stdio servers only from its config, so it gets
		// the bridge — run by Rendr's own binary, so Node needn't be installed.
		file: (target) => path.join(appData(target), "Claude", "claude_desktop_config.json"),
		container: "mcpServers",
		entry: (target) => ({
			command: target.stdio.command,
			args: target.stdio.args,
			env: target.stdio.env,
		}),
		detect: (target) => existsSync(path.join(appData(target), "Claude")),
		note: "Restart Claude Desktop after connecting.",
	}),
	jsonClient({
		id: "lmstudio",
		label: "LM Studio",
		file: (target) => path.join(homeOf(target), ".lmstudio", "mcp.json"),
		container: "mcpServers",
		entry: (target) => ({ url: target.url }),
		detect: (target) =>
			existsSync(path.join(homeOf(target), ".lmstudio")) ||
			existsSync("/Applications/LM Studio.app"),
	}),
	{
		id: "zed",
		label: "Zed",
		note: "Zed's settings allow comments, so paste this into settings.json yourself.",
		describe(target) {
			return {
				detected:
					existsSync("/Applications/Zed.app") ||
					existsSync(path.join(homeOf(target), ".config", "zed")),
				connected: false,
				canInstall: false,
				configPath: path.join(homeOf(target), ".config", "zed", "settings.json"),
				snippet: JSON.stringify(
					{ context_servers: { [SERVER_NAME]: { url: target.url } } },
					null,
					2,
				),
			};
		},
	},
	{
		id: "stdio",
		label: "Any stdio MCP client",
		note: "For clients that launch servers as commands (Goose, Cline, Continue, custom agents).",
		describe(target) {
			const env = Object.entries(target.stdio.env)
				.map(([key, value]) => `${key}=${value}`)
				.join(" ");
			return {
				detected: true,
				connected: false,
				canInstall: false,
				snippet:
					`${env} ${[target.stdio.command, ...target.stdio.args].map(shellQuote).join(" ")}`.trim(),
			};
		},
	},
];

export function listClients(target: ConnectTarget): ClientInfo[] {
	return CLIENTS.map((client) => ({
		id: client.id,
		label: client.label,
		note: client.note,
		...client.describe(target),
	}));
}

export async function installClient(id: string, target: ConnectTarget): Promise<ClientInfo> {
	const client = CLIENTS.find((entry) => entry.id === id);
	if (!client) throw new Error(`Unknown client: ${id}`);
	if (!client.install)
		throw new Error(`${client.label} has to be connected by hand — copy the snippet.`);
	await client.install(target);
	return { id: client.id, label: client.label, note: client.note, ...client.describe(target) };
}
