// Mixing the timeline's audio down to one buffer.
//
// The video export encodes a canvas, which carries no sound at all. This is the
// other half: every audible clip rendered offline with its level, fades, volume
// keyframes, speed and denoise applied, then handed to the muxer. Without it a
// finished export is silent, which is the difference between a demo and a tool.

import { clipGainAt, decodeAudio } from "./audio";
import { denoiseSamples } from "./denoise";
import type { AssetModel } from "./media";
import type { ClipModel } from "./model";
import { isAudible, type TimelineModel } from "./reducers";

const MIXDOWN_SAMPLE_RATE = 48_000;

/** One gain value per frame, which is the finest the model can express. */
export interface GainPoint {
	/** Seconds from the start of the timeline. */
	time: number;
	gain: number;
}

/**
 * The clip's gain over its own length.
 *
 * Consecutive identical values are dropped: a clip with no fades and no
 * keyframes comes back as a single point, so the common case doesn't schedule
 * thousands of no-op automation events.
 */
export function buildGainAutomation(clip: ClipModel, fps: number): GainPoint[] {
	const points: GainPoint[] = [];
	let previous = Number.NaN;
	for (let frame = clip.startFrame; frame < clip.endFrame; frame++) {
		const gain = clipGainAt(clip, frame);
		if (gain === previous) continue;
		previous = gain;
		points.push({ time: frame / fps, gain });
	}
	// A fade-out's final value lands on the last frame, not after it, so the
	// tail is added explicitly or the fade never reaches zero.
	const last = clipGainAt(clip, clip.endFrame - 1);
	if (points.length > 0 && points[points.length - 1].gain !== last) {
		points.push({ time: (clip.endFrame - 1) / fps, gain: last });
	}
	return points;
}

/** Every clip that should make a sound, whatever kind of track it sits on. */
export function audibleClips(
	timeline: TimelineModel,
	assets: readonly AssetModel[],
): Array<{ clip: ClipModel; asset: AssetModel }> {
	const out: Array<{ clip: ClipModel; asset: AssetModel }> = [];
	for (const track of timeline.tracks) {
		// Hidden hides the picture; muted and solo decide what is heard. A video
		// track's clips carry their own audio, so they sound here too.
		if (!isAudible(timeline, track)) continue;
		for (const clip of track.clips) {
			if (clip.mediaType === "text") continue;
			const asset = assets.find((entry) => entry.id === clip.assetId);
			if (!asset || asset.offline || !asset.url) continue;
			if (asset.type === "image") continue;
			if (asset.type === "video" && !asset.hasAudio) continue;
			out.push({ clip, asset });
		}
	}
	return out;
}

/** Denoised copies, keyed by asset and strength — the work is seconds long. */
const denoiseCache = new Map<string, AudioBuffer>();

export function forgetDenoised(assetId?: string): void {
	if (!assetId) return denoiseCache.clear();
	for (const key of [...denoiseCache.keys()]) {
		if (key.startsWith(`${assetId}@`)) denoiseCache.delete(key);
	}
}

function denoisedBuffer(
	context: BaseAudioContext,
	assetId: string,
	source: AudioBuffer,
	strength: number,
): AudioBuffer {
	const key = `${assetId}@${strength.toFixed(2)}`;
	const cached = denoiseCache.get(key);
	if (cached) return cached;

	const out = context.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
	for (let channel = 0; channel < source.numberOfChannels; channel++) {
		const cleaned = denoiseSamples(source.getChannelData(channel), strength);
		out.copyToChannel(new Float32Array(cleaned), channel);
	}
	denoiseCache.set(key, out);
	return out;
}

/**
 * Renders the whole timeline's audio.
 *
 * Returns null when nothing is audible, so the caller can mux a silent file
 * deliberately rather than shipping an empty audio track.
 */
export async function renderTimelineAudio(
	timeline: TimelineModel,
	assets: readonly AssetModel[],
	totalFrames: number,
	onProgress?: (ratio: number) => void,
): Promise<AudioBuffer | null> {
	const entries = audibleClips(timeline, assets);
	if (entries.length === 0 || totalFrames <= 0) return null;

	const seconds = totalFrames / timeline.fps;
	const context = new OfflineAudioContext(
		2,
		Math.ceil(seconds * MIXDOWN_SAMPLE_RATE),
		MIXDOWN_SAMPLE_RATE,
	);

	let prepared = 0;
	for (const { clip, asset } of entries) {
		const decoded = await decodeAudio(asset);
		onProgress?.(++prepared / entries.length);
		if (!decoded) continue;

		const buffer =
			clip.denoiseEnabled && clip.denoiseStrength > 0
				? denoisedBuffer(context, asset.id, decoded, clip.denoiseStrength)
				: decoded;

		const source = context.createBufferSource();
		source.buffer = buffer;
		source.playbackRate.value = clip.speed;

		const gain = context.createGain();
		source.connect(gain);
		gain.connect(context.destination);

		const startTime = clip.startFrame / timeline.fps;
		const offset = clip.trimStartFrame / timeline.fps;
		// The clip occupies `duration` on the timeline; at speed s it consumes
		// duration × s of source, which is what playbackRate already accounts for.
		const duration = (clip.endFrame - clip.startFrame) / timeline.fps;

		const points = buildGainAutomation(clip, timeline.fps);
		if (points.length === 0) {
			gain.gain.value = 0;
		} else {
			gain.gain.setValueAtTime(points[0].gain, Math.max(0, points[0].time));
			for (const point of points.slice(1)) {
				// Ramping rather than stepping keeps a fade smooth instead of
				// stair-stepping once per frame.
				gain.gain.linearRampToValueAtTime(point.gain, Math.max(0, point.time));
			}
		}

		source.start(startTime, Math.max(0, offset), duration);
	}

	return context.startRendering();
}

/** 16-bit PCM WAV, which every muxer and player accepts without negotiation. */
export function encodeWavBytes(
	channels: ReadonlyArray<Float32Array>,
	sampleRate: number,
): Uint8Array<ArrayBuffer> {
	const channelCount = Math.max(1, channels.length);
	const frames = channels[0]?.length ?? 0;
	const dataBytes = frames * channelCount * 2;
	const bytes = new Uint8Array(new ArrayBuffer(44 + dataBytes));
	const view = new DataView(bytes.buffer);

	const ascii = (offset: number, text: string) => {
		for (let index = 0; index < text.length; index++) {
			bytes[offset + index] = text.charCodeAt(index);
		}
	};

	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, channelCount, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channelCount * 2, true); // byte rate
	view.setUint16(32, channelCount * 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);

	let offset = 44;
	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channelCount; channel++) {
			const sample = Math.max(-1, Math.min(1, channels[channel]?.[frame] ?? 0));
			// Asymmetric scaling: -1 maps to -32768 and +1 to 32767, so a
			// full-scale positive sample doesn't wrap to negative.
			view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
			offset += 2;
		}
	}

	return bytes;
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
	const channels: Float32Array[] = [];
	for (let index = 0; index < buffer.numberOfChannels; index++) {
		channels.push(buffer.getChannelData(index));
	}
	// One contiguous copy so the Blob doesn't have to reason about the view.
	return new Blob([encodeWavBytes(channels, buffer.sampleRate)], { type: "audio/wav" });
}
