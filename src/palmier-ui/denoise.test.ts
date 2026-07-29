import { describe, expect, it } from "vitest";

import { gainToDb } from "./analysis";
import { denoiseSamples, noiseSpectrum } from "./denoise";

const RATE = 48_000;

function tone(seconds: number, frequency: number, amplitude = 0.5): Float32Array {
	const samples = new Float32Array(Math.round(seconds * RATE));
	for (let index = 0; index < samples.length; index++) {
		samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / RATE);
	}
	return samples;
}

/**
 * Bursts of tone separated by gaps — a stand-in for speech.
 *
 * Spectral subtraction distinguishes signal from noise by whether it is
 * *steady*, so a continuous sine is, correctly, indistinguishable from steady
 * hiss. Anything testing "the signal survives" has to be non-stationary.
 */
function bursts(seconds: number, frequency: number, amplitude = 0.5): Float32Array {
	const samples = tone(seconds, frequency, amplitude);
	const period = Math.round(RATE * 0.4);
	for (let index = 0; index < samples.length; index++) {
		if (index % period > period * 0.5) samples[index] = 0;
	}
	return samples;
}

/**
 * Deterministic pseudo-noise (mulberry32), so the test doesn't depend on
 * Math.random. A plain LCG's low bits cycle audibly, which would make the
 * "hiss" partly periodic and easier to remove than real hiss.
 */
function hiss(length: number, amplitude: number, seed = 12345): Float32Array {
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

function add(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(a.length);
	for (let index = 0; index < a.length; index++) out[index] = a[index] + (b[index] ?? 0);
	return out;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
	let sum = 0;
	for (let index = from; index < to; index++) sum += samples[index] * samples[index];
	return Math.sqrt(sum / Math.max(1, to - from));
}

describe("noiseSpectrum", () => {
	it("is silent for silence", () => {
		const profile = noiseSpectrum(new Float32Array(RATE));
		expect(Math.max(...profile)).toBe(0);
	});

	it("reports a floor proportional to the hiss level", () => {
		const quiet = noiseSpectrum(hiss(RATE, 0.01));
		const loud = noiseSpectrum(hiss(RATE, 0.1));
		const sum = (profile: Float32Array) => profile.reduce((total, value) => total + value, 0);
		expect(sum(loud)).toBeGreaterThan(sum(quiet) * 5);
	});

	it("measures the floor, not the signal, when speech is present", () => {
		// A second of hiss, then a second of hiss plus a loud tone.
		const noiseOnly = hiss(RATE, 0.02);
		const withTone = add(hiss(RATE, 0.02), tone(1, 440, 0.5));
		const mixed = new Float32Array(RATE * 2);
		mixed.set(noiseOnly, 0);
		mixed.set(withTone, RATE);

		const profile = noiseSpectrum(mixed);
		const noiseFloorOnly = noiseSpectrum(noiseOnly);
		const sum = (values: Float32Array) => values.reduce((total, value) => total + value, 0);
		// Within a factor of two of the true floor: the tone did not drag it up.
		expect(sum(profile)).toBeLessThan(sum(noiseFloorOnly) * 2);
	});
});

describe("denoiseSamples", () => {
	it("returns the input untouched at strength 0", () => {
		const input = hiss(RATE, 0.05);
		expect(denoiseSamples(input, 0)).toBe(input);
	});

	it("returns the input untouched when it is shorter than one frame", () => {
		const input = hiss(256, 0.05);
		expect(denoiseSamples(input, 1)).toBe(input);
	});

	it("lowers the noise floor of a hiss-only recording", () => {
		const noisy = hiss(RATE, 0.05);
		const cleaned = denoiseSamples(noisy, 1);
		expect(rms(cleaned)).toBeLessThan(rms(noisy) * 0.5);
	});

	it("keeps a non-steady signal while removing the hiss around it", () => {
		const clean = bursts(3, 440, 0.4);
		const noisy = add(clean, hiss(clean.length, 0.05));
		const result = denoiseSamples(noisy, 0.8);

		// The bursts survive: most of the clean signal's level is still there.
		expect(rms(result)).toBeGreaterThan(rms(clean) * 0.6);
		// And the result is closer to the clean signal than the input was.
		const error = (a: Float32Array) => {
			let sum = 0;
			for (let index = 0; index < clean.length; index++) {
				sum += (a[index] - clean[index]) ** 2;
			}
			return Math.sqrt(sum / clean.length);
		};
		expect(error(result)).toBeLessThan(error(noisy));
	});

	it("quietens the gaps between bursts far more than the bursts", () => {
		const clean = bursts(3, 440, 0.4);
		const noisy = add(clean, hiss(clean.length, 0.05));
		const result = denoiseSamples(noisy, 0.8);

		const period = Math.round(RATE * 0.4);
		const loudFrom = Math.round(period * 0.1);
		const loudTo = Math.round(period * 0.4);
		const gapFrom = Math.round(period * 0.6);
		const gapTo = Math.round(period * 0.9);

		const gapBefore = rms(noisy, gapFrom, gapTo);
		const gapAfter = rms(result, gapFrom, gapTo);
		const loudBefore = rms(noisy, loudFrom, loudTo);
		const loudAfter = rms(result, loudFrom, loudTo);

		expect(gapAfter).toBeLessThan(gapBefore * 0.5);
		expect(loudAfter).toBeGreaterThan(loudBefore * 0.7);
	});

	it("treats a perfectly steady tone as noise, because that is what it is", () => {
		// Not a defect — a stationary sine carries no information a spectral
		// method can tell apart from hiss. Documented so nobody 'fixes' it.
		const steady = tone(1, 300, 0.4);
		expect(rms(denoiseSamples(steady, 1))).toBeLessThan(rms(steady));
	});

	it("removes more at higher strength", () => {
		const noisy = hiss(RATE, 0.05);
		const light = rms(denoiseSamples(noisy, 0.3));
		const heavy = rms(denoiseSamples(noisy, 1));
		expect(heavy).toBeLessThan(light);
	});

	it("never exceeds the input's peak, including at the very edges", () => {
		const noisy = add(bursts(1, 220, 0.6), hiss(RATE, 0.05));
		const result = denoiseSamples(noisy, 0.6);
		let inputPeak = 0;
		for (const sample of noisy) inputPeak = Math.max(inputPeak, Math.abs(sample));
		let outputPeak = 0;
		for (const sample of result) outputPeak = Math.max(outputPeak, Math.abs(sample));
		expect(outputPeak).toBeLessThanOrEqual(inputPeak);
	});

	it("returns exactly as many samples as it was given", () => {
		const noisy = hiss(RATE + 137, 0.05);
		expect(denoiseSamples(noisy, 0.6).length).toBe(noisy.length);
	});

	it("holds a burst's level within a few dB when the input is already clean", () => {
		const clean = bursts(3, 300, 0.4);
		const result = denoiseSamples(clean, 0.6);
		const change = gainToDb(rms(result) / rms(clean));
		expect(Math.abs(change)).toBeLessThan(6);
	});
});
