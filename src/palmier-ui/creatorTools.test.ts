import { describe, expect, it, vi } from "vitest";

import { createCreatorTools, parseElements, setClipBackgrounds } from "./creatorTools";
import { keepOutFromFaces, placeGraphic } from "./graphicPlacement";
import { DEFAULT_GRAPHIC_STYLE } from "./graphics";
import { type ClipModel, withDefaults } from "./model";
import type { TimelineModel } from "./reducers";
import type { EditorApi } from "./state";

// The creator tools are driven through their real handlers against a fake
// editor: what matters is the timeline they commit, so that is what's checked.

function footageClip(over: Partial<ClipModel> = {}): ClipModel {
	return withDefaults({
		id: "cam",
		name: "camera.mp4",
		mediaType: "video",
		assetId: "asset-cam",
		startFrame: 0,
		endFrame: 300,
		...over,
	});
}

function timelineWith(clips: ClipModel[]): TimelineModel {
	return {
		id: "tl",
		name: "Main",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks: [{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips }],
	};
}

function fakeApi(timeline: TimelineModel, assets: unknown[] = []) {
	const commit = vi.fn();
	const api = {
		state: { assets, playhead: 0 },
		timeline,
		commit,
		attachAnalysis: vi.fn(),
	} as unknown as EditorApi;
	return { api, commit };
}

/** Applies what a handler committed to the timeline it started from. */
function committed(commit: ReturnType<typeof vi.fn>, from: TimelineModel): TimelineModel {
	expect(commit).toHaveBeenCalledTimes(1);
	const reduce = commit.mock.calls[0][1] as (t: TimelineModel) => TimelineModel;
	return reduce(from);
}

const payload = (result: { content: Array<{ type: string; text?: string }> }) =>
	JSON.parse(result.content[0].text ?? "{}");

const spec = { elements: [], style: DEFAULT_GRAPHIC_STYLE };

describe("placeGraphic", () => {
	it("puts an overlay on top of the stack", () => {
		const { timeline } = placeGraphic(timelineWith([footageClip()]), {
			id: "g",
			name: "QR",
			spec,
			startFrame: 0,
			endFrame: 90,
			layer: "front",
		});
		expect(timeline.tracks[0].clips[0].mediaType).toBe("graphic");
		expect(timeline.tracks[1].id).toBe("v1");
	});

	it("puts a 'behind' graphic under the speaker and moves their colour to a full-length backdrop", () => {
		// Two cut segments of one take, both on green. A graphic that lasts three
		// seconds must not take the green with it when it ends.
		const start = timelineWith([
			footageClip({ background: { mode: "color", color: "#0B4F3C" } }),
			footageClip({
				id: "cam2",
				startFrame: 300,
				endFrame: 600,
				background: { mode: "color", color: "#0B4F3C" },
			}),
		]);
		const placed = placeGraphic(start, {
			id: "g",
			name: "Map",
			spec,
			startFrame: 0,
			endFrame: 90,
			layer: "behind",
		});
		const [top, graphic, backdrop] = placed.timeline.tracks;
		expect(top.id).toBe("v1");
		expect(top.clips.map((clip) => clip.background?.mode)).toEqual(["remove", "remove"]);
		expect(graphic.clips[0].graphic?.background).toBeUndefined();
		expect(backdrop.clips[0]).toMatchObject({
			startFrame: 0,
			endFrame: 600,
			graphic: { background: "#0B4F3C" },
		});
		expect(placed).toMatchObject({ movedBackgroundFrom: "cam", backdropClipId: "g-backdrop" });
	});

	it("keeps a layout clear of the speaker's face and body", () => {
		const keepOut = keepOutFromFaces({
			width: 1920,
			height: 1080,
			duration: 2,
			interval: 1,
			samples: [{ t: 0, faces: [{ x: 0.45, y: 0.2, w: 0.1, h: 0.2, confidence: 0.9 }] }],
		});
		expect(keepOut?.cx).toBeCloseTo(0.5);
		// From just above the face down to the bottom of the frame.
		expect((keepOut?.cy ?? 0) + (keepOut?.ry ?? 0)).toBeCloseTo(1);
		expect(keepOutFromFaces(undefined)).toBeUndefined();
	});
});

describe("add_graphic", () => {
	it("adds the reference mind map behind matted footage", async () => {
		const start = timelineWith([
			footageClip({ background: { mode: "color", color: "#0B4F3C" } }),
		]);
		const { api, commit } = fakeApi(start, [
			{ id: "asset-cam", type: "video", matteAssetId: "m" },
		]);
		const result = await createCreatorTools(api).add_graphic({
			template: "mind_map",
			nodes: ["Ideas", "Storylines", "Numbers", "Brands", "Editing", "Thumbnails"],
			links: [
				[0, 1],
				[1, 2],
				[2, 3],
				[3, 4],
				[4, 5],
			],
		});
		expect(result.isError).toBeFalsy();
		expect(payload(result)).toMatchObject({
			layer: "behind",
			elements: 11,
			movedBackgroundFrom: "cam",
		});
		const after = committed(commit, start);
		const graphic = after.tracks[1].clips[0];
		expect(graphic.mediaType).toBe("graphic");
		expect(after.tracks[2].clips[0].graphic?.background).toBe("#0B4F3C");
		// Behind the speaker it lasts as long as the footage, not just its own entrance.
		expect(graphic.endFrame).toBe(300);
	});

	it("keeps a QR code up long enough to scan", async () => {
		const start = timelineWith([footageClip()]);
		const { api, commit } = fakeApi(start);
		await createCreatorTools(api).add_graphic({ template: "qr", data: "https://rendr.app" });
		const qr = committed(commit, start).tracks[0].clips[0];
		expect(qr.endFrame - qr.startFrame).toBeGreaterThanOrEqual(30 * 8);
	});

	it("adds a QR code in front and restyles it in place", async () => {
		const start = timelineWith([footageClip()]);
		const first = fakeApi(start);
		await createCreatorTools(first.api).add_graphic({
			template: "qr",
			data: "https://rendr.app",
			label: "Scan me",
		});
		const withQr = committed(first.commit, start);
		const qr = withQr.tracks[0].clips[0];
		expect(qr.graphic?.elements[0]).toMatchObject({ type: "qr", data: "https://rendr.app" });

		const second = fakeApi(withQr);
		await createCreatorTools(second.api).add_graphic({
			clipId: qr.id,
			template: "qr",
			data: "https://rendr.app/new",
			style: { radius: 0, nonsense: true },
		});
		const restyled = committed(second.commit, withQr).tracks[0].clips[0];
		expect(restyled.id).toBe(qr.id);
		expect(restyled.graphic?.elements[0]).toMatchObject({ data: "https://rendr.app/new" });
		expect(restyled.graphic?.style.radius).toBe(0);
		expect(restyled.graphic?.style).not.toHaveProperty("nonsense");
	});

	it("refuses what it can't draw rather than adding an empty clip", async () => {
		const { api, commit } = fakeApi(timelineWith([footageClip()]));
		const tools = createCreatorTools(api);
		expect((await tools.add_graphic({})).isError).toBe(true);
		expect((await tools.add_graphic({ template: "qr" })).isError).toBe(true);
		expect(
			(
				await tools.add_graphic({
					template: "custom",
					elements: [{ type: "box", x: 2, y: 0.5, label: "x" }],
				})
			).isError,
		).toBe(true);
		expect(
			(await tools.add_graphic({ clipId: "nope", template: "qr", data: "x" })).isError,
		).toBe(true);
		expect(commit).not.toHaveBeenCalled();
	});
});

describe("remove_background", () => {
	it("sets and clears a clip's background without touching others", () => {
		const start = timelineWith([
			footageClip(),
			footageClip({ id: "other", startFrame: 300, endFrame: 400 }),
		]);
		const set = setClipBackgrounds(start, new Set(["cam"]), { mode: "blur", blur: 20 });
		expect(set.tracks[0].clips[0].background).toEqual({ mode: "blur", blur: 20 });
		expect(set.tracks[0].clips[1].background).toBeUndefined();
		expect(setClipBackgrounds(set, new Set(["cam"]), { mode: "blur", blur: 20 })).toBe(set);
		expect(
			setClipBackgrounds(set, new Set(["cam"]), undefined).tracks[0].clips[0],
		).not.toHaveProperty("background");
	});

	it("applies to footage that already has a matte, with no analysis", async () => {
		const start = timelineWith([footageClip()]);
		const assets = [
			{
				id: "asset-cam",
				type: "video",
				url: "blob:x",
				matteAssetId: "m",
				personCoverage: 0.9,
			},
			{ id: "m", type: "video", url: "blob:m", isMatte: true },
		];
		const { api, commit } = fakeApi(start, assets);
		const result = await createCreatorTools(api).remove_background({
			mode: "color",
			color: "#00ff00",
		});
		expect(payload(result)).toMatchObject({ changed: true, clipIds: ["cam"] });
		expect(committed(commit, start).tracks[0].clips[0].background).toEqual({
			mode: "color",
			color: "#00ff00",
		});
	});

	it("validates elements for custom graphics", () => {
		expect(parseElements([{ type: "line", from: "a", to: [0.5, 0.5] }])).not.toHaveProperty(
			"error",
		);
		expect(parseElements([{ type: "sparkles", x: 0, y: 0 }])).toHaveProperty("error");
		expect(parseElements([])).toHaveProperty("error");
	});
});

describe("add_punch_ins", () => {
	const faceTrack = {
		width: 1920,
		height: 1080,
		duration: 30,
		interval: 1,
		samples: Array.from({ length: 30 }, (_, t) => ({
			t,
			faces: [{ x: 0.35, y: 0.2, w: 0.1, h: 0.2, confidence: 0.95 }],
		})),
	};
	const assets = [
		{ id: "asset-cam", type: "video", width: 1920, height: 1080, url: "blob:x", faceTrack },
	];
	const segments = () =>
		timelineWith([
			footageClip({ id: "s0", startFrame: 0, endFrame: 60 }),
			footageClip({ id: "s1", startFrame: 60, endFrame: 120, trimStartFrame: 90 }),
			footageClip({ id: "s2", startFrame: 120, endFrame: 180, trimStartFrame: 200 }),
			footageClip({ id: "s3", startFrame: 180, endFrame: 240, trimStartFrame: 300 }),
		]);

	it("punches every other segment on the face, keeping the face still", async () => {
		const start = segments();
		const { api, commit } = fakeApi(start, assets);
		const result = await createCreatorTools(api).add_punch_ins({});
		expect(payload(result)).toMatchObject({ changed: true, segments: 4, punched: 2 });
		const clips = committed(commit, start).tracks[0].clips;
		expect(clips.map((clip) => clip.transform.width.toFixed(2))).toEqual([
			"1.00",
			"1.15",
			"1.00",
			"1.15",
		]);
		// The face (centre x 0.4 in the footage) is still at x 0.4 on screen.
		const pushed = clips[1].transform;
		const faceX = pushed.centerX - pushed.width / 2 + 0.4 * pushed.width;
		expect(faceX).toBeCloseTo(0.4, 2);
	});

	it("replaces its own punch-ins on a second run instead of stacking, and 'off' restores", async () => {
		const start = segments();
		const first = fakeApi(start, assets);
		await createCreatorTools(first.api).add_punch_ins({ amount: 1.2 });
		const once = committed(first.commit, start);

		const second = fakeApi(once, assets);
		await createCreatorTools(second.api).add_punch_ins({ amount: 1.2 });
		const twice = committed(second.commit, once);
		// Unchanged the second time: same result, not 1.44.
		expect(twice.tracks[0].clips[1].transform.width).toBeCloseTo(1.2);

		const third = fakeApi(once, assets);
		await createCreatorTools(third.api).add_punch_ins({ mode: "off" });
		const restored = committed(third.commit, once).tracks[0].clips;
		expect(restored.every((clip) => clip.transform.width === 1 && !clip.punch)).toBe(true);
	});

	it("writes a slow push as keyframes, and leaves motion it didn't make alone", async () => {
		const authored = footageClip({
			id: "mine",
			startFrame: 240,
			endFrame: 300,
			keyframes: { position: [{ frame: 0, values: [0, 0], interp: "linear" }] },
		});
		const start = timelineWith([
			footageClip({ id: "s0", startFrame: 0, endFrame: 240 }),
			authored,
		]);
		const { api, commit } = fakeApi(start, assets);
		const result = await createCreatorTools(api).add_punch_ins({
			style: "push",
			pattern: "every",
		});
		expect(payload(result).skipped).toEqual(["mine"]);
		const clips = committed(commit, start).tracks[0].clips;
		expect(clips[0].keyframes?.scale?.[1].values[0]).toBeCloseTo(1.15);
		expect(clips[1]).toBe(authored);
	});
});

describe("find_retakes", () => {
	it("reports abandoned takes from the captions without cutting anything", async () => {
		const spoken = [
			"So",
			"today",
			"we're",
			"going",
			"so",
			"today",
			"we're",
			"going",
			"to",
			"edit.",
		];
		const caption = withDefaults({
			id: "cap",
			name: "Captions",
			mediaType: "text",
			startFrame: 0,
			endFrame: 300,
			captionGroupId: "g",
			captionWords: spoken.map((text, index) => ({
				text,
				startFrame: index * 10 + (index >= 4 ? 30 : 0),
				endFrame: index * 10 + 8 + (index >= 4 ? 30 : 0),
			})),
		});
		const start = timelineWith([footageClip()]);
		start.tracks.unshift({
			id: "trk-cc-g",
			name: "CC",
			kind: "video",
			muted: false,
			hidden: false,
			clips: [caption],
		});
		const { api, commit } = fakeApi(start);
		const result = await createCreatorTools(api).find_retakes({});
		const body = payload(result);
		expect(body.retakes).toEqual([
			expect.objectContaining({
				kind: "restart",
				words: [0, 3],
				removed: "So today we're going",
			}),
		]);
		expect(commit).not.toHaveBeenCalled();
	});

	it("asks for captions when there's no transcript", async () => {
		const { api } = fakeApi(timelineWith([footageClip()]));
		const result = await createCreatorTools(api).find_retakes({});
		expect(payload(result).error).toBe("no_transcript");
	});
});

describe("caption presets on small canvases", () => {
	it("scales a preset's point sizes to the timeline's short edge", async () => {
		const { scalePresetToCanvas } = await import("./agentTools");
		const preset = { fontSize: 88, strokeWidth: 7, color: "#fff" } as Parameters<
			typeof scalePresetToCanvas
		>[0];
		expect(scalePresetToCanvas(preset, { width: 640, height: 360 })).toMatchObject({
			fontSize: 29.3,
			strokeWidth: 2.3,
			color: "#fff",
		});
		// A 9:16 Short has a 1080 short edge: untouched.
		expect(scalePresetToCanvas(preset, { width: 1080, height: 1920 })).toBe(preset);
	});
});

describe("punch-ins on a face-followed clip", () => {
	it("pushes in along the follow path and restores it exactly", async () => {
		const path = [
			{ frame: 0, values: [-1, 0], interp: "smooth" as const },
			{ frame: 60, values: [-2, 0], interp: "smooth" as const },
		];
		const followed = footageClip({
			id: "s1",
			startFrame: 60,
			endFrame: 180,
			faceFollow: true,
			transform: { ...footageClip().transform, width: 3.16, centerX: 0.5 - 1 + 1.58 },
			keyframes: { position: path },
		});
		const start = timelineWith([
			footageClip({ id: "s0", startFrame: 0, endFrame: 60 }),
			followed,
		]);
		const assets = [
			{ id: "asset-cam", type: "video", width: 1920, height: 1080, url: "blob:x" },
		];
		const first = fakeApi(start, assets);
		const result = await createCreatorTools(first.api).add_punch_ins({ amount: 1.2 });
		expect(payload(result).skipped).toBeUndefined();
		const pushed = committed(first.commit, start).tracks[0].clips[1];
		expect(pushed.transform.width).toBeCloseTo(3.16 * 1.2);
		expect(pushed.keyframes?.position).toHaveLength(2);
		expect(pushed.punch?.basePosition).toEqual(path);

		const second = fakeApi(committed(first.commit, start), assets);
		await createCreatorTools(second.api).add_punch_ins({ mode: "off" });
		const restored = committed(second.commit, committed(first.commit, start)).tracks[0]
			.clips[1];
		expect(restored.keyframes?.position).toEqual(path);
		expect(restored.transform.width).toBeCloseTo(3.16);
	});
});

describe("remove_words keeps every word it didn't cut", () => {
	it("doesn't drop a zero-length word from the rebuilt captions", async () => {
		// Local Whisper hands back some tokens with no duration ("punch" here).
		// Cutting a different word used to rebuild the captions without them.
		const words = [
			{ text: "is", startFrame: 0, endFrame: 8 },
			{ text: "punch", startFrame: 10, endFrame: 10 },
			{ text: "ins.", startFrame: 12, endFrame: 20 },
			{ text: "I", startFrame: 30, endFrame: 34 },
			{ text: "think", startFrame: 34, endFrame: 42 },
			{ text: "I", startFrame: 44, endFrame: 48 },
			{ text: "think", startFrame: 48, endFrame: 56 },
		];
		const caption = withDefaults({
			id: "cap",
			name: "Captions",
			mediaType: "text",
			startFrame: 0,
			endFrame: 60,
			captionGroupId: "g",
			captionWords: words,
		});
		const start = timelineWith([footageClip({ endFrame: 60 })]);
		start.tracks.unshift({
			id: "trk-cc-g",
			name: "CC",
			kind: "video",
			muted: false,
			hidden: false,
			clips: [caption],
		});
		const { api, commit } = fakeApi(start);
		const { createAgentTools } = await import("./agentTools");
		const result = await createAgentTools(api).remove_words({
			words: [[3, 4]],
			cutAggressiveness: "tight",
		});
		expect(result.isError).toBeFalsy();
		const { transcriptWords } = await import("./captions");
		const after = transcriptWords(committed(commit, start)).map((word) => word.text);
		expect(after).toEqual(["is", "punch", "ins.", "I", "think"]);
	});
});
