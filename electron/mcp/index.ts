// MCP server lifecycle. Started with the app, stopped on quit.

import { type AgentWindows, callEditor, initAgentBridge, shutdownAgentBridge } from "./bridge";
import { MCP_PATH, MCP_PORT, McpHttpServer, type ToolCallResult } from "./httpServer";
import { TOOLS_BY_NAME } from "./toolDefinitions";

let server: McpHttpServer | null = null;
/** Other listeners serving the same tools — remote access, for one. */
const attached = new Set<McpHttpServer>();

/**
 * Every tool is forwarded to the renderer, which owns project state, the timeline,
 * and the recording state machine. Unknown names are rejected here so a typo never
 * reaches the editor. Local MCP, remote access, REST and the in-app API agent all
 * call through this one function.
 */
export async function dispatchTool(
	name: string,
	args: Record<string, unknown>,
): Promise<ToolCallResult> {
	if (!TOOLS_BY_NAME.has(name)) {
		throw new Error(`Unknown tool: ${name}`);
	}
	return callEditor(name, args);
}

export async function startMcpServer(windows: AgentWindows): Promise<void> {
	if (server) return;
	initAgentBridge(windows);
	const instance = new McpHttpServer(dispatchTool);
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

/** Registers another listener so tool-list changes reach its clients too. */
export function attachMcpServer(instance: McpHttpServer): void {
	attached.add(instance);
}

export function detachMcpServer(instance: McpHttpServer): void {
	attached.delete(instance);
}

/** Call when the tool inventory changes (e.g. a recording starts and edits become unavailable). */
export function notifyToolListChanged(): void {
	server?.notifyToolListChanged();
	for (const instance of attached) instance.notifyToolListChanged();
}

export { MCP_PATH, MCP_PORT };
