// Cutting a take's zooms.
//
// The bug these exist to prevent: a recording of somebody working through an
// app arriving with one zoom in it, or none. That happened twice for two
// different reasons — the generator discarded every dwell and kept only clicks,
// and before that the capture recorded nothing at all while the pointer was
// still, so there were no dwells to discard. Both are covered here.

import { describe, expect, it } from "vitest";

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { autoZoomRegions } from "./autoZoom";

/** Telemetry shaped like the capture writes it: a fixed-rate sample stream. */
function take(options: {
	totalMs: number;
	/** [startMs, endMs, cx, cy] spans where the pointer rests. */
	parks?: Array<[number, number, number, number]>;
	clicksAt?: Array<[number, number, number]>;
	intervalMs?: number;
}): CursorTelemetryPoint[] {
	const { totalMs, parks = [], clicksAt = [], intervalMs = 80 } = options;
	const points: CursorTelemetryPoint[] = [];
	for (let t = 0; t <= totalMs; t += intervalMs) {
		const park = parks.find(([from, to]) => t >= from && t <= to);
		points.push({
			timeMs: t,
			cx: park ? park[2] : 0.2 + 0.6 * Math.abs(Math.sin(t / 900)),
			cy: park ? park[3] : 0.3 + 0.4 * Math.abs(Math.cos(t / 1100)),
			interactionType: "move",
		});
	}
	for (const [timeMs, cx, cy] of clicksAt) {
		points.push({ timeMs, cx, cy, interactionType: "click" });
	}
	return points.sort((a, b) => a.timeMs - b.timeMs);
}

describe("autoZoomRegions", () => {
	it("cuts a zoom for each place the pointer rests", () => {
		// The case that was broken: no clicks at all, just someone reading three
		// things in turn. This has to produce three zooms, not zero.
		const regions = autoZoomRegions(
			take({
				totalMs: 14000,
				parks: [
					[1000, 2600, 0.25, 0.3],
					[5000, 7000, 0.7, 0.55],
					[9500, 11500, 0.45, 0.8],
				],
			}),
			{ totalMs: 14000 },
		);

		expect(regions).toHaveLength(3);
		expect(regions.every((region) => region.reason === "dwell")).toBe(true);
		// Each lands on what was being looked at, not the middle of the screen.
		expect(regions[0].focus.cx).toBeCloseTo(0.25, 1);
		expect(regions[1].focus.cx).toBeCloseTo(0.7, 1);
		expect(regions[2].focus.cy).toBeCloseTo(0.8, 1);
	});

	it("keeps the regions in order and never overlapping", () => {
		const regions = autoZoomRegions(
			take({
				totalMs: 20000,
				parks: [
					[1000, 2200, 0.3, 0.3],
					[4000, 5400, 0.6, 0.4],
					[8000, 9600, 0.4, 0.7],
					[13000, 15000, 0.75, 0.25],
				],
			}),
			{ totalMs: 20000 },
		);

		expect(regions.length).toBeGreaterThanOrEqual(3);
		for (let i = 1; i < regions.length; i++) {
			// Overlapping regions fight over the camera and the later one wins
			// silently, which reads as a zoom that never released.
			expect(regions[i].startMs).toBeGreaterThanOrEqual(regions[i - 1].endMs);
		}
	});

	it("zooms on clicks too, and marks which is which", () => {
		const regions = autoZoomRegions(
			take({
				totalMs: 12000,
				parks: [[1000, 2600, 0.25, 0.3]],
				clicksAt: [[7000, 0.8, 0.6]],
			}),
			{ totalMs: 12000 },
		);

		expect(regions.map((region) => region.reason)).toContain("dwell");
		expect(regions.map((region) => region.reason)).toContain("click");
	});

	it("never proposes over a region that already exists", () => {
		const reserved = [{ start: 800, end: 3500 }];
		const regions = autoZoomRegions(
			take({
				totalMs: 14000,
				parks: [
					[1000, 2600, 0.25, 0.3],
					[5000, 7000, 0.7, 0.55],
				],
			}),
			{ totalMs: 14000, reserved },
		);

		for (const region of regions) {
			expect(region.startMs >= 3500 || region.endMs <= 800).toBe(true);
		}
	});

	it("honours the cap", () => {
		const parks: Array<[number, number, number, number]> = [];
		for (let i = 0; i < 12; i++) {
			parks.push([i * 3000 + 500, i * 3000 + 2000, 0.2 + (i % 5) * 0.15, 0.3]);
		}
		const regions = autoZoomRegions(take({ totalMs: 40000, parks }), {
			totalMs: 40000,
			max: 4,
		});
		expect(regions).toHaveLength(4);
	});

	it("returns nothing rather than guessing when there is no telemetry", () => {
		expect(autoZoomRegions([], { totalMs: 10000 })).toEqual([]);
	});

	it("returns nothing for a pointer that never settles", () => {
		// Constant fast movement is not a sequence of moments worth zooming to,
		// and inventing regions for it would punch in on nothing.
		const points: CursorTelemetryPoint[] = [];
		for (let t = 0; t <= 10000; t += 80) {
			points.push({
				timeMs: t,
				cx: 0.5 + 0.45 * Math.sin(t / 90),
				cy: 0.5 + 0.45 * Math.cos(t / 70),
				interactionType: "move",
			});
		}
		expect(autoZoomRegions(points, { totalMs: 10000 })).toEqual([]);
	});

	it("stays inside the take", () => {
		const regions = autoZoomRegions(take({ totalMs: 6000, parks: [[4200, 5900, 0.6, 0.5]] }), {
			totalMs: 6000,
		});
		for (const region of regions) {
			expect(region.startMs).toBeGreaterThanOrEqual(0);
			expect(region.endMs).toBeLessThanOrEqual(6000);
		}
	});
});
