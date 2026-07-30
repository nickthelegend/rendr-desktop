// Ducking the bed under narration.
//
// Written as volume keyframes rather than a new audio stage, because clipGainAt
// already reads them and feeds both playback and the export mixdown. The tests
// are about the shape of the automation: ramps so it doesn't gate, merging so it
// doesn't pump between close lines, and refusing spans too short to hold.

import { describe, expect, it } from "vitest";

import { buildDuckPlan } from "./mixdown";
import { withDefaults } from "./model";

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
