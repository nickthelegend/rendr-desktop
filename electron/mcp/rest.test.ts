import { afterEach, describe, expect, it } from "vitest";

import { McpHttpServer, splitPathToken, type ToolCallResult } from "./httpServer";
import { formatTools, openApiDocument } from "./rest";
import { MCP_TOOLS } from "./toolDefinitions";

// The same tools, served to everything that isn't an MCP client — and the
// token gate that protects the remote listener. Port 0 keeps every run off
// the real Rendr's ports.
let server: McpHttpServer | null = null;
let ORIGIN = "";

afterEach(async () => {
	await server?.stop();
	server = null;
});

type Dispatch = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

const echo: Dispatch = async (name, args) => ({
	content: [{ type: "text", text: JSON.stringify({ name, args }) }],
});

async function start(dispatch: Dispatch = echo, token: string | null = null) {
	server = new McpHttpServer(dispatch, 0, { token: () => token });
	await server.start();
	ORIGIN = `http://127.0.0.1:${server.port}`;
	return server;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("REST surface", () => {
	it("lists tools in every function-calling dialect", async () => {
		await start();
		const openai = await (await fetch(`${ORIGIN}/v1/tools?format=openai`)).json();
		expect(openai).toHaveLength(MCP_TOOLS.length);
		expect(openai[0]).toMatchObject({
			type: "function",
			function: { name: MCP_TOOLS[0].name },
		});

		const anthropic = await (await fetch(`${ORIGIN}/v1/tools?format=anthropic`)).json();
		expect(anthropic[0]).toHaveProperty("input_schema");

		const gemini = await (await fetch(`${ORIGIN}/v1/tools?format=gemini`)).json();
		expect(gemini[0].functionDeclarations).toHaveLength(MCP_TOOLS.length);

		const bad = await fetch(`${ORIGIN}/v1/tools?format=nope`);
		expect(bad.status).toBe(400);
	});

	it("strips schema keywords Gemini rejects, at every depth", () => {
		const [{ functionDeclarations }] = formatTools("gemini") as Array<{
			functionDeclarations: unknown[];
		}>;
		expect(JSON.stringify(functionDeclarations)).not.toMatch(
			/"additionalProperties"|"\$schema"|"oneOf"/,
		);
	});

	it("calls a tool through /v1/call and /v1/tools/<name> with the same dispatcher", async () => {
		const seen: string[] = [];
		await start(async (name, args) => {
			seen.push(`${name}:${JSON.stringify(args)}`);
			return { content: [{ type: "text", text: "done" }] };
		});

		const generic = await (
			await post("/v1/call", { name: "undo", arguments: { steps: 2 } })
		).json();
		expect(generic.content[0].text).toBe("done");
		const direct = await post("/v1/tools/get_timeline", {});
		expect(direct.status).toBe(200);
		expect(seen).toEqual(['undo:{"steps":2}', "get_timeline:{}"]);
	});

	it("rejects an unknown tool and a body that isn't JSON, without reaching the editor", async () => {
		let reached = false;
		await start(async () => {
			reached = true;
			return { content: [] };
		});
		expect((await post("/v1/call", { name: "rm_rf" })).status).toBe(404);
		expect((await post("/v1/call", "{nope")).status).toBe(400);
		expect((await post("/v1/call", { name: "undo", arguments: [1] })).status).toBe(400);
		expect(reached).toBe(false);
	});

	it("reports a tool that throws as a readable error result", async () => {
		await start(async () => {
			throw new Error("no project open");
		});
		const body = await (await post("/v1/call", { name: "undo" })).json();
		expect(body).toEqual({
			content: [{ type: "text", text: "no project open" }],
			isError: true,
		});
	});

	it("serves a compact OpenAPI document a custom GPT accepts, and a full one", async () => {
		await start();
		const compact = await (await fetch(`${ORIGIN}/openapi.json`)).json();
		// Custom GPTs cap Actions at 30 operations.
		expect(Object.keys(compact.paths).length).toBeLessThanOrEqual(30);
		expect(compact.servers[0].url).toBe(ORIGIN);
		const full = openApiDocument("http://x", true) as { paths: Record<string, unknown> };
		expect(Object.keys(full.paths).length).toBe(MCP_TOOLS.length + 3);
	});

	it("serves the agent manual as llms.txt", async () => {
		await start();
		const text = await (await fetch(`${ORIGIN}/llms.txt`)).text();
		expect(text).toContain("/v1/call");
		expect(text).toContain("get_timeline");
	});
});

describe("token gate (remote access)", () => {
	const TOKEN = "s3cret-token-value-0123456789";

	it("refuses every route without the token", async () => {
		await start(echo, TOKEN);
		expect((await fetch(`${ORIGIN}/v1/health`)).status).toBe(401);
		expect((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(
			401,
		);
		expect(
			(await fetch(`${ORIGIN}/v1/health`, { headers: { Authorization: "Bearer wrong" } }))
				.status,
		).toBe(401);
	});

	it("accepts a bearer token, the x-rendr-token header, or the token in the path", async () => {
		await start(echo, TOKEN);
		expect(
			(await fetch(`${ORIGIN}/v1/health`, { headers: { Authorization: `Bearer ${TOKEN}` } }))
				.status,
		).toBe(200);
		expect(
			(await fetch(`${ORIGIN}/v1/health`, { headers: { "x-rendr-token": TOKEN } })).status,
		).toBe(200);
		expect((await fetch(`${ORIGIN}/t/${TOKEN}/v1/health`)).status).toBe(200);

		const init = await post(`/t/${TOKEN}/mcp`, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {},
		});
		expect(init.status).toBe(200);
		expect(init.headers.get("mcp-session-id")).toBeTruthy();
	});

	it("advertises no OAuth metadata, so clients don't go looking for an authorization server", async () => {
		await start(echo, TOKEN);
		const response = await fetch(`${ORIGIN}/t/${TOKEN}/.well-known/oauth-protected-resource`);
		expect(response.status).toBe(404);
	});

	it("doesn't apply the loopback-origin rule, since the token is the gate", async () => {
		await start(echo, TOKEN);
		const response = await fetch(`${ORIGIN}/t/${TOKEN}/v1/health`, {
			headers: { Origin: "https://claude.ai" },
		});
		expect(response.status).toBe(200);
	});

	it("still rejects cross-origin browsers on the tokenless local server", async () => {
		await start();
		const response = await fetch(`${ORIGIN}/v1/health`, {
			headers: { Origin: "https://evil.example" },
		});
		expect(response.status).toBe(403);
	});

	it("splits a token prefix off a path", () => {
		expect(splitPathToken("/t/abc/mcp")).toEqual({ pathname: "/mcp", pathToken: "abc" });
		expect(splitPathToken("/t/abc")).toEqual({ pathname: "/", pathToken: "abc" });
		expect(splitPathToken("/mcp")).toEqual({ pathname: "/mcp", pathToken: null });
	});
});
