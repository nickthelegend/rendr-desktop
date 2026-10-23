// Loudness, and the gain that matches two clips.
//
// The two decisions worth locking down: the average is taken over audible
// passages only, because a take with silence at the head is not quiet; and the
// gain is held back rather than clipping the peaks, because reaching a target by
// clipping is not reaching it.

import { describe, expect, it } from "vitest";

import { measureLoudness, normalizationGainDb } from "./analysis";
import { kWeightingFilters, loudnessGain, measureIntegratedLoudness } from "./loudness";

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

// ── ITU-R BS.1770 integrated loudness ─────────────────────────────────
//
// Checked against signals whose loudness the standard fixes exactly: the EBU
// Tech 3341 cases (a 1 kHz sine at -23 dBFS in both channels reads -23 LUFS),
// and a single full-scale 997 Hz sine, which BS.1770 defines as -3.01 LUFS.

/** A sine at a peak level in dBFS, at any frequency and rate. */
function sine(dbfs: number, seconds: number, frequency = 1000, rate = RATE, phase = 0) {
	const amplitude = 10 ** (dbfs / 20);
	const out = new Float32Array(Math.round(seconds * rate));
	for (let i = 0; i < out.length; i++) {
		out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate + phase);
	}
	return out;
}

function concat(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

describe("K-weighting", () => {
	it("reproduces the standard's 48 kHz coefficient table", () => {
		const [shelf, highPass] = kWeightingFilters(48000);
		expect(shelf.b0).toBeCloseTo(1.53512485958697, 8);
		expect(shelf.b1).toBeCloseTo(-2.69169618940638, 8);
		expect(shelf.b2).toBeCloseTo(1.19839281085285, 8);
		expect(shelf.a1).toBeCloseTo(-1.69065929318241, 8);
		expect(shelf.a2).toBeCloseTo(0.73248077421585, 8);
		expect(highPass.a1).toBeCloseTo(-1.99004745483398, 8);
		expect(highPass.a2).toBeCloseTo(0.99007225036621, 8);
	});
});

describe("integrated loudness", () => {
	it("reads a stereo 1 kHz sine at -23 dBFS as -23 LUFS (EBU 3341 case 1)", () => {
		const tone = sine(-23, 20);
		const result = measureIntegratedLoudness([tone, tone], RATE);
		expect(result.integratedLufs).toBeCloseTo(-23, 1);
	});

	it("reads one full-scale 997 Hz sine as -3.01 LUFS", () => {
		const result = measureIntegratedLoudness([sine(0, 5, 997)], RATE);
		expect(result.integratedLufs).toBeCloseTo(-3.01, 1);
	});

	it("gives the same answer at 44.1 kHz, the rate Web Audio often decodes at", () => {
		const tone = sine(-23, 10, 1000, 44100);
		expect(measureIntegratedLoudness([tone, tone], 44100).integratedLufs).toBeCloseTo(-23, 1);
	});

	it("sums channel powers, so one channel alone reads 3 dB quieter", () => {
		const tone = sine(-23, 10);
		const stereo = measureIntegratedLoudness([tone, tone], RATE).integratedLufs ?? 0;
		const mono = measureIntegratedLoudness([tone], RATE).integratedLufs ?? 0;
		expect(stereo - mono).toBeCloseTo(3.01, 1);
	});

	it("gates out the quiet passages around the programme (EBU 3341 case 3)", () => {
		// -36 / -23 / -36 dBFS: the quiet parts sit 13 LU down, below the
		// relative gate, so the reading is the programme's.
		const tone = concat(sine(-36, 10), sine(-23, 60), sine(-36, 10));
		expect(measureIntegratedLoudness([tone, tone], RATE).integratedLufs).toBeCloseTo(-23, 1);
	});

	it("ignores silence entirely, so a padded take isn't called quiet", () => {
		const bare = measureIntegratedLoudness([sine(-20, 20)], RATE).integratedLufs ?? 0;
		const padded = measureIntegratedLoudness(
			[concat(new Float32Array(RATE * 20), sine(-20, 20))],
			RATE,
		);
		expect(padded.integratedLufs).toBeCloseTo(bare, 1);
		expect(padded.gatedSeconds).toBeLessThan(21);
		expect(padded.measuredSeconds).toBe(40);
	});

	it("weights low bass down, which is the point of K-weighting", () => {
		// The same peak level at 40 Hz sits on the RLB high-pass and reads lower.
		const bass = measureIntegratedLoudness([sine(-20, 5, 40)], RATE).integratedLufs ?? 0;
		const mid = measureIntegratedLoudness([sine(-20, 5, 1000)], RATE).integratedLufs ?? 0;
		expect(mid - bass).toBeGreaterThan(1);
	});

	it("reports silence and very short audio as unmeasurable, not as a number", () => {
		expect(measureIntegratedLoudness([new Float32Array(RATE * 2)], RATE).integratedLufs).toBe(
			null,
		);
		// Under one 400 ms block.
		expect(measureIntegratedLoudness([sine(-20, 0.3)], RATE).integratedLufs).toBe(null);
	});

	it("measures only the ranges asked for", () => {
		const tone = concat(sine(-40, 4), sine(-18, 4));
		const ranged = measureIntegratedLoudness([tone], RATE, [[RATE * 4, RATE * 8]]);
		const sliced = measureIntegratedLoudness([sine(-18, 4)], RATE);
		expect(ranged.integratedLufs).toBeCloseTo(sliced.integratedLufs ?? 0, 1);
		expect(ranged.measuredSeconds).toBe(4);
	});
});

describe("true peak", () => {
	it("finds the peak between samples that a sample meter misses", () => {
		// A quarter-rate sine phased 45° never lands a sample on its crest:
		// every sample reads 0.707, 3 dB under the real peak.
		const tone = sine(0, 1, RATE / 4, RATE, Math.PI / 4);
		const result = measureIntegratedLoudness([tone], RATE);
		expect(result.samplePeakDb).toBeCloseTo(-3.01, 1);
		expect(result.truePeakDb).toBeGreaterThan(-0.2);
		expect(result.truePeakDb).toBeLessThan(0.2);
	});

	it("agrees with the sample peak for an ordinary tone", () => {
		const result = measureIntegratedLoudness([sine(-6, 1, 997)], RATE);
		expect(result.truePeakDb).toBeCloseTo(-6, 1);
	});

	it("reports digital silence at the floor", () => {
		const result = measureIntegratedLoudness([new Float32Array(RATE)], RATE);
		expect(result.truePeakDb).toBe(-120);
	});
});

describe("the gain to a loudness target", () => {
	it("is the plain difference when there is headroom", () => {
		const gain = loudnessGain({ integratedLufs: -24, truePeakDb: -12 }, -14, -1);
		expect(gain).toMatchObject({
			gainDb: 10,
			limitedBy: null,
			shortfallDb: 0,
			resultLufs: -14,
		});
	});

	it("stops at the true-peak ceiling and says how far short it landed", () => {
		// A talking-head take with sharp plosives: -24 LUFS, peaks at -4 dBTP.
		const gain = loudnessGain({ integratedLufs: -24, truePeakDb: -4 }, -14, -1);
		expect(gain?.gainDb).toBe(3);
		expect(gain?.limitedBy).toBe("truePeak");
		expect(gain?.shortfallDb).toBe(7);
		expect(gain?.resultTruePeakDb).toBe(-1);
		expect(gain?.resultLufs).toBe(-21);
	});

	it("turns down something already too loud", () => {
		expect(loudnessGain({ integratedLufs: -8, truePeakDb: 0 }, -14)?.gainDb).toBe(-6);
	});

	it("refuses to invent a gain for silence", () => {
		expect(loudnessGain({ integratedLufs: null, truePeakDb: -120 }, -14)).toBeNull();
	});
});
