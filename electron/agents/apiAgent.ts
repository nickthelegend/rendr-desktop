// Any model with an API key — or none, for a local server — in the agent panel.
//
// Subscription CLIs and ACP agents bring their own agent loop. A bare API does
// not, so this is one: send the conversation with Rendr's tools attached, run
// the tool calls the model asks for in-process, feed the results back, repeat
// until it answers in words. Two wire formats cover nearly every provider:
// OpenAI's chat completions (OpenAI, OpenRouter, Groq, Together, DeepSeek,
// Mistral, xAI, Gemini's compat endpoint, Ollama, LM Studio, vLLM) and
// Anthropic's messages API.

import type { ToolCallResult } from "../mcp/httpServer";
import { MCP_TOOLS } from "../mcp/toolDefinitions";
import { type AgentProvider, type ApiFlavor, type RunContext, summarizeInput } from "./types";

export interface ApiPreset {
	id: string;
	label: string;
	flavor: ApiFlavor;
	baseUrl: string;
	/** A sensible starting model; the user can type any other. */
	model: string;
	needsKey: boolean;
	keyUrl?: string;
}

export const API_PRESETS: ApiPreset[] = [
	{
		id: "openai",
		label: "OpenAI",
		flavor: "openai",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-5-mini",
		needsKey: true,
		keyUrl: "https://platform.openai.com/api-keys",
	},
	{
		id: "anthropic",
		label: "Anthropic",
		flavor: "anthropic",
		baseUrl: "https://api.anthropic.com",
		model: "claude-sonnet-5-5",
		needsKey: true,
		keyUrl: "https://console.anthropic.com/settings/keys",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		flavor: "openai",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "openrouter/free",
		needsKey: true,
		keyUrl: "https://openrouter.ai/keys",
	},
	{
		id: "gemini",
		label: "Google Gemini",
		flavor: "openai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		model: "gemini-3-flash-preview",
		needsKey: true,
		keyUrl: "https://aistudio.google.com/apikey",
	},
	{
		id: "groq",
		label: "Groq",
		flavor: "openai",
		baseUrl: "https://api.groq.com/openai/v1",
		model: "llama-3.3-70b-versatile",
		needsKey: true,
		keyUrl: "https://console.groq.com/keys",
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		flavor: "openai",
		baseUrl: "https://api.deepseek.com/v1",
		model: "deepseek-chat",
		needsKey: true,
	},
	{
		id: "mistral",
		label: "Mistral",
		flavor: "openai",
		baseUrl: "https://api.mistral.ai/v1",
		model: "mistral-large-latest",
		needsKey: true,
	},
	{
		id: "xai",
		label: "xAI",
		flavor: "openai",
		baseUrl: "https://api.x.ai/v1",
		model: "grok-4",
		needsKey: true,
	},
	{
		id: "together",
		label: "Together",
		flavor: "openai",
		baseUrl: "https://api.together.xyz/v1",
		model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
		needsKey: true,
	},
	{
		id: "ollama",
		label: "Ollama (local)",
		flavor: "openai",
		baseUrl: "http://127.0.0.1:11434/v1",
		model: "qwen3",
		needsKey: false,
	},
	{
		id: "lmstudio",
		label: "LM Studio (local)",
		flavor: "openai",
		baseUrl: "http://127.0.0.1:1234/v1",
		model: "",
		needsKey: false,
	},
];

/** A turn that calls tools forever is a bug in the model, not a long edit. */
const MAX_STEPS = 40;
const REQUEST_TIMEOUT_MS = 180_000;

type Json = Record<string, unknown>;

// The conversation is kept in each provider's own wire format, so a resumed
// turn sends back exactly what the model saw.
let history: Json[] = [];
let historyFlavor: ApiFlavor | null = null;
let controller: AbortController | null = null;

export function openAiTools(): Json[] {
	return MCP_TOOLS.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	}));
}

export function anthropicTools(): Json[] {
	return MCP_TOOLS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema,
	}));
}

function textOf(result: ToolCallResult): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
		.join("\n");
}

function imagesOf(result: ToolCallResult): Array<{ data: string; mimeType: string }> {
	return result.content.flatMap((block) =>
		block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [],
	);
}

async function runTool(context: RunContext, name: string, args: Json): Promise<ToolCallResult> {
	context.emit({ kind: "tool", tool: name, detail: summarizeInput(args) });
	try {
		return await context.dispatch(name, args);
	} catch (error) {
		// Tool failures are results the model reads, exactly as over MCP.
		return {
			content: [
				{ type: "text", text: error instanceof Error ? error.message : String(error) },
			],
			isError: true,
		};
	}
}

function joinUrl(base: string, suffix: string): string {
	return `${base.replace(/\/+$/, "")}${suffix}`;
}

async function postJson(
	url: string,
	headers: Record<string, string>,
	body: Json,
	signal: AbortSignal,
): Promise<Json> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, timeout]),
	});
	const text = await response.text();
	let parsed: Json = {};
	try {
		parsed = JSON.parse(text) as Json;
	} catch {
		// fall through with the raw text below
	}
	if (!response.ok) {
		const error = parsed.error as Json | string | undefined;
		const message =
			typeof error === "string"
				? error
				: typeof error?.message === "string"
					? error.message
					: text.slice(0, 300);
		throw new Error(`${response.status} ${message || response.statusText}`);
	}
	return parsed;
}

async function runOpenAi(prompt: string, context: RunContext, signal: AbortSignal): Promise<void> {
	const { baseUrl, model } = context.settings.api;
	if (history.length === 0) history.push({ role: "system", content: context.instructions });
	history.push({ role: "user", content: prompt });
	const headers: Record<string, string> = {};
	if (context.apiKey) headers.Authorization = `Bearer ${context.apiKey}`;
	// OpenRouter ranks apps by these; harmless everywhere else.
	headers["HTTP-Referer"] = "https://github.com/rendr-app/rendr-app";
	headers["X-Title"] = "Rendr";
	const tools = openAiTools();

	for (let step = 0; step < MAX_STEPS; step++) {
		const body: Json = { model, messages: history, tools, tool_choice: "auto" };
		const reply = await postJson(joinUrl(baseUrl, "/chat/completions"), headers, body, signal);
		const message = ((reply.choices as Json[] | undefined)?.[0]?.message ?? {}) as Json;
		const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : [];
		history.push({
			role: "assistant",
			content: message.content ?? null,
			...(calls.length ? { tool_calls: calls } : {}),
		});
		if (typeof message.content === "string" && message.content.trim()) {
			context.emit({ kind: "text", text: message.content });
		}
		if (calls.length === 0) return;

		const images: Json[] = [];
		for (const call of calls) {
			const fn = (call.function ?? {}) as Json;
			const name = String(fn.name ?? "");
			let args: Json = {};
			try {
				args =
					typeof fn.arguments === "string" && fn.arguments
						? (JSON.parse(fn.arguments) as Json)
						: {};
			} catch {
				history.push({
					role: "tool",
					tool_call_id: call.id,
					content: "The arguments were not valid JSON. Retry with a JSON object.",
				});
				continue;
			}
			const result = await runTool(context, name, args);
			history.push({
				role: "tool",
				tool_call_id: call.id,
				content: textOf(result) || "(no output)",
			});
			for (const image of imagesOf(result)) {
				images.push({
					type: "image_url",
					image_url: { url: `data:${image.mimeType};base64,${image.data}` },
				});
			}
		}
		// Tool messages are text-only in this format; a frame the editor rendered
		// comes back as a user turn so a vision model can still look at it.
		if (images.length > 0) {
			history.push({
				role: "user",
				content: [
					{ type: "text", text: "Images returned by the tool calls above:" },
					...images,
				],
			});
		}
	}
	context.emit({ kind: "error", message: `Stopped after ${MAX_STEPS} tool steps.` });
}

async function runAnthropic(
	prompt: string,
	context: RunContext,
	signal: AbortSignal,
): Promise<void> {
	const { baseUrl, model } = context.settings.api;
	history.push({ role: "user", content: prompt });
	const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
	if (context.apiKey) headers["x-api-key"] = context.apiKey;
	const tools = anthropicTools();

	for (let step = 0; step < MAX_STEPS; step++) {
		const reply = await postJson(
			joinUrl(baseUrl, "/v1/messages"),
			headers,
			{ model, max_tokens: 8192, system: context.instructions, messages: history, tools },
			signal,
		);
		const content = Array.isArray(reply.content) ? (reply.content as Json[]) : [];
		history.push({ role: "assistant", content });
		for (const block of content) {
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				context.emit({ kind: "text", text: block.text });
			}
		}
		const uses = content.filter((block) => block.type === "tool_use");
		if (uses.length === 0) return;

		const results: Json[] = [];
		for (const use of uses) {
			const result = await runTool(context, String(use.name), (use.input ?? {}) as Json);
			results.push({
				type: "tool_result",
				tool_use_id: use.id,
				is_error: result.isError === true,
				content: result.content.map((block) =>
					block.type === "text"
						? { type: "text", text: block.text }
						: {
								type: "image",
								source: {
									type: "base64",
									media_type: block.mimeType,
									data: block.data,
								},
							},
				),
			});
		}
		history.push({ role: "user", content: results });
	}
	context.emit({ kind: "error", message: `Stopped after ${MAX_STEPS} tool steps.` });
}

/** https anywhere, or plain http only to this machine (Ollama, LM Studio). */
export function sendsKeySafely(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		if (url.protocol === "https:") return true;
		return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
	} catch {
		return false;
	}
}

export const apiProvider: AgentProvider = {
	id: "api",

	async probe(settings) {
		const preset = API_PRESETS.find((entry) => entry.baseUrl === settings.api.baseUrl);
		const label = preset?.label ?? "API";
		if (!settings.api.baseUrl.trim())
			return {
				available: false,
				label,
				reason: "Set an API base URL in the agent settings.",
			};
		if (!settings.api.model.trim())
			return { available: false, label, reason: "Choose a model in the agent settings." };
		return { available: true, label: `${label} · ${settings.api.model}` };
	},

	async run(prompt, context) {
		const { emit } = context;
		if (controller) {
			emit({ kind: "error", message: "Still answering. Cancel first." });
			return;
		}
		const preset = API_PRESETS.find((entry) => entry.baseUrl === context.settings.api.baseUrl);
		if (preset?.needsKey && !context.apiKey) {
			emit({
				kind: "error",
				message: `Add your ${preset.label} API key in the agent settings.`,
			});
			emit({ kind: "done", sessionId: null });
			return;
		}
		// A key never travels in the clear to anything but this machine.
		if (context.apiKey && !sendsKeySafely(context.settings.api.baseUrl)) {
			emit({
				kind: "error",
				message:
					"That base URL is plain http to another machine, so Rendr won't send your API key to it. Use https.",
			});
			emit({ kind: "done", sessionId: null });
			return;
		}
		const flavor = context.settings.api.flavor;
		if (historyFlavor !== flavor) {
			history = [];
			historyFlavor = flavor;
		}
		const checkpoint = history.length;
		const active = new AbortController();
		controller = active;
		try {
			if (flavor === "anthropic") await runAnthropic(prompt, context, active.signal);
			else await runOpenAi(prompt, context, active.signal);
			emit({ kind: "mcp", connected: true, status: "in-process" });
		} catch (error) {
			// A turn that failed halfway leaves the history unanswerable (a tool
			// call with no result); roll it back so the next turn can be sent.
			history = history.slice(0, checkpoint);
			if (!active.signal.aborted) {
				emit({
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			controller = null;
			emit({ kind: "done", sessionId: null });
		}
	},

	cancel() {
		controller?.abort();
		controller = null;
	},

	reset() {
		history = [];
		historyFlavor = null;
	},
};
