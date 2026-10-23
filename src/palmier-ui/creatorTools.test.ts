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

	it("puts a 'behind' graphic directly under the speaker and moves their colour backdrop onto it", () => {
		const start = timelineWith([
			footageClip({ background: { mode: "color", color: "#0B4F3C" } }),
		]);
		const placed = placeGraphic(start, {
			id: "g",
			name: "Map",
			spec,
			startFrame: 0,
			endFrame: 90,
			layer: "behind",
		});
		const [top, below] = placed.timeline.tracks;
		expect(top.id).toBe("v1");
		expect(top.clips[0].background?.mode).toBe("remove");
		expect(below.clips[0].graphic?.background).toBe("#0B4F3C");
		expect(placed.movedBackgroundFrom).toBe("cam");
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
		expect(graphic.graphic?.background).toBe("#0B4F3C");
		// Long enough for six staggered cards to land and be read.
		expect(graphic.endFrame).toBeGreaterThan(30 * 5);
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
