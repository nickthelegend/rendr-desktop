import { describe, expect, it } from "vitest";

import { withDefaults } from "./model";
import {
	addTextClip,
	findClip,
	layoutClips,
	mergeRanges,
	rippleDelete,
	rippleShift,
	setClipEffects,
	setClipKeyframes,
	splitAt,
	type TimelineModel,
	totalFrames,
} from "./reducers";

/** Three clips laid end to end on V1, plus a music bed on A1. */
function timeline(): TimelineModel {
	const clip = (id: string, startFrame: number, endFrame: number) =>
		withDefaults({ id, name: id, mediaType: "video" as const, startFrame, endFrame });
	return {
		id: "tl",
		name: "Main",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks: [
			{
				id: "v1",
				name: "V1",
				kind: "video",
				muted: false,
				hidden: false,
				clips: [clip("a", 0, 100), clip("b", 100, 200), clip("c", 200, 300)],
			},
			{
				id: "a1",
				name: "A1",
				kind: "audio",
				muted: false,
				hidden: false,
				clips: [
					withDefaults({
						id: "music",
						name: "Music",
						mediaType: "audio",
						startFrame: 0,
						endFrame: 300,
					}),
				],
			},
		],
	};
}

const at = (t: TimelineModel, id: string) => {
	const clip = findClip(t, id);
	if (!clip) throw new Error(`missing ${id}`);
	return clip;
};

describe("mergeRanges", () => {
	it("merges overlapping ranges so a cut isn't counted twice", () => {
		expect(
			mergeRanges([
				[0, 10],
				[5, 20],
			]),
		).toEqual([[0, 20]]);
	});

	it("sorts and keeps disjoint ranges apart", () => {
		expect(
			mergeRanges([
				[50, 60],
				[0, 10],
			]),
		).toEqual([
			[0, 10],
			[50, 60],
		]);
	});

	it("joins ranges that only touch", () => {
		expect(
			mergeRanges([
				[0, 10],
				[10, 20],
			]),
		).toEqual([[0, 20]]);
	});

	it("drops empty and inverted ranges instead of cutting backwards", () => {
		expect(
			mergeRanges([
				[10, 10],
				[30, 20],
			]),
		).toEqual([[20, 30]]);
	});
});

describe("rippleShift", () => {
	it("moves everything at or after the point and leaves the rest", () => {
		const next = rippleShift(timeline(), 100, 50);
		expect(at(next, "a").startFrame).toBe(0);
		expect(at(next, "b").startFrame).toBe(150);
		expect(at(next, "c").startFrame).toBe(250);
	});

	it("shifts every track, so a music bed keeps its sync", () => {
		const next = rippleShift(timeline(), 0, 30);
		expect(at(next, "music").startFrame).toBe(30);
	});

	it("leaves exempt tracks where they are", () => {
		const next = rippleShift(timeline(), 0, 30, ["a1"]);
		expect(at(next, "music").startFrame).toBe(0);
		expect(at(next, "a").startFrame).toBe(30);
	});

	it("leaves a clip that spans the point where it is", () => {
		const next = rippleShift(timeline(), 150, 40);
		expect([at(next, "b").startFrame, at(next, "b").endFrame]).toEqual([100, 200]);
		expect(at(next, "c").startFrame).toBe(240);
	});

	it("never pushes anything past frame 0, and moves the group together", () => {
		const next = rippleShift(timeline(), 100, -500);
		expect(at(next, "b").startFrame).toBe(0);
		// 'c' moved by the same clamped amount, so the join it made is preserved.
		expect(at(next, "c").startFrame).toBe(100);
	});

	it("is identity for a zero shift", () => {
		const source = timeline();
		expect(rippleShift(source, 100, 0)).toBe(source);
	});
});

describe("rippleDelete", () => {
	it("cuts a whole clip and closes the gap behind it", () => {
		const { timeline: next, removedFrames } = rippleDelete(timeline(), [[100, 200]]);
		expect(removedFrames).toBe(100);
		expect(findClip(next, "b")).toBeNull();
		expect(at(next, "c").startFrame).toBe(100);
		expect(totalFrames(next)).toBe(200);
	});

	it("cuts a span out of the middle of a clip and keeps both halves", () => {
		const { timeline: next } = rippleDelete(timeline(), [[120, 150]]);
		expect(at(next, "b").endFrame).toBe(120);
		const tail = at(next, "b-r150");
		expect(tail.startFrame).toBe(120);
		// The tail resumes 150 frames into the source, not at its start.
		expect(tail.trimStartFrame).toBe(50);
	});

	it("applies several ranges in one pass without the earlier ones drifting", () => {
		const { timeline: next, removedFrames } = rippleDelete(timeline(), [
			[0, 50],
			[250, 300],
		]);
		expect(removedFrames).toBe(100);
		expect(totalFrames(next)).toBe(200);
		expect(at(next, "a").startFrame).toBe(0);
		expect(at(next, "a").endFrame).toBe(50);
	});

	it("counts overlapping ranges once", () => {
		const { removedFrames } = rippleDelete(timeline(), [
			[0, 60],
			[40, 100],
		]);
		expect(removedFrames).toBe(100);
	});

	it("cuts the music bed too, so audio doesn't drift out of sync", () => {
		const { timeline: next } = rippleDelete(timeline(), [[100, 150]]);
		// The bed is split at the cut and its tail slides back to meet the head.
		expect(at(next, "music").endFrame).toBe(100);
		expect(at(next, "music-r150").startFrame).toBe(100);
		expect(totalFrames(next)).toBe(250);
	});

	it("leaves an exempt track untouched — no cut and no shift", () => {
		const { timeline: next } = rippleDelete(timeline(), [[100, 150]], {
			exemptTrackIds: ["a1"],
		});
		expect(at(next, "music").startFrame).toBe(0);
		expect(at(next, "music").endFrame).toBe(300);
		expect(at(next, "c").startFrame).toBe(150);
	});

	it("restricts the cut to one track when asked, and still ripples the rest", () => {
		const { timeline: next } = rippleDelete(timeline(), [[100, 200]], { trackId: "v1" });
		expect(findClip(next, "b")).toBeNull();
		// The bed keeps all 300 frames of content; it just isn't pushed anywhere,
		// because it starts before the cut.
		expect(at(next, "music").endFrame).toBe(300);
		expect(at(next, "c").startFrame).toBe(100);
	});

	it("is a no-op for no ranges", () => {
		const source = timeline();
		expect(rippleDelete(source, []).timeline).toBe(source);
	});

	it("drops a remnant too short to be a clip rather than leaving a sliver", () => {
		const { timeline: next } = rippleDelete(timeline(), [[1, 100]]);
		// Only frame 0 of 'a' would survive, which is below the minimum.
		expect(findClip(next, "a")).toBeNull();
	});
});

describe("setClipEffects", () => {
	it("stores a merged stack on the named clips", () => {
		const next = setClipEffects(timeline(), ["a"], [{ type: "blur.gaussian", params: {} }]);
		expect(at(next, "a").effects?.[0].type).toBe("blur.gaussian");
		expect(at(next, "b").effects).toBeUndefined();
	});

	it("clears the field entirely when the last effect is removed", () => {
		const withBlur = setClipEffects(timeline(), ["a"], [{ type: "blur.gaussian", params: {} }]);
		const cleared = setClipEffects(withBlur, ["a"], [], ["blur.gaussian"]);
		expect(at(cleared, "a").effects).toBeUndefined();
	});

	it("leaves audio clips alone — there is no picture to filter", () => {
		const next = setClipEffects(timeline(), ["music"], [{ type: "blur.gaussian", params: {} }]);
		expect(at(next, "music").effects).toBeUndefined();
	});
});

describe("setClipKeyframes", () => {
	it("stores a track and reports it as animated", () => {
		const next = setClipKeyframes(timeline(), "a", "opacity", [
			{ frame: 0, values: [0], interp: "linear" },
		]);
		expect(at(next, "a").keyframes?.opacity).toHaveLength(1);
	});

	it("drops the whole keyframes field when the last track is cleared", () => {
		const withTrack = setClipKeyframes(timeline(), "a", "opacity", [
			{ frame: 0, values: [0], interp: "linear" },
		]);
		expect(at(setClipKeyframes(withTrack, "a", "opacity", []), "a").keyframes).toBeUndefined();
	});

	it("replaces one property's track without touching another's", () => {
		let next = setClipKeyframes(timeline(), "a", "opacity", [
			{ frame: 0, values: [0], interp: "linear" },
		]);
		next = setClipKeyframes(next, "a", "rotation", [
			{ frame: 0, values: [90], interp: "linear" },
		]);
		next = setClipKeyframes(next, "a", "opacity", []);
		expect(at(next, "a").keyframes?.rotation).toHaveLength(1);
		expect(at(next, "a").keyframes?.opacity).toBeUndefined();
	});
});

describe("layoutClips", () => {
	it("writes transform and crop together for every placed clip", () => {
		const placements = new Map([
			[
				"a",
				{
					transform: {
						centerX: 0.25,
						centerY: 0.5,
						width: 0.5,
						height: 1,
						rotation: 0,
						flipHorizontal: false,
						flipVertical: false,
					},
					crop: { top: 0, right: 0.25, bottom: 0, left: 0.25 },
				},
			],
		]);
		const next = layoutClips(timeline(), placements);
		expect(at(next, "a").transform.centerX).toBe(0.25);
		expect(at(next, "a").crop.left).toBe(0.25);
		expect(at(next, "b").transform.centerX).toBe(0.5);
	});
});

describe("insert then ripple-delete", () => {
	/** The shape insert_clips builds: split at the point, then push the tail. */
	function insertAt(t: TimelineModel, atFrame: number, frames: number): TimelineModel {
		const split = splitAt(t, atFrame);
		const shifted = rippleShift(split, atFrame, frames);
		return {
			...shifted,
			tracks: shifted.tracks.map((track) =>
				track.id === "v1"
					? {
							...track,
							clips: [
								...track.clips,
								withDefaults({
									id: "inserted",
									name: "inserted",
									mediaType: "video",
									startFrame: atFrame,
									endFrame: atFrame + frames,
								}),
							].sort((x, y) => x.startFrame - y.startFrame),
						}
					: track,
			),
		};
	}

	it("never leaves two clips overlapping on one track", () => {
		let next = insertAt(timeline(), 150, 60);
		next = rippleDelete(next, [[10, 40]]).timeline;

		for (const track of next.tracks) {
			const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
			for (let index = 1; index < sorted.length; index++) {
				expect(
					sorted[index].startFrame,
					`${sorted[index - 1].id} → ${sorted[index].id} on ${track.name}`,
				).toBeGreaterThanOrEqual(sorted[index - 1].endFrame);
			}
		}
	});

	it("splits the clip the gap opens inside, rather than covering it", () => {
		const next = insertAt(timeline(), 150, 60);
		// 'b' spanned 100–200; its head keeps 100–150 and its tail moves to 210.
		expect(at(next, "b").endFrame).toBe(150);
		expect(at(next, "b-b150").startFrame).toBe(210);
		expect(at(next, "inserted").startFrame).toBe(150);
	});
});

describe("addTextClip", () => {
	it("uses a free video track when there is one", () => {
		const empty: TimelineModel = {
			...timeline(),
			tracks: [
				{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips: [] },
			],
		};
		const result = addTextClip(empty, 0, 30, "t1", "Title");
		expect(result.timeline.tracks).toHaveLength(1);
		expect(at(result.timeline, "t1").mediaType).toBe("text");
	});

	it("never cuts a hole in the footage it overlays", () => {
		const result = addTextClip(timeline(), 10, 80, "t1", "Title");
		// Every original clip survives, whole.
		for (const id of ["a", "b", "c"]) {
			expect(at(result.timeline, id).startFrame, id).toBe(at(timeline(), id).startFrame);
			expect(at(result.timeline, id).endFrame, id).toBe(at(timeline(), id).endFrame);
		}
	});

	it("puts the new track on top, where an overlay belongs", () => {
		const result = addTextClip(timeline(), 10, 80, "t1", "Title");
		expect(result.timeline.tracks[0].clips[0].id).toBe("t1");
		expect(result.timeline.tracks).toHaveLength(3);
	});

	it("reuses that same track for a title that doesn't overlap", () => {
		const first = addTextClip(timeline(), 0, 50, "t1", "One").timeline;
		const second = addTextClip(first, 100, 50, "t2", "Two").timeline;
		expect(second.tracks).toHaveLength(3);
		expect(second.tracks[0].clips.map((clip) => clip.id)).toEqual(["t1", "t2"]);
	});

	it("adds another track when the titles do overlap", () => {
		const first = addTextClip(timeline(), 0, 50, "t1", "One").timeline;
		const second = addTextClip(first, 20, 50, "t2", "Two").timeline;
		expect(second.tracks).toHaveLength(4);
	});
});
