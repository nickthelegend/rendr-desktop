// Audio analysis: beats, silence, and alignment.
//
// Everything here works on plain sample arrays so it can be tested without a
// browser, and everything runs locally — no service, no upload. The functions
// are deliberately conservative: a wrong beat grid or a wrong sync offset is
// worse than none, so each one reports a confidence the caller can refuse on.

/** Root-mean-square of one window, which is what "how loud is this" means. */
function rms(samples: Float32Array, from: number, length: number): number {
	let sum = 0;
	const end = Math.min(samples.length, from + length);
	for (let index = from; index < end; index++) sum += samples[index] * samples[index];
	const count = end - from;
	return count > 0 ? Math.sqrt(sum / count) : 0;
}

export function gainToDb(gain: number): number {
	return gain <= 1e-6 ? -120 : 20 * Math.log10(gain);
}

// ── Beats ─────────────────────────────────────────────────────────────

/**
 * Below this, the pulse isn't worth cutting to. Non-musical material — speech,
 * room tone, ambience — reports around 0.3, so the floor sits above it.
 */
export const BEAT_CONFIDENCE_FLOOR = 0.45;

export interface BeatAnalysis {
	/** Source seconds. */
	beats: number[];
	/** Bar starts — every fourth beat, phased to the strongest onsets. */
	downbeats: number[];
	bpm: number;
	/** 0–1. Low means the tempo estimate is not worth cutting to. */
	confidence: number;
}

/** ~10 ms of audio per onset frame, whatever the sample rate. */
const ONSET_FRAME_SECONDS = 0.01;
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Energy-flux onset detection followed by autocorrelation for the tempo.
 *
 * This finds the pulse of music. Speech and ambience produce a flat flux curve
 * and fall out as low confidence rather than as an invented grid.
 */
export function detectBeats(samples: Float32Array, sampleRate: number): BeatAnalysis {
	if (sampleRate <= 0) return { beats: [], downbeats: [], bpm: 0, confidence: 0 };
	const hop = Math.max(64, Math.round(sampleRate * ONSET_FRAME_SECONDS));
	const frames = Math.floor(samples.length / hop);
	if (frames < 32) return { beats: [], downbeats: [], bpm: 0, confidence: 0 };

	// Rectified energy rise per hop: an onset is where loudness jumps.
	const raw = new Float32Array(frames);
	let previous = rms(samples, 0, hop);
	for (let index = 1; index < frames; index++) {
		const current = rms(samples, index * hop, hop);
		raw[index] = Math.max(0, current - previous);
		previous = current;
	}

	// A light smear across neighbouring frames. Beat periods are rarely a whole
	// number of frames, and without this a lag that is half a frame off
	// correlates far worse than one that happens to land square.
	const flux = new Float32Array(frames);
	for (let index = 0; index < frames; index++) {
		flux[index] =
			0.25 * (raw[index - 1] ?? 0) + 0.5 * raw[index] + 0.25 * (raw[index + 1] ?? 0);
	}

	let peak = 0;
	for (const value of flux) if (value > peak) peak = value;
	if (peak <= 0) return { beats: [], downbeats: [], bpm: 0, confidence: 0 };
	for (let index = 0; index < flux.length; index++) flux[index] /= peak;

	// Autocorrelate the flux curve; the strongest lag in the musical range is
	// the beat period.
	const hopsPerSecond = sampleRate / hop;
	const minLag = Math.max(2, Math.floor((60 / MAX_BPM) * hopsPerSecond));
	const maxLag = Math.min(frames - 1, Math.ceil((60 / MIN_BPM) * hopsPerSecond));
	if (maxLag <= minLag) return { beats: [], downbeats: [], bpm: 0, confidence: 0 };

	// Rectified flux is all-positive, so its raw autocorrelation is high for
	// every lag. Removing the mean first makes the score measure the pulse
	// rather than the average loudness.
	let fluxMean = 0;
	for (const value of flux) fluxMean += value;
	fluxMean /= frames;
	const centered = new Float32Array(frames);
	for (let index = 0; index < frames; index++) centered[index] = flux[index] - fluxMean;

	// Normalised correlation per lag, so a lag with barely any overlap can't win
	// on the strength of one large product.
	const scores = new Float32Array(maxLag + 1);
	let bestLag = 0;
	let bestScore = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let dot = 0;
		let energyA = 0;
		let energyB = 0;
		for (let index = lag; index < frames; index++) {
			const a = centered[index];
			const b = centered[index - lag];
			dot += a * b;
			energyA += a * a;
			energyB += b * b;
		}
		const denominator = Math.sqrt(energyA * energyB);
		const score = denominator > 0 ? dot / denominator : 0;
		scores[lag] = score;
		if (score > bestScore) {
			bestScore = score;
			bestLag = lag;
		}
	}
	if (bestLag === 0 || bestScore <= 0) {
		return { beats: [], downbeats: [], bpm: 0, confidence: 0 };
	}

	// Autocorrelation peaks just as hard at half and a quarter the tempo, so the
	// bar can outscore the beat — especially when the true period isn't a whole
	// number of hops and only its multiples land squarely. Prefer a subharmonic
	// that scores nearly as well: that one is the beat.
	for (const divisor of [4, 3, 2]) {
		const candidate = bestLag / divisor;
		if (candidate < minLag) continue;
		let peakLag = 0;
		let peak = 0;
		for (let lag = Math.floor(candidate) - 1; lag <= Math.ceil(candidate) + 1; lag++) {
			if (lag < minLag || lag > maxLag) continue;
			if (scores[lag] > peak) {
				peak = scores[lag];
				peakLag = lag;
			}
		}
		if (peakLag > 0 && peak >= bestScore * 0.7) {
			bestLag = peakLag;
			break;
		}
	}

	// How far the winning lag stands above a typical lag says whether there is a
	// pulse at all. A click track scores near 1; speech and steady ambience land
	// around 0.3, which is why BEAT_CONFIDENCE_FLOOR sits above that.
	const ranked = [...scores.slice(minLag, maxLag + 1)].sort((a, b) => a - b);
	const median = ranked[Math.floor(ranked.length / 2)] ?? 0;
	const confidence = Math.max(0, Math.min(1, bestScore - median));

	const period = bestLag / hopsPerSecond;
	const bpm = Math.round(60 / period);

	// Phase: slide a comb of beat positions and keep the offset that lands on
	// the most onset energy.
	let bestPhase = 0;
	let bestPhaseScore = -1;
	for (let phase = 0; phase < bestLag; phase++) {
		let score = 0;
		for (let index = phase; index < frames; index += bestLag) score += flux[index];
		if (score > bestPhaseScore) {
			bestPhaseScore = score;
			bestPhase = phase;
		}
	}

	const beats: number[] = [];
	for (let index = bestPhase; index < frames; index += bestLag) {
		beats.push(Number((index / hopsPerSecond).toFixed(3)));
	}

	// Downbeats: assume 4/4 and pick the bar phase carrying the most energy.
	let barPhase = 0;
	let barScore = -1;
	for (let phase = 0; phase < 4; phase++) {
		let score = 0;
		for (let index = phase; index < beats.length; index += 4) {
			score += flux[bestPhase + index * bestLag] ?? 0;
		}
		if (score > barScore) {
			barScore = score;
			barPhase = phase;
		}
	}
	const downbeats = beats.filter((_, index) => (index - barPhase) % 4 === 0);

	return { beats, downbeats, bpm, confidence: Number(confidence.toFixed(3)) };
}

// ── Silence ───────────────────────────────────────────────────────────

export interface SilenceOptions {
	/** Anything quieter than this counts as silence. */
	thresholdDb: number;
	/** Shorter gaps than this are breaths, not dead air. */
	minDurationSeconds: number;
	/** Kept at each edge so cuts don't clip the start of a word. */
	paddingSeconds: number;
}

const DEFAULT_SILENCE: SilenceOptions = {
	thresholdDb: -45,
	minDurationSeconds: 0.4,
	paddingSeconds: 0.08,
};

/**
 * Spans quiet enough for long enough to be worth cutting, in source seconds.
 *
 * The threshold is relative to the recording's own loud passages, not an
 * absolute level, so a quietly-recorded voice isn't read as one long silence.
 */
export function detectSilence(
	samples: Float32Array,
	sampleRate: number,
	options: Partial<SilenceOptions> = {},
): Array<[number, number]> {
	const config = { ...DEFAULT_SILENCE, ...options };
	const window = Math.max(1, Math.floor(sampleRate * 0.02));
	const windows = Math.floor(samples.length / window);
	if (windows < 2) return [];

	const levels = new Float32Array(windows);
	let loudest = 0;
	for (let index = 0; index < windows; index++) {
		levels[index] = rms(samples, index * window, window);
		if (levels[index] > loudest) loudest = levels[index];
	}
	if (loudest <= 0) return [];

	const cutoff = loudest * 10 ** (config.thresholdDb / 20);
	const spans: Array<[number, number]> = [];
	let runStart = -1;

	for (let index = 0; index <= windows; index++) {
		const quiet = index < windows && levels[index] < cutoff;
		if (quiet && runStart < 0) runStart = index;
		if (!quiet && runStart >= 0) {
			const from = (runStart * window) / sampleRate;
			const to = (index * window) / sampleRate;
			if (to - from >= config.minDurationSeconds) {
				// Leave a little air at each edge; a cut flush against speech
				// clips the consonant that starts the next word.
				const start = from + config.paddingSeconds;
				const end = to - config.paddingSeconds;
				if (end > start) spans.push([Number(start.toFixed(3)), Number(end.toFixed(3))]);
			}
			runStart = -1;
		}
	}

	return spans;
}

// ── Alignment ─────────────────────────────────────────────────────────

export interface SyncResult {
	/** Seconds to shift the target so it lines up with the reference. */
	offsetSeconds: number;
	/** 0–1 normalised correlation peak. */
	confidence: number;
}

const ENVELOPE_RATE = 200;

/** Loudness envelope at a fixed rate — what cross-correlation actually matches. */
export function envelope(samples: Float32Array, sampleRate: number): Float32Array {
	const window = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE));
	const count = Math.floor(samples.length / window);
	const out = new Float32Array(count);
	let mean = 0;
	for (let index = 0; index < count; index++) {
		out[index] = rms(samples, index * window, window);
		mean += out[index];
	}
	// Remove the DC level so the correlation matches shape, not overall volume.
	mean /= Math.max(1, count);
	for (let index = 0; index < count; index++) out[index] -= mean;
	return out;
}

/**
 * Finds how far the target sits from the reference, by correlating envelopes.
 *
 * Correlation is normalised over the overlapping region only, so a long file
 * and a short one compare fairly instead of the longer one always winning.
 */
export function findSyncOffset(
	reference: Float32Array,
	target: Float32Array,
	sampleRate: number,
	searchWindowSeconds?: number,
): SyncResult {
	const a = envelope(reference, sampleRate);
	const b = envelope(target, sampleRate);
	if (a.length < 4 || b.length < 4) return { offsetSeconds: 0, confidence: 0 };

	const limit = searchWindowSeconds
		? Math.round(searchWindowSeconds * ENVELOPE_RATE)
		: Math.max(a.length, b.length);
	const minLag = -Math.min(limit, b.length - 1);
	const maxLag = Math.min(limit, a.length - 1);

	// A lag that leaves only a sliver overlapping can correlate perfectly by
	// accident, so require a real span of both signals to be compared.
	const minOverlap = Math.max(8, Math.floor(Math.min(a.length, b.length) * 0.25));

	const span = Math.min(a.length, b.length);
	let bestLag = 0;
	let bestWeighted = -Infinity;
	let bestCorrelation = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let dot = 0;
		let normA = 0;
		let normB = 0;
		const from = Math.max(0, -lag);
		const to = Math.min(b.length, a.length - lag);
		if (to - from < minOverlap) continue;
		for (let index = from; index < to; index++) {
			const x = a[index + lag];
			const y = b[index];
			dot += x * y;
			normA += x * x;
			normB += y * y;
		}
		const denominator = Math.sqrt(normA * normB);
		if (denominator <= 0) continue;
		const correlation = dot / denominator;
		// Weighting by how much actually overlapped stops a barely-overlapping
		// lag from beating a strong match across most of both takes.
		const weighted = correlation * ((to - from) / span);
		if (weighted > bestWeighted) {
			bestWeighted = weighted;
			bestCorrelation = correlation;
			bestLag = lag;
		}
	}

	if (!Number.isFinite(bestWeighted)) return { offsetSeconds: 0, confidence: 0 };
	return {
		offsetSeconds: Number((bestLag / ENVELOPE_RATE).toFixed(3)),
		confidence: Number(Math.max(0, Math.min(1, bestCorrelation)).toFixed(3)),
	};
}

// ── Denoise ───────────────────────────────────────────────────────────

export interface NoiseProfile {
	/** Broadband noise floor as a linear gain. */
	floor: number;
	floorDb: number;
	/** Fraction of the file that sits at the floor. */
	quietRatio: number;
}

/**
 * Measures the noise floor from the quietest tenth of the recording.
 *
 * Taking the minimum instead would latch onto a single digital-silence sample
 * and report a floor no real passage ever reaches.
 */
export function measureNoiseFloor(samples: Float32Array, sampleRate: number): NoiseProfile {
	const window = Math.max(1, Math.floor(sampleRate * 0.02));
	const windows = Math.floor(samples.length / window);
	if (windows < 4) return { floor: 0, floorDb: -120, quietRatio: 0 };

	const levels: number[] = [];
	for (let index = 0; index < windows; index++) {
		levels.push(rms(samples, index * window, window));
	}
	levels.sort((a, b) => a - b);

	const tenth = Math.max(1, Math.floor(levels.length / 10));
	let sum = 0;
	for (let index = 0; index < tenth; index++) sum += levels[index];
	const floor = sum / tenth;
	const loudest = levels[levels.length - 1] || 1;

	return {
		floor,
		floorDb: Number(gainToDb(floor / loudest).toFixed(1)),
		quietRatio: Number((tenth / levels.length).toFixed(3)),
	};
}

/**
 * How hard to denoise a recording with this noise floor.
 *
 * A floor 70 dB below the peaks is already clean and wants nothing; one only
 * 20 dB down is audible hiss under every word and wants the full amount. In
 * between it is a straight line — the subtraction is gentle enough that being
 * slightly wrong costs clarity rather than artefacts.
 */
export function suggestedDenoiseStrength(profile: NoiseProfile): number {
	const raw = (profile.floorDb + 70) / 50;
	return Number(Math.min(1, Math.max(0, raw)).toFixed(2));
}

export interface LoudnessProfile {
	/** Average level of the parts that are actually audible, in dBFS. */
	programDb: number;
	/** True peak, in dBFS. 0 is full scale. */
	peakDb: number;
	/** Fraction of the file above the silence threshold. */
	activeRatio: number;
}

/**
 * How loud a clip actually sounds.
 *
 * Averaged over the *audible* passages rather than the whole file: a take with
 * thirty seconds of silence at the head is not quiet, and averaging the silence
 * in would say it was and push the gain far too high. RMS over short windows,
 * ignoring anything below the noise floor.
 *
 * Not full ITU-R BS.1770 — no K-weighting or gating — so it is not an LUFS
 * figure and is not labelled as one. For matching two clips from the same
 * capture, which is what this is for, unweighted program RMS is what matters.
 */
export function measureLoudness(samples: Float32Array, sampleRate: number): LoudnessProfile {
	const window = Math.max(1, Math.floor(sampleRate * 0.05));
	const windows = Math.floor(samples.length / window);
	if (windows < 1) return { programDb: -120, peakDb: -120, activeRatio: 0 };

	let peak = 0;
	for (let index = 0; index < samples.length; index++) {
		const value = Math.abs(samples[index]);
		if (value > peak) peak = value;
	}

	// Anything this far below the loudest window is silence rather than program.
	const levels: number[] = [];
	for (let index = 0; index < windows; index++) {
		levels.push(rms(samples, index * window, window));
	}
	const loudest = Math.max(...levels);
	const floor = loudest * 0.02;

	const active = levels.filter((level) => level > floor);
	if (active.length === 0) {
		return { programDb: -120, peakDb: gainToDb(peak), activeRatio: 0 };
	}
	// Power average, not an average of decibels: averaging dB values understates
	// the level of anything with dynamics in it.
	const power = active.reduce((sum, level) => sum + level * level, 0) / active.length;

	return {
		programDb: Number(gainToDb(Math.sqrt(power)).toFixed(1)),
		peakDb: Number(gainToDb(peak).toFixed(1)),
		activeRatio: Number((active.length / levels.length).toFixed(3)),
	};
}

/**
 * The gain that brings a clip to a target, without clipping.
 *
 * Held back when the peak would cross full scale: reaching a target level by
 * clipping the transients is not reaching it, and a receipt that claimed the
 * target had been hit would be wrong. The shortfall is reported so a caller can
 * say so rather than silently delivering something quieter than asked for.
 */
export function normalizationGainDb(
	profile: LoudnessProfile,
	targetDb: number,
	ceilingDb = -1,
): { gainDb: number; limitedBy: "peak" | null; shortfallDb: number } {
	const wanted = targetDb - profile.programDb;
	const headroom = ceilingDb - profile.peakDb;
	if (wanted <= headroom) {
		return { gainDb: Number(wanted.toFixed(2)), limitedBy: null, shortfallDb: 0 };
	}
	return {
		gainDb: Number(headroom.toFixed(2)),
		limitedBy: "peak",
		shortfallDb: Number((wanted - headroom).toFixed(2)),
	};
}
