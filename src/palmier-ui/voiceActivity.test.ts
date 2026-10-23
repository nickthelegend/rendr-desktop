// Finding the creator's voice in their own camera audio.
//
// The synthetic "voice" is a 150 Hz buzz with harmonics up to 3 kHz, gated
// into syllables — what matters to an energy detector is where the energy sits
// and how it comes and goes, and that is what this reproduces. Room tone is
// quiet white noise. The cases pinned are the ones that make a duck sound bad
// when they go wrong: pumping between words, dipping for a click, and treating
// rumble as talking.

import { describe, expect, it } from "vitest";

import { detectSpeech } from "./voiceActivity";

const RATE = 16000;

/** Seeded so a failing case fails the same way every time. */
function noise(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32 - 0.5;
	};
}

/** A timeline of segments: voice, room tone, or a low rumble. */
function take(segments: Array<["voice" | "room" | "rumble" | "click", number]>): Float32Array {
	const total = segments.reduce((sum, [, seconds]) => sum + seconds, 0);
	const out = new Float32Array(Math.round(total * RATE));
	const random = noise(7);
	let at = 0;
	for (const [kind, seconds] of segments) {
		const length = Math.round(seconds * RATE);
		for (let i = 0; i < length; i++) {
			const t = (at + i) / RATE;
			let value = 0.001 * random(); // room tone under everything, ~-65 dBFS
			if (kind === "voice") {
				// Syllables at 4 Hz that never fall fully silent.
				const envelope = 0.3 + 0.7 * Math.abs(Math.sin(Math.PI * 4 * t));
				let buzz = 0;
				for (let harmonic = 1; harmonic * 150 < 3000; harmonic++) {
					buzz += Math.sin(2 * Math.PI * 150 * harmonic * t) / harmonic;
				}
				value += 0.1 * envelope * buzz;
			} else if (kind === "rumble") {
				value += 0.2 * Math.sin(2 * Math.PI * 35 * t);
			} else if (kind === "click") {
				value += 0.3 * random();
			}
			out[at + i] = value;
		}
		at += length;
	}
	return out;
}

describe("detecting speech", () => {
	it("finds each phrase between pauses", () => {
		const spans = detectSpeech(
			take([
				["room", 0.5],
				["voice", 1],
				["room", 1],
				["voice", 1.5],
				["room", 0.5],
			]),
			RATE,
		);
		expect(spans).toHaveLength(2);
		expect(spans[0][0]).toBeCloseTo(0.5, 1);
		expect(spans[0][1]).toBeCloseTo(1.5, 1);
		expect(spans[1][0]).toBeCloseTo(2.5, 1);
		expect(spans[1][1]).toBeCloseTo(4, 1);
	});

	it("bridges a breath inside a phrase, so a duck doesn't pump between words", () => {
		const spans = detectSpeech(
			take([
				["room", 0.5],
				["voice", 1],
				["room", 0.2],
				["voice", 1],
				["room", 0.5],
			]),
			RATE,
		);
		expect(spans).toHaveLength(1);
	});

	it("ignores a click too short to be speech", () => {
		const spans = detectSpeech(
			take([
				["room", 0.5],
				["voice", 1],
				["room", 1],
				["click", 0.04],
				["room", 1],
			]),
			RATE,
		);
		expect(spans).toHaveLength(1);
	});

	it("doesn't read low rumble between phrases as talking", () => {
		const spans = detectSpeech(
			take([
				["voice", 1],
				["rumble", 1.5],
				["voice", 1],
			]),
			RATE,
		);
		expect(spans).toHaveLength(2);
		expect(spans[0][1]).toBeLessThan(1.2);
		expect(spans[1][0]).toBeGreaterThan(2.3);
	});

	it("reads a take that talks wall to wall as one span", () => {
		const spans = detectSpeech(take([["voice", 3]]), RATE);
		expect(spans).toHaveLength(1);
		expect(spans[0][1] - spans[0][0]).toBeGreaterThan(2.9);
	});

	it("finds nothing in digital silence", () => {
		expect(detectSpeech(new Float32Array(RATE * 2), RATE)).toEqual([]);
		expect(detectSpeech(new Float32Array(10), RATE)).toEqual([]);
	});
});
