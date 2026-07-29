import { describe, expect, it } from "vitest";

import {
	BEAT_CONFIDENCE_FLOOR,
	detectBeats,
	detectSilence,
	findSyncOffset,
	measureNoiseFloor,
} from "./analysis";

const RATE = 22_050;

/**
 * mulberry32 — deterministic, but without the short low-bit cycles a plain LCG
 * has. Those cycles read as a real rhythm to a beat detector, which would make
 * "is this noise?" tests pass or fail for the wrong reason.
 */
function noise(length: number, amplitude: number, seed = 7): Float32Array {
	const samples = new Float32Array(length);
	let state = seed >>> 0;
	for (let index = 0; index < length; index++) {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		samples[index] = ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * amplitude;
	}
	return samples;
}

/** A click track: short bursts at a fixed tempo, which is what a beat is. */
function clicks(seconds: number, bpm: number, rate = RATE): Float32Array {
	const samples = new Float32Array(Math.round(seconds * rate));
	const period = (60 / bpm) * rate;
	for (let beat = 0; beat * period < samples.length; beat++) {
		const start = Math.round(beat * period);
		const length = Math.round(rate * 0.03);
		for (let index = 0; index < length && start + index < samples.length; index++) {
			// Decaying burst, so each click is a clear energy rise.
			samples[start + index] =
				Math.sin((2 * Math.PI * 900 * index) / rate) * (1 - index / length);
		}
	}
	return samples;
}

describe("detectBeats", () => {
	it("recovers the tempo of a click track", () => {
		const analysis = detectBeats(clicks(8, 120), RATE);
		expect(analysis.bpm).toBeGreaterThan(112);
		expect(analysis.bpm).toBeLessThan(128);
		expect(analysis.confidence).toBeGreaterThan(0.8);
	});

	it("places beats about one period apart", () => {
		const analysis = detectBeats(clicks(8, 120), RATE);
		expect(analysis.beats.length).toBeGreaterThan(8);
		const gaps = analysis.beats.slice(1).map((beat, index) => beat - analysis.beats[index]);
		const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
		expect(average).toBeCloseTo(0.5, 1);
	});

	it("marks one downbeat every four beats", () => {
		const analysis = detectBeats(clicks(8, 120), RATE);
		expect(analysis.downbeats.length).toBeCloseTo(analysis.beats.length / 4, 0);
		for (const downbeat of analysis.downbeats) expect(analysis.beats).toContain(downbeat);
	});

	it("scores steady noise below the floor rather than inventing a grid", () => {
		const analysis = detectBeats(noise(RATE * 4, 0.2), RATE);
		expect(analysis.confidence).toBeLessThan(BEAT_CONFIDENCE_FLOOR);
	});

	it("returns nothing for silence", () => {
		const analysis = detectBeats(new Float32Array(RATE), RATE);
		expect(analysis.beats).toEqual([]);
		expect(analysis.bpm).toBe(0);
	});

	it("returns nothing rather than dividing by zero on a too-short buffer", () => {
		expect(detectBeats(new Float32Array(64), RATE).beats).toEqual([]);
	});
});

describe("detectSilence", () => {
	/** Loud, quiet, loud — the shape every dead-air cut is looking for. */
	function withGap(): Float32Array {
		const samples = new Float32Array(RATE * 3);
		samples.set(noise(RATE, 0.4), 0);
		samples.set(noise(RATE, 0.4, 99), RATE * 2);
		return samples;
	}

	it("finds the quiet stretch and nothing else", () => {
		const spans = detectSilence(withGap(), RATE);
		expect(spans).toHaveLength(1);
		const [start, end] = spans[0];
		expect(start).toBeGreaterThanOrEqual(1);
		expect(end).toBeLessThanOrEqual(2);
	});

	it("leaves padding at each edge so a cut doesn't clip the next word", () => {
		const tight = detectSilence(withGap(), RATE, { paddingSeconds: 0 });
		const padded = detectSilence(withGap(), RATE, { paddingSeconds: 0.2 });
		expect(padded[0][0] - tight[0][0]).toBeCloseTo(0.2, 1);
		expect(tight[0][1] - padded[0][1]).toBeCloseTo(0.2, 1);
	});

	it("ignores gaps shorter than the minimum", () => {
		expect(detectSilence(withGap(), RATE, { minDurationSeconds: 5 })).toEqual([]);
	});

	it("finds nothing in continuous sound", () => {
		expect(detectSilence(noise(RATE * 2, 0.4), RATE)).toEqual([]);
	});

	it("measures relative to the recording's own peaks, not an absolute level", () => {
		const quiet = new Float32Array(RATE * 3);
		quiet.set(noise(RATE, 0.01), 0);
		quiet.set(noise(RATE, 0.01, 99), RATE * 2);
		// The loud passages are only 0.01 — an absolute threshold would call the
		// whole file silent.
		expect(detectSilence(quiet, RATE)).toHaveLength(1);
	});

	it("returns nothing for a buffer with no windows", () => {
		expect(detectSilence(new Float32Array(4), RATE)).toEqual([]);
	});
});

describe("findSyncOffset", () => {
	/** A recognisable envelope: a burst at a known place in a quiet field. */
	function take(seconds: number, burstAt: number): Float32Array {
		const samples = noise(Math.round(seconds * RATE), 0.01);
		const start = Math.round(burstAt * RATE);
		const length = Math.round(RATE * 0.3);
		for (let index = 0; index < length; index++) {
			samples[start + index] = (samples[start + index] ?? 0) + 0.6;
		}
		return samples;
	}

	it("finds a zero offset for identical takes", () => {
		const a = take(4, 1);
		const result = findSyncOffset(a, a, RATE);
		expect(result.offsetSeconds).toBeCloseTo(0, 1);
		expect(result.confidence).toBeGreaterThan(0.9);
	});

	it("reports how far the target lags the reference", () => {
		const reference = take(4, 1);
		const target = take(4, 1.5);
		const result = findSyncOffset(reference, target, RATE);
		// The target's burst happens 0.5s later, so it must move 0.5s earlier.
		expect(result.offsetSeconds).toBeCloseTo(-0.5, 1);
		expect(result.confidence).toBeGreaterThan(0.5);
	});

	it("handles the target leading the reference", () => {
		const result = findSyncOffset(take(4, 1.5), take(4, 1), RATE);
		expect(result.offsetSeconds).toBeCloseTo(0.5, 1);
	});

	it("reports low confidence for unrelated material", () => {
		const a = noise(RATE * 3, 0.3, 1);
		const b = noise(RATE * 3, 0.3, 500);
		expect(findSyncOffset(a, b, RATE).confidence).toBeLessThan(0.5);
	});

	it("respects the search window", () => {
		const result = findSyncOffset(take(4, 1), take(4, 3), RATE, 0.5);
		expect(Math.abs(result.offsetSeconds)).toBeLessThanOrEqual(0.5);
	});

	it("returns nothing for buffers too short to correlate", () => {
		const result = findSyncOffset(new Float32Array(8), new Float32Array(8), RATE);
		expect(result).toEqual({ offsetSeconds: 0, confidence: 0 });
	});
});

describe("measureNoiseFloor", () => {
	it("reads the floor from the quiet part, not the loud part", () => {
		const samples = new Float32Array(RATE * 2);
		samples.set(noise(RATE, 0.005), 0);
		samples.set(noise(RATE, 0.5, 42), RATE);
		const profile = measureNoiseFloor(samples, RATE);
		expect(profile.floorDb).toBeLessThan(-30);
	});

	it("does not latch onto a single digital-silence sample", () => {
		const samples = noise(RATE, 0.2);
		samples[100] = 0;
		expect(measureNoiseFloor(samples, RATE).floor).toBeGreaterThan(0);
	});

	it("returns a floor of nothing for a buffer with no windows", () => {
		expect(measureNoiseFloor(new Float32Array(4), RATE).floorDb).toBe(-120);
	});
});
