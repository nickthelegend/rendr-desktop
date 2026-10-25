// Background removal and replacement for camera footage.
//
// The person matte is a greyscale video made once by the main process (white
// is person, black is background). At render time the footage is drawn, the
// matte frame at the same source time becomes its alpha, and whatever the
// clip asks for goes behind: nothing (so lower tracks show through — graphics
// behind the speaker), a colour, a still, or the footage itself blurred.
//
// One function draws it for both the preview and the export, so the file
// matches what was on screen.

export type BackgroundMode = "remove" | "color" | "blur" | "image";

export const BACKGROUND_MODES: readonly BackgroundMode[] = ["remove", "color", "blur", "image"];

export interface ClipBackground {
	mode: BackgroundMode;
	/** For "color": any CSS colour. */
	color?: string;
	/** For "image": a library image (or video still) to put behind the person. */
	imageAssetId?: string;
	/** For "blur": radius in pixels at 1080p; scaled with the output. */
	blur?: number;
	/** Softens the cut-out edge, in pixels at 1080p. */
	feather?: number;
}

export const DEFAULT_BLUR = 24;
export const DEFAULT_FEATHER = 1.5;

/**
 * Validates a background request from an agent or the inspector. Returns the
 * cleaned value, or a reason it can't be used.
 */
export function parseBackground(
	input: unknown,
): { background: ClipBackground } | { error: string } {
	if (!input || typeof input !== "object")
		return { error: "background must be an object with a mode." };
	const raw = input as Record<string, unknown>;
	const mode = raw.mode as BackgroundMode;
	if (!BACKGROUND_MODES.includes(mode)) {
		return { error: `mode must be one of ${BACKGROUND_MODES.join(", ")}.` };
	}
	const background: ClipBackground = { mode };
	if (mode === "color") {
		const color = typeof raw.color === "string" ? raw.color.trim() : "";
		if (!color) return { error: "mode 'color' needs a color, e.g. '#0B4F3C'." };
		background.color = color;
	}
	if (mode === "image") {
		if (typeof raw.imageAssetId !== "string" || !raw.imageAssetId) {
			return { error: "mode 'image' needs imageAssetId — import the image first." };
		}
		background.imageAssetId = raw.imageAssetId;
	}
	if (mode === "blur") {
		const blur = Number(raw.blur ?? DEFAULT_BLUR);
		if (!Number.isFinite(blur) || blur < 0 || blur > 200)
			return { error: "blur must be 0–200 pixels." };
		background.blur = blur;
	}
	if (raw.feather !== undefined) {
		const feather = Number(raw.feather);
		if (!Number.isFinite(feather) || feather < 0 || feather > 40)
			return { error: "feather must be 0–40 pixels." };
		background.feather = feather;
	}
	return { background };
}

/**
 * Turns a greyscale matte into an alpha mask in place: brightness becomes
 * opacity, colour becomes white. The matte is greyscale H.264, so all three
 * channels carry the same value give or take compression; red is read.
 */
export function lumaToAlpha(data: Uint8ClampedArray): void {
	for (let index = 0; index < data.length; index += 4) {
		const alpha = data[index];
		data[index] = 255;
		data[index + 1] = 255;
		data[index + 2] = 255;
		data[index + 3] = alpha;
	}
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const scratch = new Map<string, Canvas>();

function scratchCanvas(
	name: string,
	width: number,
	height: number,
): { canvas: Canvas; context: Context } | null {
	let canvas = scratch.get(name);
	if (!canvas) {
		canvas =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(width, height)
				: Object.assign(document.createElement("canvas"), { width, height });
		scratch.set(name, canvas);
	}
	if (canvas.width !== width) canvas.width = width;
	if (canvas.height !== height) canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true }) as Context | null;
	return context ? { canvas, context } : null;
}

function naturalSize(source: CanvasImageSource): { width: number; height: number } {
	if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
		return { width: source.videoWidth, height: source.videoHeight };
	}
	if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
		return { width: source.naturalWidth, height: source.naturalHeight };
	}
	if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
		return { width: source.displayWidth, height: source.displayHeight };
	}
	const sized = source as { width?: number; height?: number };
	return { width: Number(sized.width) || 0, height: Number(sized.height) || 0 };
}

export interface MattedDraw {
	source: CanvasImageSource;
	/** The matte frame at the same source time. Null draws the footage untouched. */
	matte: CanvasImageSource | null;
	/** Crop as fractions of the source, the same for footage and matte. */
	crop: { top: number; right: number; bottom: number; left: number };
	/** Where the cropped footage lands in the clip's box (cover-fit). */
	dest: { x: number; y: number; width: number; height: number };
	boxWidth: number;
	boxHeight: number;
	background: ClipBackground;
	backgroundImage?: CanvasImageSource | null;
	/** Output height / 1080, so blur and feather look the same at any size. */
	pixelScale: number;
	/** The clip's colour-grade filter, applied to footage but not to a flat colour. */
	gradeFilter?: string;
}

/**
 * Draws matted footage into a context whose origin is the clip box's top-left.
 *
 * Fails open: with no matte frame (still analysing, or the file is offline)
 * the footage is drawn as it is, because a missing background is a smaller
 * surprise than a missing person.
 */
export function drawMatted(target: Context, draw: MattedDraw): void {
	const { source, matte, crop, dest, boxWidth, boxHeight, background, pixelScale } = draw;
	const sourceSize = naturalSize(source);
	const sx = crop.left * sourceSize.width;
	const sy = crop.top * sourceSize.height;
	const sw = sourceSize.width * (1 - crop.left - crop.right);
	const sh = sourceSize.height * (1 - crop.top - crop.bottom);
	const grade = draw.gradeFilter && draw.gradeFilter !== "none" ? draw.gradeFilter : "none";

	const plain = () => {
		target.filter = grade;
		target.drawImage(source, sx, sy, sw, sh, dest.x, dest.y, dest.width, dest.height);
		target.filter = "none";
	};
	if (!matte || sw <= 0 || sh <= 0) return plain();
	const matteSize = naturalSize(matte);
	const width = Math.max(2, Math.round(boxWidth));
	const height = Math.max(2, Math.round(boxHeight));
	const person = scratchCanvas("person", width, height);
	const mw = Math.max(2, Math.round(matteSize.width * (1 - crop.left - crop.right)));
	const mh = Math.max(2, Math.round(matteSize.height * (1 - crop.top - crop.bottom)));
	const mask = scratchCanvas("mask", mw, mh);
	if (!person || !mask || matteSize.width === 0) return plain();

	// The mask, at the matte's own resolution: the per-pixel pass is the one
	// cost here, and the matte is never larger than 1280 on its long edge.
	mask.context.clearRect(0, 0, mw, mh);
	mask.context.drawImage(
		matte,
		crop.left * matteSize.width,
		crop.top * matteSize.height,
		mw,
		mh,
		0,
		0,
		mw,
		mh,
	);
	const pixels = mask.context.getImageData(0, 0, mw, mh);
	lumaToAlpha(pixels.data);
	mask.context.putImageData(pixels, 0, 0);

	// The person: footage with the mask as its alpha, scaled up smoothly.
	person.context.clearRect(0, 0, width, height);
	person.context.filter = grade;
	person.context.drawImage(source, sx, sy, sw, sh, dest.x, dest.y, dest.width, dest.height);
	person.context.filter = "none";
	person.context.globalCompositeOperation = "destination-in";
	const feather = (background.feather ?? DEFAULT_FEATHER) * pixelScale;
	if (feather > 0.25) person.context.filter = `blur(${feather.toFixed(2)}px)`;
	person.context.drawImage(mask.canvas, 0, 0, mw, mh, dest.x, dest.y, dest.width, dest.height);
	person.context.filter = "none";
	person.context.globalCompositeOperation = "source-over";

	// What goes behind them.
	if (background.mode === "color" && background.color) {
		target.fillStyle = background.color;
		target.fillRect(0, 0, boxWidth, boxHeight);
	} else if (background.mode === "blur") {
		const radius = (background.blur ?? DEFAULT_BLUR) * pixelScale;
		target.filter =
			grade === "none"
				? `blur(${radius.toFixed(1)}px)`
				: `${grade} blur(${radius.toFixed(1)}px)`;
		// Drawn a little oversized so the blur doesn't pull black in from the edges.
		const bleed = radius * 2;
		target.drawImage(
			source,
			sx,
			sy,
			sw,
			sh,
			dest.x - bleed,
			dest.y - bleed,
			dest.width + bleed * 2,
			dest.height + bleed * 2,
		);
		target.filter = "none";
	} else if (background.mode === "image" && draw.backgroundImage) {
		const image = naturalSize(draw.backgroundImage);
		if (image.width > 0 && image.height > 0) {
			const scale = Math.max(boxWidth / image.width, boxHeight / image.height);
			const iw = image.width * scale;
			const ih = image.height * scale;
			target.drawImage(
				draw.backgroundImage,
				(boxWidth - iw) / 2,
				(boxHeight - ih) / 2,
				iw,
				ih,
			);
		}
	}
	target.drawImage(person.canvas, 0, 0);
}
