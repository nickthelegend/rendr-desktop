// Where Rendr's own connector scripts live, in development and when packaged.
//
// Both are plain Node scripts. They run under Rendr's own binary with
// ELECTRON_RUN_AS_NODE=1, so a machine without Node installed can still use them.

import { existsSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

function firstExisting(candidates: string[]): string {
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** The stdio→HTTP MCP bridge (mcpb/server/index.cjs). */
export function bridgeScriptPath(): string {
	return firstExisting([
		path.join(process.resourcesPath ?? "", "connect", "mcp-bridge.cjs"),
		path.join(app.getAppPath(), "mcpb", "server", "index.cjs"),
	]);
}

/** The `rendr` command-line client (bin/rendr.mjs). */
export function cliScriptPath(): string {
	return firstExisting([
		path.join(process.resourcesPath ?? "", "connect", "rendr.mjs"),
		path.join(app.getAppPath(), "bin", "rendr.mjs"),
	]);
}

/** How to launch a connector script with nothing but Rendr installed. */
export function nodeCommand(script: string): {
	command: string;
	args: string[];
	env: Record<string, string>;
} {
	return { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}
