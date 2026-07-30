// Trimming the fumble at each end of a take.
//
// You hit record, then reach for the browser; at the end you reach back for the
// stop button. Measured from the cursor, not from audio: a screen recording
// often has no audio at all, and a still pointer is what "nothing is happening"
// actually looks like on a screen.

import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { detectDeadAir } from "./autoZoom";

/**
 * Still until `fromMs`, moving until `toMs`, still after.
 *
 * The moving section sweeps back and forth at a realistic rate — a hand crosses
 * a screen in a second or two, not in ten. Motion an order of magnitude slower
 * than that is indistinguishable from a resting hand by any measure, which is
 * the thing the detector has to separate.
 */
function take(fromMs: number, toMs: number, totalMs = 20000): CursorTelemetryPoint[] {
	const points: CursorTelemetryPoint[] = [];
	for (let t = 0; t <= totalMs; t += 50) {
		const moving = t >= fromMs && t <= toMs;
		points.push({
			timeMs: t,
			cx: moving ? 0.5 + Math.sin((t - fromMs) / 400) * 0.3 : t < fromMs ? 0.2 : 0.7,
			cy: 0.5,
			interactionType: "move",
		});
	}
	return points;
}

describe("finding dead air", () => {
	it("finds the fumble at the head", () => {
		const dead = detectDeadAir(take(4000, 15000), 20000);
		// Confirmation needs half a second of travel, so detection lags the
		// first movement by up to the window.
		expect(dead.firstActivityMs).toBeGreaterThanOrEqual(4000);
		expect(dead.firstActivityMs).toBeLessThanOrEqual(4600);
		expect(dead.headMs).toBeGreaterThan(3000);
	});

	it("finds the reach for the stop button", () => {
		const dead = detectDeadAir(take(4000, 15000), 20000);
		expect(dead.lastActivityMs).toBeGreaterThan(14000);
		expect(dead.tailMs).toBeGreaterThan(3000);
	});

	it("leaves a beat either side rather than cutting to the exact frame", () => {
		// Cutting to the first movement lands the viewer mid-gesture.
		const dead = detectDeadAir(take(4000, 15000), 20000);
		expect(dead.headMs).toBeLessThan(dead.firstActivityMs);
		expect(dead.firstActivityMs - dead.headMs).toBeCloseTo(250, -1);
	});

	it("counts a click as activity even with no movement", () => {
		const points: CursorTelemetryPoint[] = [];
		for (let t = 0; t <= 10000; t += 50) {
			points.push({
				timeMs: t,
				cx: 0.5,
				cy: 0.5,
				interactionType: t === 3000 ? "click" : "move",
			});
		}
		expect(detectDeadAir(points, 10000).firstActivityMs).toBe(3000);
	});

	it("ignores a hand resting on a trackpad", () => {
		// Sub-threshold drift is not activity; treating it as such would trim
		// nothing on a take that begins with somebody's palm on the pad.
		const points: CursorTelemetryPoint[] = [];
		for (let t = 0; t <= 10000; t += 50) {
			const drifting = t < 5000;
			points.push({
				timeMs: t,
				cx: drifting
					? 0.5 + Math.sin(t / 400) * 0.002
					: 0.5 + Math.sin((t - 5000) / 400) * 0.3,
				cy: 0.5,
				interactionType: "move",
			});
		}
		expect(detectDeadAir(points, 10000).firstActivityMs).toBeGreaterThan(4000);
	});

	it("trims nothing when the take starts and ends busy", () => {
		const dead = detectDeadAir(take(0, 20000), 20000);
		expect(dead.headMs).toBe(0);
		expect(dead.tailMs).toBe(0);
	});

	it("trims nothing from a take where nothing ever happens", () => {
		// A dead take is not a take with dead air; there is nothing to keep.
		const still: CursorTelemetryPoint[] = Array.from({ length: 100 }, (_, i) => ({
			timeMs: i * 100,
			cx: 0.5,
			cy: 0.5,
			interactionType: "move",
		}));
		const dead = detectDeadAir(still, 10000);
		expect(dead.headMs).toBe(0);
		expect(dead.tailMs).toBe(0);
	});

	it("handles no telemetry at all", () => {
		expect(detectDeadAir([], 10000).headMs).toBe(0);
	});
});
