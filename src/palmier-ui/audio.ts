// Audio: waveform peaks, playback, and metering.
//
// Peaks are decoded once per asset and cached, because decoding a long
// recording is expensive and a waveform never changes. Playback runs through a
// Web Audio graph so mute, solo and per-clip gain are actually audible, and the
// meter reads the real output rather than animating a guess.

import { clipAtFrame, fadeMultiplierAt } from "./keyframes";
import type { AssetModel } from "./media";
import type { ClipModel } from "./model";
import { isAudible, type TimelineModel } from "./reducers";

/** Peaks are min/max pairs per bucket, which is what draws a real waveform. */
export interface Waveform {
	/** Normalised 0–1 magnitudes, one per bucket. */
	peaks: Float32Array;
	buckets: number;
}

const PEAK_BUCKETS = 1200;
const waveformCache = new Map<string, Waveform>();
const inFlight = new Map<string, Promise<Waveform | null>>();

let sharedContext: AudioContext | null = null;

function context(): AudioContext {
	if (!sharedContext) {
		sharedContext = new AudioContext();
	}
	return sharedContext;
}

/**
 * Decodes an asset's audio down to peaks. Returns null when the asset has no
 * decodable audio — a silent video, an image, or a file the browser refuses.
 */
export async function loadWaveform(asset: AssetModel): Promise<Waveform | null> {
	if (asset.offline || !asset.url) return null;
	const cached = waveformCache.get(asset.id);
	if (cached) return cached;

	const pending = inFlight.get(asset.id);
	if (pending) return pending;

	const work = (async (): Promise<Waveform | null> => {
		try {
			const response = await fetch(asset.url);
			const bytes = await response.arrayBuffer();
			const buffer = await context().decodeAudioData(bytes);

			const channel = buffer.getChannelData(0);
			const perBucket = Math.max(1, Math.floor(channel.length / PEAK_BUCKETS));
			const peaks = new Float32Array(PEAK_BUCKETS);
			let loudest = 0;

			for (let bucket = 0; bucket < PEAK_BUCKETS; bucket++) {
				const start = bucket * perBucket;
				let peak = 0;
				for (let index = 0; index < perBucket; index++) {
					const sample = Math.abs(channel[start + index] ?? 0);
					if (sample > peak) peak = sample;
				}
				peaks[bucket] = peak;
				if (peak > loudest) loudest = peak;
			}

			// Normalise so a quiet recording still draws a readable shape.
			if (loudest > 0) {
				for (let index = 0; index < peaks.length; index++) peaks[index] /= loudest;
			}

			const waveform: Waveform = { peaks, buckets: PEAK_BUCKETS };
			waveformCache.set(asset.id, waveform);
			return waveform;
		} catch {
			// A video with no audio track throws here; that's a normal outcome.
			return null;
		} finally {
			inFlight.delete(asset.id);
		}
	})();

	inFlight.set(asset.id, work);
	return work;
}

export function cachedWaveform(assetId: string): Waveform | null {
	return waveformCache.get(assetId) ?? null;
}

const bufferCache = new Map<string, AudioBuffer | null>();
const bufferInFlight = new Map<string, Promise<AudioBuffer | null>>();

/**
 * Decodes an asset's audio to samples, for the analysis tools.
 *
 * Kept separate from `loadWaveform` because the peaks are a lossy summary —
 * beat detection and cross-correlation need the samples themselves. The buffer
 * is cached because decoding a long recording twice is minutes of waiting.
 */
export async function decodeAudio(asset: AssetModel): Promise<AudioBuffer | null> {
	if (asset.offline || !asset.url) return null;
	if (bufferCache.has(asset.id)) return bufferCache.get(asset.id) ?? null;
	const pending = bufferInFlight.get(asset.id);
	if (pending) return pending;

	const work = (async (): Promise<AudioBuffer | null> => {
		try {
			const response = await fetch(asset.url);
			const bytes = await response.arrayBuffer();
			const buffer = await context().decodeAudioData(bytes);
			bufferCache.set(asset.id, buffer);
			return buffer;
		} catch {
			// A video with no audio track lands here; that's a normal answer.
			bufferCache.set(asset.id, null);
			return null;
		} finally {
			bufferInFlight.delete(asset.id);
		}
	})();

	bufferInFlight.set(asset.id, work);
	return work;
}

/** Mono mixdown, which is what every analysis in analysis.ts expects. */
export function monoSamples(buffer: AudioBuffer): Float32Array {
	if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
	const left = buffer.getChannelData(0);
	const right = buffer.getChannelData(1);
	const out = new Float32Array(left.length);
	for (let index = 0; index < left.length; index++) {
		out[index] = (left[index] + right[index]) / 2;
	}
	return out;
}

/** Drops one asset's cached peaks and decoded buffer, or all of them. */
export function forgetWaveform(assetId?: string): void {
	if (!assetId) {
		waveformCache.clear();
		bufferCache.clear();
		return;
	}
	waveformCache.delete(assetId);
	bufferCache.delete(assetId);
}

/** Draws peaks into a canvas, clipped to the clip's visible source span. */
export function drawWaveform(
	canvas: HTMLCanvasElement,
	waveform: Waveform,
	options: { startRatio: number; endRatio: number; color: string },
): void {
	const context2d = canvas.getContext("2d");
	if (!context2d) return;

	const { width, height } = canvas;
	context2d.clearRect(0, 0, width, height);
	context2d.fillStyle = options.color;

	const first = Math.floor(options.startRatio * waveform.buckets);
	const last = Math.ceil(options.endRatio * waveform.buckets);
	const span = Math.max(1, last - first);
	const middle = height / 2;

	for (let x = 0; x < width; x++) {
		const bucket = first + Math.floor((x / width) * span);
		const peak = waveform.peaks[bucket] ?? 0;
		// Always paint at least a hairline so silence still reads as a track.
		const bar = Math.max(1, peak * height * 0.9);
		context2d.fillRect(x, middle - bar / 2, 1, bar);
	}
}

// ── Playback ──────────────────────────────────────────────────────────

const DB_FLOOR = -60;

function dbToGain(db: number): number {
	return db <= DB_FLOOR ? 0 : 10 ** (db / 20);
}

/**
 * The gain a clip should sound at, at one frame: its level, its fades, and any
 * volume keyframes, in that order. The meter, playback and the exporter all
 * read this so they can't disagree about how loud something is.
 */
export function clipGainAt(clip: ClipModel, frame: number): number {
	return dbToGain(clipAtFrame(clip, frame).volumeDb) * fadeMultiplierAt(clip, frame);
}

interface Voice {
	element: HTMLAudioElement;
	gain: GainNode;
	clipId: string;
}

/**
 * Plays whatever the timeline says should be audible at the playhead.
 *
 * One `<audio>` element per sounding clip, routed through a gain node, summed
 * into an analyser so the meter reads the real mix.
 */
export class AudioEngine {
	private readonly voices = new Map<string, Voice>();
	private readonly master: GainNode;
	private readonly analyser: AnalyserNode;
	private readonly samples: Float32Array<ArrayBuffer>;

	constructor() {
		const audio = context();
		this.master = audio.createGain();
		this.analyser = audio.createAnalyser();
		this.analyser.fftSize = 1024;
		this.samples = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
		this.master.connect(this.analyser);
		this.analyser.connect(audio.destination);
	}

	/** Browsers start the context suspended until a gesture resumes it. */
	async resume(): Promise<void> {
		if (context().state === "suspended") await context().resume();
	}

	/**
	 * Brings the graph in line with the timeline at `frame`. Called every tick
	 * during playback; it adds, removes and retunes voices rather than
	 * rebuilding, so playback doesn't stutter.
	 */
	sync(
		timeline: TimelineModel,
		assets: readonly AssetModel[],
		frame: number,
		playing: boolean,
		/**
		 * The transport's review speed, multiplied onto each clip's own speed.
		 * Kept separate because a clip's speed is an edit that exports, and this
		 * is a way of watching — the two multiply for playback and only the
		 * clip's own speed ever reaches the file.
		 */
		reviewRate = 1,
	): void {
		const audio = context();
		const wanted = new Map<string, { clip: ClipModel; asset: AssetModel; gain: number }>();

		if (playing) {
			for (const track of timeline.tracks) {
				// A video clip carries its own audio — Rendr places one clip per
				// asset rather than splitting picture and sound onto two tracks —
				// so video tracks sound here too, gated by the same mute and solo.
				if (!isAudible(timeline, track)) continue;
				for (const clip of track.clips) {
					if (frame < clip.startFrame || frame >= clip.endFrame) continue;
					if (clip.mediaType === "text" || clip.mediaType === "image") continue;
					const asset = assets.find((entry) => entry.id === clip.assetId);
					if (!asset || asset.offline || !asset.url) continue;
					if (asset.type === "image") continue;
					if (asset.type === "video" && !asset.hasAudio) continue;
					wanted.set(clip.id, { clip, asset, gain: clipGainAt(clip, frame) });
				}
			}
		}

		// Stop voices that should no longer sound.
		for (const [clipId, voice] of this.voices) {
			if (!wanted.has(clipId)) {
				voice.element.pause();
				voice.gain.disconnect();
				this.voices.delete(clipId);
			}
		}

		for (const [clipId, entry] of wanted) {
			let voice = this.voices.get(clipId);
			if (!voice) {
				const element = new Audio(entry.asset.url);
				element.crossOrigin = "anonymous";
				const source = audio.createMediaElementSource(element);
				const gain = audio.createGain();
				source.connect(gain);
				gain.connect(this.master);
				voice = { element, gain, clipId };
				this.voices.set(clipId, voice);
			}

			voice.gain.gain.value = entry.gain;
			const sourceSeconds =
				(entry.clip.trimStartFrame + (frame - entry.clip.startFrame) * entry.clip.speed) /
				timeline.fps;
			// Only re-seek when drift is audible; a seek every frame would stutter.
			if (Math.abs(voice.element.currentTime - sourceSeconds) > 0.25) {
				voice.element.currentTime = Math.max(0, sourceSeconds);
			}
			// Browsers refuse rates outside roughly 0.0625–16 and mute above 4;
			// the transport already clamps to 0.25–4, and this guards the product
			// of the two.
			voice.element.playbackRate = Math.min(4, Math.max(0.25, entry.clip.speed * reviewRate));
			if (voice.element.paused) void voice.element.play().catch(() => undefined);
		}
	}

	/** Peak level of the real output, 0–1, for the meter. */
	level(): number {
		this.analyser.getFloatTimeDomainData(this.samples);
		let peak = 0;
		for (const sample of this.samples) {
			const magnitude = Math.abs(sample);
			if (magnitude > peak) peak = magnitude;
		}
		return Math.min(1, peak);
	}

	stop(): void {
		for (const voice of this.voices.values()) {
			voice.element.pause();
			voice.gain.disconnect();
		}
		this.voices.clear();
	}
}
