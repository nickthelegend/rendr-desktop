import { afterEach, describe, expect, it } from "vitest";

import { McpHttpServer, type ToolCallResult } from "./httpServer";
import { MCP_TOOLS } from "./toolDefinitions";

// Port 0 asks the OS for a free port, so parallel test files and a running
// Rendr can never collide.
let server: McpHttpServer | null = null;
let BASE = "";

afterEach(async () => {
	await server?.stop();
	server = null;
});

async function start(
	dispatch: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<ToolCallResult> = async () => ({
		content: [{ type: "text", text: "{}" }],
	}),
) {
	server = new McpHttpServer(dispatch, 0);
	await server.start();
	BASE = `http://127.0.0.1:${server.port}/mcp`;
	return server;
}

async function rpc(body: unknown, headers: Record<string, string> = {}) {
	const response = await fetch(BASE, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return response;
}

async function initialize(): Promise<string> {
	const response = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
	const sessionId = response.headers.get("mcp-session-id");
	if (!sessionId) throw new Error("initialize returned no session id");
	return sessionId;
}

describe("McpHttpServer", () => {
	it("returns protocol version, tool capability, and instructions on initialize", async () => {
		await start();
		const response = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get("mcp-session-id")).toBeTruthy();
		expect(body.result.protocolVersion).toBe("2025-06-18");
		expect(body.result.capabilities.tools.listChanged).toBe(true);
		expect(body.result.instructions).toContain("Rendr");
	});

	it("lists every declared tool with a schema", async () => {
		await start();
		const session = await initialize();
		const body = await (
			await rpc(
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
				{ "Mcp-Session-Id": session },
			)
		).json();

		expect(body.result.tools).toHaveLength(MCP_TOOLS.length);
		for (const tool of body.result.tools) {
			expect(typeof tool.name).toBe("string");
			expect(tool.description.length).toBeGreaterThan(0);
			expect(tool.inputSchema.type).toBe("object");
		}
	});

	it("routes tools/call to the dispatcher and returns its result", async () => {
		const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
		await start(async (name, args) => {
			seen.push({ name, args });
			return { content: [{ type: "text", text: '{"ok":true}' }] };
		});
		const session = await initialize();

		const body = await (
			await rpc(
				{
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: { name: "get_recording_status", arguments: { a: 1 } },
				},
				{ "Mcp-Session-Id": session },
			)
		).json();

		expect(seen).toEqual([{ name: "get_recording_status", args: { a: 1 } }]);
		expect(body.result.content[0].text).toBe('{"ok":true}');
	});

	it("reports a dispatcher throw as an error result the model can read, not a protocol error", async () => {
		await start(async () => {
			throw new Error("editor is gone");
		});
		const session = await initialize();

		const body = await (
			await rpc(
				{
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: { name: "undo", arguments: {} },
				},
				{ "Mcp-Session-Id": session },
			)
		).json();

		expect(body.error).toBeUndefined();
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toContain("editor is gone");
	});

	it("404s an unknown session so the client re-initializes", async () => {
		await start();
		const response = await rpc(
			{ jsonrpc: "2.0", id: 5, method: "tools/list" },
			{ "Mcp-Session-Id": "not-a-real-session" },
		);
		expect(response.status).toBe(404);
	});

	it("rejects a non-loopback Origin", async () => {
		await start();
		const response = await rpc(
			{ jsonrpc: "2.0", id: 6, method: "initialize", params: {} },
			{ Origin: "https://evil.example" },
		);
		expect(response.status).toBe(403);
	});

	it("rejects an unknown method", async () => {
		await start();
		const session = await initialize();
		const body = await (
			await rpc(
				{ jsonrpc: "2.0", id: 7, method: "resources/list" },
				{ "Mcp-Session-Id": session },
			)
		).json();

		expect(body.error.code).toBe(-32601);
	});

	it("answers a notification with 202 and no body", async () => {
		await start();
		const session = await initialize();
		const response = await rpc(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ "Mcp-Session-Id": session },
		);
		expect(response.status).toBe(202);
	});

	it("drops the session on DELETE", async () => {
		await start();
		const session = await initialize();

		const deleted = await fetch(BASE, {
			method: "DELETE",
			headers: { "Mcp-Session-Id": session },
		});
		expect(deleted.status).toBe(200);

		const after = await rpc(
			{ jsonrpc: "2.0", id: 8, method: "tools/list" },
			{ "Mcp-Session-Id": session },
		);
		expect(after.status).toBe(404);
	});
});

describe("tool definitions", () => {
	it("has unique names", () => {
		const names = MCP_TOOLS.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("marks every required property as a declared property", () => {
		for (const tool of MCP_TOOLS) {
			const required = (tool.inputSchema.required ?? []) as string[];
			const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
			for (const key of required) {
				expect(properties, `${tool.name}.${key}`).toHaveProperty(key);
			}
		}
	});
});
