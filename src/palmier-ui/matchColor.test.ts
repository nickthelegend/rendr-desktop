// Turning a measured gap into a grade that closes it.
//
// The two things worth locking: the correction uses the same scale factors the
// hints quote, so what a caller is told and what is applied cannot drift; and a
// gap under what anyone can see is left alone rather than dirtying a clip's
// grade for no visible gain.

import { describe, expect, it } from "vitest";

import { correctionFor, type ScopeGap, worthCorrecting } from "./scopes";

const neutral = { exposure: 0, contrast: 1, saturation: 1, temperature: 6500, tint: 0 };

const gap = (over: Partial<ScopeGap> = {}): ScopeGap => ({
	exposure: 0,
	contrast: 0,
	saturation: 0,
	warmCool: 0,
	greenMagenta: 0,
	hints: [],
	...over,
});

describe("correcting exposure", () => {
	it("raises exposure when the subject is darker than the reference", () => {
		// compareScopes gives a positive exposure gap when the reference is
		// brighter, and the hint quotes it times three.
		const out = correctionFor(gap({ exposure: 0.1 }), neutral);
		expect(out.exposure).toBeCloseTo(0.3, 3);
	});

	it("lowers it when the subject is brighter", () => {
		expect(correctionFor(gap({ exposure: -0.05 }), neutral).exposure).toBeCloseTo(-0.15, 3);
	});
});

describe("correcting the rest", () => {
	it("scales contrast around neutral rather than replacing it", () => {
		expect(correctionFor(gap({ contrast: 0.2 }), neutral).contrast).toBeCloseTo(1.2, 3);
	});

	it("never drives contrast to zero or below", () => {
		// A contrast of 0 would flatten the picture to a single value.
		expect(correctionFor(gap({ contrast: -5 }), neutral).contrast).toBeGreaterThan(0);
	});

	it("never drives saturation negative", () => {
		expect(correctionFor(gap({ saturation: -9 }), neutral).saturation).toBe(0);
	});

	it("lowers colour temperature to go warmer", () => {
		// Warmer is a *lower* Kelvin figure, which is the easy sign to get wrong.
		const warmer = correctionFor(gap({ warmCool: 0.1 }), neutral);
		expect(warmer.temperature).toBeLessThan(6500);
	});

	it("raises it to go cooler", () => {
		expect(correctionFor(gap({ warmCool: -0.1 }), neutral).temperature).toBeGreaterThan(6500);
	});

	it("shifts tint by the green/magenta gap", () => {
		expect(correctionFor(gap({ greenMagenta: 0.04 }), neutral).tint).toBeCloseTo(0.04, 3);
	});
});

describe("building on what the clip already has", () => {
	it("corrects on top of an existing grade rather than resetting it", () => {
		// A match is a correction; discarding a look somebody chose in order to
		// fix exposure would be the wrong trade.
		const existing = {
			exposure: 0.2,
			contrast: 1.3,
			saturation: 1.1,
			temperature: 5000,
			tint: 0.05,
		};
		const out = correctionFor(gap({ exposure: 0.1 }), existing);
		expect(out.exposure).toBeCloseTo(0.5, 3);
		expect(out.contrast).toBeCloseTo(1.3, 3);
		expect(out.temperature).toBe(5000);
		expect(out.tint).toBeCloseTo(0.05, 3);
	});
});

describe("knowing when not to bother", () => {
	it("leaves an imperceptible gap alone", () => {
		expect(worthCorrecting(gap({ exposure: 0.004, saturation: 0.002 }))).toBe(false);
	});

	it("acts on a visible one", () => {
		expect(worthCorrecting(gap({ exposure: 0.05 }))).toBe(true);
		expect(worthCorrecting(gap({ warmCool: 0.02 }))).toBe(true);
	});

	it("treats a perfect match as nothing to do", () => {
		expect(worthCorrecting(gap())).toBe(false);
	});
});
