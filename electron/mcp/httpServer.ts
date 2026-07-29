// Streamable-HTTP MCP transport, reimplemented in Node from Palmier Pro (GPL-3.0),
// Sources/PalmierPro/Agent/MCP/MCPHTTPServer.swift. Session semantics, the 404-on-unknown-
// session contract, idle eviction, and the tools/list_changed announce are carried over.
// See NOTICE.md.

import crypto from "node:crypto";
import http from "node:http";

import { FULL_INSTRUCTIONS } from "./agentInstructions";
import { MCP_TOOLS } from "./toolDefinitions";

export const MCP_PORT = 19790;
export const MCP_PATH = "/mcp";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "rendr";
const SESSION_IDLE_LIMIT_MS = 60 * 60 * 1000;
const SESSION_COUNT_LIMIT = 32;
const SESSION_HEADER = "mcp-session-id";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface ToolCallResult {
	content: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	>;
	isError?: boolean;
}

export type ToolDispatcher = (
	name: string,
	args: Record<string, unknown>,
) => Promise<ToolCallResult>;

interface Session {
	id: string;
	lastUsed: number;
	toolListAnnounced: boolean;
	/** Open GET stream for server-initiated messages, if the client attached one. */
	notifyStream: http.ServerResponse | null;
}

export class McpHttpServer {
	private server: http.Server | null = null;
	private readonly sessions = new Map<string, Session>();
	private readonly dispatch: ToolDispatcher;
	private readonly requestedPort: number;
	/** Sockets held open by keep-alive, so stop() can actually free the port. */
	private readonly sockets = new Set<import("node:net").Socket>();
	/** The port actually bound. Differs from the request when 0 is passed. */
	private boundPort = 0;

	constructor(dispatch: ToolDispatcher, port: number = MCP_PORT) {
		this.dispatch = dispatch;
		this.requestedPort = port;
	}

	get port(): number {
		return this.boundPort || this.requestedPort;
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				this.handle(req, res).catch((error) => {
					writeJson(res, 500, {
						jsonrpc: "2.0",
						id: 0,
						error: { code: -32603, message: describeError(error) },
					});
				});
			});
			server.on("error", reject);
			// Keep-alive sockets outlive close(); tracking them lets stop() free
			// the port instead of leaving it held until the peer gives up.
			server.on("connection", (socket) => {
				this.sockets.add(socket);
				socket.on("close", () => this.sockets.delete(socket));
			});
			// Loopback only: the MCP server must never be reachable from the LAN.
			server.listen(this.requestedPort, "127.0.0.1", () => {
				const address = server.address();
				this.boundPort =
					typeof address === "object" && address ? address.port : this.requestedPort;
				this.server = server;
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		for (const session of this.sessions.values()) session.notifyStream?.end();
		this.sessions.clear();
		const server = this.server;
		this.server = null;
		if (!server) return;
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		// close() stops accepting but waits on live sockets; drop them so the
		// port is genuinely free when this resolves.
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await closed;
	}

	/** Tell attached clients the tool inventory changed (e.g. recording started, edits now refused). */
	notifyToolListChanged(): void {
		for (const session of this.sessions.values()) {
			writeSse(session.notifyStream, {
				jsonrpc: "2.0",
				method: "notifications/tools/list_changed",
			});
		}
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.boundPort}`);

		if (url.pathname === "/.well-known/oauth-protected-resource") {
			writeJson(res, 200, { resource: `http://127.0.0.1:${this.boundPort}` });
			return;
		}
		if (url.pathname !== MCP_PATH && url.pathname !== "/") {
			res.writeHead(404).end();
			return;
		}
		// Reject cross-origin browser callers; a local MCP server is not a web API.
		const origin = req.headers.origin;
		if (typeof origin === "string" && !isLoopbackOrigin(origin)) {
			res.writeHead(403).end();
			return;
		}

		const claimed = headerValue(req, SESSION_HEADER);

		if (req.method === "GET") {
			if (!claimed || !this.sessions.has(claimed)) {
				res.writeHead(404).end();
				return;
			}
			this.attachNotifyStream(claimed, res);
			return;
		}

		if (req.method === "DELETE") {
			if (claimed) this.evict(claimed);
			res.writeHead(200).end();
			return;
		}

		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}

		const body = await readBody(req);
		let message: JsonRpcRequest;
		try {
			message = JSON.parse(body) as JsonRpcRequest;
		} catch {
			writeJson(res, 400, {
				jsonrpc: "2.0",
				id: 0,
				error: { code: -32700, message: "Parse error" },
			});
			return;
		}

		if (message.method === "initialize") {
			const session = this.createSession();
			res.setHeader("Mcp-Session-Id", session.id);
			writeJson(res, 200, this.initializeResult(message));
			return;
		}

		// Unknown/expired session -> 404 per spec; the client re-initializes and refetches tools.
		if (claimed) {
			const session = this.sessions.get(claimed);
			if (!session) {
				res.writeHead(404).end();
				return;
			}
			session.lastUsed = Date.now();
		}

		const response = await this.route(message);
		if (!response) {
			// A notification carries no id and gets no body.
			res.writeHead(202).end();
			return;
		}
		writeJson(res, 200, response);
	}

	private initializeResult(message: JsonRpcRequest): JsonRpcResponse {
		return {
			jsonrpc: "2.0",
			id: message.id ?? 0,
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: SERVER_NAME, version: "0.1.0" },
				instructions: FULL_INSTRUCTIONS,
			},
		};
	}

	private async route(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
		if (message.id === undefined) return null; // notification

		switch (message.method) {
			case "ping":
				return { jsonrpc: "2.0", id: message.id, result: {} };
			case "tools/list":
				return {
					jsonrpc: "2.0",
					id: message.id,
					result: {
						tools: MCP_TOOLS.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					},
				};
			case "tools/call": {
				const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
				if (typeof params.name !== "string") {
					return {
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32602, message: "tools/call requires a string 'name'" },
					};
				}
				const args = (params.arguments ?? {}) as Record<string, unknown>;
				try {
					const result = await this.dispatch(params.name, args);
					return { jsonrpc: "2.0", id: message.id, result };
				} catch (error) {
					// Tool failures are results, not protocol errors: the model must be able to read them.
					return {
						jsonrpc: "2.0",
						id: message.id,
						result: {
							content: [{ type: "text", text: describeError(error) }],
							isError: true,
						},
					};
				}
			}
			default:
				return {
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: `Unknown method: ${message.method}` },
				};
		}
	}

	private createSession(): Session {
		this.pruneIdleSessions();
		const session: Session = {
			id: crypto.randomUUID(),
			lastUsed: Date.now(),
			toolListAnnounced: false,
			notifyStream: null,
		};
		this.sessions.set(session.id, session);
		return session;
	}

	private attachNotifyStream(sessionId: string, res: http.ServerResponse): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			res.writeHead(404).end();
			return;
		}
		session.notifyStream?.end();
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		// Prime the stream so the client's parser sees bytes and stops waiting on headers.
		res.write(": ok\n\n");
		session.notifyStream = res;
		res.on("close", () => {
			if (session.notifyStream === res) session.notifyStream = null;
		});

		// A failed announce retries on the next GET-stream attach.
		if (!session.toolListAnnounced) {
			session.toolListAnnounced = writeSse(res, {
				jsonrpc: "2.0",
				method: "notifications/tools/list_changed",
			});
		}
	}

	// Evicted clients recover transparently: their next request gets 404 and they re-initialize.
	private pruneIdleSessions(): void {
		const cutoff = Date.now() - SESSION_IDLE_LIMIT_MS;
		for (const [id, session] of this.sessions) {
			if (session.lastUsed < cutoff) this.evict(id);
		}
		while (this.sessions.size >= SESSION_COUNT_LIMIT) {
			let oldest: Session | null = null;
			for (const session of this.sessions.values()) {
				if (!oldest || session.lastUsed < oldest.lastUsed) oldest = session;
			}
			if (!oldest) break;
			this.evict(oldest.id);
		}
	}

	private evict(id: string): void {
		const session = this.sessions.get(id);
		if (!session) return;
		session.notifyStream?.end();
		this.sessions.delete(id);
	}
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
	const raw = req.headers[name];
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) return raw[0] ?? null;
	return null;
}

function isLoopbackOrigin(origin: string): boolean {
	try {
		const host = new URL(origin).hostname;
		return host === "127.0.0.1" || host === "localhost" || host === "::1";
	} catch {
		return false;
	}
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 16_777_216) {
				reject(new Error("request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
	if (res.headersSent) return;
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

function writeSse(res: http.ServerResponse | null, payload: unknown): boolean {
	if (!res || res.writableEnded) return false;
	return res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
