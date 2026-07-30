// Cross-dissolves.
//
// Built from fades because those already render: overlap the two clips and give
// the outgoing one a fade-out and the incoming one a matching fade-in. The
// tests are mostly about refusing a dissolve that cannot honestly be made — one
// longer than the clips it joins, or one that needs source footage that isn't
// there.

import { describe, expect, it } from "vitest";

import { withDefaults } from "./model";
import { addTransition, removeTransition, type TimelineModel } from "./reducers";

/** Two touching clips, each with source either side of its in/out points. */
function cut(over: { outLen?: number; inLen?: number; trim?: number } = {}): TimelineModel {
	const outLen = over.outLen ?? 120;
	const inLen = over.inLen ?? 120;
	const trim = over.trim ?? 60;
	return {
		id: "t",
		name: "T",
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
				clips: [
					withDefaults({
						id: "a",
						name: "A",
						mediaType: "video",
						assetId: "m1",
						startFrame: 0,
						endFrame: outLen,
					}),
					withDefaults({
						id: "b",
						name: "B",
						mediaType: "video",
						assetId: "m1",
						startFrame: outLen,
						endFrame: outLen + inLen,
						trimStartFrame: trim,
					}),
				],
			},
		],
	};
}

const clip = (t: TimelineModel, id: string) =>
	t.tracks.flatMap((track) => track.clips).find((c) => c.id === id);

describe("adding a dissolve", () => {
	it("overlaps the clips and fades both across the overlap", () => {
		const result = addTransition(cut(), 120, 20);
		expect(result.error).toBeUndefined();
		expect(result.between).toEqual(["a", "b"]);

		const a = clip(result.timeline, "a");
		const b = clip(result.timeline, "b");
		expect(a?.fadeOutFrames).toBe(20);
		expect(b?.fadeInFrames).toBe(20);
		// The incoming clip is pulled earlier, so the two genuinely overlap.
		expect(b?.startFrame).toBe(100);
		expect(a?.endFrame).toBe(120);
	});

	it("pulls the source back with the clip, so the picture doesn't jump", () => {
		const b = clip(addTransition(cut({ trim: 60 }), 120, 20).timeline, "b");
		// Started 60 frames into its source; pulled back 20, so 40 now.
		expect(b?.trimStartFrame).toBe(40);
	});

	it("leaves the outgoing clip's own start alone", () => {
		const a = clip(addTransition(cut(), 120, 20).timeline, "a");
		expect(a?.startFrame).toBe(0);
	});
});

describe("refusing a dissolve that can't be made", () => {
	it("refuses one longer than the clips it joins", () => {
		const result = addTransition(cut({ outLen: 15, inLen: 15 }), 15, 30);
		expect(result.error).toContain("doesn't fit");
		// Nothing changed, so a caller that ignores the error can't corrupt it.
		expect(clip(result.timeline, "a")?.fadeOutFrames).toBe(0);
	});

	it("refuses when the incoming clip has no source to pull back into", () => {
		const result = addTransition(cut({ trim: 5 }), 120, 20);
		expect(result.error).toContain("frames of source before its start");
		expect(clip(result.timeline, "b")?.startFrame).toBe(120);
	});

	it("refuses a zero or negative length", () => {
		expect(addTransition(cut(), 120, 0).error).toContain("at least one frame");
		expect(addTransition(cut(), 120, -5).error).toContain("at least one frame");
	});

	it("says there is no cut when the clips don't touch", () => {
		const gapped = cut();
		gapped.tracks[0].clips[1] = {
			...gapped.tracks[0].clips[1],
			startFrame: 200,
			endFrame: 320,
		};
		const result = addTransition(gapped, 120, 20);
		expect(result.error).toContain("No cut at frame");
	});

	it("says there is no cut when asked at a frame with no edit", () => {
		expect(addTransition(cut(), 60, 20).error).toContain("No cut at frame");
	});
});

describe("removing a dissolve", () => {
	it("restores the hard cut's fades to zero", () => {
		const withDissolve = addTransition(cut(), 120, 20).timeline;
		const after = removeTransition(withDissolve, "a");
		expect(clip(after, "a")?.fadeOutFrames).toBe(0);
	});
});
