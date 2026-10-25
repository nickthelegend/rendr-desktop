// Where dropped footage lands, and what shape the project takes from it.
//
// Two ways a phone video used to go wrong before a single edit: the project
// stayed 1920×1080 and centre-cropped a vertical face into a landscape strip,
// and once captions existed a drop landed on the caption track and deleted the
// captions it covered.

import { describe, expect, it } from "vitest";

import type { AssetModel } from "./media";
import { withDefaults } from "./model";
import {
	adoptFootageFormat,
	DEFAULT_CANVAS,
	footageTrackIndex,
	isOverlayTrack,
	snapFps,
	withFootageTrack,
} from "./placement";
import type { TimelineModel, TrackModel } from "./reducers";

const phone: AssetModel = {
	id: "p",
	name: "IMG_0042.MOV",
	type: "video",
	durationSeconds: 30,
	width: 1080,
	height: 1920,
	fps: 29.97,
	hasAudio: true,
	url: "blob:p",
};

const track = (over: Partial<TrackModel>): TrackModel => ({
	id: "v1",
	name: "V1",
	kind: "video",
	muted: false,
	hidden: false,
	clips: [],
	...over,
});

const empty = (over: Partial<TimelineModel> = {}): TimelineModel => ({
	id: "t",
	name: "Main",
	...DEFAULT_CANVAS,
	tracks: [track({}), track({ id: "a1", name: "A1", kind: "audio" })],
	...over,
});

const caption = withDefaults({
	id: "cap",
	name: "Caption",
	mediaType: "text",
	startFrame: 0,
	endFrame: 30,
	captionGroupId: "g",
});

const take = withDefaults({
	id: "take",
	name: "Take",
	mediaType: "video",
	assetId: "p",
	startFrame: 0,
	endFrame: 90,
});

describe("snapFps", () => {
	it("snaps measured and fractional rates to the rate they were shot at", () => {
		expect(snapFps(29.97)).toBe(30);
		expect(snapFps(29.6)).toBe(30);
		expect(snapFps(23.976)).toBe(24);
		expect(snapFps(59.94)).toBe(60);
		expect(snapFps(25)).toBe(25);
	});

	it("rounds a rate that is no standard one, and survives nonsense", () => {
		expect(snapFps(15.2)).toBe(15);
		expect(snapFps(Number.NaN)).toBe(DEFAULT_CANVAS.fps);
		expect(snapFps(0)).toBe(DEFAULT_CANVAS.fps);
	});
});

describe("adoptFootageFormat", () => {
	it("never makes a project smaller than 1080 on its short edge", () => {
		// A 360p stock clip keeps its 16:9 shape but not its resolution — captions
		// and graphics drawn at 640×360 would come out soft.
		const small = adoptFootageFormat(empty(), { ...phone, width: 640, height: 360, fps: 30 });
		expect([small.width, small.height]).toEqual([1920, 1080]);
		const tall = adoptFootageFormat(empty(), { ...phone, width: 540, height: 960 });
		expect([tall.width, tall.height]).toEqual([1080, 1920]);
	});

	it("makes an empty default project vertical for vertical footage", () => {
		const next = adoptFootageFormat(empty(), phone);
		expect([next.width, next.height, next.fps]).toEqual([1080, 1920, 30]);
	});

	it("takes a 60 fps clip's rate", () => {
		const next = adoptFootageFormat(empty(), { ...phone, fps: 59.94 });
		expect(next.fps).toBe(60);
	});

	it("keeps the project's rate when the footage couldn't say", () => {
		const next = adoptFootageFormat(empty(), { ...phone, fps: undefined });
		expect(next.fps).toBe(DEFAULT_CANVAS.fps);
		expect(next.height).toBe(1920);
	});

	it("holds a huge master to a 4K short edge, in even numbers", () => {
		const next = adoptFootageFormat(empty(), { ...phone, width: 3241, height: 5761 });
		expect(next.width).toBe(2160);
		expect(next.height % 2).toBe(0);
		expect(next.height / next.width).toBeCloseTo(5761 / 3241, 2);
	});

	it("never reshapes a timeline that already has clips", () => {
		const busy = empty({ tracks: [track({ clips: [take] })] });
		expect(adoptFootageFormat(busy, phone)).toBe(busy);
	});

	it("respects a canvas someone chose", () => {
		const chosen = empty({ width: 1080, height: 1080 });
		expect(adoptFootageFormat(chosen, { ...phone, width: 1920, height: 1080 })).toBe(chosen);
	});

	it("ignores stills and audio", () => {
		const timeline = empty();
		expect(adoptFootageFormat(timeline, { ...phone, type: "image" })).toBe(timeline);
		expect(adoptFootageFormat(timeline, { ...phone, type: "audio" })).toBe(timeline);
	});
});

describe("footageTrackIndex", () => {
	it("skips the caption track stacked on top", () => {
		const timeline = empty({
			tracks: [
				track({ id: "trk-cc-g", name: "CC", clips: [caption] }),
				track({ clips: [take] }),
				track({ id: "a1", name: "A1", kind: "audio" }),
			],
		});
		expect(footageTrackIndex(timeline)).toBe(1);
	});

	it("skips a graphics track sitting behind the speaker", () => {
		const map = withDefaults({
			id: "map",
			name: "mind map",
			mediaType: "graphic",
			startFrame: 0,
			endFrame: 90,
		});
		const timeline = empty({
			tracks: [
				track({ clips: [take] }),
				track({ id: "trk-graphic-map", name: "Graphics (behind)", clips: [map] }),
				track({ id: "a1", name: "A1", kind: "audio" }),
			],
		});
		expect(footageTrackIndex(timeline)).toBe(0);
	});

	it("skips an empty caption or title track by its id", () => {
		const timeline = empty({
			tracks: [
				track({ id: "trk-text-1", name: "T1" }),
				track({ id: "trk-cc-g", name: "CC" }),
				track({}),
			],
		});
		expect(footageTrackIndex(timeline)).toBe(2);
	});

	it("prefers the base of the stack that already holds the take", () => {
		const broll = withDefaults({ ...take, id: "broll" });
		const timeline = empty({
			tracks: [track({ id: "v2", name: "V2", clips: [broll] }), track({ clips: [take] })],
		});
		expect(footageTrackIndex(timeline)).toBe(1);
	});

	it("treats a track of only text as an overlay", () => {
		const title = withDefaults({
			id: "title",
			name: "Title",
			mediaType: "text",
			startFrame: 0,
			endFrame: 30,
		});
		expect(isOverlayTrack(track({ id: "v9", clips: [title] }))).toBe(true);
		expect(isOverlayTrack(track({ clips: [take] }))).toBe(false);
	});
});

describe("withFootageTrack", () => {
	it("adds a footage track under the captions when there is none", () => {
		const timeline = empty({
			tracks: [
				track({ id: "trk-cc-g", name: "CC", clips: [caption] }),
				track({ id: "a1", name: "A1", kind: "audio" }),
			],
		});
		const { timeline: next, index } = withFootageTrack(timeline);
		expect(index).toBe(1);
		expect(next.tracks[index].kind).toBe("video");
		expect(isOverlayTrack(next.tracks[index])).toBe(false);
		// The captions are still on top, and still there.
		expect(next.tracks[0].clips).toEqual([caption]);
	});
});
