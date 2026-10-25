// Ducking the bed under narration.
//
// Written as volume keyframes rather than a new audio stage, because clipGainAt
// already reads them and feeds both playback and the export mixdown. The tests
// are about the shape of the automation: ramps so it doesn't gate, merging so it
// doesn't pump between close lines, and refusing spans too short to hold.

import { describe, expect, it } from "vitest";

import {
	buildDuckPlan,
	clipSourceWindow,
	sourceSpansToTimeline,
	splitVoiceAndBeds,
} from "./mixdown";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";

const bed = (over: Partial<Parameters<typeof withDefaults>[0]> = {}) =>
	withDefaults({
		id: "bed",
		name: "Screen recording",
		mediaType: "video",
		assetId: "a1",
		startFrame: 0,
		endFrame: 600,
		...over,
	});

describe("building a duck", () => {
	it("ramps down and back up around the line", () => {
		const plan = buildDuckPlan(bed(), [{ startFrame: 100, endFrame: 200 }], {
			amountDb: -12,
			rampFrames: 8,
		});
		expect(plan).not.toBeNull();
		// full, down, down, full — a gate would be just two points.
		expect(plan?.rows).toEqual([
			[92, 0],
			[100, -12],
			[200, -12],
			[208, 0],
		]);
	});

	it("ducks relative to the clip's own level, not to zero", () => {
		const plan = buildDuckPlan(bed({ volumeDb: -6 }), [{ startFrame: 100, endFrame: 200 }], {
			amountDb: -12,
		});
		// A clip already at -6 goes to -18, and returns to -6, not to 0.
		expect(plan?.rows.map(([, db]) => db)).toEqual([-6, -18, -18, -6]);
	});

	it("stays down between two lines that are close together", () => {
		// Lifting for a half-second gap and dipping again is audible pumping.
		const plan = buildDuckPlan(
			bed(),
			[
				{ startFrame: 100, endFrame: 200 },
				{ startFrame: 210, endFrame: 300 },
			],
			{ rampFrames: 8 },
		);
		expect(plan?.rows).toHaveLength(4);
		expect(plan?.rows[3][0]).toBe(308);
	});

	it("ducks twice when the lines are far apart", () => {
		const plan = buildDuckPlan(
			bed(),
			[
				{ startFrame: 100, endFrame: 200 },
				{ startFrame: 400, endFrame: 500 },
			],
			{ rampFrames: 8 },
		);
		expect(plan?.rows).toHaveLength(8);
	});

	it("clips the span to the clip it is ducking", () => {
		const plan = buildDuckPlan(bed({ startFrame: 150, endFrame: 400 }), [
			{ startFrame: 100, endFrame: 300 },
		]);
		// Frames are clip-relative, so the first row cannot be negative.
		expect(plan?.rows[0][0]).toBeGreaterThanOrEqual(0);
	});

	it("refuses a span too short to hold a ducked level", () => {
		// Shorter than two ramps means it would ramp down and straight back up.
		expect(
			buildDuckPlan(bed(), [{ startFrame: 100, endFrame: 110 }], { rampFrames: 8 }),
		).toBeNull();
	});

	it("returns nothing when no line overlaps the clip", () => {
		expect(
			buildDuckPlan(bed({ endFrame: 50 }), [{ startFrame: 100, endFrame: 200 }]),
		).toBeNull();
	});

	it("keeps rows ordered and one per frame", () => {
		const plan = buildDuckPlan(
			bed(),
			[
				{ startFrame: 300, endFrame: 400 },
				{ startFrame: 100, endFrame: 200 },
			],
			{ rampFrames: 8 },
		);
		const frames = plan?.rows.map(([frame]) => frame) ?? [];
		expect(frames).toEqual([...frames].sort((a, b) => a - b));
		expect(new Set(frames).size).toBe(frames.length);
	});
});

describe("ducking under the creator's own voice", () => {
	it("ramps down fast before speech and back up slowly after it", () => {
		const plan = buildDuckPlan(bed(), [{ startFrame: 100, endFrame: 200 }], {
			amountDb: -12,
			attackFrames: 5,
			releaseFrames: 18,
		});
		expect(plan?.rows).toEqual([
			[95, 0],
			[100, -12],
			[200, -12],
			[218, 0],
		]);
	});

	it("stays down across a pause shorter than a release plus an attack", () => {
		// A breath between sentences mustn't swell the music up and back.
		const plan = buildDuckPlan(
			bed(),
			[
				{ startFrame: 100, endFrame: 200 },
				{ startFrame: 220, endFrame: 300 },
			],
			{ attackFrames: 5, releaseFrames: 18 },
		);
		expect(plan?.rows).toHaveLength(4);
		// 30 frames apart is longer than 5 + 18, so that one lifts in between.
		const apart = buildDuckPlan(
			bed(),
			[
				{ startFrame: 100, endFrame: 200 },
				{ startFrame: 230, endFrame: 300 },
			],
			{ attackFrames: 5, releaseFrames: 18 },
		);
		expect(apart?.rows).toHaveLength(8);
	});

	it("ducks under a short phrase when the floor is lowered for speech", () => {
		const short = [{ startFrame: 100, endFrame: 110 }];
		expect(buildDuckPlan(bed(), short, { rampFrames: 8 })).toBeNull();
		expect(buildDuckPlan(bed(), short, { rampFrames: 8, minSpanFrames: 6 })).not.toBeNull();
	});
});

describe("telling the voice from the bed", () => {
	const timeline = (tracks: TimelineModel["tracks"]): TimelineModel => ({
		id: "t",
		name: "T",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks,
	});
	const track = (
		id: string,
		kind: "video" | "audio",
		name: string,
		clipIds: string[],
		over: Partial<TimelineModel["tracks"][number]> = {},
	) => ({
		id,
		kind,
		name,
		muted: false,
		hidden: false,
		clips: clipIds.map((clipId) =>
			bed({ id: clipId, mediaType: kind === "video" ? "video" : "audio" }),
		),
		...over,
	});

	it("treats camera footage as the voice and music as the bed", () => {
		const { voices, beds } = splitVoiceAndBeds(
			timeline([
				track("v", "video", "Video 1", ["cam"]),
				track("a", "audio", "Music", ["song"]),
			]),
		);
		expect(voices.map((clip) => clip.id)).toEqual(["cam"]);
		expect(beds.map((clip) => clip.id)).toEqual(["song"]);
	});

	it("counts an audio track named like a mic as voice, not bed", () => {
		const { voices, beds } = splitVoiceAndBeds(
			timeline([
				track("m", "audio", "Lav mic", ["lav"]),
				track("a", "audio", "Bed", ["song"]),
			]),
		);
		expect(voices.map((clip) => clip.id)).toEqual(["lav"]);
		expect(beds.map((clip) => clip.id)).toEqual(["song"]);
	});

	it("doesn't listen for speech on a muted track", () => {
		const { voices } = splitVoiceAndBeds(
			timeline([track("v", "video", "Video 1", ["cam"], { muted: true })]),
		);
		expect(voices).toEqual([]);
	});

	it("takes explicit lists over the guess, and never ducks a clip under itself", () => {
		const { voices, beds } = splitVoiceAndBeds(
			timeline([
				track("v", "video", "Video 1", ["cam", "broll"]),
				track("a", "audio", "Music", ["song"]),
			]),
			{ voiceClipIds: ["cam"], bedClipIds: ["broll", "cam", "song"] },
		);
		expect(voices.map((clip) => clip.id)).toEqual(["cam"]);
		expect(beds.map((clip) => clip.id)).toEqual(["broll", "song"]);
	});
});

describe("mapping speech in a source onto the timeline", () => {
	it("follows the clip's trim and speed, and clamps to the clip", () => {
		// Starts at frame 300, plays its source from 10 s, at double speed.
		const clip = bed({ startFrame: 300, endFrame: 600, trimStartFrame: 300, speed: 2 });
		expect(clipSourceWindow(clip, 30)).toEqual([10, 30]);
		const spans = sourceSpansToTimeline(
			clip,
			[
				[5, 9], // in the trimmed-off head: dropped
				[12, 14], // 2 s in at 2x, so timeline frames 330–360
				[28, 40], // runs past the clip's end: clamped
			],
			30,
		);
		expect(spans).toEqual([
			{ startFrame: 330, endFrame: 360 },
			{ startFrame: 570, endFrame: 600 },
		]);
	});
});
