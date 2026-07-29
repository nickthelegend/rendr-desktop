// The webcam inset.
//
// A second camera stream recorded alongside the screen and composited over it,
// the way Recordly does: a corner bubble that can grow when the zoom camera
// punches in, so the presenter doesn't shrink away just as the detail arrives.
//
// The placement maths is pure so the preview and the encoder put the bubble in
// the same place, and the crop is expressed the same way clip crops are.

import type { Crop } from "./model";

export type WebcamPosition =
	| "top-left"
	| "top"
	| "top-right"
	| "left"
	| "center"
	| "right"
	| "bottom-left"
	| "bottom"
	| "bottom-right";

export type WebcamShape = "rounded" | "circle" | "square";

export interface WebcamSettings {
	show: boolean;
	/** Device to capture from. Absent means the system default. */
	deviceId?: string;
	/** Grows the bubble while the zoom camera is punched in. */
	reactsToZoom: boolean;
	/** Selfie view — what the presenter expects to see of themselves. */
	mirror: boolean;
	/** Fraction of the canvas' short edge. */
	size: number;
	shape: WebcamShape;
	position: WebcamPosition;
	/** Inset from the frame edge, as a fraction of the canvas. */
	margin: number;
	/** Side insets into the camera image, like a clip's crop. */
	crop: Crop;
}

export const DEFAULT_WEBCAM: WebcamSettings = {
	show: false,
	reactsToZoom: true,
	mirror: true,
	size: 0.4,
	shape: "rounded",
	position: "bottom-right",
	margin: 0.03,
	crop: { top: 0, right: 0, bottom: 0, left: 0 },
};

export const WEBCAM_LIMITS = {
	size: { min: 0.1, max: 1, step: 0.01 },
	margin: { min: 0, max: 0.2, step: 0.005 },
} as const;

export const WEBCAM_POSITIONS: WebcamPosition[][] = [
	["top-left", "top", "top-right"],
	["left", "center", "right"],
	["bottom-left", "bottom", "bottom-right"],
];

export const WEBCAM_SHAPES: Array<{ id: WebcamShape; label: string }> = [
	{ id: "rounded", label: "Rounded" },
	{ id: "circle", label: "Circle" },
	{ id: "square", label: "Square" },
];

/** Where the bubble sits, in 0–1 of the canvas. */
export interface WebcamBox {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Corner radius as a fraction of the shorter side. */
	radius: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Places the bubble for one frame.
 *
 * `size` is a fraction of the canvas' *short* edge, so the bubble is the same
 * physical size whether the project is 16:9 or 9:16 — sizing off the width
 * would make a vertical project's webcam huge.
 *
 * `zoomScale` above 1 means the camera is punched in; with `reactsToZoom` the
 * bubble grows a little so it doesn't shrink away against the magnified detail.
 */
export function webcamBox(
	settings: WebcamSettings,
	canvasAspect: number,
	zoomScale = 1,
): WebcamBox | null {
	if (!settings.show) return null;

	// A quarter of the punch-in, so it grows noticeably but never dominates.
	const growth = settings.reactsToZoom ? 1 + (Math.max(1, zoomScale) - 1) * 0.25 : 1;
	// The bubble is square before cropping; `size` is against the short edge.
	const shortEdgeFraction = clamp01(settings.size * 0.4 * growth);

	const height = shortEdgeFraction;
	const width = shortEdgeFraction / canvasAspect;

	const margin = settings.margin;
	const [row, column] = positionCell(settings.position);
	const x = column === 0 ? margin : column === 1 ? (1 - width) / 2 : 1 - width - margin;
	const y = row === 0 ? margin : row === 1 ? (1 - height) / 2 : 1 - height - margin;

	return {
		x: clamp01(x),
		y: clamp01(y),
		width,
		height,
		radius: settings.shape === "circle" ? 0.5 : settings.shape === "square" ? 0 : 0.12,
	};
}

function positionCell(position: WebcamPosition): [number, number] {
	for (let row = 0; row < WEBCAM_POSITIONS.length; row++) {
		const column = WEBCAM_POSITIONS[row].indexOf(position);
		if (column >= 0) return [row, column];
	}
	return [2, 2];
}

/**
 * Which part of the camera image to draw, in source pixels.
 *
 * The camera is almost never the bubble's shape, so the crop the user set is
 * applied first and whatever survives is then centre-cropped to fill — the same
 * cover rule `apply_layout` uses, so nothing is ever stretched.
 */
export function webcamSourceRect(
	settings: WebcamSettings,
	naturalWidth: number,
	naturalHeight: number,
	boxAspect: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
	if (naturalWidth <= 0 || naturalHeight <= 0) return null;

	const { top, right, bottom, left } = settings.crop;
	let sx = left * naturalWidth;
	let sy = top * naturalHeight;
	let sw = naturalWidth * Math.max(0.02, 1 - left - right);
	let sh = naturalHeight * Math.max(0.02, 1 - top - bottom);

	// Cover: trim the longer axis so the remaining rectangle matches the bubble.
	const cropped = sw / sh;
	if (cropped > boxAspect) {
		const wanted = sh * boxAspect;
		sx += (sw - wanted) / 2;
		sw = wanted;
	} else if (cropped < boxAspect) {
		const wanted = sw / boxAspect;
		sy += (sh - wanted) / 2;
		sh = wanted;
	}

	return { sx, sy, sw, sh };
}
