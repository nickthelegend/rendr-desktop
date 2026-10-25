// Rendr's tools for everything that isn't an MCP client.
//
// MCP is the native surface, but plenty of agents never speak it: a custom GPT
// takes an OpenAPI spec, LangChain / LlamaIndex / the Vercel AI SDK take a list
// of function schemas, n8n and Zapier make HTTP calls, and a shell script has
// curl. The same tool definitions are served here in each of those shapes, and
// a call made over REST goes through exactly the dispatcher an MCP call does.

import type http from "node:http";

import { FULL_INSTRUCTIONS } from "./agentInstructions";
import type { ToolCallResult, ToolDispatcher } from "./httpServer";
import { getPrompt, listPrompts } from "./recipes";
import { type AgentTool, MCP_TOOLS, TOOLS_BY_NAME } from "./toolDefinitions";

export type ToolFormat = "mcp" | "openai" | "openai-responses" | "anthropic" | "gemini";

export const TOOL_FORMATS: ToolFormat[] = [
	"mcp",
	"openai",
	"openai-responses",
	"anthropic",
	"gemini",
];

/** Gemini's function declarations take an OpenAPI subset; these keywords are outside it. */
const GEMINI_UNSUPPORTED = new Set([
	"additionalProperties",
	"$schema",
	"examples",
	"default",
	"const",
	"oneOf",
	"allOf",
	"not",
]);

function geminiSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(geminiSchema);
	if (!schema || typeof schema !== "object") return schema;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
		if (GEMINI_UNSUPPORTED.has(key)) continue;
		if (key === "properties" && value && typeof value === "object") {
			out.properties = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([name, child]) => [
					name,
					geminiSchema(child),
				]),
			);
			continue;
		}
		out[key] = geminiSchema(value);
	}
	return out;
}

export function formatTools(format: ToolFormat, tools: AgentTool[] = MCP_TOOLS): unknown {
	switch (format) {
		case "openai":
			return tools.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.inputSchema,
				},
			}));
		case "openai-responses":
			return tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
			}));
		case "anthropic":
			return tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.inputSchema,
			}));
		case "gemini":
			return [
				{
					functionDeclarations: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: geminiSchema(tool.inputSchema),
					})),
				},
			];
		default:
			return {
				tools: tools.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			};
	}
}

/**
 * An OpenAPI 3.1 document. `full` gives every tool its own operation, which is
 * what code generators want; the default is three generic operations, because
 * a custom GPT accepts at most 30 and Rendr has over a hundred tools.
 */
export function openApiDocument(baseUrl: string, full = false): Record<string, unknown> {
	const resultSchema = {
		type: "object",
		properties: {
			content: {
				type: "array",
				items: {
					type: "object",
					properties: {
						type: { type: "string" },
						text: { type: "string" },
						data: { type: "string" },
						mimeType: { type: "string" },
					},
				},
			},
			isError: { type: "boolean" },
		},
	};
	const security = [{ bearer: [] }];
	const paths: Record<string, unknown> = {
		"/v1/tools": {
			get: {
				operationId: "listTools",
				summary: "List every Rendr tool with its JSON Schema",
				parameters: [
					{
						name: "format",
						in: "query",
						required: false,
						schema: { type: "string", enum: TOOL_FORMATS },
						description:
							"Shape of the list: mcp (default), openai, openai-responses, anthropic or gemini",
					},
				],
				responses: { "200": { description: "The tool list" } },
				security,
			},
		},
		"/v1/call": {
			post: {
				operationId: "callTool",
				summary: "Call one Rendr tool by name",
				description:
					"Runs a Rendr tool against the open project. Call listTools first for names and argument schemas. Start every session with get_timeline.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["name"],
								properties: {
									name: {
										type: "string",
										description: "Tool name, e.g. get_timeline",
									},
									arguments: {
										type: "object",
										description: "Arguments matching the tool's input schema",
										additionalProperties: true,
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "The tool's result",
						content: { "application/json": { schema: resultSchema } },
					},
				},
				security,
			},
		},
		"/llms.txt": {
			get: {
				operationId: "getInstructions",
				summary: "How to drive Rendr: the same manual MCP clients receive",
				responses: { "200": { description: "Plain-text instructions" } },
				security,
			},
		},
	};
	if (full) {
		for (const tool of MCP_TOOLS) {
			paths[`/v1/tools/${tool.name}`] = {
				post: {
					operationId: tool.name,
					summary: tool.description.split(/(?<=\.)\s/)[0].slice(0, 300),
					description: tool.description,
					requestBody: {
						required: false,
						content: { "application/json": { schema: tool.inputSchema } },
					},
					responses: {
						"200": {
							description: "The tool's result",
							content: { "application/json": { schema: resultSchema } },
						},
					},
					security,
				},
			};
		}
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Rendr",
			version: "0.1.0",
			description:
				"Record and edit screen video in Rendr. Every tool the Rendr MCP server exposes, over plain HTTP.",
		},
		servers: [{ url: baseUrl }],
		components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
		paths,
	};
}

export function llmsText(baseUrl: string): string {
	return `# Rendr

> Rendr records and edits screen video. This endpoint exposes its whole editor to agents.

## Connect
- MCP (streamable HTTP): ${baseUrl}/mcp
- REST: POST ${baseUrl}/v1/call with {"name": "<tool>", "arguments": {...}}
- Tool schemas: GET ${baseUrl}/v1/tools?format=openai|anthropic|gemini|mcp
- OpenAPI: ${baseUrl}/openapi.json (3 operations) or ${baseUrl}/openapi.full.json (one per tool)

## Recipes
Proven plans for common creator edits (also MCP prompts / slash commands). GET ${baseUrl}/v1/recipes/<name>?media=…
${listPrompts()
	.map((recipe) => `- ${recipe.name}: ${recipe.description}`)
	.join("\n")}

## Tools (${MCP_TOOLS.length})
${MCP_TOOLS.map((tool) => `- ${tool.name}: ${tool.description.split(/(?<=\.)\s/)[0]}`).join("\n")}

## Manual
${FULL_INSTRUCTIONS}
`;
}

function send(
	res: http.ServerResponse,
	status: number,
	body: unknown,
	type = "application/json",
): void {
	if (res.headersSent) return;
	const text =
		typeof body === "string"
			? body
			: JSON.stringify(body, null, type === "application/json" ? 0 : 2);
	res.writeHead(status, {
		"Content-Type": `${type}; charset=utf-8`,
		"Content-Length": Buffer.byteLength(text),
	});
	res.end(text);
}

export interface RestContext {
	dispatch: ToolDispatcher;
	readBody: () => Promise<string>;
	/** The URL clients should use to reach this server, for documents that name it. */
	baseUrl: string;
}

/** Handles a REST route. Returns false when the path isn't one, so MCP can take it. */
export async function handleRest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	pathname: string,
	query: URLSearchParams,
	context: RestContext,
): Promise<boolean> {
	if (req.method === "GET" && pathname === "/v1/health") {
		send(res, 200, { ok: true, name: "rendr", tools: MCP_TOOLS.length });
		return true;
	}
	if (req.method === "GET" && pathname === "/v1/tools") {
		const requested = (query.get("format") ?? "mcp") as ToolFormat;
		if (!TOOL_FORMATS.includes(requested)) {
			send(res, 400, { error: `format must be one of ${TOOL_FORMATS.join(", ")}` });
			return true;
		}
		send(res, 200, formatTools(requested));
		return true;
	}
	if (
		req.method === "GET" &&
		(pathname === "/openapi.json" || pathname === "/openapi.full.json")
	) {
		send(res, 200, openApiDocument(context.baseUrl, pathname === "/openapi.full.json"));
		return true;
	}
	if (req.method === "GET" && pathname === "/v1/recipes") {
		send(res, 200, { recipes: listPrompts() });
		return true;
	}
	const recipe = pathname.match(/^\/v1\/recipes\/([A-Za-z0-9_-]+)$/);
	if (req.method === "GET" && recipe) {
		const prompt = getPrompt(recipe[1], Object.fromEntries(query.entries()));
		if (!prompt)
			send(res, 404, { error: `Unknown recipe: ${recipe[1]}. GET /v1/recipes lists them.` });
		else send(res, 200, { name: recipe[1], plan: prompt.messages[0].content.text });
		return true;
	}
	if (req.method === "GET" && pathname === "/llms.txt") {
		send(res, 200, llmsText(context.baseUrl), "text/plain");
		return true;
	}

	const single = pathname.match(/^\/v1\/tools\/([A-Za-z0-9_-]+)$/);
	if (req.method === "POST" && (pathname === "/v1/call" || single)) {
		let payload: Record<string, unknown> = {};
		try {
			const body = await context.readBody();
			payload = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {};
		} catch {
			send(res, 400, { error: "Body must be JSON" });
			return true;
		}
		const name = single ? single[1] : payload.name;
		const args = (single ? payload : payload.arguments) ?? {};
		if (typeof name !== "string" || !TOOLS_BY_NAME.has(name)) {
			send(res, 404, { error: `Unknown tool: ${String(name)}. GET /v1/tools lists them.` });
			return true;
		}
		if (typeof args !== "object" || Array.isArray(args)) {
			send(res, 400, { error: "arguments must be a JSON object" });
			return true;
		}
		let result: ToolCallResult;
		try {
			result = await context.dispatch(name, args as Record<string, unknown>);
		} catch (error) {
			// Same contract as MCP: a failed tool is a readable result, not a transport error.
			result = {
				content: [
					{ type: "text", text: error instanceof Error ? error.message : String(error) },
				],
				isError: true,
			};
		}
		send(res, 200, result);
		return true;
	}
	return false;
}
