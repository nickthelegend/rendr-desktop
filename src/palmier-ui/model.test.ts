// The clip model's invariants.
//
// `withDefaults` is what every clip in the project goes through, so a mistake
// here is a mistake in every clip at once — and `clampTo` is the only thing
// standing between an agent's arbitrary number and the renderer.

import { describe, expect, it } from "vitest";

import { CLIP_LIMITS, clamp01, clampTo, isGraded, NEUTRAL_GRADE, withDefaults } from "./model";

describe("clampTo", () => {
	it("holds a value inside its declared range", () => {
		expect(clampTo("opacity", 5)).toBe(CLIP_LIMITS.opacity.max);
		expect(clampTo("opacity", -5)).toBe(CLIP_LIMITS.opacity.min);
		expect(clampTo("opacity", 0.5)).toBe(0.5);
	});

	it("returns the minimum for a value that isn't a number", () => {
		// NaN would otherwise propagate into a transform and blank the frame,
		// with nothing in the UI to explain why.
		expect(clampTo("opacity", Number.NaN)).toBe(CLIP_LIMITS.opacity.min);
		expect(clampTo("opacity", Number.POSITIVE_INFINITY)).toBe(CLIP_LIMITS.opacity.min);
	});

	it("covers every key the limits table declares", () => {
		// A key added to CLIP_LIMITS but not handled would throw at runtime.
		for (const key of Object.keys(CLIP_LIMITS) as Array<keyof typeof CLIP_LIMITS>) {
			const { min, max } = CLIP_LIMITS[key];
			expect(clampTo(key, max + 1)).toBe(max);
			expect(clampTo(key, min - 1)).toBe(min);
		}
	});
});

describe("clamp01", () => {
	it("bounds to 0–1 and treats nonsense as 0", () => {
		expect(clamp01(-1)).toBe(0);
		expect(clamp01(2)).toBe(1);
		expect(clamp01(0.25)).toBe(0.25);
		expect(clamp01(Number.NaN)).toBe(0);
	});
});

describe("withDefaults", () => {
	const seed = {
		id: "c1",
		name: "Take.mp4",
		mediaType: "video" as const,
		assetId: "a1",
		startFrame: 0,
		endFrame: 90,
	};

	it("fills in everything the renderer reads", () => {
		const clip = withDefaults(seed);
		expect(clip.speed).toBe(1);
		expect(clip.opacity).toBe(1);
		expect(clip.volumeDb).toBe(0);
		expect(clip.trimStartFrame).toBe(0);
		expect(clip.transform).toBeDefined();
		expect(clip.crop).toBeDefined();
		expect(clip.color).toEqual(NEUTRAL_GRADE);
	});

	it("lets the seed win over the defaults", () => {
		expect(withDefaults({ ...seed, opacity: 0.4 }).opacity).toBe(0.4);
	});

	it("gives a text clip its content and style, and nothing else one", () => {
		const text = withDefaults({ ...seed, mediaType: "text", name: "Title" });
		expect(text.content).toBe("Title");
		expect(text.textStyle).toBeDefined();
		expect(withDefaults(seed).textStyle).toBeUndefined();
	});

	it("does not share mutable defaults between two clips", () => {
		// A shared transform object would make dragging one clip move another.
		const a = withDefaults({ ...seed, id: "a" });
		const b = withDefaults({ ...seed, id: "b" });
		a.transform.centerX = 0.9;
		expect(b.transform.centerX).not.toBe(0.9);
		a.crop.left = 0.3;
		expect(b.crop.left).not.toBe(0.3);
	});
});

describe("isGraded", () => {
	it("is false for the neutral grade", () => {
		expect(isGraded(NEUTRAL_GRADE)).toBe(false);
	});

	it("notices every primary knob moving off neutral", () => {
		const knobs = [
			{ exposure: 0.2 },
			{ contrast: 1.2 },
			{ saturation: 0.5 },
			{ vibrance: 0.3 },
			{ temperature: 5000 },
			{ tint: 0.1 },
			{ highlights: -0.2 },
			{ shadows: 0.2 },
			{ whites: 0.1 },
			{ blacks: -0.1 },
		];
		for (const knob of knobs) {
			expect(isGraded({ ...NEUTRAL_GRADE, ...knob })).toBe(true);
		}
	});

	it("counts hue targets and a LUT, which aren't primary knobs", () => {
		expect(
			isGraded({
				...NEUTRAL_GRADE,
				hueCurves: { targets: [{ targetHue: 30, satScale: 0.5 }] },
			}),
		).toBe(true);
	});

	it("ignores a hue target that changes nothing", () => {
		expect(isGraded({ ...NEUTRAL_GRADE, hueCurves: { targets: [{ targetHue: 30 }] } })).toBe(
			false,
		);
	});
});
