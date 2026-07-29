import { describe, expect, it } from "vitest";

import {
	animatedProperties,
	clipAtFrame,
	clipOpacityAt,
	fadeMultiplierAt,
	hasKeyframes,
	keyframeRows,
	parseKeyframeRows,
	sampleTrack,
} from "./keyframes";
import { withDefaults } from "./model";

const clip = (extra: Partial<ReturnType<typeof withDefaults>> = {}) =>
	withDefaults({
		id: "c1",
		name: "Clip",
		mediaType: "video",
		startFrame: 100,
		endFrame: 200,
		...extra,
	});

describe("parseKeyframeRows", () => {
	it("accepts the documented row shape and defaults to smooth", () => {
		const result = parseKeyframeRows("opacity", [
			[0, 0],
			[30, 1],
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keyframes[0].interp).toBe("smooth");
	});

	it("reads a trailing interpolation name", () => {
		const result = parseKeyframeRows("opacity", [[0, 0, "hold"]]);
		expect(result.ok && result.keyframes[0].interp).toBe("hold");
	});

	it("names the offending row when the arity is wrong", () => {
		const result = parseKeyframeRows("position", [[0, 0.5]]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("keyframes[0]");
		expect(result.reason).toContain("position");
	});

	it("rejects an unknown interpolation instead of silently defaulting", () => {
		const result = parseKeyframeRows("opacity", [[0, 1, "bouncy"]]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("bouncy");
	});

	it("rejects non-finite values", () => {
		const result = parseKeyframeRows("opacity", [[0, Number.NaN]]);
		expect(result.ok).toBe(false);
	});

	it("sorts by frame and lets the last duplicate win", () => {
		const result = parseKeyframeRows("opacity", [
			[30, 1],
			[0, 0.1],
			[30, 0.5],
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keyframes.map((k) => k.frame)).toEqual([0, 30]);
		expect(result.keyframes[1].values[0]).toBe(0.5);
	});

	it("round-trips through keyframeRows", () => {
		const parsed = parseKeyframeRows("scale", [[0, 1, 1, "linear"]]);
		expect(parsed.ok && keyframeRows(parsed.keyframes)).toEqual([[0, 1, 1, "linear"]]);
	});
});

describe("sampleTrack", () => {
	const track = [
		{ frame: 0, values: [0], interp: "linear" as const },
		{ frame: 10, values: [1], interp: "linear" as const },
	];

	it("holds the first and last values outside the track", () => {
		expect(sampleTrack(track, -50)).toEqual([0]);
		expect(sampleTrack(track, 500)).toEqual([1]);
	});

	it("interpolates linearly between two keys", () => {
		expect(sampleTrack(track, 5)?.[0]).toBeCloseTo(0.5, 6);
	});

	it("hold keeps the leading value until the next key", () => {
		const held = [
			{ frame: 0, values: [0], interp: "hold" as const },
			{ frame: 10, values: [1], interp: "hold" as const },
		];
		expect(sampleTrack(held, 9)?.[0]).toBe(0);
		expect(sampleTrack(held, 10)?.[0]).toBe(1);
	});

	it("smooth eases in and out but hits the midpoint dead centre", () => {
		const smooth = [
			{ frame: 0, values: [0], interp: "smooth" as const },
			{ frame: 10, values: [1], interp: "smooth" as const },
		];
		expect(sampleTrack(smooth, 5)?.[0]).toBeCloseTo(0.5, 6);
		// Eased motion lags a linear ramp early on.
		expect(sampleTrack(smooth, 2)?.[0]).toBeLessThan(0.2);
	});

	it("returns null for an empty track", () => {
		expect(sampleTrack([], 0)).toBeNull();
		expect(sampleTrack(undefined, 0)).toBeNull();
	});
});

describe("clipAtFrame", () => {
	it("returns the same object when nothing is animated", () => {
		const source = clip();
		expect(clipAtFrame(source, 150)).toBe(source);
	});

	it("reads frames relative to the clip, not the timeline", () => {
		const animated = clip({
			keyframes: {
				opacity: [
					{ frame: 0, values: [0], interp: "linear" },
					{ frame: 100, values: [1], interp: "linear" },
				],
			},
		});
		// The clip starts at frame 100, so timeline frame 150 is local 50.
		expect(clipAtFrame(animated, 150).opacity).toBeCloseTo(0.5, 6);
		expect(clipAtFrame(animated, 100).opacity).toBe(0);
	});

	it("converts a position row's top-left corner into the model's centre", () => {
		const animated = clip({
			keyframes: {
				position: [{ frame: 0, values: [0, 0], interp: "hold" }],
				scale: [{ frame: 0, values: [0.5, 0.5], interp: "hold" }],
			},
		});
		const at = clipAtFrame(animated, 100);
		expect(at.transform.width).toBe(0.5);
		expect(at.transform.centerX).toBeCloseTo(0.25, 6);
		expect(at.transform.centerY).toBeCloseTo(0.25, 6);
	});

	it("clamps opposite crop insets so the clip can't invert", () => {
		const animated = clip({
			keyframes: {
				crop: [{ frame: 0, values: [0.9, 0, 0.9, 0], interp: "hold" }],
			},
		});
		const at = clipAtFrame(animated, 100);
		expect(at.crop.top + at.crop.bottom).toBeLessThanOrEqual(0.98 + 1e-9);
	});

	it("clamps animated values to the same limits the inspector enforces", () => {
		const animated = clip({
			keyframes: {
				opacity: [{ frame: 0, values: [5], interp: "hold" }],
				volumeDb: [{ frame: 0, values: [999], interp: "hold" }],
			},
		});
		const at = clipAtFrame(animated, 100);
		expect(at.opacity).toBe(1);
		expect(at.volumeDb).toBe(15);
	});

	it("leaves un-animated properties alone", () => {
		const animated = clip({
			opacity: 0.4,
			keyframes: { rotation: [{ frame: 0, values: [45], interp: "hold" }] },
		});
		const at = clipAtFrame(animated, 100);
		expect(at.opacity).toBe(0.4);
		expect(at.transform.rotation).toBe(45);
	});
});

describe("hasKeyframes / animatedProperties", () => {
	it("reports nothing for a plain clip", () => {
		expect(hasKeyframes(clip())).toBe(false);
		expect(animatedProperties(clip())).toEqual([]);
	});

	it("ignores an empty track", () => {
		const empty = clip({ keyframes: { opacity: [] } });
		expect(hasKeyframes(empty)).toBe(false);
		expect(animatedProperties(empty)).toEqual([]);
	});

	it("lists what is actually animated", () => {
		const animated = clip({
			keyframes: {
				opacity: [{ frame: 0, values: [1], interp: "hold" }],
				rotation: [{ frame: 0, values: [0], interp: "hold" }],
			},
		});
		expect(animatedProperties(animated).sort()).toEqual(["opacity", "rotation"]);
	});
});

describe("fadeMultiplierAt / clipOpacityAt", () => {
	it("is 1 for a clip with no fades", () => {
		expect(fadeMultiplierAt(clip(), 150)).toBe(1);
	});

	it("ramps in from zero over the fade's length", () => {
		const faded = clip({ fadeInFrames: 10 });
		expect(fadeMultiplierAt(faded, 100)).toBe(0);
		expect(fadeMultiplierAt(faded, 105)).toBeCloseTo(0.5, 5);
		expect(fadeMultiplierAt(faded, 110)).toBe(1);
	});

	it("reaches zero on the clip's last frame, not past its end", () => {
		const faded = clip({ fadeOutFrames: 10 });
		// The clip spans 100–200, so frame 199 is its last.
		expect(fadeMultiplierAt(faded, 199)).toBe(0);
		expect(fadeMultiplierAt(faded, 194)).toBeCloseTo(0.5, 5);
		expect(fadeMultiplierAt(faded, 189)).toBe(1);
	});

	it("eases when asked to, and hits the midpoint either way", () => {
		const linear = clip({ fadeInFrames: 10 });
		const smooth = clip({ fadeInFrames: 10, fadeInInterpolation: "smooth" });
		expect(fadeMultiplierAt(smooth, 105)).toBeCloseTo(0.5, 5);
		// An eased ramp starts slower than a straight one.
		expect(fadeMultiplierAt(smooth, 102)).toBeLessThan(fadeMultiplierAt(linear, 102));
	});

	it("multiplies overlapping fades rather than letting one win", () => {
		const both = clip({ startFrame: 0, endFrame: 10, fadeInFrames: 10, fadeOutFrames: 10 });
		expect(fadeMultiplierAt(both, 5)).toBeLessThan(0.5);
	});

	it("scales the clip's own opacity, and keyframes still apply", () => {
		expect(clipOpacityAt(clip({ opacity: 0.5, fadeInFrames: 10 }), 105)).toBeCloseTo(0.25, 5);
		const animated = clip({
			fadeInFrames: 10,
			keyframes: { opacity: [{ frame: 0, values: [0.8], interp: "hold" }] },
		});
		expect(clipOpacityAt(animated, 110)).toBeCloseTo(0.8, 5);
	});

	it("never leaves the 0–1 range", () => {
		const odd = clip({ opacity: 1, fadeInFrames: 10, fadeOutFrames: 10 });
		for (let frame = 95; frame <= 205; frame++) {
			const value = clipOpacityAt(odd, frame);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(1);
		}
	});
});
