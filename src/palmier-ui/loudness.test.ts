// Loudness, and the gain that matches two clips.
//
// The two decisions worth locking down: the average is taken over audible
// passages only, because a take with silence at the head is not quiet; and the
// gain is held back rather than clipping the peaks, because reaching a target by
// clipping is not reaching it.

import { describe, expect, it } from "vitest";

import { measureLoudness, normalizationGainDb } from "./analysis";

const RATE = 48000;

/** A sine at a given amplitude, optionally preceded by silence. */
function tone(amplitude: number, seconds = 2, silenceSeconds = 0): Float32Array {
	const silence = Math.floor(RATE * silenceSeconds);
	const out = new Float32Array(silence + Math.floor(RATE * seconds));
	for (let i = silence; i < out.length; i++) {
		out[i] = amplitude * Math.sin((2 * Math.PI * 440 * (i - silence)) / RATE);
	}
	return out;
}

describe("measuring loudness", () => {
	it("reads a louder tone as louder", () => {
		const quiet = measureLoudness(tone(0.1), RATE);
		const loud = measureLoudness(tone(0.5), RATE);
		expect(loud.programDb).toBeGreaterThan(quiet.programDb);
		// A 0.5 sine peaks about 6 dB below full scale.
		expect(loud.peakDb).toBeCloseTo(-6, 0);
	});

	it("ignores leading silence, so a padded take isn't called quiet", () => {
		// This is the mistake that pushes gain far too high: averaging silence in.
		const bare = measureLoudness(tone(0.3, 2), RATE);
		const padded = measureLoudness(tone(0.3, 2, 6), RATE);
		expect(padded.programDb).toBeCloseTo(bare.programDb, 0);
		// It does report how much of the file was actually program.
		expect(padded.activeRatio).toBeLessThan(0.4);
		expect(bare.activeRatio).toBeGreaterThan(0.9);
	});

	it("reports silence as silence rather than dividing by zero", () => {
		const profile = measureLoudness(new Float32Array(RATE), RATE);
		expect(profile.programDb).toBe(-120);
		expect(profile.activeRatio).toBe(0);
	});

	it("handles a buffer too short to window", () => {
		expect(measureLoudness(new Float32Array(4), RATE).programDb).toBe(-120);
	});
});

describe("the gain to reach a target", () => {
	it("returns the plain difference when there is headroom", () => {
		const profile = { programDb: -30, peakDb: -20, activeRatio: 1 };
		const result = normalizationGainDb(profile, -18, -1);
		expect(result.gainDb).toBe(12);
		expect(result.limitedBy).toBeNull();
		expect(result.shortfallDb).toBe(0);
	});

	it("holds back rather than clipping, and says by how much", () => {
		// Wants +16 but the peak is already at -3, so only +2 fits under -1.
		const profile = { programDb: -19, peakDb: -3, activeRatio: 1 };
		const result = normalizationGainDb(profile, -3, -1);
		expect(result.limitedBy).toBe("peak");
		expect(result.gainDb).toBe(2);
		// Reporting the shortfall is what stops a receipt claiming the target
		// was hit when it wasn't.
		expect(result.shortfallDb).toBeGreaterThan(0);
	});

	it("attenuates something already too loud", () => {
		const profile = { programDb: -6, peakDb: -2, activeRatio: 1 };
		expect(normalizationGainDb(profile, -18, -1).gainDb).toBe(-12);
	});

	it("never lets the peak cross the ceiling", () => {
		const profile = { programDb: -40, peakDb: -0.5, activeRatio: 1 };
		const result = normalizationGainDb(profile, -12, -1);
		expect(profile.peakDb + result.gainDb).toBeLessThanOrEqual(-1);
	});
});
