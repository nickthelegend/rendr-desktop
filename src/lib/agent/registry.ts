// Maps every tool the MCP server advertises to a handler. A tool with no handler
// returns not_implemented — never a success-shaped response.

import {
	getRecordingStatus,
	listCaptureSources,
	type RecordingControls,
	startRecording,
	stopRecording,
} from "./recordingTools";
import { notImplemented } from "./result";
import type { AgentEditorContext, AgentToolResult } from "./types";
import { addZoomRegions, suggestZooms, updateZoomRegions } from "./zoomTools";

/** Everything the MCP server declares, so the registry can be checked for gaps. */
export const DECLARED_TOOLS = [
	// Editing (ported from Palmier Pro — schemas only so far)
	"get_timeline",
	"inspect_timeline",
	"create_timeline",
	"set_active_timeline",
	"set_project_settings",
	"export_project",
	"manage_exports",
	"get_media",
	"inspect_media",
	"search_media",
	"import_media",
	"capture_frame",
	"organize_media",
	"add_clips",
	"insert_clips",
	"move_clips",
	"remove_clips",
	"manage_tracks",
	"split_clips",
	"ripple_delete_ranges",
	"set_clip_properties",
	"set_keyframes",
	"apply_layout",
	"sync_clips",
	"undo",
	"get_transcript",
	"remove_words",
	"remove_silence",
	"detect_beats",
	"add_texts",
	"update_text",
	"add_captions",
	"apply_color",
	"apply_effect",
	"inspect_color",
	"denoise_audio",
	"manage_project",
	// Recording (Rendr's own)
	"list_capture_sources",
	"start_recording",
	"stop_recording",
	"get_recording_status",
	// Notes and narration
	"manage_comments",
	"setup_voice",
	"narrate_timeline",
	// Workflows
	"manage_workflows",
	"edit_workflow",
	"run_workflow",
	"set_cursor",
	"set_webcam",
	"set_background",
	// Zoom (Rendr's own, over Recordly's zoom modules)
	"suggest_zooms",
	"add_zoom_regions",
	"update_zoom_regions",
] as const;

/** Tools that mutate the timeline and are therefore refused while capture is running. */
const EDIT_TOOLS_BLOCKED_WHILE_RECORDING = new Set([
	"add_zoom_regions",
	"update_zoom_regions",
	"add_clips",
	"insert_clips",
	"move_clips",
	"remove_clips",
	"split_clips",
	"ripple_delete_ranges",
	"set_clip_properties",
	"set_keyframes",
	"apply_layout",
	"remove_words",
	"remove_silence",
	"add_texts",
	"update_text",
	"add_captions",
	"apply_color",
	"apply_effect",
	"denoise_audio",
	"narrate_timeline",
	"run_workflow",
	"undo",
]);

/**
 * A renderer hosts one half of the surface: the launch window owns the recorder,
 * the editor window owns the timeline. Whichever half this window does not host is
 * absent, and tools needing it report that instead of guessing.
 */
export interface AgentRuntime {
	editor?: () => AgentEditorContext;
	recorder?: () => RecordingControls;
}

function unavailable(name: string, host: string): AgentToolResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error: "host_unavailable",
					message: `'${name}' is served by Rendr's ${host}, which is not open. Ask the user to open it, then retry.`,
				}),
			},
		],
		isError: true,
	};
}

export async function dispatchAgentTool(
	name: string,
	args: Record<string, unknown>,
	runtime: AgentRuntime,
): Promise<AgentToolResult> {
	if (EDIT_TOOLS_BLOCKED_WHILE_RECORDING.has(name) && runtime.recorder?.().recording) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "recording_active",
						message: `'${name}' is refused while a recording is running. Call stop_recording first.`,
					}),
				},
			],
			isError: true,
		};
	}

	const recorder = runtime.recorder;
	const editor = runtime.editor;

	switch (name) {
		// ── Recording ────────────────────────────────────────────────────
		case "list_capture_sources":
			return listCaptureSources(args);
		case "start_recording":
			return recorder
				? startRecording(args, recorder)
				: unavailable(name, "recording window");
		case "stop_recording":
			return recorder ? stopRecording(args, recorder) : unavailable(name, "recording window");
		case "get_recording_status":
			return recorder ? getRecordingStatus(recorder) : unavailable(name, "recording window");

		// ── Zoom ─────────────────────────────────────────────────────────
		case "suggest_zooms":
			return editor ? suggestZooms(args, editor()) : unavailable(name, "editor window");
		case "add_zoom_regions":
			return editor ? addZoomRegions(args, editor()) : unavailable(name, "editor window");
		case "update_zoom_regions":
			return editor ? updateZoomRegions(args, editor()) : unavailable(name, "editor window");

		// ── Editing ───────────────────────────────────────────────────────
		// This registry is the recording half. Editing tools belong to the
		// editor window, which answers them through src/palmier-ui/agentTools.ts.
		// Answering here would mean whichever window replied first won.
		default:
			if ((DECLARED_TOOLS as readonly string[]).includes(name)) {
				return unavailable(name, "editor window");
			}
			return notImplemented(name, "It is not a tool Rendr declares at all.");
	}
}
