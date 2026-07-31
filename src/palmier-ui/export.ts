// Export.
//
// The timeline is composited onto an offscreen canvas frame by frame and the
// canvas is captured with MediaRecorder. That is a real encode of the real
// edit — transforms, crop, opacity, colour, text and the zoom camera all land
// in the file, because the same maths runs here as in the preview.
//
// It renders in real time rather than offline: a two-minute timeline takes two
// minutes. Offline encoding needs WebCodecs and a muxer, which is a bigger
// piece of work; this is honest and it produces a file you can play.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import {
	type BackgroundSettings,
	footageBox,
	hasBackground,
	paintBackground,
	shadowFor,
} from "./background";
import {
	type CursorFrame,
	type CursorSettings,
	type CursorSpringState,
	capturedPointerPatch,
	createCursorSpringState,
	cursorFill,
	cursorPath,
	rawCursorAt,
	resolveCursor,
	ringAt,
} from "./cursor";
import { applyLuts, buildChannelLuts, type ChannelLuts } from "./curves";
import { clipFilter } from "./effects";
import type { FrameSource } from "./frameSource";
import { clipAtFrame, clipOpacityAt } from "./keyframes";
import type { AssetModel } from "./media";
import { audioBufferToWav, renderTimelineAudio } from "./mixdown";
import { applyPixelGrade, needsPixelGrade, type PixelGrade } from "./pixelGrade";
import type { TimelineModel } from "./reducers";
import { frameToClipSourceMs } from "./state";
import { isPerWord, resolveTextAnimation, wordColor } from "./textAnimation";
import { type WebcamSettings, webcamBox, webcamSourceRect } from "./webcam";
import {
	type CameraSpringState,
	type CursorFollowCameraState,
	createCameraSpringState,
	createCursorFollowCameraState,
	DEFAULT_ZOOM_TIMING,
	resolveCamera,
	springCamera,
	type ZoomTiming,
} from "./zoom";

export interface ExportSettings {
	/** Long-edge resolution. "source" keeps the timeline's own size. */
	resolution: "source" | "1080p" | "720p";
	format: "webm";
	/** 0–1; maps onto the encoder's bitrate. */
	quality: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
	resolution: "source",
	format: "webm",
	quality: 0.8,
};

export function exportDimensions(
	timeline: TimelineModel,
	settings: ExportSettings,
): { width: number; height: number } {
	if (settings.resolution === "source") {
		return { width: timeline.width, height: timeline.height };
	}
	const targetHeight = settings.resolution === "1080p" ? 1080 : 720;
	const scale = targetHeight / timeline.height;
	// Encoders reject odd dimensions, so round both axes to even numbers.
	return {
		width: Math.round((timeline.width * scale) / 2) * 2,
		height: Math.round(targetHeight / 2) * 2,
	};
}

function bitrateFor(width: number, height: number, quality: number): number {
	// Roughly 0.1 bits per pixel per frame at full quality, which lands in the
	// range browsers encode well.
	const pixels = width * height;
	return Math.round(pixels * 30 * 0.1 * (0.4 + quality * 0.6));
}

/**
 * Maps the clip's box through its channel tables, in place.
 *
 * The read is confined to the box the clip just drew into, so a small inset
 * costs a small readback rather than a full-frame one.
 */
function applyLutsToRegion(
	context: CanvasRenderingContext2D,
	boxW: number,
	boxH: number,
	luts: ChannelLuts | null,
	/** Hue curves and a 3D LUT, which need the whole pixel rather than a channel. */
	pixelGrade?: PixelGrade,
): void {
	// getImageData ignores the current transform, so the region is located in
	// device pixels from the transform the clip was drawn with.
	const matrix = context.getTransform();
	const x = Math.max(0, Math.floor(matrix.e));
	const y = Math.max(0, Math.floor(matrix.f));
	const width = Math.min(context.canvas.width - x, Math.ceil(boxW));
	const height = Math.min(context.canvas.height - y, Math.ceil(boxH));
	if (width <= 0 || height <= 0) return;

	const image = context.getImageData(x, y, width, height);
	// One readback covers both: the per-channel tables first, because the hue
	// curves and the LUT are a look applied over a graded picture, not under it.
	if (luts) applyLuts(image.data, luts);
	if (pixelGrade) applyPixelGrade(image.data, pixelGrade);
	// putImageData ignores alpha and filter but not a transform, so the write
	// is done with the identity and the drawing state put back afterwards.
	const filter = context.filter;
	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.putImageData(image, x, y);
	context.restore();
	context.filter = filter;
}

/** One rounded-rectangle path. `roundRect` throws on a zero radius in some builds. */
function roundedRectPath(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	context.beginPath();
	if (radius > 0.5) context.roundRect(x, y, width, height, radius);
	else context.rect(x, y, width, height);
}

/** Sources decoded once and reused for every frame of the export. */
export interface DecodedSources {
	video: Map<string, HTMLVideoElement>;
	image: Map<string, HTMLImageElement>;
	/**
	 * WebCodecs decoders, when the asset's container and codec allow one.
	 * Preferred over the <video>: a forward walk is ~2× faster through a decode
	 * cursor than through a seek per frame. Absent means "seek".
	 */
	frames?: Map<string, FrameSource>;
}

export async function decodeSources(assets: readonly AssetModel[]): Promise<DecodedSources> {
	const video = new Map<string, HTMLVideoElement>();
	const image = new Map<string, HTMLImageElement>();

	await Promise.all(
		assets
			.filter((asset) => !asset.offline && asset.url)
			.map(
				(asset) =>
					new Promise<void>((resolve) => {
						if (asset.type === "image") {
							const element = new Image();
							element.onload = () => {
								image.set(asset.id, element);
								resolve();
							};
							element.onerror = () => resolve();
							element.src = asset.url;
							return;
						}
						if (asset.type !== "video") return resolve();
						const element = document.createElement("video");
						element.muted = true;
						element.preload = "auto";
						element.onloadeddata = () => {
							video.set(asset.id, element);
							resolve();
						};
						element.onerror = () => resolve();
						element.src = asset.url;
					}),
			),
	);

	return { video, image };
}

/** Seeks a video and waits for the frame to actually be ready. */
function seek(element: HTMLVideoElement, seconds: number): Promise<void> {
	return new Promise((resolve) => {
		if (Math.abs(element.currentTime - seconds) < 0.005) return resolve();
		const done = () => {
			element.removeEventListener("seeked", done);
			resolve();
		};
		element.addEventListener("seeked", done);
		try {
			element.currentTime = Math.max(0, seconds);
		} catch {
			element.removeEventListener("seeked", done);
			resolve();
		}
		// A seek that never lands must not stall the whole export.
		setTimeout(done, 250);
	});
}

/**
 * Paints one composited frame. Shared by the video export and the
 * export-a-still path so a PNG always matches what the movie contains.
 */
export async function renderFrame(
	context: CanvasRenderingContext2D,
	timeline: TimelineModel,
	frame: number,
	sources: DecodedSources,
	width: number,
	height: number,
	/** Telemetry and settings for the pointer Rendr draws over a capture. */
	cursor?: { telemetry: readonly CursorTelemetryPoint[]; settings: CursorSettings },
	/** The camera inset, drawn from the take captured alongside the screen. */
	webcam?: { settings: WebcamSettings; assets: readonly AssetModel[] },
	/** The backdrop the footage sits on, and its decoded image if it has one. */
	background?: { settings: BackgroundSettings; image?: CanvasImageSource | null },
	/**
	 * The follow camera's memory across frames. An export passes one for the
	 * whole run; a single still passes none, which falls back to the region's
	 * own focus — a one-frame render has no travel to follow.
	 */
	followState?: CursorFollowCameraState,
	/** How the punch-in and release are timed. Defaults to Recordly's. */
	zoomTiming?: ZoomTiming,
	/**
	 * The camera's spring, carried across the export. Stepped by exactly one
	 * frame's worth of time per frame, so the file eases identically to
	 * playback rather than cutting between the zoom curve's raw values.
	 */
	cameraSpring?: CameraSpringState,
	/** The pointer's spring, carried across the export for the same reason. */
	cursorSpring?: CursorSpringState,
): Promise<void> {
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.clearRect(0, 0, width, height);
	context.fillStyle = "#000";
	context.fillRect(0, 0, width, height);

	// The backdrop goes down first and everything else is drawn over it. The
	// footage is then inset, rounded and shadowed inside it — which is what
	// turns a full-bleed screen capture into a shot.
	const backdrop = background?.settings;
	const inset = backdrop && hasBackground(backdrop) ? footageBox(backdrop, width, height) : null;
	if (backdrop && inset) {
		paintBackground(context, backdrop, width, height, background?.image ?? null);
	}

	const visible = timeline.tracks
		.filter((track) => track.kind === "video" && !track.hidden)
		.flatMap((track) =>
			track.clips.filter((clip) => frame >= clip.startFrame && frame < clip.endFrame),
		);

	// The zoom camera applies to the whole stack, as it does in the preview.
	const zoomHost = visible.find((clip) => (clip.zoomRegions?.length ?? 0) > 0);
	const rawCamera = zoomHost
		? resolveCamera(
				zoomHost.zoomRegions ?? [],
				frameToClipSourceMs(zoomHost, frame, timeline.fps),
				width,
				height,
				cursor?.telemetry,
				followState,
				zoomTiming,
			)
		: null;
	// An export always runs time forward, so the spring always applies. A single
	// still has no previous frame, so it renders the curve's value as authored.
	const camera =
		rawCamera && cameraSpring
			? springCamera(
					rawCamera,
					cameraSpring,
					1000 / timeline.fps,
					(zoomTiming ?? DEFAULT_ZOOM_TIMING).smoothness,
				)
			: rawCamera;

	context.save();

	if (inset && backdrop) {
		// The shadow is painted as its own rounded rectangle before the clip is
		// masked: a shadow on the clipped group would be clipped away with it.
		const shadow = shadowFor(backdrop, height);
		if (shadow) {
			context.save();
			context.shadowColor = `rgba(0, 0, 0, ${shadow.alpha})`;
			context.shadowBlur = shadow.blur;
			context.shadowOffsetY = shadow.offsetY;
			context.fillStyle = "#000";
			roundedRectPath(
				context,
				inset.x * width,
				inset.y * height,
				inset.width * width,
				inset.height * height,
				inset.radiusPx,
			);
			context.fill();
			context.restore();
		}

		// Everything below is drawn into the inset rectangle: the transform maps
		// the full canvas onto it, so a clip that filled the frame still fills
		// the footage, and the rounded corners clip the lot.
		roundedRectPath(
			context,
			inset.x * width,
			inset.y * height,
			inset.width * width,
			inset.height * height,
			inset.radiusPx,
		);
		context.clip();
		context.translate(inset.x * width, inset.y * height);
		context.scale(inset.width, inset.height);
	}

	if (camera) {
		context.translate(camera.x, camera.y);
		context.scale(camera.scale, camera.scale);
	}

	// The clip whose captured pixels contain the hardware pointer. macOS burns
	// it into every take regardless of the capture constraint, so it is painted
	// over during that clip's draw — otherwise it shows beside the drawn cursor
	// whenever the pointer moves, because the drawn one is smoothed and trails.
	const maskedHost =
		cursor && cursor.telemetry.length > 0
			? visible.find((clip) => clip.mediaType === "video")
			: undefined;

	// Bottom track last in the array paints first, so index 0 ends up on top.
	for (const raw of [...visible].reverse()) {
		// Same resolver the preview runs, so animation exports as it plays.
		const clip = clipAtFrame(raw, frame);
		const { transform, crop } = clip;
		// Same resolver as the preview, so a fade exports as it plays.
		const opacity = clipOpacityAt(raw, frame);
		const boxW = transform.width * width;
		const boxH = transform.height * height;
		const boxX = (transform.centerX - transform.width / 2) * width;
		const boxY = (transform.centerY - transform.height / 2) * height;

		context.save();

		/*
		 * A caption is drawn in canvas space, outside the zoom camera.
		 *
		 * The camera transform scales and offsets everything drawn under it —
		 * which is the point for footage and wrong for a subtitle: at 1.5x a
		 * caption at centerY 0.86 lands at y 438 of a 405px frame and is simply
		 * off the bottom edge. That is why narration subtitles were invisible in
		 * every zoomed take while the drawn cursor, which is *meant* to magnify
		 * with the picture, rendered fine. Resetting to the identity also drops
		 * the backdrop inset, which is right: an overlay belongs to the finished
		 * frame, not to the footage sitting inside it.
		 */
		if (clip.captionGroupId !== undefined) {
			context.setTransform(1, 0, 0, 1, 0, 0);
		}

		context.globalAlpha = opacity;
		context.filter = clipFilter(clip);
		context.translate(boxX + boxW / 2, boxY + boxH / 2);
		if (transform.rotation) context.rotate((transform.rotation * Math.PI) / 180);
		context.scale(transform.flipHorizontal ? -1 : 1, transform.flipVertical ? -1 : 1);
		context.translate(-boxW / 2, -boxH / 2);

		if (clip.mediaType === "text") {
			// The same resolver the preview uses, so the file matches playback.
			const anim = resolveTextAnimation(clip, frame, timeline.fps);
			const style = clip.textStyle;
			const preset = style?.animation ?? "off";
			const size = ((style?.fontSize ?? 48) / timeline.height) * height;
			const cased = (value: string) => (style?.uppercase ? value.toUpperCase() : value);

			context.filter = "none";
			context.globalAlpha = opacity * anim.opacity;
			context.font = `${style?.italic ? "italic " : ""}${style?.bold ? "700" : "400"} ${size}px ${style?.fontFamily ?? "sans-serif"}`;
			context.textBaseline = "middle";
			// Entrance offset and scale apply about the block's centre.
			context.translate(boxW / 2, boxH / 2 + anim.offsetY * boxH);
			context.scale(anim.scale, anim.scale);

			// The plate is drawn first, sized from the text that is about to go on
			// top of it. Both branches need it, so the measurement happens here
			// rather than being duplicated inside each.
			if (style?.backgroundColor) {
				const cased2 = cased;
				const perWordNow = isPerWord(preset) && anim.words.length > 0;
				const spaceW = context.measureText(" ").width;
				let plateW: number;
				let plateLines: number;
				if (perWordNow) {
					const ws = anim.words.map((w) => context.measureText(cased2(w.text)).width);
					plateW = ws.reduce((a, b) => a + b, 0) + spaceW * Math.max(0, ws.length - 1);
					plateLines = 1;
				} else {
					const text = cased2(anim.visibleText ?? clip.content ?? "");
					const rows = text.split("\n");
					plateW = Math.max(...rows.map((row) => context.measureText(row).width), 0);
					plateLines = rows.length;
				}
				if (plateW > 0) {
					const pad = size * (style.backgroundPadding ?? 0.35);
					const lineHeight = size * 1.15;
					const h = lineHeight * plateLines + pad * 2 - size * 0.15;
					const w = plateW + pad * 2;
					const originX =
						style.alignment === "left"
							? -boxW / 2 - pad
							: style.alignment === "right"
								? boxW / 2 - w + pad
								: -w / 2;
					const originY = -h / 2;
					const radius = Math.min(h / 2, h * (style.backgroundRadius ?? 0.25));
					const previousAlpha = context.globalAlpha;
					context.globalAlpha = opacity * anim.opacity * (style.backgroundOpacity ?? 1);
					context.fillStyle = style.backgroundColor;
					context.beginPath();
					// roundRect is not everywhere; the manual path keeps the
					// encoder and the preview drawing the same shape.
					context.moveTo(originX + radius, originY);
					context.lineTo(originX + w - radius, originY);
					context.quadraticCurveTo(originX + w, originY, originX + w, originY + radius);
					context.lineTo(originX + w, originY + h - radius);
					context.quadraticCurveTo(
						originX + w,
						originY + h,
						originX + w - radius,
						originY + h,
					);
					context.lineTo(originX + radius, originY + h);
					context.quadraticCurveTo(originX, originY + h, originX, originY + h - radius);
					context.lineTo(originX, originY + radius);
					context.quadraticCurveTo(originX, originY, originX + radius, originY);
					context.closePath();
					context.fill();
					context.globalAlpha = previousAlpha;
				}
			}

			if (isPerWord(preset) && anim.words.length > 0) {
				// Word-by-word is laid out by hand: each word carries its own
				// colour and opacity, so one fillText can't draw the line.
				const spaceWidth = context.measureText(" ").width;
				const widths = anim.words.map(
					(word) => context.measureText(cased(word.text)).width,
				);
				const total =
					widths.reduce((sum, w) => sum + w, 0) + spaceWidth * (widths.length - 1);
				context.textAlign = "left";
				let cursor =
					style?.alignment === "left"
						? -boxW / 2
						: style?.alignment === "right"
							? boxW / 2 - total
							: -total / 2;
				anim.words.forEach((word, index) => {
					const paint = wordColor(
						preset,
						word,
						style?.color ?? "#fff",
						style?.highlightColor ?? "#F29933",
					);
					context.globalAlpha = opacity * anim.opacity * paint.opacity;
					context.fillStyle = paint.color;
					context.fillText(cased(word.text), cursor, 0);
					cursor += widths[index] + spaceWidth;
				});
			} else {
				context.fillStyle = style?.color ?? "#fff";
				context.textAlign =
					style?.alignment === "left"
						? "left"
						: style?.alignment === "right"
							? "right"
							: "center";
				const text = cased(anim.visibleText ?? clip.content ?? "");
				const lines = text.split("\n");
				const lineHeight = size * 1.15;
				const originX =
					style?.alignment === "left"
						? -boxW / 2
						: style?.alignment === "right"
							? boxW / 2
							: 0;
				lines.forEach((line, index) => {
					context.fillText(line, originX, (index - (lines.length - 1) / 2) * lineHeight);
				});
			}
		} else {
			// The decoder first, then the <video>, then a still.
			const sourceMs = frameToClipSourceMs(clip, frame, timeline.fps);
			const decoded =
				(await sources.frames?.get(clip.assetId ?? "")?.frameAt(sourceMs / 1000)) ?? null;
			const source =
				decoded ??
				sources.video.get(clip.assetId ?? "") ??
				sources.image.get(clip.assetId ?? "");
			if (source) {
				if (!decoded && source instanceof HTMLVideoElement) {
					await seek(source, sourceMs / 1000);
				}
				const naturalW =
					source instanceof HTMLVideoElement
						? source.videoWidth
						: ((source as HTMLImageElement).naturalWidth ??
							(source as HTMLCanvasElement).width);
				const naturalH =
					source instanceof HTMLVideoElement
						? source.videoHeight
						: ((source as HTMLImageElement).naturalHeight ??
							(source as HTMLCanvasElement).height);
				if (naturalW > 0 && naturalH > 0) {
					// Curves are a per-channel lookup, which `context.filter` has
					// no syntax for — so those pixels are mapped directly. Only a
					// clip that actually carries a curve pays for the readback.
					const luts = buildChannelLuts(clip.color.curves, clip.color.balance);
					const pixels = needsPixelGrade(clip.color) ? clip.color : undefined;
					// Crop in source space, then cover-fit into the clip's box.
					const sx = crop.left * naturalW;
					const sy = crop.top * naturalH;
					const sw = naturalW * (1 - crop.left - crop.right);
					const sh = naturalH * (1 - crop.top - crop.bottom);
					const scale = Math.max(boxW / sw, boxH / sh);
					const drawW = sw * scale;
					const drawH = sh * scale;
					context.save();
					context.beginPath();
					context.rect(0, 0, boxW, boxH);
					context.clip();
					context.drawImage(
						source,
						sx,
						sy,
						sw,
						sh,
						(boxW - drawW) / 2,
						(boxH - drawH) / 2,
						drawW,
						drawH,
					);
					if (raw === maskedHost && cursor) {
						// Paint over the captured hardware pointer with the
						// pixels beside it, before grading so the patch is
						// graded like everything around it.
						const point = rawCursorAt(cursor.telemetry, sourceMs);
						const patch = point
							? capturedPointerPatch(point, naturalW, naturalH, { sx, sy, sw, sh })
							: null;
						if (patch) {
							context.drawImage(
								source,
								patch.from.x,
								patch.from.y,
								patch.rect.w,
								patch.rect.h,
								(boxW - drawW) / 2 + (patch.rect.x - sx) * scale,
								(boxH - drawH) / 2 + (patch.rect.y - sy) * scale,
								patch.rect.w * scale,
								patch.rect.h * scale,
							);
						}
					}
					if (luts || pixels) {
						applyLutsToRegion(context, boxW, boxH, luts, pixels);
					}
					context.restore();
				}
			}
		}
		context.restore();
	}

	// The camera inset. It reads the zoom's scale so the bubble can grow with a
	// punch-in, but note it is still drawn under the camera transform, unlike
	// captions above — worth revisiting if a presenter ever slides off frame.
	if (webcam?.settings.show) {
		const element = await cameraFrameFor(webcam.assets, visible, sources, frame, timeline.fps);
		if (element) {
			drawWebcam(context, webcam.settings, element, width, height, camera?.scale ?? 1);
		}
	}

	// The drawn pointer sits inside the camera transform, so a punch-in
	// magnifies it exactly as it magnifies the picture — the same as the preview.
	if (cursor && cursor.telemetry.length > 0) {
		const host = visible.find((clip) => clip.mediaType === "video");
		const resolved = host
			? resolveCursor(
					cursor.telemetry,
					frameToClipSourceMs(host, frame, timeline.fps),
					cursor.settings,
					cursorSpring,
					1000 / timeline.fps,
				)
			: null;
		if (resolved) {
			// The spotlight and the ring go under the pointer, so the pointer is
			// never dimmed by its own spotlight.
			drawSpotlight(context, resolved, cursor.settings, width, height);
			drawClickRing(context, resolved, cursor.settings, width, height);
			drawCursor(context, resolved, cursor.settings, width, height);
		}
	}

	context.restore();
}

/**
 * Seeks and returns the camera take belonging to whichever screen take is on
 * screen at this frame.
 *
 * The two files were recorded from one clock, so the camera is seeked to the
 * *screen clip's* source time: trimming or sliding the screen take carries its
 * camera with it, and no drift correction is needed.
 */
async function cameraFrameFor(
	assets: readonly AssetModel[],
	visible: TimelineModel["tracks"][number]["clips"],
	sources: DecodedSources,
	frame: number,
	fps: number,
): Promise<HTMLVideoElement | null> {
	for (const clip of visible) {
		if (clip.mediaType === "text" || !clip.assetId) continue;
		const asset = assets.find((entry) => entry.id === clip.assetId);
		if (!asset?.webcamAssetId) continue;
		const element = sources.video.get(asset.webcamAssetId);
		if (!element) continue;
		await seek(element, frameToClipSourceMs(clip, frame, fps) / 1000);
		return element;
	}
	return null;
}

/**
 * Paints the camera bubble.
 *
 * The placement and the source rectangle come from webcam.ts, the same module
 * the preview uses, so the bubble is in the same place and cropped the same way
 * in the file as it was on screen.
 */
function drawWebcam(
	context: CanvasRenderingContext2D,
	settings: WebcamSettings,
	video: CanvasImageSource,
	width: number,
	height: number,
	zoomScale: number,
): void {
	const box = webcamBox(settings, width / height, zoomScale);
	if (!box) return;

	const naturalWidth =
		video instanceof HTMLVideoElement ? video.videoWidth : (video as HTMLImageElement).width;
	const naturalHeight =
		video instanceof HTMLVideoElement ? video.videoHeight : (video as HTMLImageElement).height;
	const boxW = box.width * width;
	const boxH = box.height * height;
	const source = webcamSourceRect(settings, naturalWidth, naturalHeight, boxW / boxH);
	if (!source) return;

	const x = box.x * width;
	const y = box.y * height;
	const radius = box.radius * Math.min(boxW, boxH);

	context.save();
	context.filter = "none";
	context.globalAlpha = 1;

	// The bubble's shape is a clip, so a circle really is a circle rather than a
	// square with a drawn-on outline.
	context.beginPath();
	if (radius > 0) context.roundRect(x, y, boxW, boxH, radius);
	else context.rect(x, y, boxW, boxH);
	context.clip();

	if (settings.mirror) {
		// Mirrored about the bubble's own centre, not the canvas'.
		context.translate(x + boxW / 2, 0);
		context.scale(-1, 1);
		context.translate(-(x + boxW / 2), 0);
	}
	context.drawImage(video, source.sx, source.sy, source.sw, source.sh, x, y, boxW, boxH);
	context.restore();

	// The border is drawn unmirrored and unclipped, so it stays a clean edge.
	context.save();
	context.filter = "none";
	context.beginPath();
	if (radius > 0) context.roundRect(x, y, boxW, boxH, radius);
	else context.rect(x, y, boxW, boxH);
	context.strokeStyle = "rgba(255, 255, 255, 0.16)";
	context.lineWidth = Math.max(1, height / 720);
	context.stroke();
	context.restore();
}

/**
 * Dims everything outside a soft circle around the pointer.
 *
 * Drawn as a radial gradient from transparent at the centre to the dim colour
 * at the edge, so the falloff has no visible ring — a hard-edged mask reads as
 * a hole cut in the picture rather than as light.
 */
function drawSpotlight(
	context: CanvasRenderingContext2D,
	frame: CursorFrame,
	settings: CursorSettings,
	width: number,
	height: number,
): void {
	const amount = Math.min(1, Math.max(0, settings.spotlight ?? 0));
	if (amount <= 0) return;

	const shortEdge = Math.min(width, height);
	const inner = shortEdge * Math.max(0.05, settings.spotlightSize ?? 0.28);
	const x = frame.cx * width;
	const y = frame.cy * height;

	context.save();
	context.filter = "none";
	context.globalAlpha = 1;
	const gradient = context.createRadialGradient(x, y, inner * 0.55, x, y, inner * 1.6);
	gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
	gradient.addColorStop(1, `rgba(0, 0, 0, ${(amount * 0.72).toFixed(3)})`);
	context.fillStyle = gradient;
	context.fillRect(0, 0, width, height);
	context.restore();
}

/** The ring a click throws off — expanding and fading, centred on the pointer. */
function drawClickRing(
	context: CanvasRenderingContext2D,
	frame: CursorFrame,
	settings: CursorSettings,
	width: number,
	height: number,
): void {
	if (frame.ring === null || !settings.clickRing) return;

	const { radius, alpha } = ringAt(frame.ring, Math.min(width, height));
	const x = frame.cx * width;
	const y = frame.cy * height;

	context.save();
	context.filter = "none";
	context.globalAlpha = alpha;
	context.strokeStyle = settings.ringColor || "#FFFFFF";
	context.lineWidth = Math.max(1.5, Math.min(width, height) / 320);
	context.beginPath();
	context.arc(x, y, radius, 0, Math.PI * 2);
	context.stroke();
	context.restore();
}

/**
 * Paints over the hardware pointer at its raw position.
 *
 * A system arrow is about 20×24 logical pixels from its hotspot, down and to
 * the right. The fill colour is sampled from just beyond that box rather than
 * guessed, because a fixed colour would be a visible square on anything but a
 * matching background.
 */
function maskCaptured(
	context: CanvasRenderingContext2D,
	frame: CursorFrame,
	width: number,
	height: number,
): void {
	const scale = height / 1080;
	// A couple of pixels of margin around the arrow's box. The hotspot is the
	// arrow's own tip, so a box starting exactly there leaves its topmost row
	// uncovered — which shows up as a stray light pixel above the drawn pointer.
	const margin = Math.ceil(3 * scale);
	const boxW = Math.ceil(22 * scale) + margin * 2;
	const boxH = Math.ceil(26 * scale) + margin * 2;
	const x = Math.round(frame.rawCx * width) - margin;
	const y = Math.round(frame.rawCy * height) - margin;
	if (x + boxW < 0 || y + boxH < 0 || x >= width || y >= height) return;

	// Sample to the left of the hotspot — the arrow occupies down-and-right, so
	// this pixel is background rather than cursor.
	const sampleX = Math.max(0, x - Math.ceil(4 * scale));
	const sampleY = Math.min(height - 1, Math.max(0, y + Math.ceil(boxH / 2)));
	let fill = "#000";
	try {
		const pixel = context.getImageData(sampleX, sampleY, 1, 1).data;
		fill = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
	} catch {
		// A tainted canvas can't be read; the drawn pointer still covers most of
		// it, so a miss here is cosmetic rather than fatal.
		return;
	}

	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.filter = "none";
	context.globalAlpha = 1;
	context.fillStyle = fill;
	// Clipped to the canvas, so a pointer near an edge doesn't ask the context
	// to fill outside it.
	const left = Math.max(0, x);
	const top = Math.max(0, y);
	context.fillRect(
		left,
		top,
		Math.min(boxW - (left - x), width - left),
		Math.min(boxH - (top - y), height - top),
	);
	context.restore();
}

/** Paints one pointer. The path is shared with the preview, so both agree. */
function drawCursor(
	context: CanvasRenderingContext2D,
	frame: CursorFrame,
	settings: CursorSettings,
	width: number,
	height: number,
): void {
	// The 24-unit design box scales with the canvas so the pointer is the same
	// relative size at 720p and at source resolution.
	const unit = (height / 1080) * frame.scale;
	context.save();
	context.translate(frame.cx * width, frame.cy * height);
	context.scale(unit, unit);
	// Canvas has no directional blur, so the smear is drawn: a few progressively
	// fainter copies stepped back along the direction of travel. A symmetric
	// blur() reads as the pointer being out of focus rather than moving, which
	// is why Recordly uses a directional filter and why this does the same by
	// hand. Recordly ships motionBlur at 0, so most takes never reach this.
	context.filter = "none";
	context.globalAlpha = frame.opacity;

	/*
	 * Cover the pointer the capture burnt in.
	 *
	 * macOS ignores `cursor: "never"` on every capture path tried, so the real
	 * pointer is in the pixels. It sits at the *raw* sample position while the
	 * drawn one lags behind it by the smoothing, which is why it shows: during
	 * movement it pokes out ahead. The patch is filled from a pixel just outside
	 * the arrow's own box, so plain backgrounds come out seamless and busy ones
	 * get a small smudge that the drawn pointer then covers.
	 */
	if (settings.maskCapturedCursor !== false) {
		maskCaptured(context, frame, width, height);
	}

	const paint = cursorFill(settings.style);
	const path = new Path2D(cursorPath(settings.style));
	context.lineJoin = "round";
	context.lineWidth = 1.2;
	context.strokeStyle = paint.stroke;
	context.fillStyle = paint.fill;

	const draw = () => {
		context.stroke(path);
		context.fill(path);
	};

	if (frame.blur > 0.4) {
		// Trailing copies, stepped back along travel and fading out. Drawn
		// before the pointer so the solid one stays on top and legible.
		const steps = 4;
		const back = Math.min(4, frame.blur) / unit;
		for (let index = steps; index >= 1; index--) {
			const distance = (back * index) / steps;
			context.save();
			context.globalAlpha = frame.opacity * (0.16 * (1 - index / (steps + 1)));
			context.translate(-Math.cos(frame.angle) * distance, -Math.sin(frame.angle) * distance);
			draw();
			context.restore();
		}
		context.globalAlpha = frame.opacity;
	}

	draw();
	context.restore();
}

export interface ExportProgress {
	frame: number;
	totalFrames: number;
	/** 0–1. */
	ratio: number;
	/** What the export is doing right now, for the dialog's caption. */
	stage?: "audio" | "video" | "muxing";
}

/**
 * Muxes the rendered audio into the encoded video.
 *
 * MediaRecorder over a canvas produces picture only, so without this an export
 * is silent. The desktop bridge owns the muxer; in a plain browser there is
 * none, and the caller is told rather than handed a silent file that looks fine.
 */
async function muxAudio(
	video: Blob,
	audio: AudioBuffer,
	durationSeconds: number,
): Promise<{ blob: Blob } | { warning: string }> {
	const bridge = window.electronAPI;
	if (!bridge?.muxExportedVideoAudio || !bridge.readLocalFile) {
		return {
			warning:
				"This build has no muxer, so the file has picture but no sound. Run Rendr as the desktop app to export with audio.",
		};
	}

	const wav = audioBufferToWav(audio);
	const result = await bridge.muxExportedVideoAudio(await video.arrayBuffer(), {
		audioMode: "edited-track",
		editedTrackStrategy: "offline-render-fallback",
		editedAudioData: await wav.arrayBuffer(),
		editedAudioMimeType: "audio/wav",
		outputDurationSec: durationSeconds,
	});
	if (!result?.success || !result.tempPath) {
		return {
			warning: `The picture encoded but the audio couldn't be muxed in: ${result?.error ?? "the muxer failed"}. The file is silent.`,
		};
	}

	const read = await bridge.readLocalFile(result.tempPath);
	if (!read?.success || !read.data) {
		return {
			warning: `The muxed file was written to ${result.tempPath} but couldn't be read back: ${read?.error ?? "unknown error"}.`,
		};
	}
	return { blob: new Blob([new Uint8Array(read.data)], { type: video.type }) };
}

export interface ExportHandle {
	/** Resolves with the finished file, or null when cancelled. */
	done: Promise<Blob | null>;
	cancel: () => void;
	/** Set when the file came out usable but not as asked — e.g. no audio. */
	warning: () => string | null;
}

/**
 * Renders every frame of the timeline into a video file.
 *
 * The canvas stream is driven manually (`requestFrame`) rather than by a frame
 * rate, so a slow seek stretches wall-clock time instead of dropping frames.
 */
export function exportTimeline(
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
	// One follow state for the whole export, so the camera remembers where it
	// was between frames exactly as it does during playback.
	const followState = createCursorFollowCameraState();
	const cameraSpring = createCameraSpringState();
	const cursorSpring = createCursorSpringState();
	const { width, height } = exportDimensions(timeline, settings);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { alpha: false });

	let cancelled = false;
	let warning: string | null = null;

	const done = (async (): Promise<Blob | null> => {
		if (!context) throw new Error("This browser can't provide a 2D canvas to render into.");
		if (totalFrames <= 0) throw new Error("There's nothing on the timeline to export.");

		// Audio first: the mix is needed before the muxing step, and rendering it
		// offline is fast compared with the frame-by-frame video pass.
		onProgress({ frame: 0, totalFrames, ratio: 0, stage: "audio" });
		const mix = await renderTimelineAudio(timeline, assets, totalFrames, (ratio) =>
			onProgress({ frame: 0, totalFrames, ratio: ratio * 0.05, stage: "audio" }),
		).catch(() => null);
		if (cancelled) return null;

		const sources = await decodeSources(assets);

		const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
			(type) => MediaRecorder.isTypeSupported(type),
		);
		if (!mimeType) throw new Error("This browser can't encode video.");

		// captureStream(0) hands back a track we advance ourselves, so a slow
		// seek stretches wall-clock time instead of dropping frames.
		const stream = canvas.captureStream(0);
		const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream, {
			mimeType,
			videoBitsPerSecond: bitrateFor(width, height, settings.quality),
		});
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.start();

		try {
			// MediaRecorder timestamps each frame by the wall clock at the moment
			// it arrives, so the container's frame rate is however fast frames
			// were pushed — not the timeline's. Rendering faster than real time
			// therefore produced a file that played fast: 150 frames of a 5s cut
			// packed into 2.8 seconds. Pacing the loop to the timeline's own frame
			// rate is what makes the exported duration match the edit.
			const startedAt = performance.now();
			for (let frame = 0; frame < totalFrames; frame++) {
				if (cancelled) break;
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

				const dueAt = startedAt + (frame / timeline.fps) * 1000;
				const earlyBy = dueAt - performance.now();
				if (earlyBy > 0) {
					await new Promise((resolve) => setTimeout(resolve, earlyBy));
				}
				track.requestFrame();
				// The audio pass owns the first 5%, so the bar doesn't jump back.
				onProgress({
					frame,
					totalFrames,
					ratio: 0.05 + ((frame + 1) / totalFrames) * 0.9,
					stage: "video",
				});
				// Yield so the encoder drains and the UI stays responsive.
				await new Promise((resolve) => setTimeout(resolve, 0));
			}

			const blob = await new Promise<Blob>((resolve) => {
				recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
				recorder.stop();
			});
			if (cancelled) return null;

			if (!mix) {
				warning = "Nothing on the timeline makes a sound, so the file has no audio track.";
				return blob;
			}

			onProgress({ frame: totalFrames, totalFrames, ratio: 0.95, stage: "muxing" });
			const muxed = await muxAudio(blob, mix, totalFrames / timeline.fps);
			onProgress({ frame: totalFrames, totalFrames, ratio: 1, stage: "muxing" });
			if ("warning" in muxed) {
				warning = muxed.warning;
				return blob;
			}
			return muxed.blob;
		} finally {
			for (const t of stream.getTracks()) t.stop();
		}
	})();

	return {
		done,
		cancel() {
			cancelled = true;
		},
		warning: () => warning,
	};
}

/** Renders one frame and hands back a PNG. */
export async function exportStill(
	timeline: TimelineModel,
	assets: readonly AssetModel[],
	frame: number,
	cursor?: { telemetry: readonly CursorTelemetryPoint[]; settings: CursorSettings },
	webcam?: { settings: WebcamSettings; assets: readonly AssetModel[] },
	background?: { settings: BackgroundSettings; image?: CanvasImageSource | null },
): Promise<Blob | null> {
	const canvas = document.createElement("canvas");
	canvas.width = timeline.width;
	canvas.height = timeline.height;
	const context = canvas.getContext("2d", { alpha: false });
	if (!context) return null;

	const sources = await decodeSources(assets);
	await renderFrame(
		context,
		timeline,
		frame,
		sources,
		timeline.width,
		timeline.height,
		cursor,
		webcam,
		background,
	);
	return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
