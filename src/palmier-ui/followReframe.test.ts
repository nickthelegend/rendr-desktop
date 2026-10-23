// A vertical crop that follows the cursor.
//
// Centring a 16:9 recording into 9:16 shows the middle of the screen, which is
// often not where the work is. These tests are about the two things that make
// following watchable rather than nauseating: smoothing, so it doesn't mirror
// every flick of the wrist, and clamping, so the crop never exposes an edge.

import { describe, expect, it } from "vitest";

import { clipAtFrame } from "./keyframes";
import { withDefaults } from "./model";
import { followKeyframes } from "./workflowRun";

const base = {
	clipStartFrame: 0,
	clipEndFrame: 300,
	trimStartFrame: 0,
	fps: 30,
	width: 3.16, // 16:9 into 9:16
};

/** Telemetry with the pointer parked at one x. */
function parked(cx: number) {
	return Array.from({ length: 200 }, (_, i) => ({ timeMs: i * 50, cx, cy: 0.5 }));
}

describe("following the cursor", () => {
	it("moves the crop toward the side the cursor is on", () => {
		// Pointer on the left means the crop must move right in transform space
		// to bring the left of the frame into shot.
		const left = followKeyframes(parked(0.15), base);
		const right = followKeyframes(parked(0.85), base);
		expect(left[0].values[0]).toBeGreaterThan(right[0].values[0]);
	});

	it("centres when the cursor is centred", () => {
		// Rows are the top-left corner, so a centred box sits half its width
		// left of the middle.
		const keys = followKeyframes(parked(0.5), base);
		for (const key of keys) expect(key.values[0] + base.width / 2).toBeCloseTo(0.5, 3);
	});

	it("never exposes an edge, however far out the cursor goes", () => {
		// The footage's left edge may never come past the frame's, nor its
		// right edge fall short of the frame's.
		for (const cx of [0, 1, -0.5, 1.5]) {
			for (const key of followKeyframes(parked(cx), base)) {
				expect(key.values[0]).toBeLessThanOrEqual(1e-6);
				expect(key.values[0] + base.width).toBeGreaterThanOrEqual(1 - 1e-6);
			}
		}
	});

	it("smooths a jittery hand instead of mirroring it", () => {
		// Alternating hard left/right every sample: following this literally
		// would be unwatchable.
		const jitter = Array.from({ length: 200 }, (_, i) => ({
			timeMs: i * 50,
			cx: i % 2 === 0 ? 0.1 : 0.9,
			cy: 0.5,
		}));
		const keys = followKeyframes(jitter, base);
		const spread =
			Math.max(...keys.map((k) => k.values[0])) - Math.min(...keys.map((k) => k.values[0]));
		// Raw following would swing the full travel; smoothed stays near centre.
		expect(spread).toBeLessThan((base.width - 1) / 2);
	});

	it("keeps vertical centred, since the crop only moves sideways", () => {
		// A full-height box centred vertically has its top at the frame's top.
		for (const key of followKeyframes(parked(0.2), base)) {
			expect(key.values[1]).toBe(0);
		}
	});

	it("keeps the pointer in shot once the rows are played back", () => {
		// The rows are only right if the reader that plays them agrees: the
		// point of the footage under the pointer must land inside the frame.
		const still = withDefaults({
			id: "c",
			name: "Take",
			mediaType: "video",
			assetId: "a",
			startFrame: 0,
			endFrame: 300,
		});
		for (const cx of [0.05, 0.3, 0.5, 0.7, 0.95]) {
			const [key] = followKeyframes(parked(cx), base);
			const clip = {
				...still,
				transform: { ...still.transform, width: base.width, height: 1 },
				keyframes: { position: [key] },
			};
			const at = clipAtFrame(clip, 0).transform;
			const pointerOnCanvas = at.centerX - at.width / 2 + cx * at.width;
			expect(pointerOnCanvas).toBeGreaterThanOrEqual(0);
			expect(pointerOnCanvas).toBeLessThanOrEqual(1);
			expect(at.centerY).toBeCloseTo(0.5, 6);
		}
	});

	it("samples sparsely rather than keying every frame", () => {
		const keys = followKeyframes(parked(0.3), { ...base, everyFrames: 12 });
		expect(keys.length).toBeLessThan(30);
		expect(keys[0].frame).toBe(0);
		expect(keys[1].frame).toBe(12);
	});

	it("reads the source time, so a trimmed clip follows the right moment", () => {
		// A clip trimmed 5s in must sample telemetry from 5s, not from 0.
		const moving = Array.from({ length: 400 }, (_, i) => ({
			timeMs: i * 50,
			cx: i * 50 < 5000 ? 0.1 : 0.9,
			cy: 0.5,
		}));
		const untrimmed = followKeyframes(moving, base);
		const trimmed = followKeyframes(moving, { ...base, trimStartFrame: 150 });
		expect(untrimmed[0].values[0]).not.toBeCloseTo(trimmed[0].values[0], 2);
	});

	it("does nothing when the footage already fits", () => {
		// width 1 means no crop travel is possible, so keys would be pointless.
		expect(followKeyframes(parked(0.2), { ...base, width: 1 })).toEqual([]);
	});

	it("does nothing without telemetry", () => {
		expect(followKeyframes([], base)).toEqual([]);
	});
});
