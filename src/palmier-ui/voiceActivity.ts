// Where someone is talking, in a recording of them talking.
//
// Ducking music under a creator's own voice needs the spans of speech in the
// camera audio, not a narration track. A neural VAD would be more precise, but
// a talking-head take is one close voice over room tone — the easy case — and
// an energy detector restricted to the speech band gets it right without a
// model or a network. Three choices make it hold up on real takes:
//
//   - The level is measured after a 120 Hz–4 kHz band-pass, so HVAC rumble,
//     desk thumps and a bass-heavy bed bleeding into the mic don't read as
//     talking.
//   - The threshold is relative to the take itself — between its noise floor
//     and its loud passages — so a quietly recorded voice isn't read as silence
//     and a noisy room isn't read as speech.
//   - Short gaps are bridged (hangover) and short blips dropped, because a
//     duck that lifts between every word pumps, and one that dips for a cough
//     is worse than none.

export interface SpeechOptions {
	/** Gaps shorter than this are pauses inside a phrase and stay "speech". */
	hangoverSeconds: number;
	/** Bursts shorter than this are clicks or coughs, not speech. */
	minSpeechSeconds: number;
	/** How far above the noise floor a frame must be to count, in dB. */
	floorMarginDb: number;
	/** Frames this far below the take's loud passages never count, in dB. */
	rangeDb: number;
}

const DEFAULT_SPEECH: SpeechOptions = {
	hangoverSeconds: 0.3,
	minSpeechSeconds: 0.15,
	floorMarginDb: 10,
	rangeDb: 30,
};

const FRAME_SECONDS = 0.02;

/** One Butterworth (Q = 1/√2) RBJ biquad section, returning a filtered copy. */
function biquad(
	input: Float32Array,
	sampleRate: number,
	kind: "highpass" | "lowpass",
	frequency: number,
): Float32Array {
	const w0 = (2 * Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate;
	const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
	const cos = Math.cos(w0);
	const a0 = 1 + alpha;
	const b0 = (kind === "highpass" ? (1 + cos) / 2 : (1 - cos) / 2) / a0;
	const b1 = (kind === "highpass" ? -(1 + cos) : 1 - cos) / a0;
	const b2 = b0;
	const a1 = (-2 * cos) / a0;
	const a2 = (1 - alpha) / a0;

	const out = new Float32Array(input.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	for (let index = 0; index < input.length; index++) {
		const x = input[index];
		const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
		x2 = x1;
		x1 = x;
		y2 = y1;
		y1 = y;
		out[index] = y;
	}
	return out;
}

function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) return -120;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
	return sorted[index];
}

/**
 * Spans of speech, in seconds from the start of `samples`.
 *
 * Returns nothing for digital silence or a buffer too short to frame, rather
 * than inventing a span — a duck under nothing is a level change nobody asked
 * for.
 */
export function detectSpeech(
	samples: Float32Array,
	sampleRate: number,
	options: Partial<SpeechOptions> = {},
): Array<[number, number]> {
	const config = { ...DEFAULT_SPEECH, ...options };
	if (sampleRate <= 0) return [];
	const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
	const frames = Math.floor(samples.length / frame);
	if (frames < 2) return [];

	const band = biquad(biquad(samples, sampleRate, "highpass", 120), sampleRate, "lowpass", 4000);
	const levels = new Float64Array(frames);
	for (let index = 0; index < frames; index++) {
		let sum = 0;
		for (let n = index * frame; n < (index + 1) * frame; n++) sum += band[n] * band[n];
		const rms = Math.sqrt(sum / frame);
		levels[index] = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
	}

	const sorted = [...levels].sort((a, b) => a - b);
	const loud = percentile(sorted, 0.95);
	if (loud <= -100) return [];
	const floor = percentile(sorted, 0.1);
	// Between the floor and the loud passages: never closer to the loud end than
	// 6 dB, so a take that is talking wall to wall (floor ≈ speech) still reads
	// as speech rather than as nothing.
	const threshold = Math.min(
		loud - 6,
		Math.max(floor + config.floorMarginDb, loud - config.rangeDb),
	);

	const active: boolean[] = Array.from(levels, (level) => level > threshold);

	// Bridge short gaps first, then drop short bursts, so a phrase with brief
	// pauses survives as one span and an isolated click does not.
	const hangover = Math.round(config.hangoverSeconds / FRAME_SECONDS);
	let lastActive = -1;
	for (let index = 0; index < frames; index++) {
		if (!active[index]) continue;
		if (lastActive >= 0 && index - lastActive - 1 <= hangover) {
			for (let gap = lastActive + 1; gap < index; gap++) active[gap] = true;
		}
		lastActive = index;
	}

	const minFrames = Math.max(1, Math.round(config.minSpeechSeconds / FRAME_SECONDS));
	const spans: Array<[number, number]> = [];
	let runStart = -1;
	for (let index = 0; index <= frames; index++) {
		const on = index < frames && active[index];
		if (on && runStart < 0) runStart = index;
		if (!on && runStart >= 0) {
			if (index - runStart >= minFrames) {
				spans.push([
					Number(((runStart * frame) / sampleRate).toFixed(3)),
					Number(((index * frame) / sampleRate).toFixed(3)),
				]);
			}
			runStart = -1;
		}
	}
	return spans;
}
