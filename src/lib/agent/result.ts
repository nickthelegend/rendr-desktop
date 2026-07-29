import type { AgentToolResult } from "./types";

/** A structured receipt. Tools return what actually changed, never a bare "ok". */
export function ok(payload: unknown): AgentToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(
	code: string,
	message: string,
	extra?: Record<string, unknown>,
): AgentToolResult {
	return {
		content: [
			{ type: "text", text: JSON.stringify({ error: code, message, ...extra }, null, 2) },
		],
		isError: true,
	};
}

/**
 * The tool is declared but not built yet. Deliberately distinct from a validation
 * failure: the agent instructions tell the model this means "Rendr can't do this yet",
 * not "you called it wrong". Never dress this up as a success.
 */
export function notImplemented(name: string, note?: string): AgentToolResult {
	return fail(
		"not_implemented",
		`'${name}' is declared by Rendr's MCP server but not implemented yet.${note ? ` ${note}` : ""} Do not retry it; tell the user this capability is missing.`,
	);
}
