import { describe, expect, it } from "vitest";

import { ANCHORS, placeInSlot, slotNames, slotsFor } from "./layout";

const WIDE = 16 / 9;

describe("slotsFor", () => {
	it("names grid cells from the top-left, row-major", () => {
		expect(slotNames("grid_3x3")).toEqual([
			"r1c1",
			"r1c2",
			"r1c3",
			"r2c1",
			"r2c2",
			"r2c3",
			"r3c1",
			"r3c2",
			"r3c3",
		]);
		const topLeft = slotsFor("grid_3x3")[0];
		expect([topLeft.x, topLeft.y]).toEqual([0, 0]);
	});

	it("tiles every layout without gaps or overlap in total area", () => {
		for (const layout of [
			"side_by_side",
			"top_bottom",
			"grid_2x2",
			"three_up",
			"main_sidebar",
		] as const) {
			const area = slotsFor(layout).reduce((sum, slot) => sum + slot.width * slot.height, 0);
			expect(area).toBeCloseTo(1, 6);
		}
	});

	it("puts the PIP inset in the corner its name promises, on top", () => {
		const inset = slotsFor("pip_bottom_right").find((slot) => slot.name === "inset");
		expect(inset?.onTop).toBe(true);
		// Bottom-right means its far edges sit near 1, not near 0.
		expect((inset?.x ?? 0) + (inset?.width ?? 0)).toBeGreaterThan(0.9);
		expect((inset?.y ?? 0) + (inset?.height ?? 0)).toBeGreaterThan(0.9);

		const topLeft = slotsFor("pip_top_left").find((slot) => slot.name === "inset");
		expect(topLeft?.x).toBeLessThan(0.1);
		expect(topLeft?.y).toBeLessThan(0.1);
	});
});

describe("placeInSlot — fill", () => {
	it("gives the clip the whole slot and crops the source instead of stretching", () => {
		const [left] = slotsFor("side_by_side");
		const { transform, crop } = placeInSlot(left, WIDE, WIDE);

		expect(transform.width).toBeCloseTo(0.5, 6);
		expect(transform.height).toBeCloseTo(1, 6);
		expect(transform.centerX).toBeCloseTo(0.25, 6);
		// A 16:9 source in a half-width, full-height slot has to lose its sides.
		expect(crop.left + crop.right).toBeGreaterThan(0);
		expect(crop.top + crop.bottom).toBe(0);
	});

	it("centers the crop by default and splits it evenly", () => {
		const [left] = slotsFor("side_by_side");
		const { crop } = placeInSlot(left, WIDE, WIDE);
		expect(crop.left).toBeCloseTo(crop.right, 6);
	});

	it("keeps the top when anchored there", () => {
		const [top] = slotsFor("top_bottom");
		// A 9:16 source in a full-width, half-height slot loses top and bottom.
		const centered = placeInSlot(top, 9 / 16, WIDE);
		const anchored = placeInSlot(top, 9 / 16, WIDE, { anchorY: ANCHORS.top.y });

		expect(centered.crop.top).toBeGreaterThan(0);
		expect(anchored.crop.top).toBe(0);
		expect(anchored.crop.bottom).toBeCloseTo(centered.crop.top + centered.crop.bottom, 6);
	});

	it("crops nothing when the source already matches the slot's shape", () => {
		const [full] = slotsFor("full");
		const { crop } = placeInSlot(full, WIDE, WIDE);
		expect(crop).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
	});

	it("leaves what survives proportional to the shape mismatch", () => {
		const [left] = slotsFor("side_by_side");
		// Slot is 0.5 × 1 of a 16:9 canvas → 8:9. A 16:9 source keeps half its width.
		const { crop } = placeInSlot(left, WIDE, WIDE);
		expect(1 - crop.left - crop.right).toBeCloseTo(0.5, 6);
	});
});

describe("placeInSlot — fit", () => {
	it("letterboxes inside the slot and never crops", () => {
		const [left] = slotsFor("side_by_side");
		const { transform, crop } = placeInSlot(left, WIDE, WIDE, { fit: "fit" });

		expect(crop).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
		// A wide source in a tall slot must shrink vertically, not fill it.
		expect(transform.width).toBeCloseTo(0.5, 6);
		expect(transform.height).toBeLessThan(1);
		expect(transform.centerX).toBeCloseTo(0.25, 6);
		expect(transform.centerY).toBeCloseTo(0.5, 6);
	});

	it("stays inside the slot on both axes for either mismatch direction", () => {
		const [top] = slotsFor("top_bottom");
		for (const sourceAspect of [WIDE, 1, 9 / 16, 2.4]) {
			const { transform } = placeInSlot(top, sourceAspect, WIDE, { fit: "fit" });
			expect(transform.width).toBeLessThanOrEqual(top.width + 1e-9);
			expect(transform.height).toBeLessThanOrEqual(top.height + 1e-9);
		}
	});

	it("preserves the source's aspect ratio in the placed box", () => {
		const [main] = slotsFor("main_sidebar");
		const canvasAspect = WIDE;
		const sourceAspect = 4 / 3;
		const { transform } = placeInSlot(main, sourceAspect, canvasAspect, { fit: "fit" });
		// Normalised width maps back to pixels through the canvas aspect.
		const placedAspect = (transform.width * canvasAspect) / transform.height;
		expect(placedAspect).toBeCloseTo(sourceAspect, 6);
	});
});
