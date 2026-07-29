import { describe, expect, it } from "vitest";

import { ZOOM_DEPTH_SCALES } from "@/components/video-editor/types";

import type { ZoomRegionModel } from "./model";
import { resolveCamera, scaleForDepth } from "./zoom";

const STAGE = { width: 1920, height: 1080 };

function region(overrides: Partial<ZoomRegionModel> = {}): ZoomRegionModel {
	return {
		id: "z1",
		startMs: 2000,
		endMs: 8000,
		depth: 3,
		focus: { cx: 0.5, cy: 0.5 },
		mode: "auto",
		...overrides,
	};
}

const camera = (regions: ZoomRegionModel[], atMs: number) =>
	resolveCamera(regions, atMs, STAGE.width, STAGE.height);

describe("scaleForDepth", () => {
	it("uses Recordly's depth table, not a copy of it", () => {
		for (const [depth, scale] of Object.entries(ZOOM_DEPTH_SCALES)) {
			expect(scaleForDepth(Number(depth))).toBe(scale);
		}
	});

	it("falls back to 1× for an unknown depth", () => {
		expect(scaleForDepth(99)).toBe(1);
	});
});

describe("resolveCamera", () => {
	it("is neutral with no regions", () => {
		const result = camera([], 3000);
		expect(result.scale).toBe(1);
		expect(result.region).toBeNull();
		expect(result.strength).toBe(0);
	});

	it("is neutral well before a region starts", () => {
		expect(camera([region()], 0).scale).toBe(1);
	});

	it("is neutral well after a region ends", () => {
		expect(camera([region()], 20_000).scale).toBe(1);
	});

	it("reaches the region's full depth scale mid-hold", () => {
		const result = camera([region({ depth: 3 })], 5000);
		expect(result.strength).toBe(1);
		expect(result.scale).toBeCloseTo(ZOOM_DEPTH_SCALES[3], 5);
	});

	it("eases in rather than snapping — mid-transition sits strictly between 1× and full", () => {
		const held = camera([region()], 5000).scale;
		const easing = camera([region()], 2300).scale;
		expect(easing).toBeGreaterThan(1);
		expect(easing).toBeLessThan(held);
	});

	it("eases back out before the region's end", () => {
		const held = camera([region()], 5000).scale;
		const easingOut = camera([region()], 7900).scale;
		expect(easingOut).toBeLessThan(held);
	});

	it("scales monotonically through the zoom-in ramp", () => {
		const samples = [2000, 2200, 2400, 2600, 2800, 3000].map(
			(ms) => camera([region()], ms).scale,
		);
		for (let index = 1; index < samples.length; index++) {
			expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1]);
		}
	});

	it("deeper regions zoom further at the same moment", () => {
		const shallow = camera([region({ depth: 1 })], 5000).scale;
		const deep = camera([region({ depth: 5 })], 5000).scale;
		expect(deep).toBeGreaterThan(shallow);
	});

	it("centres the stage on the resolved focus point when fully zoomed", () => {
		const result = camera([region({ focus: { cx: 0.25, cy: 0.75 } })], 5000);
		// The resolved focus must land on the stage centre after the transform.
		const projectedX = result.x + result.focus.cx * STAGE.width * result.scale;
		const projectedY = result.y + result.focus.cy * STAGE.height * result.scale;
		expect(projectedX).toBeCloseTo(STAGE.width / 2, 3);
		expect(projectedY).toBeCloseTo(STAGE.height / 2, 3);
	});

	it("pulls the focus in so the zoomed frame never shows past the footage edge", () => {
		// At depth 3 (1.8x) the camera can only travel to within 1/(2*1.8) of an edge.
		const limit = 1 / (2 * ZOOM_DEPTH_SCALES[3]);
		const topLeft = camera([region({ depth: 3, focus: { cx: 0, cy: 0 } })], 5000);
		expect(topLeft.focus.cx).toBeCloseTo(limit, 5);
		expect(topLeft.focus.cy).toBeCloseTo(limit, 5);

		const bottomRight = camera([region({ depth: 3, focus: { cx: 1, cy: 1 } })], 5000);
		expect(bottomRight.focus.cx).toBeCloseTo(1 - limit, 5);
		expect(bottomRight.focus.cy).toBeCloseTo(1 - limit, 5);
	});

	it("leaves a focus point that is already safely inside alone", () => {
		const focus = { cx: 0.5, cy: 0.5 };
		expect(camera([region({ focus })], 5000).focus).toEqual(focus);
	});

	it("reports the region that owns the moment", () => {
		const regions = [region({ id: "a" }), region({ id: "b", startMs: 12_000, endMs: 18_000 })];
		expect(camera(regions, 5000).region?.id).toBe("a");
		expect(camera(regions, 15_000).region?.id).toBe("b");
	});

	it("lets a deeper zoom travel closer to the edge, since its window is smaller", () => {
		const shallow = camera([region({ depth: 1, focus: { cx: 0, cy: 0.5 } })], 5000);
		const deep = camera([region({ depth: 6, focus: { cx: 0, cy: 0.5 } })], 5000);
		expect(deep.focus.cx).toBeLessThan(shallow.focus.cx);
		// Each is exactly half its own visible window in from the edge.
		expect(shallow.focus.cx).toBeCloseTo(1 / (2 * ZOOM_DEPTH_SCALES[1]), 5);
		expect(deep.focus.cx).toBeCloseTo(1 / (2 * ZOOM_DEPTH_SCALES[6]), 5);
	});

	it("stays neutral on a zero-sized stage instead of dividing by zero", () => {
		const result = resolveCamera([region()], 5000, 0, 0);
		expect(result.scale).toBe(1);
		expect(Number.isFinite(result.x)).toBe(true);
	});

	it("produces finite offsets for extreme focus points", () => {
		for (const focus of [
			{ cx: 0, cy: 0 },
			{ cx: 1, cy: 1 },
		]) {
			const result = camera([region({ focus })], 5000);
			expect(Number.isFinite(result.x)).toBe(true);
			expect(Number.isFinite(result.y)).toBe(true);
		}
	});
});
