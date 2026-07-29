import { describe, expect, it } from "vitest";

import { compareScopes, HUE_BIN_NAMES, measureScopes } from "./scopes";

/** Builds a frame of solid pixels, which is all the statistics need. */
function solid(r: number, g: number, b: number, count = 64, alpha = 255): Uint8ClampedArray {
	const pixels = new Uint8ClampedArray(count * 4);
	for (let index = 0; index < count; index++) {
		pixels.set([r, g, b, alpha], index * 4);
	}
	return pixels;
}

function mix(a: Uint8ClampedArray, b: Uint8ClampedArray): Uint8ClampedArray {
	const out = new Uint8ClampedArray(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

describe("measureScopes", () => {
	it("reads black and white points off a two-tone frame", () => {
		const scopes = measureScopes(mix(solid(0, 0, 0), solid(255, 255, 255)), 1);
		expect(scopes.blackPoint).toBe(0);
		expect(scopes.whitePoint).toBe(1);
		expect(scopes.clippedShadows).toBeCloseTo(50, 1);
		expect(scopes.clippedHighlights).toBeCloseTo(50, 1);
	});

	it("reports mid grey as neither clipped nor tinted", () => {
		const scopes = measureScopes(solid(128, 128, 128), 1);
		expect(scopes.clippedShadows).toBe(0);
		expect(scopes.clippedHighlights).toBe(0);
		expect(scopes.saturation).toBe(0);
		expect(scopes.warmCool).toBe(0);
		expect(scopes.greenMagenta).toBe(0);
	});

	it("calls a red-leaning frame warm and a blue-leaning frame cool", () => {
		expect(measureScopes(solid(200, 120, 60), 1).warmCool).toBeGreaterThan(0);
		expect(measureScopes(solid(60, 120, 200), 1).warmCool).toBeLessThan(0);
	});

	it("puts green on the green side of the tint axis", () => {
		expect(measureScopes(solid(60, 200, 60), 1).greenMagenta).toBeGreaterThan(0);
		expect(measureScopes(solid(200, 60, 200), 1).greenMagenta).toBeLessThan(0);
	});

	it("weights the hue histogram toward the hue that is actually there", () => {
		const orange = measureScopes(solid(230, 140, 40), 1);
		const peak = orange.hueHistogram.indexOf(Math.max(...orange.hueHistogram));
		expect(HUE_BIN_NAMES[peak]).toBe("orange");

		const sky = measureScopes(solid(70, 140, 230), 1);
		const skyPeak = sky.hueHistogram.indexOf(Math.max(...sky.hueHistogram));
		expect(["azure", "blue"]).toContain(HUE_BIN_NAMES[skyPeak]);
	});

	it("leaves the hue histogram empty for a grey frame", () => {
		const scopes = measureScopes(solid(128, 128, 128), 1);
		expect(scopes.hueHistogram.every((value) => value === 0)).toBe(true);
	});

	it("ignores fully transparent pixels rather than reading them as black", () => {
		const frame = mix(solid(255, 255, 255, 32), solid(0, 0, 0, 32, 0));
		const scopes = measureScopes(frame, 1);
		expect(scopes.meanLuma).toBe(1);
		expect(scopes.blackPoint).toBe(1);
	});

	it("returns zeroes rather than NaN for an empty frame", () => {
		const scopes = measureScopes(new Uint8ClampedArray(0), 1);
		expect(scopes.meanLuma).toBe(0);
		expect(scopes.blackPoint).toBe(0);
		expect(Number.isNaN(scopes.saturation)).toBe(false);
	});

	it("sorts luma into shadow, mid and highlight bands", () => {
		const scopes = measureScopes(
			mix(mix(solid(10, 10, 10), solid(128, 128, 128)), solid(245, 245, 245)),
			1,
		);
		expect(scopes.shadows).toBeLessThan(scopes.midtones);
		expect(scopes.midtones).toBeLessThan(scopes.highlights);
	});

	it("gives the same answer when subsampling a uniform frame", () => {
		const frame = solid(90, 140, 200, 400);
		expect(measureScopes(frame, 4).meanLuma).toBeCloseTo(measureScopes(frame, 1).meanLuma, 6);
	});
});

describe("compareScopes", () => {
	it("says the subject already matches when it does", () => {
		const scopes = measureScopes(solid(128, 128, 128), 1);
		const gap = compareScopes(scopes, scopes);
		expect(gap.exposure).toBe(0);
		expect(gap.hints).toEqual(["The subject already matches the reference closely."]);
	});

	it("points the exposure the right way when the subject is darker", () => {
		const gap = compareScopes(
			measureScopes(solid(60, 60, 60), 1),
			measureScopes(solid(200, 200, 200), 1),
		);
		expect(gap.exposure).toBeGreaterThan(0);
		expect(gap.hints.join(" ")).toContain("darker");
	});

	it("names the temperature move in the direction the reference sits", () => {
		const gap = compareScopes(
			measureScopes(solid(60, 120, 200), 1),
			measureScopes(solid(200, 120, 60), 1),
		);
		expect(gap.warmCool).toBeGreaterThan(0);
		expect(gap.hints.join(" ")).toContain("warmer");
	});

	it("calls out a saturation gap", () => {
		const gap = compareScopes(
			measureScopes(solid(128, 128, 128), 1),
			measureScopes(solid(220, 40, 40), 1),
		);
		expect(gap.saturation).toBeGreaterThan(0);
		expect(gap.hints.join(" ")).toContain("saturation raise");
	});
});
