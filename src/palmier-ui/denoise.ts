// Denoise: spectral subtraction over an overlap-added STFT.
//
// This is a real noise reduction, not a gate on the whole signal. The noise
// floor is measured per frequency bin from the recording's own quiet passages,
// then subtracted from every frame — so a steady hiss or room tone comes out
// while speech, which is not steady, stays in.
//
// It is not a neural speech-enhancement model, and nothing here claims to be
// one. Everything runs locally on plain arrays and is testable without audio
// hardware.

const FFT_SIZE = 1024;
const HOP = FFT_SIZE / 4;

/** Radix-2 in-place complex FFT. Sizes are powers of two by construction. */
function fft(real: Float32Array, imag: Float32Array): void {
	const n = real.length;

	// Bit-reversal permutation.
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[real[i], real[j]] = [real[j], real[i]];
			[imag[i], imag[j]] = [imag[j], imag[i]];
		}
	}

	for (let length = 2; length <= n; length <<= 1) {
		const angle = (-2 * Math.PI) / length;
		const stepReal = Math.cos(angle);
		const stepImag = Math.sin(angle);
		for (let start = 0; start < n; start += length) {
			let wReal = 1;
			let wImag = 0;
			for (let offset = 0; offset < length / 2; offset++) {
				const a = start + offset;
				const b = a + length / 2;
				const tReal = real[b] * wReal - imag[b] * wImag;
				const tImag = real[b] * wImag + imag[b] * wReal;
				real[b] = real[a] - tReal;
				imag[b] = imag[a] - tImag;
				real[a] += tReal;
				imag[a] += tImag;
				const nextReal = wReal * stepReal - wImag * stepImag;
				wImag = wReal * stepImag + wImag * stepReal;
				wReal = nextReal;
			}
		}
	}
}

function ifft(real: Float32Array, imag: Float32Array): void {
	// Conjugate, forward transform, conjugate, scale — the standard identity.
	for (let index = 0; index < imag.length; index++) imag[index] = -imag[index];
	fft(real, imag);
	const scale = 1 / real.length;
	for (let index = 0; index < real.length; index++) {
		real[index] *= scale;
		imag[index] *= -scale;
	}
}

/** Hann window, which sums to a constant at 75% overlap. */
function hann(size: number): Float32Array {
	const window = new Float32Array(size);
	for (let index = 0; index < size; index++) {
		window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
	}
	return window;
}

/**
 * Per-bin noise magnitude, taken from the quietest frames.
 *
 * Using the quietest 10% rather than a hand-picked "noise sample" means the
 * caller doesn't have to find a silent passage — the recording supplies one.
 */
export function noiseSpectrum(samples: Float32Array): Float32Array {
	const window = hann(FFT_SIZE);
	const bins = FFT_SIZE / 2 + 1;
	const frames: Array<{ energy: number; magnitudes: Float32Array }> = [];

	for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP * 2) {
		const real = new Float32Array(FFT_SIZE);
		const imag = new Float32Array(FFT_SIZE);
		let energy = 0;
		for (let index = 0; index < FFT_SIZE; index++) {
			const sample = samples[start + index];
			real[index] = sample * window[index];
			energy += sample * sample;
		}
		fft(real, imag);
		const magnitudes = new Float32Array(bins);
		for (let bin = 0; bin < bins; bin++) {
			magnitudes[bin] = Math.hypot(real[bin], imag[bin]);
		}
		frames.push({ energy, magnitudes });
	}

	const profile = new Float32Array(bins);
	if (frames.length === 0) return profile;

	frames.sort((a, b) => a.energy - b.energy);
	const quiet = frames.slice(0, Math.max(1, Math.floor(frames.length / 10)));
	for (const frame of quiet) {
		for (let bin = 0; bin < bins; bin++) profile[bin] += frame.magnitudes[bin];
	}
	for (let bin = 0; bin < bins; bin++) profile[bin] /= quiet.length;
	return profile;
}

/**
 * Subtracts the measured noise floor from every frame.
 *
 * `strength` is the dry/wet mix the tool exposes: 0 returns the input
 * untouched, 1 subtracts the full measured floor. Full strength on real-world
 * material sounds thin, which is why the tool's default is 0.6.
 */
export function denoiseSamples(
	samples: Float32Array,
	strength: number,
	profile?: Float32Array,
): Float32Array {
	const wet = Math.max(0, Math.min(1, strength));
	if (wet === 0 || samples.length < FFT_SIZE) return samples;

	const noise = profile ?? noiseSpectrum(samples);
	const window = hann(FFT_SIZE);
	const bins = FFT_SIZE / 2 + 1;

	// Pad both ends so every real sample is covered by a full set of overlapping
	// frames. Without this the first and last frame's worth of audio is divided
	// by a near-zero window sum and comes back amplified.
	const padded = new Float32Array(samples.length + FFT_SIZE * 2);
	padded.set(samples, FFT_SIZE);

	const output = new Float32Array(padded.length);
	const weights = new Float32Array(padded.length);

	const real = new Float32Array(FFT_SIZE);
	const imag = new Float32Array(FFT_SIZE);

	for (let start = 0; start + FFT_SIZE <= padded.length; start += HOP) {
		real.fill(0);
		imag.fill(0);
		for (let index = 0; index < FFT_SIZE; index++) {
			real[index] = padded[start + index] * window[index];
		}
		fft(real, imag);

		for (let bin = 0; bin < bins; bin++) {
			const magnitude = Math.hypot(real[bin], imag[bin]);
			if (magnitude <= 0) continue;
			// Over-subtract slightly and keep a small floor: subtracting exactly
			// the estimate leaves "musical noise", isolated bins winking in and out.
			const reduced = Math.max(magnitude * 0.08, magnitude - noise[bin] * 1.5 * wet);
			const gain = reduced / magnitude;
			real[bin] *= gain;
			imag[bin] *= gain;
			// The spectrum of a real signal is conjugate-symmetric; keep it that
			// way or the inverse transform comes back complex.
			const mirror = FFT_SIZE - bin;
			if (bin > 0 && mirror < FFT_SIZE) {
				real[mirror] = real[bin];
				imag[mirror] = -imag[bin];
			}
		}

		ifft(real, imag);
		for (let index = 0; index < FFT_SIZE; index++) {
			output[start + index] += real[index] * window[index];
			weights[start + index] += window[index] * window[index];
		}
	}

	// Normalise by the accumulated window energy. Anywhere the frames don't
	// fully overlap — only the padding, now — the original sample is kept
	// rather than divided by a near-zero weight.
	const result = new Float32Array(samples.length);
	let steady = 0;
	for (const weight of weights) if (weight > steady) steady = weight;
	const floor = steady * 0.9;
	for (let index = 0; index < samples.length; index++) {
		const weight = weights[index + FFT_SIZE];
		result[index] = weight >= floor ? output[index + FFT_SIZE] / weight : samples[index];
	}
	return result;
}
