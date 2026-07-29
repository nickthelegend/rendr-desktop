import type { ZoomRegion } from "@/components/video-editor/types";

export interface AgentToolCall {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export type AgentContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface AgentToolResult {
	content: AgentContent[];
	isError?: boolean;
}

/**
 * What a tool handler is allowed to touch. Kept explicit so the agent surface can
 * never reach further into editor state than it declares here.
 */
export interface AgentEditorContext {
	/** Total length of the loaded recording, in source milliseconds. */
	totalMs: number;
	zoomRegions: ZoomRegion[];
	cursorTelemetry: import("@/components/video-editor/types").CursorTelemetryPoint[];
	/** Replaces the zoom list. Goes through the editor's own undo history. */
	setZoomRegions: (next: ZoomRegion[]) => void;
	/** True while a capture is running; edit tools are refused during one. */
	isRecording: boolean;
}

export type AgentToolHandler = (
	args: Record<string, unknown>,
	context: AgentEditorContext,
) => Promise<AgentToolResult> | AgentToolResult;
