// What Rendr knows about a piece of camera footage: where the person is
// (a matte, for background removal) and where their face is (a track, for
// reframing and punch-ins). Made once per file by the main process — see
// electron/vision.ts — and kept on the asset.

export interface FaceBox {
	/** Normalized 0–1, top-left origin, in the footage's displayed orientation. */
	x: number;
	y: number;
	w: number;
	h: number;
	confidence: number;
}

export interface FaceTrack {
	width: number;
	height: number;
	duration: number;
	/** Seconds between samples. */
	interval: number;
	samples: Array<{ t: number; faces: FaceBox[] }>;
}

/** What the main process returns for one analysis run. */
export interface FootageAnalysis {
	ok: boolean;
	key?: string;
	mattePath?: string;
	faces?: FaceTrack;
	width?: number;
	height?: number;
	duration?: number;
	personCoverage?: number;
	cached?: boolean;
	reason?: string;
}

/** A face position the camera can aim at: centre and height, normalized. */
export interface FacePoint {
	cx: number;
	cy: number;
	/** Face height as a share of the frame — how close the person is. */
	size: number;
}

/** Below this, Vision is guessing; a wrong face is worse than none. */
const MIN_CONFIDENCE = 0.5;

/** The face that matters in a sample: the biggest confident one, i.e. the speaker. */
export function primaryFace(faces: readonly FaceBox[]): FaceBox | null {
	let best: FaceBox | null = null;
	for (const face of faces) {
		if (face.confidence < MIN_CONFIDENCE) continue;
		if (!best || face.w * face.h > best.w * best.h) best = face;
	}
	return best;
}

function toPoint(face: FaceBox): FacePoint {
	return { cx: face.x + face.w / 2, cy: face.y + face.h / 2, size: face.h };
}

/**
 * The speaker's face at a source time, interpolated between samples.
 *
 * Returns null when no face was seen within `maxGap` seconds — a camera that
 * holds its last known framing through a cutaway is better than one that
 * swings to a guess.
 */
export function faceAt(track: FaceTrack, seconds: number, maxGap = 1): FacePoint | null {
	const samples = track.samples;
	if (samples.length === 0) return null;
	// Samples are in time order; find the last one at or before `seconds`.
	let low = 0;
	let high = samples.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (samples[mid].t <= seconds) low = mid;
		else high = mid - 1;
	}
	const before = findFace(samples, low, -1, seconds, maxGap);
	const after = findFace(samples, samples[low].t <= seconds ? low + 1 : low, 1, seconds, maxGap);
	if (before && after && after.t > before.t) {
		const mix = (seconds - before.t) / (after.t - before.t);
		return {
			cx: before.point.cx + (after.point.cx - before.point.cx) * mix,
			cy: before.point.cy + (after.point.cy - before.point.cy) * mix,
			size: before.point.size + (after.point.size - before.point.size) * mix,
		};
	}
	return (before ?? after)?.point ?? null;
}

function findFace(
	samples: FaceTrack["samples"],
	start: number,
	step: 1 | -1,
	seconds: number,
	maxGap: number,
): { t: number; point: FacePoint } | null {
	for (let index = start; index >= 0 && index < samples.length; index += step) {
		const sample = samples[index];
		if (Math.abs(sample.t - seconds) > maxGap) return null;
		const face = primaryFace(sample.faces);
		if (face) return { t: sample.t, point: toPoint(face) };
	}
	return null;
}

/**
 * Where the speaker usually is across a span of the footage — the median, so
 * a moment of leaning out of frame doesn't drag a static crop off their face.
 */
export function typicalFace(
	track: FaceTrack,
	fromSeconds = 0,
	toSeconds = Number.POSITIVE_INFINITY,
): FacePoint | null {
	const points: FacePoint[] = [];
	for (const sample of track.samples) {
		if (sample.t < fromSeconds || sample.t > toSeconds) continue;
		const face = primaryFace(sample.faces);
		if (face) points.push(toPoint(face));
	}
	if (points.length === 0) return null;
	const median = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		const middle = sorted.length >> 1;
		return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	};
	return {
		cx: median(points.map((point) => point.cx)),
		cy: median(points.map((point) => point.cy)),
		size: median(points.map((point) => point.size)),
	};
}

/** Share of samples with a confident face — "is this a talking-head shot at all?" */
export function faceCoverage(track: FaceTrack): number {
	if (track.samples.length === 0) return 0;
	const seen = track.samples.filter((sample) => primaryFace(sample.faces)).length;
	return seen / track.samples.length;
}

/** Keeps a face track small enough to live in a project file: confident faces only, rounded. */
export function compactFaceTrack(track: FaceTrack): FaceTrack {
	const round = (value: number) => Math.round(value * 10000) / 10000;
	return {
		width: track.width,
		height: track.height,
		duration: track.duration,
		interval: track.interval,
		samples: track.samples.map((sample) => ({
			t: Math.round(sample.t * 1000) / 1000,
			faces: sample.faces
				.filter((face) => face.confidence >= MIN_CONFIDENCE)
				.map((face) => ({
					x: round(face.x),
					y: round(face.y),
					w: round(face.w),
					h: round(face.h),
					confidence: Math.round(face.confidence * 100) / 100,
				})),
		})),
	};
}
