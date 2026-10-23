// @vitest-environment jsdom
//
// The tools a talking-head Short is made with, through their real handlers.
//
// Every check here is about the picture rather than the numbers a tool wrote:
// a keyframe row that is "correct" but read under the other convention parks
// the clip half off the frame, and a reframe that reports success while the
// canvas stays landscape is not a vertical video. So results are played back
// through `clipAtFrame` — the reader the preview and the encoder both use —
// and asserted on where the clip actually is.

import { describe, expect, it, vi } from "vitest";

import { createAgentTools, type ToolResult } from "./agentTools";
import { clipAtFrame } from "./keyframes";
import type { AssetModel } from "./media";
import { type ClipModel, withDefaults } from "./model";
import type { TimelineModel } from "./reducers";
import type { EditorApi } from "./state";
import { clipsWorkflow } from "./workflow";

const footage = (over: Partial<ClipModel> = {}): ClipModel =>
	withDefaults({
		id: "c1",
		name: "Talking head.mov",
		mediaType: "video",
		assetId: "a1",
		startFrame: 0,
		endFrame: 90,
		...over,
	});

const landscape: AssetModel = {
	id: "a1",
	name: "Talking head.mov",
	type: "video",
	durationSeconds: 3,
	width: 1920,
	height: 1080,
	hasAudio: true,
	url: "blob:a1",
};

function timelineWith(clips: ClipModel[], over: Partial<TimelineModel> = {}): TimelineModel {
	return {
		id: "tl",
		name: "Main",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks: [
			{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips },
			{ id: "a1", name: "A1", kind: "audio", muted: false, hidden: false, clips: [] },
		],
		...over,
	};
}

/** Just enough editor for the handlers under test, following useAgentBridge.test. */
function fakeApi(timeline: TimelineModel, over: Record<string, unknown> = {}) {
	const commit = vi.fn();
	const agentExport = vi.fn(async () => "job-1");
	const api = {
		state: {
			assets: [landscape],
			timelines: [timeline],
			cursorTelemetry: [],
			comments: [],
			workflows: [],
			projectName: "Short",
		},
		timeline,
		commit,
		agentExport,
		...over,
	} as unknown as EditorApi;
	return { api, commit, agentExport };
}

/** What the handler committed, applied to the timeline it was given. */
function committed(commit: ReturnType<typeof vi.fn>, timeline: TimelineModel): TimelineModel {
	expect(commit).toHaveBeenCalledTimes(1);
	const reduce = commit.mock.calls[0][1] as (t: TimelineModel) => TimelineModel;
	return reduce(timeline);
}

const body = (result: ToolResult) =>
	JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

/** The clip's box, as drawn, at a timeline frame. */
function boxAt(timeline: TimelineModel, clipId: string, frame: number) {
	const clip = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
	if (!clip) throw new Error(`no clip ${clipId}`);
	const { centerX, centerY, width, height } = clipAtFrame(clip, frame).transform;
	return {
		centerX,
		centerY,
		width,
		height,
		left: centerX - width / 2,
		right: centerX + width / 2,
		top: centerY - height / 2,
		bottom: centerY + height / 2,
	};
}

const frames = [0, 15, 30, 45, 60, 75, 89];

describe("add_ken_burns", () => {
	it("pushes in on the centre without the clip ever leaving it", () => {
		const timeline = timelineWith([footage()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_ken_burns({ clipIds: ["c1"], direction: "in", amount: 0.2 });
		const next = committed(commit, timeline);

		for (const frame of frames) {
			const box = boxAt(next, "c1", frame);
			expect(box.centerX).toBeCloseTo(0.5, 6);
			expect(box.centerY).toBeCloseTo(0.5, 6);
			// Covering the frame the whole way: no background ever shows.
			expect(box.left).toBeLessThanOrEqual(1e-9);
			expect(box.top).toBeLessThanOrEqual(1e-9);
			expect(box.right).toBeGreaterThanOrEqual(1 - 1e-9);
			expect(box.bottom).toBeGreaterThanOrEqual(1 - 1e-9);
		}
		// It starts at the clip's own size — not half off the frame, which is
		// what writing the centre into a top-left row used to do.
		expect(boxAt(next, "c1", 0).width).toBeCloseTo(1, 6);
		expect(boxAt(next, "c1", 89).width).toBeCloseTo(1.2, 6);
	});

	it("holds the focus point still and still never shows an edge", () => {
		const timeline = timelineWith([footage()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_ken_burns({
			clipIds: ["c1"],
			direction: "in",
			amount: 0.3,
			focusX: 0.8,
			focusY: 0.3,
		});
		const next = committed(commit, timeline);
		for (const frame of frames) {
			const box = boxAt(next, "c1", frame);
			// Where the picture's (0.8, 0.3) lands on the canvas.
			expect(box.left + 0.8 * box.width).toBeCloseTo(0.8, 6);
			expect(box.top + 0.3 * box.height).toBeCloseTo(0.3, 6);
			expect(box.left).toBeLessThanOrEqual(1e-9);
			expect(box.right).toBeGreaterThanOrEqual(1 - 1e-9);
		}
	});

	it("pulls out back to exactly where the clip was placed", () => {
		const timeline = timelineWith([footage()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_ken_burns({ clipIds: ["c1"], direction: "out", amount: 0.15 });
		const next = committed(commit, timeline);
		expect(boxAt(next, "c1", 0).width).toBeCloseTo(1.15, 6);
		const end = boxAt(next, "c1", 89);
		expect(end).toMatchObject({ width: 1, height: 1 });
		expect(end.centerX).toBeCloseTo(0.5, 6);
		expect(end.centerY).toBeCloseTo(0.5, 6);
	});

	it("pans within the oversize, so the picture's edge never slides in", () => {
		const timeline = timelineWith([footage()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_ken_burns({ clipIds: ["c1"], direction: "left", amount: 0.1 });
		const next = committed(commit, timeline);
		const start = boxAt(next, "c1", 0);
		const end = boxAt(next, "c1", 89);
		expect(end.centerX).toBeLessThan(start.centerX);
		expect(start.centerY).toBeCloseTo(0.5, 6);
		for (const frame of frames) {
			const box = boxAt(next, "c1", frame);
			expect(box.left).toBeLessThanOrEqual(1e-9);
			expect(box.right).toBeGreaterThanOrEqual(1 - 1e-9);
		}
	});

	it("keeps an inset an inset, moving around its own centre", () => {
		// Scale rows are absolute sizes. A bare factor of 1.12 would have
		// blown a corner inset up past the whole frame.
		const inset = footage({
			transform: {
				...footage().transform,
				centerX: 0.75,
				centerY: 0.25,
				width: 0.3,
				height: 0.3,
			},
		});
		const timeline = timelineWith([inset]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_ken_burns({ clipIds: ["c1"], direction: "in" });
		const next = committed(commit, timeline);
		const end = boxAt(next, "c1", 89);
		expect(end.width).toBeCloseTo(0.3 * 1.12, 6);
		for (const frame of frames) {
			const box = boxAt(next, "c1", frame);
			expect(box.centerX).toBeCloseTo(0.75, 6);
			expect(box.centerY).toBeCloseTo(0.25, 6);
		}
	});
});

describe("add_motion_preset", () => {
	const title = () =>
		footage({
			transform: {
				...footage().transform,
				centerX: 0.7,
				centerY: 0.8,
				width: 0.4,
				height: 0.2,
			},
		});

	it("slides in and comes to rest exactly where the clip is placed", () => {
		const timeline = timelineWith([title()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_motion_preset({
			clipIds: ["c1"],
			preset: "slide",
			from: "left",
			durationFrames: 12,
		});
		const next = committed(commit, timeline);
		const rest = boxAt(next, "c1", 12);
		expect(rest.centerX).toBeCloseTo(0.7, 6);
		expect(rest.centerY).toBeCloseTo(0.8, 6);
		// And it really did come from the left.
		expect(boxAt(next, "c1", 0).centerX).toBeCloseTo(0.2, 6);
		// After the move it stays put for the rest of the clip.
		expect(boxAt(next, "c1", 60).centerX).toBeCloseTo(0.7, 6);
	});

	it("drifts out from where the clip sits, not from half a width away", () => {
		const timeline = timelineWith([title()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_motion_preset({
			clipIds: ["c1"],
			preset: "drift",
			at: "out",
			from: "bottom",
		});
		const next = committed(commit, timeline);
		const before = boxAt(next, "c1", 60);
		expect(before.centerX).toBeCloseTo(0.7, 6);
		expect(before.centerY).toBeCloseTo(0.8, 6);
		expect(boxAt(next, "c1", 89).centerY).toBeCloseTo(0.8 + 0.5 * 0.12, 6);
	});

	it("pops up to the clip's own size, not the frame's", () => {
		const timeline = timelineWith([title()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).add_motion_preset({ clipIds: ["c1"], preset: "pop" });
		const next = committed(commit, timeline);
		const start = boxAt(next, "c1", 0);
		const end = boxAt(next, "c1", 12);
		expect(start.width).toBeCloseTo(0.24, 6);
		expect(end.width).toBeCloseTo(0.4, 6);
		expect(end.height).toBeCloseTo(0.2, 6);
		// Scale alone grows about the centre.
		expect(start.centerX).toBeCloseTo(0.7, 6);
	});
});

describe("reframe_timeline", () => {
	it("makes the canvas itself vertical, at the project's short edge", () => {
		const timeline = timelineWith([footage()]);
		const { api, commit } = fakeApi(timeline);
		const result = createAgentTools(api).reframe_timeline({ aspect: "9:16" });
		expect(result.isError).toBeFalsy();
		const next = committed(commit, timeline);
		expect([next.width, next.height]).toEqual([1080, 1920]);
		expect(body(result).resolution).toEqual([1080, 1920]);
		// One undoable step named for what it did.
		expect(commit.mock.calls[0][0]).toBe("Reframe to 9:16");
	});

	it("centre-crops landscape footage to cover the vertical frame", () => {
		const timeline = timelineWith([footage()]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).reframe_timeline({ aspect: "9:16" });
		const next = committed(commit, timeline);
		const box = boxAt(next, "c1", 0);
		// Full height, and as wide as the picture's own shape: drawn at its
		// natural aspect, so nothing is stretched and the middle is what shows.
		expect(box.height).toBeCloseTo(1, 6);
		expect((box.width * next.width) / (box.height * next.height)).toBeCloseTo(16 / 9, 3);
		expect(box.centerX).toBeCloseTo(0.5, 6);
		expect(box.left).toBeLessThanOrEqual(0);
		expect(box.right).toBeGreaterThanOrEqual(1);
	});

	it("keeps an inset's size in pixels and holds it inside the new frame", () => {
		const inset = footage({
			id: "pip",
			transform: {
				...footage().transform,
				centerX: 0.85,
				centerY: 0.15,
				width: 0.25,
				height: 0.25,
			},
		});
		const timeline = timelineWith([footage(), inset]);
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).reframe_timeline({ aspect: "9:16" });
		const next = committed(commit, timeline);
		const box = boxAt(next, "pip", 0);
		expect(box.width * next.width).toBeCloseTo(0.25 * 1920, 3);
		expect(box.height * next.height).toBeCloseTo(0.25 * 1080, 3);
		expect(box.left).toBeGreaterThanOrEqual(0);
		expect(box.right).toBeLessThanOrEqual(1 + 1e-9);
	});

	it("carries a Ken Burns over, so the push still covers the vertical frame", () => {
		const timeline = timelineWith([footage()]);
		const first = fakeApi(timeline);
		createAgentTools(first.api).add_ken_burns({
			clipIds: ["c1"],
			direction: "in",
			amount: 0.2,
		});
		const pushed = committed(first.commit, timeline);

		const second = fakeApi(pushed);
		createAgentTools(second.api).reframe_timeline({ aspect: "9:16" });
		const next = committed(second.commit, pushed);
		for (const frame of frames) {
			const box = boxAt(next, "c1", frame);
			expect(box.centerX).toBeCloseTo(0.5, 6);
			expect(box.height).toBeGreaterThanOrEqual(1 - 1e-9);
			expect(box.left).toBeLessThanOrEqual(1e-9);
			expect(box.right).toBeGreaterThanOrEqual(1 - 1e-9);
		}
		// The push still grows the picture by the same 1.2×.
		expect(boxAt(next, "c1", 89).height).toBeCloseTo(1.2, 6);
	});

	it("follows the pointer when there is telemetry, without exposing an edge", () => {
		const timeline = timelineWith([footage()]);
		const telemetry = Array.from({ length: 80 }, (_, i) => ({
			timeMs: i * 50,
			cx: 0.1,
			cy: 0.5,
		}));
		const { api, commit } = fakeApi(timeline, {
			state: {
				assets: [landscape],
				timelines: [timeline],
				cursorTelemetry: telemetry,
				comments: [],
				workflows: [],
			},
		});
		const result = createAgentTools(api).reframe_timeline({ aspect: "9:16" });
		expect(body(result).followingCursor).toBe(true);
		const next = committed(commit, timeline);
		const box = boxAt(next, "c1", 30);
		// Pointer on the far left of the screen: the crop moves toward it.
		expect(box.centerX).toBeGreaterThan(0.5);
		expect(box.left).toBeLessThanOrEqual(1e-9);
		expect(box.right).toBeGreaterThanOrEqual(1 - 1e-9);
		expect(box.centerY).toBeCloseTo(0.5, 6);
		// And the pointer itself is in shot.
		const pointer = box.left + 0.1 * box.width;
		expect(pointer).toBeGreaterThanOrEqual(0);
		expect(pointer).toBeLessThanOrEqual(1);
	});

	it("leaves captions alone", () => {
		const caption = withDefaults({
			id: "cap",
			name: "Caption",
			mediaType: "text",
			startFrame: 0,
			endFrame: 30,
			captionGroupId: "g",
		});
		const timeline = timelineWith([footage()]);
		timeline.tracks.unshift({
			id: "trk-cc-g",
			name: "CC",
			kind: "video",
			muted: false,
			hidden: false,
			clips: [caption],
		});
		const { api, commit } = fakeApi(timeline);
		createAgentTools(api).reframe_timeline({ aspect: "9:16" });
		const next = committed(commit, timeline);
		const after = next.tracks[0].clips[0];
		expect(after.transform).toEqual(caption.transform);
	});
});

describe("export_project presets", () => {
	it("refuses a vertical preset on a landscape timeline and names the fix", async () => {
		const timeline = timelineWith([footage()]);
		const { api, agentExport } = fakeApi(timeline);
		const result = await createAgentTools(api).export_project({ preset: "shorts" });
		expect(result.isError).toBe(true);
		const error = body(result);
		expect(error.error).toBe("aspect_mismatch");
		expect(String(error.message)).toMatch(/reframe_timeline/);
		expect(error.fix).toEqual({ tool: "reframe_timeline", args: { aspect: "9:16" } });
		// Nothing was encoded: a letterboxed Short is the outcome being refused.
		expect(agentExport).not.toHaveBeenCalled();
	});

	it("exports a vertical timeline at 1080×1920 with the platform's bitrate", async () => {
		const timeline = timelineWith([footage()], { width: 1080, height: 1920 });
		const { api, agentExport } = fakeApi(timeline);
		const result = await createAgentTools(api).export_project({ preset: "tiktok" });
		expect(result.isError).toBeFalsy();
		expect(agentExport).toHaveBeenCalledWith({ resolution: "1080p", bitrate: 8_000_000 });
		expect(body(result).resolution).toEqual([1080, 1920]);
	});

	it("still takes a plain resolution, as before", async () => {
		const timeline = timelineWith([footage()]);
		const { api, agentExport } = fakeApi(timeline);
		await createAgentTools(api).export_project({ resolution: "720p" });
		expect(agentExport).toHaveBeenCalledWith({ resolution: "720p" });
	});

	it("won't take a preset and a resolution at once", async () => {
		const timeline = timelineWith([footage()]);
		const { api } = fakeApi(timeline);
		const result = await createAgentTools(api).export_project({
			preset: "youtube",
			resolution: "720p",
		});
		expect(result.isError).toBe(true);
	});
});

describe("run_workflow with an export step", () => {
	it("commits the run first and exports the timeline it committed", async () => {
		const workflow = clipsWorkflow();
		const timeline = timelineWith([footage({ endFrame: 600 })]);
		const telemetry = Array.from({ length: 400 }, (_, i) => ({
			timeMs: i * 50,
			cx: i < 100 ? 0.3 : 0.7,
			cy: 0.5,
			interactionType: i % 60 === 0 ? "click" : "move",
		}));
		const order: string[] = [];
		const { api, commit, agentExport } = fakeApi(timeline, {
			state: {
				assets: [landscape],
				timelines: [timeline],
				cursorTelemetry: telemetry,
				comments: [
					{
						id: "n1",
						frame: 10,
						text: "Here is the part that matters.",
						durationFrames: 0,
						author: "user",
						createdAt: "2026-01-01T00:00:00Z",
					},
				],
				workflows: [workflow],
			},
			runNarration: async () => ({ spoken: 1, lines: [] }),
		});
		commit.mockImplementation(() => order.push("commit"));
		agentExport.mockImplementation(async () => {
			order.push("export");
			return "job-7";
		});

		const result = await createAgentTools(api).run_workflow({ workflowId: workflow.id });
		expect(result.isError).toBeFalsy();
		expect(order).toEqual(["commit", "export"]);
		const reduce = commit.mock.calls[0][1] as (t: TimelineModel) => TimelineModel;
		const committedTimeline = reduce(timeline);
		const exported = agentExport.mock.calls[0] as unknown as [unknown, TimelineModel];
		expect(exported[1]).toBe(committedTimeline);
		// The file is the reframed cut, not the landscape one the run began with.
		expect([exported[1].width, exported[1].height]).toEqual([1080, 1920]);
		expect(body(result).exportJobId).toBe("job-7");
	});
});
