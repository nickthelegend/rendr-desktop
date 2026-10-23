// Remote access: Rendr as a connector for agents that don't run on this machine.
//
// claude.ai, ChatGPT, and agents in the cloud can't reach 127.0.0.1. Turning
// this on starts a second listener — token-protected, unlike the local one —
// and, when cloudflared is installed, a Cloudflare quick tunnel to it. The
// result is one URL with the token in its path, which is the form every
// "add a custom connector" box accepts. People with their own tunnel (ngrok,
// Tailscale Funnel, a reverse proxy) point it at the same port instead.
//
// Off by default and off again on every launch: an always-on public endpoint
// to someone's screen recorder should be a decision made each time.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

import { agentEnv, hasBinary, resolveBinary } from "../agents/binaries";
import { McpHttpServer } from "../mcp/httpServer";
import { attachMcpServer, detachMcpServer, dispatchTool } from "../mcp/index";

export const REMOTE_PORT = 19791;

export type RemoteStatus = "off" | "starting" | "on" | "error";

export interface RemoteState {
	status: RemoteStatus;
	/** cloudflared, or "manual" when the user brings their own tunnel. */
	mode: "cloudflared" | "manual";
	/** Public origin the tunnel gave us (or the user typed), without the token. */
	publicOrigin: string | null;
	/** The full connector URL — origin + token path + /mcp. Null until on. */
	connectorUrl: string | null;
	/** Base for REST and OpenAPI over the same tunnel. */
	restBase: string | null;
	token: string;
	localPort: number;
	cloudflaredInstalled: boolean;
	error: string | null;
}

interface Stored {
	token: string;
	manualOrigin?: string;
}

function storeFile(): string {
	return path.join(app.getPath("userData"), "connect.json");
}

function newToken(): string {
	return crypto.randomBytes(24).toString("base64url");
}

function readStore(): Stored {
	try {
		if (existsSync(storeFile())) {
			const parsed = JSON.parse(readFileSync(storeFile(), "utf8")) as Partial<Stored>;
			if (typeof parsed.token === "string" && parsed.token.length >= 24)
				return parsed as Stored;
		}
	} catch {
		// fall through to a fresh token
	}
	const fresh = { token: newToken() };
	writeStore(fresh);
	return fresh;
}

function writeStore(value: Stored): void {
	writeFileSync(storeFile(), JSON.stringify(value, null, 2), { mode: 0o600 });
}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class RemoteAccess {
	private server: McpHttpServer | null = null;
	private tunnel: ChildProcessWithoutNullStreams | null = null;
	private store: Stored;
	private state: Omit<
		RemoteState,
		"token" | "connectorUrl" | "restBase" | "localPort" | "cloudflaredInstalled"
	>;

	constructor(private readonly onChange: (state: RemoteState) => void) {
		this.store = readStore();
		this.state = { status: "off", mode: "cloudflared", publicOrigin: null, error: null };
	}

	snapshot(): RemoteState {
		const base = this.state.publicOrigin
			? `${this.state.publicOrigin.replace(/\/+$/, "")}/t/${this.store.token}`
			: null;
		return {
			...this.state,
			token: this.store.token,
			connectorUrl: this.state.status === "on" && base ? `${base}/mcp` : null,
			restBase: this.state.status === "on" ? base : null,
			localPort: REMOTE_PORT,
			cloudflaredInstalled: hasBinary("cloudflared"),
		};
	}

	private set(patch: Partial<RemoteAccess["state"]>): void {
		this.state = { ...this.state, ...patch };
		this.onChange(this.snapshot());
	}

	private async ensureServer(): Promise<void> {
		if (this.server) return;
		const server = new McpHttpServer(dispatchTool, REMOTE_PORT, {
			token: () => this.store.token,
			publicUrl: () => this.snapshot().restBase,
		});
		await server.start();
		attachMcpServer(server);
		this.server = server;
	}

	/** Starts remote access through a cloudflared quick tunnel. */
	async startTunnel(): Promise<RemoteState> {
		await this.stop();
		this.set({ status: "starting", mode: "cloudflared", publicOrigin: null, error: null });
		if (!hasBinary("cloudflared")) {
			this.set({
				status: "error",
				error: "cloudflared isn't installed. Install it (brew install cloudflared), or use your own tunnel to port 19791.",
			});
			return this.snapshot();
		}
		try {
			await this.ensureServer();
		} catch (error) {
			this.set({
				status: "error",
				error: `Couldn't open port ${REMOTE_PORT}: ${String(error)}`,
			});
			return this.snapshot();
		}

		const child = spawn(
			resolveBinary("cloudflared"),
			["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${REMOTE_PORT}`],
			{ env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] },
		);
		this.tunnel = child;
		let log = "";
		const timer = setTimeout(() => {
			if (this.tunnel === child && this.state.status === "starting") {
				this.set({
					status: "error",
					error: "cloudflared didn't hand out a URL within 45 seconds.",
				});
				child.kill();
			}
		}, 45_000);
		const watch = (chunk: Buffer) => {
			log = (log + chunk.toString("utf8")).slice(-8000);
			const match = log.match(QUICK_TUNNEL_URL);
			if (match && this.state.status === "starting" && this.tunnel === child) {
				clearTimeout(timer);
				this.set({ status: "on", publicOrigin: match[0] });
			}
		};
		// cloudflared logs to stderr; watch both in case that ever changes.
		child.stdout.on("data", watch);
		child.stderr.on("data", watch);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (this.tunnel !== child) return;
			this.tunnel = null;
			if (this.state.status !== "off") {
				const last = log.trim().split("\n").filter(Boolean).pop() ?? "";
				this.set({
					status: "error",
					publicOrigin: null,
					error: `The tunnel closed (code ${code}). ${last}`.trim(),
				});
			}
		});
		return this.snapshot();
	}

	/** Starts remote access behind a tunnel the user runs themselves. */
	async startManual(origin: string): Promise<RemoteState> {
		await this.stop();
		let parsed: URL;
		try {
			parsed = new URL(origin.trim());
		} catch {
			this.set({
				status: "error",
				mode: "manual",
				error: "That isn't a URL. Paste the https:// address your tunnel gave you.",
			});
			return this.snapshot();
		}
		if (parsed.protocol !== "https:") {
			this.set({
				status: "error",
				mode: "manual",
				error: "Use an https:// URL — the token travels in it.",
			});
			return this.snapshot();
		}
		try {
			await this.ensureServer();
		} catch (error) {
			this.set({
				status: "error",
				mode: "manual",
				error: `Couldn't open port ${REMOTE_PORT}: ${String(error)}`,
			});
			return this.snapshot();
		}
		this.store = { ...this.store, manualOrigin: parsed.origin };
		writeStore(this.store);
		this.set({ status: "on", mode: "manual", publicOrigin: parsed.origin, error: null });
		return this.snapshot();
	}

	async stop(): Promise<RemoteState> {
		const tunnel = this.tunnel;
		this.tunnel = null;
		tunnel?.kill();
		const server = this.server;
		this.server = null;
		if (server) {
			detachMcpServer(server);
			await server.stop();
		}
		this.set({ status: "off", publicOrigin: null, error: null });
		return this.snapshot();
	}

	/**
	 * Issues a new token. Every URL handed out before stops working at once:
	 * the token is checked on each request, so there is nothing to revoke.
	 */
	rotateToken(): RemoteState {
		this.store = { ...this.store, token: newToken() };
		writeStore(this.store);
		this.onChange(this.snapshot());
		return this.snapshot();
	}

	get manualOrigin(): string | null {
		return this.store.manualOrigin ?? null;
	}
}
