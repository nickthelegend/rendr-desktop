import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	type ConnectTarget,
	installClient,
	listClients,
	mergeJsonServer,
	UnparseableConfigError,
} from "./clients";

// Setup writes into other apps' config files, so the thing to pin is what it
// must never do: drop the user's other servers, or rewrite a file it can't
// fully read. Every test runs against a throwaway home directory.

function sandbox(): ConnectTarget & { home: string } {
	const home = mkdtempSync(path.join(os.tmpdir(), "rendr-home-"));
	return {
		home,
		platform: "darwin",
		url: "http://127.0.0.1:19790/mcp",
		stdio: {
			command: "/Applications/Rendr.app/Contents/MacOS/Rendr",
			args: ["/x/mcp-bridge.cjs"],
			env: { ELECTRON_RUN_AS_NODE: "1" },
		},
	};
}

describe("mergeJsonServer", () => {
	it("adds rendr and keeps every other key and server", () => {
		const { home } = sandbox();
		const file = path.join(home, "mcp.json");
		writeFileSync(
			file,
			JSON.stringify({ theme: "dark", mcpServers: { github: { url: "https://gh" } } }),
		);

		mergeJsonServer(file, "mcpServers", { url: "http://127.0.0.1:19790/mcp" });

		const written = JSON.parse(readFileSync(file, "utf8"));
		expect(written.theme).toBe("dark");
		expect(written.mcpServers.github).toEqual({ url: "https://gh" });
		expect(written.mcpServers.rendr).toEqual({ url: "http://127.0.0.1:19790/mcp" });
		// The original is kept once, so a bad merge can always be undone.
		expect(
			JSON.parse(readFileSync(`${file}.rendr-backup`, "utf8")).mcpServers.rendr,
		).toBeUndefined();
	});

	it("creates the file and its folder when the app has never had a server", () => {
		const { home } = sandbox();
		const file = path.join(home, "deep", "dir", "mcp.json");
		mergeJsonServer(file, "servers", { type: "http", url: "u" });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			servers: { rendr: { type: "http", url: "u" } },
		});
		expect(existsSync(`${file}.rendr-backup`)).toBe(false);
	});

	it("refuses to rewrite a config with comments rather than lose them", () => {
		const { home } = sandbox();
		const file = path.join(home, "settings.json");
		const original = '{\n  // my servers\n  "mcpServers": {}\n}';
		writeFileSync(file, original);
		expect(() => mergeJsonServer(file, "mcpServers", {})).toThrow(UnparseableConfigError);
		expect(readFileSync(file, "utf8")).toBe(original);
	});
});

describe("client catalog", () => {
	it("offers every major client with a snippet that names Rendr's endpoint", () => {
		const clients = listClients(sandbox());
		const ids = clients.map((client) => client.id);
		for (const id of [
			"claude-code",
			"codex",
			"gemini",
			"opencode",
			"cursor",
			"vscode",
			"windsurf",
			"claude-desktop",
			"lmstudio",
			"zed",
			"stdio",
		]) {
			expect(ids).toContain(id);
		}
		for (const client of clients.filter(
			(entry) => entry.id !== "claude-desktop" && entry.id !== "stdio",
		)) {
			expect(client.snippet).toContain("http://127.0.0.1:19790/mcp");
		}
	});

	it("connects Cursor and then reports it connected", async () => {
		const target = sandbox();
		mkdirSync(path.join(target.home, ".cursor"));
		const before = listClients(target).find((client) => client.id === "cursor");
		expect(before).toMatchObject({ detected: true, connected: false });

		const after = await installClient("cursor", target);

		expect(after.connected).toBe(true);
		const config = JSON.parse(
			readFileSync(path.join(target.home, ".cursor", "mcp.json"), "utf8"),
		);
		expect(config.mcpServers.rendr).toEqual({ url: target.url });
	});

	it("gives Claude Desktop the stdio bridge, run by Rendr's own binary", async () => {
		const target = sandbox();
		await installClient("claude-desktop", target);
		const file = path.join(
			target.home,
			"Library",
			"Application Support",
			"Claude",
			"claude_desktop_config.json",
		);
		expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.rendr).toEqual({
			command: target.stdio.command,
			args: target.stdio.args,
			env: { ELECTRON_RUN_AS_NODE: "1" },
		});
	});

	it("writes OpenCode's remote-server shape", async () => {
		const target = sandbox();
		await installClient("opencode", target);
		const config = JSON.parse(
			readFileSync(path.join(target.home, ".config", "opencode", "opencode.json"), "utf8"),
		);
		expect(config.mcp.rendr).toEqual({ type: "remote", url: target.url, enabled: true });
	});

	it("won't pretend to install a client that has to be set up by hand", async () => {
		await expect(installClient("zed", sandbox())).rejects.toThrow(/by hand/);
		await expect(installClient("nope", sandbox())).rejects.toThrow(/Unknown client/);
	});
});
