import { describe, expect, it } from "vitest";

import {
	applyLuts,
	buildChannelLuts,
	type ColorBalance,
	hasBalance,
	hasCurves,
	lutToTableValues,
	parseCurve,
	sampleCurve,
	type ToneCurves,
} from "./curves";

const IDENTITY = [
	{ x: 0, y: 0 },
	{ x: 1, y: 1 },
];

describe("parseCurve", () => {
	it("reads a flat x,y list", () => {
		const result = parseCurve("masterCurve", [0, 0, 0.5, 0.7, 1, 1]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.points).toEqual([
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.7 },
			{ x: 1, y: 1 },
		]);
	});

	it("reads a list of point objects", () => {
		const result = parseCurve("redCurve", [
			{ x: 0, y: 0.1 },
			{ x: 1, y: 1 },
		]);
		expect(result.ok && result.points[0].y).toBe(0.1);
	});

	it("sorts points by x so an out-of-order curve still works", () => {
		const result = parseCurve("masterCurve", [1, 1, 0, 0, 0.5, 0.3]);
		expect(result.ok && result.points.map((point) => point.x)).toEqual([0, 0.5, 1]);
	});

	it("clamps points into range rather than rejecting them", () => {
		const result = parseCurve("masterCurve", [-1, -1, 2, 2]);
		expect(result.ok && result.points).toEqual([
			{ x: 0, y: 0 },
			{ x: 1, y: 1 },
		]);
	});

	it("names the tool's own argument when a pair is malformed", () => {
		const odd = parseCurve("blueCurve", [0, 0, 1]);
		expect(odd.ok).toBe(false);
		if (!odd.ok) expect(odd.reason).toContain("blueCurve");
	});

	it("refuses a single point, which describes no curve", () => {
		expect(parseCurve("masterCurve", [0.5, 0.5]).ok).toBe(false);
	});

	it("treats an absent or empty curve as identity, not an error", () => {
		expect(parseCurve("masterCurve", undefined)).toEqual({ ok: true, points: [] });
		expect(parseCurve("masterCurve", [])).toEqual({ ok: true, points: [] });
	});

	it("rejects a non-finite value", () => {
		expect(parseCurve("masterCurve", [0, 0, 1, Number.NaN]).ok).toBe(false);
	});
});

describe("sampleCurve", () => {
	it("is the identity for an identity curve", () => {
		for (const x of [0, 0.25, 0.5, 0.75, 1]) {
			expect(sampleCurve(IDENTITY, x)).toBeCloseTo(x, 5);
		}
	});

	it("holds the end values outside the curve's range", () => {
		const curve = [
			{ x: 0.2, y: 0.3 },
			{ x: 0.8, y: 0.9 },
		];
		expect(sampleCurve(curve, 0)).toBe(0.3);
		expect(sampleCurve(curve, 1)).toBe(0.9);
	});

	it("passes through every control point", () => {
		const curve = [
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.8 },
			{ x: 1, y: 1 },
		];
		for (const point of curve) expect(sampleCurve(curve, point.x)).toBeCloseTo(point.y, 5);
	});

	it("never overshoots between control points", () => {
		// A near-vertical step is what makes plain cubic interpolation ring.
		const curve = [
			{ x: 0, y: 0 },
			{ x: 0.49, y: 0.05 },
			{ x: 0.51, y: 0.95 },
			{ x: 1, y: 1 },
		];
		for (let x = 0; x <= 1; x += 0.005) {
			const y = sampleCurve(curve, x);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(1);
		}
	});

	it("stays monotonic for a monotonic curve", () => {
		const curve = [
			{ x: 0, y: 0 },
			{ x: 0.3, y: 0.1 },
			{ x: 0.7, y: 0.9 },
			{ x: 1, y: 1 },
		];
		let previous = -1;
		for (let x = 0; x <= 1; x += 0.01) {
			const y = sampleCurve(curve, x);
			expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
			previous = y;
		}
	});
});

describe("buildChannelLuts", () => {
	it("is null when nothing is set, so the common path costs nothing", () => {
		expect(buildChannelLuts(undefined, undefined)).toBeNull();
		expect(buildChannelLuts({}, {})).toBeNull();
		expect(buildChannelLuts({ master: IDENTITY }, { midsGamma: 1 })).not.toBeNull();
	});

	it("is the identity table for an identity curve", () => {
		const luts = buildChannelLuts({ master: IDENTITY }, undefined);
		expect(luts).not.toBeNull();
		if (!luts) return;
		for (const value of [0, 64, 128, 192, 255]) {
			expect(luts.r[value]).toBeCloseTo(value, -1);
		}
	});

	it("spans the full range", () => {
		const luts = buildChannelLuts({ master: IDENTITY }, undefined);
		expect(luts?.r[0]).toBe(0);
		expect(luts?.r[255]).toBe(255);
	});

	it("applies a per-channel curve only to that channel", () => {
		const curves: ToneCurves = {
			red: [
				{ x: 0, y: 0.5 },
				{ x: 1, y: 1 },
			],
		};
		const luts = buildChannelLuts(curves, undefined);
		expect(luts?.r[0]).toBeGreaterThan(100);
		expect(luts?.g[0]).toBe(0);
		expect(luts?.b[0]).toBe(0);
	});

	it("lifts the black point without blowing out white", () => {
		const luts = buildChannelLuts(undefined, { shadowsLum: 0.2 });
		expect(luts?.r[0]).toBeGreaterThan(40);
		expect(luts?.r[255]).toBe(255);
	});

	it("crushes the blacks for a negative lift", () => {
		const luts = buildChannelLuts(undefined, { shadowsLum: -0.2 });
		expect(luts?.r[0]).toBe(0);
		expect(luts?.r[40]).toBeLessThan(40);
	});

	it("brightens the midtones for a gamma above one, leaving the ends alone", () => {
		const luts = buildChannelLuts(undefined, { midsGamma: 2 });
		expect(luts?.r[128]).toBeGreaterThan(128);
		expect(luts?.r[0]).toBe(0);
		expect(luts?.r[255]).toBe(255);
	});

	it("scales the highlights with gain", () => {
		const dim = buildChannelLuts(undefined, { highsGain: 0.5 });
		expect(dim?.r[255]).toBeCloseTo(128, -1);
	});

	it("tints the shadows toward the hue it was given", () => {
		// Hue 0 is red, so a red shadow tint lifts red above green and blue.
		const warm = buildChannelLuts(undefined, { shadowsHue: 0, shadowsAmount: 0.5 });
		expect(warm?.r[0]).toBeGreaterThan(warm?.g[0] ?? 0);
		expect(warm?.r[0]).toBeGreaterThan(warm?.b[0] ?? 0);

		// Hue 240 is blue.
		const cool = buildChannelLuts(undefined, { shadowsHue: 240, shadowsAmount: 0.5 });
		expect(cool?.b[0]).toBeGreaterThan(cool?.r[0] ?? 0);
	});

	it("tints without also changing overall exposure", () => {
		const tinted = buildChannelLuts(undefined, { shadowsHue: 0, shadowsAmount: 0.5 });
		if (!tinted) throw new Error("expected a table");
		// The three channels move apart around the untinted value rather than all
		// moving the same way. Measured at mid grey: at pure black the two
		// channels being pushed down are already at the floor, so the average
		// there is skewed by the clamp rather than by the tint.
		const mean = (tinted.r[128] + tinted.g[128] + tinted.b[128]) / 3;
		expect(mean).toBeCloseTo(128, -1);
		expect(tinted.r[128]).toBeGreaterThan(tinted.g[128]);
	});

	it("applies the balance before the curve", () => {
		// A curve that clamps everything to black must win over a lift.
		const black = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
		];
		const luts = buildChannelLuts({ master: black }, { shadowsLum: 0.5 });
		expect(luts?.r[128]).toBe(0);
	});

	it("stays inside 0–255 for extreme settings", () => {
		const luts = buildChannelLuts(
			{
				master: [
					{ x: 0, y: 1 },
					{ x: 1, y: 0 },
				],
			},
			{ shadowsLum: 1, midsGamma: 4, highsGain: 4, shadowsAmount: 1, shadowsHue: 200 },
		);
		if (!luts) throw new Error("expected a table");
		for (const table of [luts.r, luts.g, luts.b]) {
			for (const value of table) {
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(255);
			}
		}
	});
});

describe("hasCurves / hasBalance", () => {
	it("ignores a curve with fewer than two points", () => {
		expect(hasCurves({ master: [{ x: 0, y: 0 }] })).toBe(false);
		expect(hasCurves({ master: IDENTITY })).toBe(true);
	});

	it("ignores neutral balance values", () => {
		const neutral: ColorBalance = { shadowsHue: 180, midsGamma: 1, highsGain: 1 };
		expect(hasBalance(neutral)).toBe(false);
		expect(hasBalance({ ...neutral, midsGamma: 1.2 })).toBe(true);
	});
});

describe("lutToTableValues / applyLuts", () => {
	it("samples the table into normalised values for SVG", () => {
		const luts = buildChannelLuts({ master: IDENTITY }, undefined);
		if (!luts) throw new Error("expected a table");
		const values = lutToTableValues(luts.r, 5).split(" ");
		expect(values).toHaveLength(5);
		expect(Number(values[0])).toBeCloseTo(0, 2);
		expect(Number(values[4])).toBeCloseTo(1, 2);
	});

	it("maps pixels through the table and leaves alpha alone", () => {
		const luts = buildChannelLuts(
			{
				master: [
					{ x: 0, y: 1 },
					{ x: 1, y: 0 },
				],
			},
			undefined,
		);
		if (!luts) throw new Error("expected a table");
		const pixels = new Uint8ClampedArray([0, 0, 0, 128]);
		applyLuts(pixels, luts);
		// An inverting curve turns black into white.
		expect(pixels[0]).toBe(255);
		expect(pixels[3]).toBe(128);
	});
});
