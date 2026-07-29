import { describe, expect, it } from "vitest";

import {
	applyPixelGrade,
	type CubeLut,
	hslToRgb,
	LutParseError,
	needsPixelGrade,
	parseCubeLut,
	rgbToHsl,
	sampleCube,
} from "./pixelGrade";

/** A cube of the given size built from a per-channel function. */
function buildCube(
	size: number,
	fn: (r: number, g: number, b: number) => [number, number, number],
) {
	const lines = [`LUT_3D_SIZE ${size}`];
	const last = size - 1;
	// Red varies fastest, then green, then blue — the .cube row order.
	for (let bi = 0; bi < size; bi++) {
		for (let gi = 0; gi < size; gi++) {
			for (let ri = 0; ri < size; ri++) {
				const [r, g, b] = fn(ri / last, gi / last, bi / last);
				lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
			}
		}
	}
	return lines.join("\n");
}

const px = (r: number, g: number, b: number) => new Uint8ClampedArray([r, g, b, 255]);

describe("parseCubeLut", () => {
	it("reads size, rows and title comments", () => {
		const lut = parseCubeLut(
			[
				"# a comment",
				'TITLE "Test"',
				...buildCube(2, (r, g, b) => [r, g, b]).split("\n"),
			].join("\n"),
			"Test.cube",
		);
		expect(lut.size).toBe(2);
		expect(lut.table).toHaveLength(2 * 2 * 2 * 3);
		expect(lut.name).toBe("Test.cube");
	});

	it("reads a non-default domain", () => {
		const text = `DOMAIN_MIN 0 0 0\nDOMAIN_MAX 4 4 4\n${buildCube(2, (r, g, b) => [r, g, b])}`;
		expect(parseCubeLut(text).domainMax).toEqual([4, 4, 4]);
	});

	it("refuses a file whose row count disagrees with its declared size", () => {
		// A truncated cube would otherwise grade an entire export with garbage
		// that nobody notices until the file is watched.
		const text = `${buildCube(3, (r, g, b) => [r, g, b])}\n`
			.split("\n")
			.slice(0, -3)
			.join("\n");
		expect(() => parseCubeLut(text)).toThrow(LutParseError);
	});

	it("refuses a file with no LUT_3D_SIZE", () => {
		expect(() => parseCubeLut("0 0 0\n1 1 1")).toThrow(/isn't a 3D cube/);
	});

	it("says so when handed a 1D LUT", () => {
		expect(() => parseCubeLut("LUT_1D_SIZE 32\n0 0 0")).toThrow(/1D LUT/);
	});

	it("refuses a cube larger than the cap", () => {
		expect(() => parseCubeLut("LUT_3D_SIZE 128\n0 0 0")).toThrow(/beyond the 64/);
	});

	it("refuses a row that isn't numbers", () => {
		expect(() => parseCubeLut("LUT_3D_SIZE 2\nnope nope nope")).toThrow(LutParseError);
	});
});

describe("sampleCube", () => {
	const identity: CubeLut = parseCubeLut(buildCube(2, (r, g, b) => [r, g, b]));

	it("passes colour through an identity cube unchanged", () => {
		const [r, g, b] = sampleCube(identity, 0.3, 0.6, 0.9);
		expect(r).toBeCloseTo(0.3, 5);
		expect(g).toBeCloseTo(0.6, 5);
		expect(b).toBeCloseTo(0.9, 5);
	});

	it("interpolates between entries rather than snapping to the nearest", () => {
		// A 2-cube has no entry near 0.5 — only trilinear blending lands there.
		const [r] = sampleCube(identity, 0.5, 0.5, 0.5);
		expect(r).toBeCloseTo(0.5, 5);
	});

	it("reads the axes in .cube row order, not transposed", () => {
		// Only red is mapped, so a transposed reader would move green or blue.
		const redOnly = parseCubeLut(buildCube(2, (r) => [r * 0.5, 0, 0]));
		const [r, g, b] = sampleCube(redOnly, 1, 1, 1);
		expect(r).toBeCloseTo(0.5, 5);
		expect(g).toBeCloseTo(0, 5);
		expect(b).toBeCloseTo(0, 5);
	});

	it("clamps input outside the domain instead of reading past the table", () => {
		const [r] = sampleCube(identity, 2, -1, 0.5);
		expect(Number.isFinite(r)).toBe(true);
		expect(r).toBeCloseTo(1, 5);
	});
});

describe("rgbToHsl / hslToRgb", () => {
	it("round-trips a saturated colour", () => {
		const [h, s, l] = rgbToHsl(0.2, 0.7, 0.4);
		const [r, g, b] = hslToRgb(h, s, l);
		expect(r).toBeCloseTo(0.2, 5);
		expect(g).toBeCloseTo(0.7, 5);
		expect(b).toBeCloseTo(0.4, 5);
	});

	it("reports grey as unsaturated rather than an arbitrary hue", () => {
		const [, s] = rgbToHsl(0.5, 0.5, 0.5);
		expect(s).toBe(0);
	});
});

describe("needsPixelGrade", () => {
	it("is false for nothing, and for a target that changes nothing", () => {
		expect(needsPixelGrade(undefined)).toBe(false);
		expect(needsPixelGrade({})).toBe(false);
		// A row in a panel is not a grade.
		expect(needsPixelGrade({ hueCurves: { targets: [{ targetHue: 30 }] } })).toBe(false);
		expect(needsPixelGrade({ hueCurves: { targets: [{ targetHue: 30, satScale: 1 }] } })).toBe(
			false,
		);
		expect(
			needsPixelGrade({ hueCurves: { targets: [{ targetHue: 30, satScale: 0.5 }] } }),
		).toBe(true);
	});

	it("is false for a LUT dialled to zero", () => {
		const lut = parseCubeLut(buildCube(2, () => [0, 0, 0]));
		expect(needsPixelGrade({ lut, lutAmount: 0 })).toBe(false);
		expect(needsPixelGrade({ lut })).toBe(true);
	});
});

describe("applyPixelGrade", () => {
	it("leaves pixels untouched when there is nothing to do", () => {
		const pixels = px(10, 20, 30);
		applyPixelGrade(pixels, {});
		expect([...pixels]).toEqual([10, 20, 30, 255]);
	});

	it("desaturates only the hue it targets", () => {
		// Red sits at 0°, green at 120° — well outside the ±22° reach.
		const grade = { hueCurves: { targets: [{ targetHue: 0, satScale: 0 }] } };
		const red = px(255, 0, 0);
		const green = px(0, 255, 0);
		applyPixelGrade(red, grade);
		applyPixelGrade(green, grade);
		// Red collapses to grey; green is untouched.
		expect(red[0]).toBe(red[1]);
		expect(red[1]).toBe(red[2]);
		expect([...green]).toEqual([0, 255, 0, 255]);
	});

	it("wraps the wheel, so a target on red reaches hues just below 360°", () => {
		const grade = { hueCurves: { targets: [{ targetHue: 350, satScale: 0 }] } };
		// Hue 0 (pure red) is 10° from 350°, inside the reach — but only if the
		// distance is measured the short way round.
		const red = px(255, 0, 0);
		applyPixelGrade(red, grade);
		expect(red[0]).toBeLessThan(255);
	});

	it("falls off with distance rather than switching on at the edge", () => {
		const grade = { hueCurves: { targets: [{ targetHue: 0, satScale: 0 }] } };
		// 0° is dead centre; ~14° is near the edge of the ±22° reach.
		const centre = px(255, 0, 0);
		const edge = px(255, 120, 0);
		const before = edge[1];
		applyPixelGrade(centre, grade);
		applyPixelGrade(edge, grade);
		// The centre is fully desaturated; the edge only partly.
		expect(centre[0]).toBe(centre[1]);
		expect(edge[1]).toBeGreaterThan(before * 0.5);
		expect(edge[0]).toBeGreaterThan(edge[1]);
	});

	it("blends two overlapping targets instead of letting one win", () => {
		const both = px(255, 60, 0);
		applyPixelGrade(both, {
			hueCurves: {
				targets: [
					{ targetHue: 10, satScale: 0.5 },
					{ targetHue: 20, satScale: 0.5 },
				],
			},
		});
		const one = px(255, 60, 0);
		applyPixelGrade(one, { hueCurves: { targets: [{ targetHue: 10, satScale: 0.5 }] } });
		// Saturation is how far apart the channels are, so more desaturation
		// means a smaller spread — not a smaller signed difference.
		const spread = (p: Uint8ClampedArray) =>
			Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
		expect(spread(both)).toBeLessThan(spread(one));
	});

	it("applies a LUT, and honours the dry/wet amount", () => {
		// A cube that halves every channel.
		const lut = parseCubeLut(buildCube(2, (r, g, b) => [r / 2, g / 2, b / 2]));
		const full = px(200, 200, 200);
		const half = px(200, 200, 200);
		applyPixelGrade(full, { lut });
		applyPixelGrade(half, { lut, lutAmount: 0.5 });
		expect(full[0]).toBe(100);
		// Halfway between the original 200 and the graded 100.
		expect(half[0]).toBe(150);
	});

	it("runs the hue targets before the LUT", () => {
		// The LUT maps everything to pure blue, so if it ran first the hue curve
		// would act on blue rather than on the source red.
		const lut = parseCubeLut(buildCube(2, () => [0, 0, 1]));
		const pixels = px(255, 0, 0);
		applyPixelGrade(pixels, {
			lut,
			hueCurves: { targets: [{ targetHue: 0, satScale: 0 }] },
		});
		// The LUT is last, so the result is its output regardless.
		expect([...pixels].slice(0, 3)).toEqual([0, 0, 255]);
	});

	it("keeps alpha untouched", () => {
		const lut = parseCubeLut(buildCube(2, () => [0, 0, 0]));
		const pixels = new Uint8ClampedArray([255, 128, 64, 77]);
		applyPixelGrade(pixels, { lut });
		expect(pixels[3]).toBe(77);
	});

	it("grades every pixel of a multi-pixel block", () => {
		const lut = parseCubeLut(buildCube(2, () => [1, 1, 1]));
		const pixels = new Uint8ClampedArray(3 * 4);
		applyPixelGrade(pixels, { lut });
		expect([...pixels]).toEqual([255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0]);
	});
});
