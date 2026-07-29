// MCP server lifecycle. Started with the app, stopped on quit.

import { type AgentWindows, callEditor, initAgentBridge, shutdownAgentBridge } from "./bridge";
import { MCP_PATH, MCP_PORT, McpHttpServer, type ToolCallResult } from "./httpServer";
import { TOOLS_BY_NAME } from "./toolDefinitions";

let server: McpHttpServer | null = null;

/**
 * Every tool is forwarded to the renderer, which owns project state, the timeline,
 * and the recording state machine. Unknown names are rejected here so a typo never
 * reaches the editor.
 */
async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
	if (!TOOLS_BY_NAME.has(name)) {
		throw new Error(`Unknown tool: ${name}`);
	}
	return callEditor(name, args);
}

export async function startMcpServer(windows: AgentWindows): Promise<void> {
	if (server) return;
	initAgentBridge(windows);
	const instance = new McpHttpServer(dispatch);
	try {
		await instance.start();
		server = instance;
		console.log(`[rendr-mcp] listening on http://127.0.0.1:${MCP_PORT}${MCP_PATH}`);
	} catch (error) {
		// A busy port must not take the app down — the editor still works without agents.
		console.error("[rendr-mcp] failed to start:", error);
	}
}

export async function stopMcpServer(): Promise<void> {
	shutdownAgentBridge();
	const instance = server;
	server = null;
	await instance?.stop();
}

/** Call when the tool inventory changes (e.g. a recording starts and edits become unavailable). */
export function notifyToolListChanged(): void {
	server?.notifyToolListChanged();
}

export { MCP_PATH, MCP_PORT };
