// Rendering single frames on demand, for the tools that need to look at the
// picture rather than the model: inspect_timeline, inspect_color, capture_frame.
//
// These all go through export.ts's `renderFrame`, so what an agent measures or
// screenshots is the same composite the encoder writes — a separate "preview
// renderer" would eventually disagree with the file and nobody would know.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { CursorSettings } from "./cursor";
import { type DecodedSources, decodeSources, renderFrame } from "./export";
import type { AssetModel } from "./media";
import type { TimelineModel } from "./reducers";
import type { WebcamSettings } from "./webcam";

/** Frames are usually asked for in bursts, so the decode is worth keeping. */
let cache: { key: string; sources: DecodedSources } | null = null;

async function sourcesFor(assets: readonly AssetModel[]): Promise<DecodedSources> {
	const key = assets.map((asset) => `${asset.id}:${asset.url}`).join("|");
	if (cache?.key === key) return cache.sources;
	const sources = await decodeSources(assets);
	cache = { key, sources };
	return sources;
}

/** Drops the decoded elements — call when assets are released. */
export function forgetDecodedSources(): void {
	cache = null;
}

export interface RenderedFrame {
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
}

/**
 * One composited frame at full project resolution.
 *
 * `maxEdge` scales the output down; the composite is still computed at project
 * size so framing and crop are identical, only the readback is cheaper.
 */
export async function renderFrameToCanvas(
	timeline: TimelineModel,
	assets: readonly AssetModel[],
	frame: number,
	maxEdge?: number,
	/**
	 * The take's overlays. Passed through so a frame an agent looks at carries
	 * the same drawn pointer and camera inset the export will — a screenshot
	 * without them is a picture of a file that will never exist.
	 */
	overlays?: {
		cursor?: { telemetry: readonly CursorTelemetryPoint[]; settings: CursorSettings };
		webcam?: { settings: WebcamSettings; assets: readonly AssetModel[] };
	},
): Promise<RenderedFrame | null> {
	const longest = Math.max(timeline.width, timeline.height);
	const scale = maxEdge && longest > maxEdge ? maxEdge / longest : 1;
	const width = Math.max(2, Math.round(timeline.width * scale));
	const height = Math.max(2, Math.round(timeline.height * scale));

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
	if (!context) return null;

	const sources = await sourcesFor(assets);
	await renderFrame(
		context,
		timeline,
		frame,
		sources,
		width,
		height,
		overlays?.cursor,
		overlays?.webcam,
	);
	return { canvas, width, height };
}

/** A raw asset frame, with no grade, effects, transform, or crop applied. */
export async function renderAssetFrame(
	asset: AssetModel,
	sourceSeconds = 0,
	maxEdge = 640,
): Promise<RenderedFrame | null> {
	if (asset.offline || !asset.url || asset.type === "audio") return null;

	const element = await new Promise<HTMLImageElement | HTMLVideoElement | null>((resolve) => {
		if (asset.type === "image") {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => resolve(null);
			image.src = asset.url;
			return;
		}
		const video = document.createElement("video");
		video.muted = true;
		video.preload = "auto";
		video.onerror = () => resolve(null);
		video.onloadeddata = () => {
			const seconds = Math.max(0, Math.min(sourceSeconds, video.duration || 0));
			if (Math.abs(video.currentTime - seconds) < 0.005) return resolve(video);
			const done = () => {
				video.removeEventListener("seeked", done);
				resolve(video);
			};
			video.addEventListener("seeked", done);
			video.currentTime = seconds;
			// A seek that never lands must not hang the tool call.
			setTimeout(done, 500);
		};
		video.src = asset.url;
	});
	if (!element) return null;

	const naturalW =
		element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
	const naturalH =
		element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
	if (naturalW === 0 || naturalH === 0) return null;

	const scale = Math.min(1, maxEdge / Math.max(naturalW, naturalH));
	const width = Math.max(2, Math.round(naturalW * scale));
	const height = Math.max(2, Math.round(naturalH * scale));

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
	if (!context) return null;
	context.drawImage(element, 0, 0, width, height);
	return { canvas, width, height };
}

/** Burns the frame number in, so a returned image maps back to a frame. */
export function stampFrameNumber(canvas: HTMLCanvasElement, frame: number): void {
	const context = canvas.getContext("2d");
	if (!context) return;
	const size = Math.max(12, Math.round(canvas.height * 0.045));
	context.save();
	context.font = `700 ${size}px ui-monospace, monospace`;
	context.textBaseline = "top";
	const label = `f${frame}`;
	const padding = Math.round(size * 0.35);
	const width = context.measureText(label).width;
	context.fillStyle = "rgba(0, 0, 0, 0.65)";
	context.fillRect(0, 0, width + padding * 2, size + padding * 2);
	context.fillStyle = "#FFFFFF";
	context.fillText(label, padding, padding);
	context.restore();
}

/** Base64 PNG, which is the encoding MCP image content parts take. */
export function canvasToBase64Png(canvas: HTMLCanvasElement): string {
	return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}
