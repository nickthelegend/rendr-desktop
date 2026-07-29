// Multi-clip layouts: split screen, picture-in-picture, grids.
//
// A layout assigns each clip a slot rectangle, then computes the transform and
// crop that makes the clip FILL that rectangle without stretching — the source
// is cropped to the slot's shape, like dropping footage into a template. `fit`
// letterboxes instead, for a screen recording where the whole frame matters.

import { type Crop, clamp01, type Transform } from "./model";

export type LayoutName =
	| "full"
	| "side_by_side"
	| "top_bottom"
	| "pip_bottom_right"
	| "pip_bottom_left"
	| "pip_top_right"
	| "pip_top_left"
	| "grid_2x2"
	| "grid_3x3"
	| "grid_4x4"
	| "main_sidebar"
	| "three_up";

export type LayoutFit = "fill" | "fit";

/** A slot in 0-1 canvas coordinates. */
export interface Slot {
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Drawn above the others; the PIP inset. */
	onTop?: boolean;
}

const PIP_SIZE = 0.28;
const PIP_MARGIN = 0.03;

function grid(size: number): Slot[] {
	const slots: Slot[] = [];
	for (let row = 1; row <= size; row++) {
		for (let column = 1; column <= size; column++) {
			slots.push({
				name: `r${row}c${column}`,
				x: (column - 1) / size,
				y: (row - 1) / size,
				width: 1 / size,
				height: 1 / size,
			});
		}
	}
	return slots;
}

/** Slot rectangles for a layout, in the order the contract names them. */
export function slotsFor(layout: LayoutName): Slot[] {
	switch (layout) {
		case "full":
			return [{ name: "main", x: 0, y: 0, width: 1, height: 1 }];
		case "side_by_side":
			return [
				{ name: "left", x: 0, y: 0, width: 0.5, height: 1 },
				{ name: "right", x: 0.5, y: 0, width: 0.5, height: 1 },
			];
		case "top_bottom":
			return [
				{ name: "top", x: 0, y: 0, width: 1, height: 0.5 },
				{ name: "bottom", x: 0, y: 0.5, width: 1, height: 0.5 },
			];
		case "pip_bottom_right":
		case "pip_bottom_left":
		case "pip_top_right":
		case "pip_top_left": {
			const right = layout.endsWith("right");
			const bottom = layout.includes("bottom");
			// The inset keeps its aspect by taking the same fraction of each axis.
			return [
				{ name: "main", x: 0, y: 0, width: 1, height: 1 },
				{
					name: "inset",
					x: right ? 1 - PIP_SIZE - PIP_MARGIN : PIP_MARGIN,
					y: bottom ? 1 - PIP_SIZE - PIP_MARGIN : PIP_MARGIN,
					width: PIP_SIZE,
					height: PIP_SIZE,
					onTop: true,
				},
			];
		}
		case "grid_2x2":
			return grid(2);
		case "grid_3x3":
			return grid(3);
		case "grid_4x4":
			return grid(4);
		case "main_sidebar":
			return [
				{ name: "main", x: 0, y: 0, width: 0.7, height: 1 },
				{ name: "sidebar", x: 0.7, y: 0, width: 0.3, height: 1 },
			];
		case "three_up":
			return [
				{ name: "left", x: 0, y: 0, width: 1 / 3, height: 1 },
				{ name: "center", x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
				{ name: "right", x: 2 / 3, y: 0, width: 1 / 3, height: 1 },
			];
	}
}

export function slotNames(layout: LayoutName): string[] {
	return slotsFor(layout).map((slot) => slot.name);
}

/** Coarse anchor names, resolved to the same 0-1 pair anchorX/anchorY take. */
export const ANCHORS: Record<string, { x: number; y: number }> = {
	center: { x: 0.5, y: 0.5 },
	top: { x: 0.5, y: 0 },
	bottom: { x: 0.5, y: 1 },
	left: { x: 0, y: 0.5 },
	right: { x: 1, y: 0.5 },
	top_left: { x: 0, y: 0 },
	top_right: { x: 1, y: 0 },
	bottom_left: { x: 0, y: 1 },
	bottom_right: { x: 1, y: 1 },
};

export interface Placement {
	transform: Transform;
	crop: Crop;
}

/**
 * Places one source into one slot.
 *
 * `fill` crops the source to the slot's shape and keeps the transform equal to
 * the slot, so nothing stretches. `fit` shrinks the transform inside the slot
 * and leaves the source uncropped, which is what a screen recording needs.
 */
export function placeInSlot(
	slot: Slot,
	sourceAspect: number,
	canvasAspect: number,
	options: { fit?: LayoutFit; anchorX?: number; anchorY?: number } = {},
): Placement {
	const fit = options.fit ?? "fill";
	const anchorX = clamp01(options.anchorX ?? 0.5);
	const anchorY = clamp01(options.anchorY ?? 0.5);

	// The slot's aspect in real pixels, not in normalised units.
	const slotAspect = (slot.width * canvasAspect) / slot.height;

	if (fit === "fit") {
		// Letterbox: shrink the box until the whole source is inside the slot.
		const scale =
			sourceAspect > slotAspect
				? 1 // width-limited: already fits horizontally
				: sourceAspect / slotAspect;
		const width = slot.width * (sourceAspect > slotAspect ? 1 : scale);
		const height = slot.height * (sourceAspect > slotAspect ? slotAspect / sourceAspect : 1);
		return {
			transform: {
				centerX: slot.x + slot.width / 2,
				centerY: slot.y + slot.height / 2,
				width,
				height,
				rotation: 0,
				flipHorizontal: false,
				flipVertical: false,
			},
			crop: { top: 0, right: 0, bottom: 0, left: 0 },
		};
	}

	// Cover: the transform equals the slot, and the source is cropped to match.
	const crop = { top: 0, right: 0, bottom: 0, left: 0 };
	if (sourceAspect > slotAspect) {
		// Source is wider: trim the sides.
		const keep = slotAspect / sourceAspect;
		const trim = 1 - keep;
		crop.left = trim * anchorX;
		crop.right = trim * (1 - anchorX);
	} else if (sourceAspect < slotAspect) {
		// Source is taller: trim top and bottom.
		const keep = sourceAspect / slotAspect;
		const trim = 1 - keep;
		crop.top = trim * anchorY;
		crop.bottom = trim * (1 - anchorY);
	}

	return {
		transform: {
			centerX: slot.x + slot.width / 2,
			centerY: slot.y + slot.height / 2,
			width: slot.width,
			height: slot.height,
			rotation: 0,
			flipHorizontal: false,
			flipVertical: false,
		},
		crop,
	};
}
