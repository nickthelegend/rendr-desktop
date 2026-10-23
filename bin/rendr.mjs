#!/usr/bin/env node
// rendr — drive a running Rendr from any shell, script, or agent that has one.
//
//   rendr status                     Is Rendr running, and how many tools does it have?
//   rendr tools [--format F]         List tools (names), or full schemas as mcp|openai|anthropic|gemini
//   rendr call <tool> [json|-]       Call a tool; arguments as JSON, or "-" to read them from stdin
//   rendr instructions               The manual Rendr gives every agent (llms.txt)
//   rendr openapi [--full]           The OpenAPI document
//   rendr mcp                        Speak MCP over stdio (for clients that launch servers as commands)
//
// RENDR_URL picks the Rendr to talk to (default http://127.0.0.1:19790; a remote-access
// base such as https://x.trycloudflare.com/t/<token> works too). RENDR_TOKEN is sent as a
// bearer token when set. Exit codes: 0 ok, 1 the tool reported an error, 2 usage, 3 unreachable.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.RENDR_URL || "http://127.0.0.1:19790")
	.replace(/\/+$/, "")
	.replace(/\/mcp$/, "");
const TOKEN = process.env.RENDR_TOKEN || "";

function usage(code = 2) {
	const text = `usage: rendr <status|tools|call|instructions|openapi|mcp> …

  rendr status
  rendr tools [--format mcp|openai|openai-responses|anthropic|gemini]
  rendr call <tool> ['{"json":"args"}' | -] [--json]
  rendr instructions
  rendr openapi [--full]
  rendr mcp

env: RENDR_URL (default http://127.0.0.1:19790), RENDR_TOKEN`;
	(code === 0 ? console.log : console.error)(text);
	process.exit(code);
}

async function request(pathname, init = {}) {
	const headers = { ...(init.headers || {}) };
	if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
	try {
		return await fetch(`${BASE}${pathname}`, { ...init, headers });
	} catch (error) {
		console.error(
			`rendr: can't reach Rendr at ${BASE} (${error.cause?.code || error.message}). Is the app open?`,
		);
		process.exit(3);
	}
}

/** A response body as JSON, or a clear message when the server sent something else. */
async function json(response) {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		console.error(
			`rendr: ${response.status} ${response.statusText} from ${BASE}${response.status === 401 ? " — set RENDR_TOKEN" : ""}${response.status === 404 ? " — is this an older Rendr without REST?" : ""}`,
		);
		process.exit(3);
	}
}

async function readStdin() {
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

function flag(args, name) {
	const index = args.indexOf(name);
	if (index < 0) return null;
	const value = args[index + 1];
	args.splice(index, 2);
	return value ?? "";
}

async function main() {
	const args = process.argv.slice(2);
	const command = args.shift();
	if (!command || command === "-h" || command === "--help" || command === "help") usage(0);

	if (command === "mcp") {
		// The same bridge Claude Desktop uses, pointed at RENDR_URL.
		process.env.RENDR_MCP_URL ||= `${BASE}/mcp`;
		const here = path.dirname(fileURLToPath(import.meta.url));
		const bridge = [
			path.join(here, "mcp-bridge.cjs"),
			path.join(here, "..", "mcpb", "server", "index.cjs"),
		].find(existsSync);
		if (!bridge) {
			console.error("rendr: the MCP bridge script is missing from this install.");
			process.exit(3);
		}
		createRequire(import.meta.url)(bridge);
		return;
	}

	if (command === "status") {
		const response = await request("/v1/health");
		if (!response.ok) {
			console.error(
				`rendr: ${response.status} ${response.statusText}${response.status === 401 ? " — set RENDR_TOKEN" : ""}`,
			);
			process.exit(3);
		}
		const health = await json(response);
		// The token can be part of the URL; never echo it back into a terminal log.
		console.log(
			`Rendr is running at ${BASE.replace(/\/t\/[^/]+/, "/t/…")} with ${health.tools} tools.`,
		);
		return;
	}

	if (command === "tools") {
		const format = flag(args, "--format");
		const response = await request(`/v1/tools?format=${encodeURIComponent(format || "mcp")}`);
		const body = await json(response);
		if (!response.ok) {
			console.error(`rendr: ${body.error || response.status}`);
			process.exit(2);
		}
		if (format) {
			console.log(JSON.stringify(body, null, 2));
			return;
		}
		for (const tool of body.tools)
			console.log(`${tool.name.padEnd(28)} ${tool.description.split(/(?<=\.)\s/)[0]}`);
		return;
	}

	if (command === "call") {
		const raw = args.includes("--json");
		const rest = args.filter((arg) => arg !== "--json");
		const name = rest[0];
		if (!name) usage();
		let input = rest[1] ?? "{}";
		if (input === "-") input = await readStdin();
		let parsed;
		try {
			parsed = input.trim() ? JSON.parse(input) : {};
		} catch {
			console.error("rendr: arguments must be a JSON object");
			process.exit(2);
		}
		const response = await request("/v1/call", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, arguments: parsed }),
		});
		const result = await json(response);
		if (!response.ok) {
			console.error(`rendr: ${result.error || response.status}`);
			process.exit(2);
		}
		if (raw) console.log(JSON.stringify(result, null, 2));
		else {
			for (const block of result.content ?? []) {
				console.log(
					block.type === "text"
						? block.text
						: `[${block.type} ${block.mimeType ?? ""}, ${block.data?.length ?? 0} base64 chars — use --json to get it]`,
				);
			}
		}
		process.exit(result.isError ? 1 : 0);
	}

	if (command === "instructions") {
		const response = await request("/llms.txt");
		console.log(await response.text());
		return;
	}

	if (command === "openapi") {
		const response = await request(
			args.includes("--full") ? "/openapi.full.json" : "/openapi.json",
		);
		console.log(JSON.stringify(await json(response), null, 2));
		return;
	}

	usage();
}

main();
