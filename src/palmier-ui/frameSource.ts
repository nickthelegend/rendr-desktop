// Decoded frames, without seeking a <video>.
//
// The export loop asks for frame 0, 1, 2, … in order. Handing that to a
// <video> means a seek per frame: the element decodes forward from the nearest
// keyframe every time.
//
// mediabunny reads the file and decodes it with WebCodecs directly, and its
// CanvasSink can stream frames in order — so a forward walk decodes each GOP
// once instead of re-entering it per frame. Measured on a 1080p webm:
//
//   sequential generator    3.1 ms/frame
//   <video> seek           11.2 ms/frame
//   getCanvas(t)          104.9 ms/frame
//
// getCanvas restarts the decode run on every call, which is why it loses so
// badly, and why this holds a cursor rather than asking per timestamp.
//
// The <video> path stays as the fallback: this needs a demuxable container and
// a decoder for its codec, and neither is guaranteed for imported media.

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";

import type { AssetModel } from "./media";

/** What CanvasSink yields: a decoded frame and the span it covers. */
interface WrappedFrame {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	timestamp: number;
	duration: number;
}

/** A hair under a frame, to absorb float error in timestamp comparisons. */
const EPSILON = 1e-6;

/** A source of frames for one asset, addressed by source seconds. */
export interface FrameSource {
	/**
	 * The frame at a time. Timestamps are expected to arrive in increasing
	 * order; going backwards works but costs a fresh decode run.
	 */
	frameAt(seconds: number): Promise<CanvasImageSource | null>;
	close(): void;
	/** Which path this ended up on, so callers can report it honestly. */
	readonly kind: "webcodecs";
}

/**
 * Opens a decoder-backed source for an asset.
 *
 * Returns null when the file can't be demuxed or its codec has no decoder —
 * the caller then keeps using the <video> it already has, rather than this
 * failing the export.
 */
async function openFrameSource(asset: AssetModel): Promise<FrameSource | null> {
	if (asset.type !== "video" || asset.offline || !asset.url) return null;
	if (typeof VideoDecoder === "undefined") return null;

	try {
		const blob = await (await fetch(asset.url)).blob();
		const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
		const track = await input.getPrimaryVideoTrack();
		if (!track) return null;
		if (!(await track.canDecode())) return null;

		const sink = new CanvasSink(track, { poolSize: 2 });

		let closed = false;
		let cursor: AsyncGenerator<WrappedFrame | null> | null = null;
		let held: WrappedFrame | null = null;
		let inFlight: Promise<unknown> = Promise.resolve();

		const restart = (seconds: number) => {
			void cursor?.return?.(undefined);
			cursor = sink.canvases(seconds) as unknown as AsyncGenerator<WrappedFrame | null>;
			held = null;
		};

		/**
		 * Walks the cursor forward until it covers `seconds`.
		 *
		 * The frame is held rather than dropped once found: the next request is
		 * usually the following timeline frame, and when the project runs faster
		 * than the source, two timeline frames legitimately share one decode.
		 */
		const advanceTo = async (seconds: number): Promise<CanvasImageSource | null> => {
			if (!cursor) restart(seconds);
			// Behind the cursor — a backwards scrub. Reopening is the only way
			// back, and it is what getCanvas would have done anyway.
			if (held && seconds + EPSILON < held.timestamp) restart(seconds);
			if (held && seconds < held.timestamp + held.duration) {
				return held.canvas as CanvasImageSource;
			}

			while (!closed && cursor) {
				const step = await cursor.next();
				if (step.done || !step.value) {
					// Past the end: the last frame is the honest answer, matching
					// what a <video> parked at its duration would show.
					return held ? (held.canvas as CanvasImageSource) : null;
				}
				held = step.value;
				if (seconds < held.timestamp + held.duration) {
					return held.canvas as CanvasImageSource;
				}
			}
			return null;
		};

		return {
			kind: "webcodecs",
			async frameAt(seconds: number) {
				if (closed) return null;
				// Serialised: one decoder, one cursor. Overlapping reads would
				// hand each caller the other's frame.
				const next = inFlight
					.catch(() => undefined)
					.then(() => advanceTo(Math.max(0, seconds)));
				inFlight = next;
				try {
					return await next;
				} catch {
					// A decode that fails mid-file costs this frame, not the export.
					return null;
				}
			},
			close() {
				closed = true;
				void cursor?.return?.(undefined);
				cursor = null;
				held = null;
				input.dispose?.();
			},
		};
	} catch {
		// An unreadable container, a codec with no decoder, or a build without
		// mediabunny's dependencies — all mean "use the <video>".
		return null;
	}
}

/** Opens a decoder for every video asset that will take one. */
export async function openFrameSources(
	assets: readonly AssetModel[],
): Promise<Map<string, FrameSource>> {
	const out = new Map<string, FrameSource>();
	await Promise.all(
		assets.map(async (asset) => {
			const source = await openFrameSource(asset);
			if (source) out.set(asset.id, source);
		}),
	);
	return out;
}

export function closeFrameSources(sources: Map<string, FrameSource>): void {
	for (const source of sources.values()) source.close();
	sources.clear();
}
