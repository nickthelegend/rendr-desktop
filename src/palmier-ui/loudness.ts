// Integrated loudness (ITU-R BS.1770-4 / EBU R128) and true peak.
//
// This is the measurement every platform normalises against: YouTube, Spotify
// and TikTok turn a mix down to about -14 LUFS, Apple Podcasts asks for -16, and
// EBU broadcast delivers at -23. An unweighted RMS figure tracks it loosely for
// speech, but misreads anything with bass or sibilance in it, so a creator
// asking "will this be turned down?" needs the real number.
//
// The algorithm, as the standard writes it:
//
//   1. K-weighting: a high shelf (+4 dB above ~1.5 kHz, modelling the head) and
//      the RLB high-pass (~38 Hz), as two biquads per channel.
//   2. Mean square per channel over 400 ms blocks, stepped by 100 ms (75%
//      overlap), summed across channels with the surround weights.
//   3. Absolute gate: blocks below -70 LUFS are dropped — that is silence, and
//      a take with a long quiet head is not a quiet take.
//   4. Relative gate: blocks more than 10 LU below the loudness of what passed
//      the absolute gate are dropped, so pauses between sentences don't drag
//      the figure down.
//   5. Integrated loudness is the power average of what survives.
//
// Pure functions over sample arrays, so they are tested against signals whose
// loudness is known exactly rather than against another meter's opinion.

/** Normalised biquad: a0 is 1. */
export interface Biquad {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
/** Floor reported for a peak in digital silence, so results stay JSON numbers. */
const SILENT_DB = -120;

/**
 * The two K-weighting stages, derived for any sample rate.
 *
 * The standard tabulates coefficients for 48 kHz only. Web Audio decodes at the
 * context's rate — often 44.1 kHz — so the filters are rebuilt from the analog
 * prototypes (the same parameters libebur128 uses) via the bilinear transform,
 * which reproduces the 48 kHz table to better than 1e-8.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
	return [highShelf(sampleRate), rlbHighPass(sampleRate)];
}

/** Stage 1: the +4 dB high shelf that models the head. */
function highShelf(sampleRate: number): Biquad {
	const f0 = 1681.974450955533;
	const gainDb = 3.999843853973347;
	const q = 0.7071752369554196;
	const k = Math.tan((Math.PI * f0) / sampleRate);
	const vh = 10 ** (gainDb / 20);
	const vb = vh ** 0.4996667741545416;
	const a0 = 1 + k / q + k * k;
	return {
		b0: (vh + (vb * k) / q + k * k) / a0,
		b1: (2 * (k * k - vh)) / a0,
		b2: (vh - (vb * k) / q + k * k) / a0,
		a1: (2 * (k * k - 1)) / a0,
		a2: (1 - k / q + k * k) / a0,
	};
}

/** Stage 2: the RLB high-pass. The standard leaves its numerator unscaled. */
function rlbHighPass(sampleRate: number): Biquad {
	const f0 = 38.13547087602444;
	const q = 0.5003270373238773;
	const k = Math.tan((Math.PI * f0) / sampleRate);
	const a0 = 1 + k / q + k * k;
	return {
		b0: 1,
		b1: -2,
		b2: 1,
		a1: (2 * (k * k - 1)) / a0,
		a2: (1 - k / q + k * k) / a0,
	};
}

/**
 * Per-channel weights from BS.1770: 1 for front channels, 1.41 (+1.5 dB) for
 * surrounds, and the LFE left out. Six channels are read in Web Audio's 5.1
 * order — L, R, C, LFE, Ls, Rs.
 */
export function channelWeights(count: number): number[] {
	if (count === 6) return [1, 1, 1, 0, 1.41, 1.41];
	return Array.from({ length: count }, () => 1);
}

/** Source sample ranges, [start, end), measured as if spliced together. */
export type SampleRange = readonly [number, number];

export interface LoudnessMeasurement {
	/** Gated integrated loudness. Null when nothing passed the gates (silence, or under 400 ms). */
	integratedLufs: number | null;
	/** Highest momentary (400 ms) loudness, or null when no block was measured. */
	maxMomentaryLufs: number | null;
	/** 4x-oversampled peak estimate, in dBTP. */
	truePeakDb: number;
	/** Highest sample magnitude, in dBFS. */
	samplePeakDb: number;
	/** Seconds of audio that survived both gates — how much of it is programme. */
	gatedSeconds: number;
	/** Seconds measured in total. */
	measuredSeconds: number;
}

function powerToLufs(power: number): number {
	return power > 0 ? -0.691 + 10 * Math.log10(power) : Number.NEGATIVE_INFINITY;
}

function round(value: number, places = 2): number {
	return Number(value.toFixed(places));
}

function clampRanges(length: number, ranges?: readonly SampleRange[]): Array<[number, number]> {
	const source = ranges && ranges.length > 0 ? ranges : [[0, length] as const];
	return source
		.map(([start, end]): [number, number] => [
			Math.max(0, Math.min(length, Math.floor(start))),
			Math.max(0, Math.min(length, Math.floor(end))),
		])
		.filter(([start, end]) => end > start);
}

/**
 * K-weighted energy per 100 ms step, for one channel over one range.
 *
 * Steps rather than whole blocks, because a 400 ms block at a 100 ms hop is
 * just four consecutive steps summed — computing it that way filters every
 * sample once instead of four times.
 */
function weightedStepEnergies(
	samples: Float32Array,
	start: number,
	end: number,
	step: number,
	filters: readonly [Biquad, Biquad],
): Float64Array {
	const [s, h] = filters;
	const steps = Math.floor((end - start) / step);
	const energies = new Float64Array(steps);
	// Direct form I, in doubles: the RLB pole sits very near the unit circle,
	// and single precision lets it drift.
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	let z1 = 0;
	let z2 = 0;
	for (let index = 0; index < steps; index++) {
		let sum = 0;
		const from = start + index * step;
		for (let n = from; n < from + step; n++) {
			const x = samples[n];
			const y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
			x2 = x1;
			x1 = x;
			const z = h.b0 * y + h.b1 * y1 + h.b2 * y2 - h.a1 * z1 - h.a2 * z2;
			y2 = y1;
			y1 = y;
			z2 = z1;
			z1 = z;
			sum += z * z;
		}
		energies[index] = sum;
	}
	return energies;
}

/**
 * Integrated loudness and true peak of some audio.
 *
 * `channels` are the decoded channels as they are — not a mono mixdown. The
 * standard sums channel *powers*, so a stereo file with the same signal in
 * both channels reads 3 dB louder than one channel of it alone, which is how
 * it plays. `ranges` restricts the measurement to the parts of a source a
 * timeline actually uses; each range is filtered from rest, since an edit
 * point is a discontinuity anyway.
 */
export function measureIntegratedLoudness(
	channels: readonly Float32Array[],
	sampleRate: number,
	ranges?: readonly SampleRange[],
): LoudnessMeasurement {
	const length = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
	const spans = clampRanges(length, ranges);
	const measuredSamples = spans.reduce((sum, [start, end]) => sum + (end - start), 0);
	const peaks = measurePeaks(channels, spans);
	const empty: LoudnessMeasurement = {
		integratedLufs: null,
		maxMomentaryLufs: null,
		truePeakDb: peaks.truePeakDb,
		samplePeakDb: peaks.samplePeakDb,
		gatedSeconds: 0,
		measuredSeconds: sampleRate > 0 ? round(measuredSamples / sampleRate, 3) : 0,
	};
	if (sampleRate <= 0 || channels.length === 0) return empty;

	const step = Math.max(1, Math.round(sampleRate * STEP_SECONDS));
	const stepsPerBlock = Math.round(BLOCK_SECONDS / STEP_SECONDS);
	const blockLength = step * stepsPerBlock;
	const filters = kWeightingFilters(sampleRate);
	const weights = channelWeights(channels.length);

	// Weighted mean-square power of every 400 ms block, across every range.
	const blocks: number[] = [];
	for (const [start, end] of spans) {
		const perChannel = channels.map((channel, index) =>
			weights[index] > 0 ? weightedStepEnergies(channel, start, end, step, filters) : null,
		);
		const steps = Math.floor((end - start) / step);
		for (let first = 0; first + stepsPerBlock <= steps; first++) {
			let power = 0;
			for (let channel = 0; channel < channels.length; channel++) {
				const energies = perChannel[channel];
				if (!energies) continue;
				let energy = 0;
				for (let offset = 0; offset < stepsPerBlock; offset++) {
					energy += energies[first + offset];
				}
				power += weights[channel] * (energy / blockLength);
			}
			blocks.push(power);
		}
	}
	if (blocks.length === 0) return empty;

	let loudest = 0;
	for (const power of blocks) if (power > loudest) loudest = power;

	const absolute = blocks.filter((power) => powerToLufs(power) > ABSOLUTE_GATE_LUFS);
	if (absolute.length === 0) {
		return { ...empty, maxMomentaryLufs: round(powerToLufs(loudest)) };
	}
	const absoluteMean = absolute.reduce((sum, power) => sum + power, 0) / absolute.length;
	const relativeGate = powerToLufs(absoluteMean) + RELATIVE_GATE_LU;
	const gated = absolute.filter((power) => powerToLufs(power) > relativeGate);
	const gatedMean = gated.reduce((sum, power) => sum + power, 0) / Math.max(1, gated.length);

	return {
		...empty,
		integratedLufs: gated.length > 0 ? round(powerToLufs(gatedMean)) : null,
		maxMomentaryLufs: round(powerToLufs(loudest)),
		// Blocks overlap, so each surviving one stands for one 100 ms hop.
		gatedSeconds: round(gated.length * STEP_SECONDS, 1),
	};
}

// ── True peak ─────────────────────────────────────────────────────────

const OVERSAMPLE = 4;
const HALF_TAPS = 6;

/**
 * Interpolation filters for the three in-between positions of 4x oversampling:
 * a Blackman-windowed sinc, 12 taps per phase. Each phase is scaled to unity
 * DC gain so a constant signal doesn't read as a peak.
 */
const PHASES: Float64Array[] = (() => {
	const phases: Float64Array[] = [];
	for (let phase = 1; phase < OVERSAMPLE; phase++) {
		const fraction = phase / OVERSAMPLE;
		const taps = new Float64Array(HALF_TAPS * 2);
		let sum = 0;
		for (let tap = 0; tap < taps.length; tap++) {
			// Tap `tap` multiplies sample i + tap - HALF_TAPS + 1.
			const distance = fraction - (tap - HALF_TAPS + 1);
			const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
			const position = (distance + HALF_TAPS) / (HALF_TAPS * 2);
			const window =
				0.42 -
				0.5 * Math.cos(2 * Math.PI * position) +
				0.08 * Math.cos(4 * Math.PI * position);
			taps[tap] = sinc * window;
			sum += taps[tap];
		}
		for (let tap = 0; tap < taps.length; tap++) taps[tap] /= sum;
		phases.push(taps);
	}
	return phases;
})();

/**
 * Sample peak and a 4x-oversampled true-peak estimate.
 *
 * Interpolating every sample of a long file is most of the cost, and an
 * inter-sample peak can only exceed the sample peak where neighbouring samples
 * are already close to it — so only the stretches within 6 dB of the sample
 * peak are oversampled. That is an estimate, labelled as one, which is what a
 * ceiling needs: a margin, not a certificate.
 */
function measurePeaks(
	channels: readonly Float32Array[],
	spans: ReadonlyArray<readonly [number, number]>,
): { samplePeakDb: number; truePeakDb: number } {
	let samplePeak = 0;
	for (const channel of channels) {
		for (const [start, end] of spans) {
			for (let index = start; index < Math.min(end, channel.length); index++) {
				const value = Math.abs(channel[index]);
				if (value > samplePeak) samplePeak = value;
			}
		}
	}
	if (samplePeak === 0) return { samplePeakDb: SILENT_DB, truePeakDb: SILENT_DB };

	const near = samplePeak * 10 ** (-6 / 20);
	let truePeak = samplePeak;
	for (const channel of channels) {
		for (const [start, rawEnd] of spans) {
			const end = Math.min(rawEnd, channel.length);
			for (let index = start; index < end - 1; index++) {
				if (Math.abs(channel[index]) < near && Math.abs(channel[index + 1]) < near)
					continue;
				for (const taps of PHASES) {
					let value = 0;
					for (let tap = 0; tap < taps.length; tap++) {
						const at = index + tap - HALF_TAPS + 1;
						if (at >= start && at < end) value += taps[tap] * channel[at];
					}
					const magnitude = Math.abs(value);
					if (magnitude > truePeak) truePeak = magnitude;
				}
			}
		}
	}

	return {
		samplePeakDb: round(20 * Math.log10(samplePeak)),
		truePeakDb: round(20 * Math.log10(truePeak)),
	};
}

// ── Reaching a target ─────────────────────────────────────────────────

export interface LoudnessGain {
	gainDb: number;
	/** What held the gain back, if anything. */
	limitedBy: "truePeak" | null;
	/** How far short of the target the result lands, in LU. 0 when it reaches it. */
	shortfallDb: number;
	/** Integrated loudness after the gain. */
	resultLufs: number;
	/** True peak after the gain. */
	resultTruePeakDb: number;
}

/**
 * The gain that brings a measurement to a loudness target without crossing a
 * true-peak ceiling.
 *
 * There is no limiter in Rendr's audio path, so a gain that would push the
 * peaks over the ceiling is capped instead, and the shortfall reported: a
 * talking-head take with sharp plosives can't reach -14 LUFS by gain alone,
 * and a receipt claiming it had would be wrong.
 */
export function loudnessGain(
	measurement: Pick<LoudnessMeasurement, "integratedLufs" | "truePeakDb">,
	targetLufs: number,
	ceilingDb = -1,
): LoudnessGain | null {
	if (measurement.integratedLufs === null) return null;
	const wanted = targetLufs - measurement.integratedLufs;
	const headroom = ceilingDb - measurement.truePeakDb;
	const gainDb = Math.min(wanted, headroom);
	const limited = wanted > headroom;
	return {
		gainDb: round(gainDb),
		limitedBy: limited ? "truePeak" : null,
		shortfallDb: limited ? round(wanted - headroom) : 0,
		resultLufs: round(measurement.integratedLufs + gainDb),
		resultTruePeakDb: round(measurement.truePeakDb + gainDb),
	};
}
