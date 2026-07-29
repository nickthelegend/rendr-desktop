import { describe, expect, it, vi } from "vitest";

import { MCP_TOOLS } from "../../../electron/mcp/toolDefinitions";
import type { RecordingControls } from "./recordingTools";
import { type AgentRuntime, DECLARED_TOOLS, dispatchAgentTool } from "./registry";
import type { AgentEditorContext, AgentToolResult } from "./types";

function payload(result: AgentToolResult): Record<string, unknown> {
	const first = result.content[0];
	if (first.type !== "text") throw new Error("expected a text receipt");
	return JSON.parse(first.text) as Record<string, unknown>;
}

function runtime(
	overrides: { editor?: Partial<AgentEditorContext>; recorder?: Partial<RecordingControls> } = {},
): AgentRuntime {
	const editor: AgentEditorContext = {
		totalMs: 10_000,
		zoomRegions: [],
		cursorTelemetry: [],
		setZoomRegions: vi.fn(),
		isRecording: false,
		...overrides.editor,
	};
	const recorder: RecordingControls = {
		recording: false,
		paused: false,
		finalizing: false,
		countdownActive: false,
		toggleRecording: vi.fn(),
		setMicrophoneEnabled: vi.fn(),
		setMicrophoneDeviceId: vi.fn(),
		setSystemAudioEnabled: vi.fn(),
		setCountdownDelay: vi.fn(),
		selectedSourceName: "Screen 1",
		elapsedMs: 0,
		lastRecordingPath: null,
		...overrides.recorder,
	};
	return { editor: () => editor, recorder: () => recorder };
}

const IMPLEMENTED = new Set([
	"list_capture_sources",
	"start_recording",
	"stop_recording",
	"get_recording_status",
	"suggest_zooms",
	"add_zoom_regions",
	"update_zoom_regions",
]);

describe("agent tool registry", () => {
	it("declares exactly the tools the MCP server advertises", () => {
		expect([...DECLARED_TOOLS].sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());
	});

	it("declines every editing tool — never a success — as belonging to the editor", async () => {
		// This registry is the recording half. Editing tools are answered by the
		// editor window (src/palmier-ui/agentTools.ts); if this one answered them
		// too, whichever window replied first would win.
		for (const name of DECLARED_TOOLS) {
			if (IMPLEMENTED.has(name)) continue;
			const result = await dispatchAgentTool(name, {}, runtime());
			expect(result.isError, name).toBe(true);
			expect(payload(result).error, name).toBe("host_unavailable");
			expect(String(payload(result).message), name).toContain("editor window");
		}
	});

	it("rejects a tool it does not declare at all", async () => {
		const result = await dispatchAgentTool("delete_everything", {}, runtime());
		expect(payload(result).error).toBe("not_implemented");
		expect(payload(result).message).toContain("not a tool Rendr declares");
	});

	it("refuses mutating tools while a recording is running", async () => {
		const result = await dispatchAgentTool(
			"add_zoom_regions",
			{ regions: [{ startMs: 0, endMs: 2000, depth: 2 }] },
			runtime({ recorder: { recording: true } }),
		);
		expect(payload(result).error).toBe("recording_active");
	});

	it("still allows recording status while a recording is running", async () => {
		const result = await dispatchAgentTool(
			"get_recording_status",
			{},
			runtime({ recorder: { recording: true, elapsedMs: 4200 } }),
		);
		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			active: true,
			state: "recording",
			elapsedSeconds: 4.2,
		});
	});

	it("refuses a second recording", async () => {
		const result = await dispatchAgentTool(
			"start_recording",
			{ sourceId: "screen:0" },
			runtime({ recorder: { recording: true } }),
		);
		expect(payload(result).error).toBe("already_recording");
	});

	it("refuses stop_recording when nothing is recording", async () => {
		const result = await dispatchAgentTool("stop_recording", {}, runtime());
		expect(payload(result).error).toBe("not_recording");
	});
});
