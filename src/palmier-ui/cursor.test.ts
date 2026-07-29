import { describe, expect, it } from "vitest";

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { CURSOR_STYLES, cursorPath, DEFAULT_CURSOR, resolveCursor } from "./cursor";

/** A straight left-to-right drag, sampled every 20ms. */
function travel(): CursorTelemetryPoint[] {
	return Array.from({ length: 51 }, (_, index) => ({
		timeMs: index * 20,
		cx: index / 50,
		cy: 0.5,
		interactionType: "move" as const,
	}));
}

const settings = (extra: Partial<typeof DEFAULT_CURSOR> = {}) => ({ ...DEFAULT_CURSOR, ...extra });

describe("resolveCursor", () => {
	it("draws nothing when the cursor is turned off", () => {
		expect(resolveCursor(travel(), 500, settings({ show: false }))).toBeNull();
	});

	it("draws nothing when the take carries no telemetry", () => {
		expect(resolveCursor([], 500, settings())).toBeNull();
	});

	it("follows the recorded path", () => {
		const early = resolveCursor(travel(), 200, settings({ smoothing: 0 }));
		const late = resolveCursor(travel(), 800, settings({ smoothing: 0 }));
		expect(early?.cx ?? 1).toBeLessThan(late?.cx ?? 0);
	});

	it("interpolates between samples rather than stepping", () => {
		const between = resolveCursor(travel(), 30, settings({ smoothing: 0, sway: 0 }));
		// Halfway between the samples at 20ms (0.02) and 40ms (0.04).
		expect(between?.cx).toBeCloseTo(0.03, 3);
	});

	it("lags behind the raw samples when smoothed", () => {
		const raw = resolveCursor(travel(), 500, settings({ smoothing: 0, sway: 0 }));
		const smoothed = resolveCursor(travel(), 500, settings({ smoothing: 1, sway: 0 }));
		expect(smoothed?.cx ?? 1).toBeLessThan(raw?.cx ?? 0);
	});

	it("holds at the ends rather than flying off", () => {
		// Smoothing off: with it on the drawn pointer deliberately trails the
		// samples, so it is still short of the end at the end.
		const flat = settings({ smoothing: 0, sway: 0 });
		expect(resolveCursor(travel(), 0, flat)?.cx).toBeCloseTo(0, 2);
		expect(resolveCursor(travel(), 1000, flat)?.cx).toBeCloseTo(1, 2);
	});

	it("still trails at the end when smoothing is on, which is the point of it", () => {
		const smoothed = resolveCursor(travel(), 1000, settings({ sway: 0 }));
		expect(smoothed?.cx ?? 1).toBeLessThan(1);
		expect(smoothed?.cx ?? 0).toBeGreaterThan(0.85);
	});

	it("stops drawing past the end of the telemetry", () => {
		expect(resolveCursor(travel(), 9000, settings())).toBeNull();
	});

	it("replays from the start when looping", () => {
		const looped = resolveCursor(travel(), 1000 + 200, settings({ loop: true, smoothing: 0 }));
		const original = resolveCursor(travel(), 200, settings({ loop: true, smoothing: 0 }));
		expect(looped?.cx).toBeCloseTo(original?.cx ?? -1, 3);
	});

	it("scales by the size setting", () => {
		expect(resolveCursor(travel(), 500, settings({ size: 3 }))?.scale).toBeCloseTo(3, 3);
	});

	it("pops on a click and settles back", () => {
		const clicked: CursorTelemetryPoint[] = [
			...travel(),
			{ timeMs: 500, cx: 0.5, cy: 0.5, interactionType: "click" },
		].sort((a, b) => a.timeMs - b.timeMs);

		const base = settings({ clickBounce: 400, bounceSpeed: 300 });
		const atClick = resolveCursor(clicked, 500, base);
		const midBounce = resolveCursor(clicked, 640, base);
		const afterBounce = resolveCursor(clicked, 900, base);

		// The pop rises after the click and is gone once the bounce ends.
		expect(midBounce?.scale ?? 0).toBeGreaterThan(atClick?.scale ?? 0);
		expect(afterBounce?.scale).toBeCloseTo(base.size, 3);
	});

	it("never bounces when the bounce is turned off", () => {
		const clicked: CursorTelemetryPoint[] = [
			...travel(),
			{ timeMs: 500, cx: 0.5, cy: 0.5, interactionType: "click" },
		].sort((a, b) => a.timeMs - b.timeMs);
		const flat = settings({ clickBounce: 0 });
		expect(resolveCursor(clicked, 560, flat)?.scale).toBeCloseTo(flat.size, 5);
	});

	it("blurs in proportion to speed and to the setting", () => {
		const moving = resolveCursor(travel(), 500, settings({ motionBlur: 1 }));
		const still = resolveCursor(
			[
				{ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" },
				{ timeMs: 1000, cx: 0.5, cy: 0.5, interactionType: "move" },
			],
			500,
			settings({ motionBlur: 1 }),
		);
		expect(moving?.blur ?? 0).toBeGreaterThan(0);
		expect(still?.blur).toBe(0);
		expect(resolveCursor(travel(), 500, settings({ motionBlur: 0 }))?.blur).toBe(0);
	});

	it("never leaves the frame, however much it sways", () => {
		for (let t = 0; t <= 1000; t += 25) {
			const frame = resolveCursor(travel(), t, settings({ sway: 1 }));
			if (!frame) continue;
			expect(frame.cx).toBeGreaterThanOrEqual(0);
			expect(frame.cx).toBeLessThanOrEqual(1);
			expect(frame.cy).toBeGreaterThanOrEqual(0);
			expect(frame.cy).toBeLessThanOrEqual(1);
		}
	});

	it("holds a still cursor perfectly still, whatever the sway", () => {
		const parked: CursorTelemetryPoint[] = [
			{ timeMs: 0, cx: 0.25, cy: 0.75, interactionType: "move" },
			{ timeMs: 1000, cx: 0.25, cy: 0.75, interactionType: "move" },
		];
		const frame = resolveCursor(parked, 500, settings({ sway: 1 }));
		expect(frame?.cx).toBeCloseTo(0.25, 6);
		expect(frame?.cy).toBeCloseTo(0.75, 6);
	});
});

describe("cursorPath", () => {
	it("gives every offered style a drawable shape", () => {
		for (const style of CURSOR_STYLES) {
			const path = cursorPath(style.id);
			expect(path.length, style.id).toBeGreaterThan(10);
			expect(path.startsWith("M"), style.id).toBe(true);
		}
	});
});

describe("DEFAULT_CURSOR", () => {
	it("matches Recordly's own preset values", () => {
		// These are the numbers Recordly's Focused and Smooth presets share, so a
		// take feels the same in both apps. Changing one is a product decision.
		expect(DEFAULT_CURSOR.size).toBe(2.5);
		expect(DEFAULT_CURSOR.smoothing).toBe(0.67);
		// Recordly's cursor renderer ships motionBlur at 0. The 0.4 that used to
		// be here came from its *preset* table, not from what the renderer
		// actually defaults to — and a blurred pointer reads as a rendering
		// fault rather than as motion, so it is opt-in.
		expect(DEFAULT_CURSOR.motionBlur).toBe(0);
		expect(DEFAULT_CURSOR.clickBounce).toBe(3.5);
		expect(DEFAULT_CURSOR.bounceSpeed).toBe(350);
	});
});
