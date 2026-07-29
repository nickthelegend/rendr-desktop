// Offline export.
//
// The real-time path in export.ts drives a canvas stream through MediaRecorder,
// so a two-minute timeline takes two minutes whatever the machine can do. This
// one encodes with WebCodecs instead: frames are pushed to a VideoEncoder as
// fast as they can be composited, and the packets are muxed straight to an MP4.
// Nothing is paced by a clock, so the export finishes when the work is done.
//
// It falls back to the real-time path when WebCodecs isn't available, and says
// which one ran — an export that quietly took a different route and produced a
// different file would be worse than a slow one.
//
// Measured on a 1080p screen take: compositing was 25.2 ms/frame, of which
// ~11 ms was seeking the source <video>, and encoding 2.1 ms. Replacing the
// seek with a WebCodecs decode cursor (frameSource.ts) cut that to ~5.5 ms and
// took a 12-second export from ~11 s to ~2 s end to end.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { VideoMuxer } from "@/lib/exporter/muxer";
import type { BackgroundSettings } from "./background";
import type { CursorSettings } from "./cursor";
import { createCursorSpringState } from "./cursor";
import {
	decodeSources,
	type ExportHandle,
	type ExportProgress,
	type ExportSettings,
	exportDimensions,
	renderFrame,
} from "./export";
import { closeFrameSources, openFrameSources } from "./frameSource";
import type { AssetModel } from "./media";
import { audibleClips, renderTimelineAudio } from "./mixdown";
import type { TimelineModel } from "./reducers";
import type { WebcamSettings } from "./webcam";
import { createCameraSpringState, createCursorFollowCameraState, type ZoomTiming } from "./zoom";

/** Codecs in preference order: hardware H.264 first, then a safe baseline. */
const VIDEO_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];
const AUDIO_CODEC = "mp4a.40.2";
const AUDIO_BITRATE = 192_000;

/** A keyframe every two seconds, so the file scrubs without being huge. */
const KEYFRAME_SECONDS = 2;

/**
 * How many frames may be in the encoder before the loop waits.
 *
 * Without a cap the compositor runs ahead of the encoder and every queued frame
 * holds a decoded surface — a long timeline exhausts GPU memory and the tab
 * dies. Eight is enough to keep the encoder fed across a slow seek.
 */
const MAX_ENCODE_QUEUE = 8;

export interface OfflineSupport {
	supported: boolean;
	/** The codec that will be used, when supported. */
	codec?: string;
	/** Why not, when unsupported — shown to the user rather than swallowed. */
	reason?: string;
}

/**
 * Whether this build can encode offline, and with what.
 *
 * Asked before the export starts so the caller can tell the user which path is
 * about to run, rather than discovering it from how long the export took.
 */
export async function offlineExportSupport(
	width: number,
	height: number,
	frameRate: number,
): Promise<OfflineSupport> {
	if (typeof VideoEncoder === "undefined") {
		return { supported: false, reason: "This build has no WebCodecs VideoEncoder." };
	}
	// Encoders reject odd dimensions and some reject very large ones, so the
	// real size is offered rather than a token config that always passes.
	for (const codec of VIDEO_CODECS) {
		try {
			const probe = await VideoEncoder.isConfigSupported({
				codec,
				width,
				height,
				framerate: frameRate,
				bitrate: 8_000_000,
			});
			if (probe.supported) return { supported: true, codec };
		} catch {
			// An unsupported codec string throws rather than reporting false.
		}
	}
	return {
		supported: false,
		reason: `No H.264 encoder accepted ${width}×${height}.`,
	};
}

function bitrateFor(width: number, height: number, quality: number): number {
	// Matches the real-time path's curve, so switching routes doesn't silently
	// change how big the file comes out.
	return Math.round(width * height * 30 * 0.1 * (0.4 + quality * 0.6));
}

/**
 * Encodes the timeline offline.
 *
 * Returns the same handle shape the real-time export returns, so the caller
 * doesn't branch on which one ran.
 */
export function exportTimelineOffline(
	timeline: TimelineModel,
	assets: readonly AssetModel[],
	totalFrames: number,
	settings: ExportSettings,
	onProgress: (progress: ExportProgress) => void,
	cursor?: { telemetry: readonly CursorTelemetryPoint[]; settings: CursorSettings },
	webcam?: { settings: WebcamSettings; assets: readonly AssetModel[] },
	background?: { settings: BackgroundSettings; image?: CanvasImageSource | null },
	/** How the punch-in and release are timed. Defaults to Recordly's. */
	zoomTiming?: ZoomTiming,
): ExportHandle {
	const { width, height } = exportDimensions(timeline, settings);
	let cancelled = false;
	let warning: string | null = null;

	const done = (async (): Promise<Blob | null> => {
		const support = await offlineExportSupport(width, height, timeline.fps);
		if (!support.supported || !support.codec) {
			throw new Error(support.reason ?? "Offline encoding is unavailable.");
		}

		// One follow state for the run, so the camera remembers where it was
		// between frames exactly as it does during playback.
		const followState = createCursorFollowCameraState();
		const cameraSpring = createCameraSpringState();
		const cursorSpring = createCursorSpringState();

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
		if (!context) throw new Error("This build can't provide a canvas to render into.");

		// The audio is mixed first: the muxer has to know at initialisation
		// whether the file carries an audio track at all.
		const wantsAudio = audibleClips(timeline, assets).length > 0;
		let mixed: AudioBuffer | null = null;
		if (wantsAudio) {
			try {
				mixed = await renderTimelineAudio(timeline, assets, totalFrames);
			} catch {
				// A failed mixdown costs the audio, not the export.
				mixed = null;
			}
			if (!mixed) warning = "The audio couldn't be mixed, so the file has no sound.";
		} else {
			warning = "Nothing on the timeline makes a sound, so the file has no audio track.";
		}

		// Buffer mode deliberately, not the streaming target. Streaming writes to
		// a temp file to keep peak memory down — but this path has to hand back a
		// Blob for the caller to save, so the whole file would be read straight
		// back into memory anyway. Same peak, one fewer round trip through disk.
		const muxer = new VideoMuxer(
			{
				width,
				height,
				frameRate: timeline.fps,
				bitrate: bitrateFor(width, height, settings.quality),
				codec: support.codec,
			},
			Boolean(mixed),
			"buffer",
		);
		await muxer.initialize();

		let failure: Error | null = null;
		// Hoisted so the catch below can release the decoders it opened.
		let sources: Awaited<ReturnType<typeof decodeSources>> | null = null;
		const encoder = new VideoEncoder({
			output: (chunk, meta) => {
				// The muxer is async and the encoder callback is not, so writes
				// are chained rather than awaited here; `flush` below waits on
				// the chain before the file is finalized.
				writes = writes
					.then(() => muxer.addVideoChunk(chunk, meta))
					.catch((error) => {
						failure ??= error instanceof Error ? error : new Error(String(error));
					});
			},
			error: (error) => {
				failure ??= error instanceof Error ? error : new Error(String(error));
			},
		});
		let writes: Promise<void> = Promise.resolve();

		encoder.configure({
			codec: support.codec,
			width,
			height,
			framerate: timeline.fps,
			bitrate: bitrateFor(width, height, settings.quality),
			// Annex B would need conversion; the muxer wants AVCC.
			avc: { format: "avc" },
		});

		try {
			// Decoders for whatever will take one; the rest keep their <video>.
			// Opened here rather than in decodeSources so only an export pays for
			// them — the preview scrubs backwards constantly, which is the one
			// access pattern a forward cursor is worse at.
			sources = await decodeSources(assets);
			sources.frames = await openFrameSources(assets);
			const keyframeEvery = Math.max(1, Math.round(timeline.fps * KEYFRAME_SECONDS));
			const microsecondsPerFrame = 1_000_000 / timeline.fps;

			for (let frame = 0; frame < totalFrames; frame++) {
				if (cancelled) break;
				if (failure) throw failure;

				await renderFrame(
					context,
					timeline,
					frame,
					sources,
					width,
					height,
					cursor,
					webcam,
					background,
					followState,
					zoomTiming,
					cameraSpring,
					cursorSpring,
				);

				// Timestamps come from the frame index, not the wall clock —
				// which is precisely what the real-time path cannot do, and why
				// its output plays back at whatever speed the render managed.
				const videoFrame = new VideoFrame(canvas, {
					timestamp: Math.round(frame * microsecondsPerFrame),
					duration: Math.round(microsecondsPerFrame),
				});
				encoder.encode(videoFrame, { keyFrame: frame % keyframeEvery === 0 });
				videoFrame.close();

				// Backpressure: let the encoder drain before compositing more.
				while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE && !cancelled) {
					await new Promise((resolve) => setTimeout(resolve, 4));
				}

				const ratio = (frame + 1) / totalFrames;
				onProgress({ frame: frame + 1, totalFrames, ratio });
			}

			if (cancelled) {
				await muxer.abortStream();
				encoder.close();
				return null;
			}

			await encoder.flush();
			encoder.close();
			await writes;
			if (failure) throw failure;

			if (mixed) await encodeAudio(mixed, muxer);

			if (sources.frames) closeFrameSources(sources.frames);
			const result = await muxer.finalize();
			return result.mode === "buffer" ? result.blob : null;
		} catch (error) {
			if (sources?.frames) closeFrameSources(sources.frames);
			await muxer.abortStream().catch(() => undefined);
			try {
				encoder.close();
			} catch {
				// Already closed by the error that brought us here.
			}
			throw error;
		}
	})();

	return {
		done,
		cancel: () => {
			cancelled = true;
		},
		warning: () => warning,
	};
}

/**
 * Encodes the mixdown to AAC and feeds it to the muxer.
 *
 * The buffer is pushed in one-second slices: AudioEncoder wants AudioData, and
 * handing it the whole timeline as a single object would allocate a copy of the
 * entire mix in one go.
 */
async function encodeAudio(mixed: AudioBuffer, muxer: VideoMuxer): Promise<void> {
	if (typeof AudioEncoder === "undefined") return;

	const channels = mixed.numberOfChannels;
	const sampleRate = mixed.sampleRate;
	const probe = await AudioEncoder.isConfigSupported({
		codec: AUDIO_CODEC,
		sampleRate,
		numberOfChannels: channels,
		bitrate: AUDIO_BITRATE,
	});
	if (!probe.supported) return;

	let failure: Error | null = null;
	let writes: Promise<void> = Promise.resolve();
	const encoder = new AudioEncoder({
		output: (chunk, meta) => {
			writes = writes
				.then(() => muxer.addAudioChunk(chunk, meta))
				.catch((error) => {
					failure ??= error instanceof Error ? error : new Error(String(error));
				});
		},
		error: (error) => {
			failure ??= error instanceof Error ? error : new Error(String(error));
		},
	});
	encoder.configure({
		codec: AUDIO_CODEC,
		sampleRate,
		numberOfChannels: channels,
		bitrate: AUDIO_BITRATE,
	});

	// AudioData wants the channels interleaved back together; the mixdown holds
	// them planar, one Float32Array each.
	const sliceFrames = sampleRate;
	const planes = Array.from({ length: channels }, (_, index) => mixed.getChannelData(index));

	for (let start = 0; start < mixed.length; start += sliceFrames) {
		const count = Math.min(sliceFrames, mixed.length - start);
		const interleaved = new Float32Array(count * channels);
		for (let channel = 0; channel < channels; channel++) {
			const plane = planes[channel];
			for (let index = 0; index < count; index++) {
				interleaved[index * channels + channel] = plane[start + index];
			}
		}
		const data = new AudioData({
			format: "f32",
			sampleRate,
			numberOfFrames: count,
			numberOfChannels: channels,
			timestamp: Math.round((start / sampleRate) * 1_000_000),
			data: interleaved,
		});
		encoder.encode(data);
		data.close();
		while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
			await new Promise((resolve) => setTimeout(resolve, 4));
		}
	}

	await encoder.flush();
	encoder.close();
	await writes;
	if (failure) throw failure;
}
