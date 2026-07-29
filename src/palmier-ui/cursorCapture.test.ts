// @vitest-environment jsdom
//
// Cursor telemetry capture.
//
// This is the input to suggest_zooms, so what it drops matters as much as what
// it keeps: moves are thinned to keep the file small, clicks never are, because
// a click is the entire signal a zoom is cut from.

import { afterEach, describe, expect, it, vi } from "vitest";

import { startCursorCapture } from "./cursorCapture";

/** Dispatches a pointer event at a point in the (jsdom) window. */
function pointer(type: string, x: number, y: number, button = 0) {
	window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button, bubbles: true }));
}

afterEach(() => {
	(window as { electronAPI?: unknown }).electronAPI = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("startCursorCapture", () => {
	it("normalises positions to 0–1 of the window", () => {
		Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
		const capture = startCursorCapture();
		pointer("pointerdown", 250, 100);
		return capture.stop().then((points) => {
			expect(points[0].cx).toBeCloseTo(0.25, 5);
			expect(points[0].cy).toBeCloseTo(0.2, 5);
		});
	});

	it("clamps a pointer dragged outside the window", () => {
		Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
		const capture = startCursorCapture();
		pointer("pointerdown", -50, 900);
		return capture.stop().then((points) => {
			expect(points[0].cx).toBe(0);
			expect(points[0].cy).toBe(1);
		});
	});

	it("keeps every click, however fast they arrive", async () => {
		const capture = startCursorCapture();
		// Four clicks inside one sampling interval. Thinning these would lose
		// exactly the events suggest_zooms cuts regions from.
		for (let i = 0; i < 4; i++) pointer("pointerdown", 10 * i, 10 * i);
		const points = await capture.stop();
		const clicks = points.filter((point) => point.interactionType === "click");
		expect(clicks).toHaveLength(4);
	});

	it("distinguishes a right-click", async () => {
		const capture = startCursorCapture();
		pointer("pointerdown", 5, 5, 2);
		const points = await capture.stop();
		expect(points[0].interactionType).toBe("right-click");
	});

	it("thins moves rather than recording every one", async () => {
		const capture = startCursorCapture();
		// Twenty moves with no time between them: the sampling interval should
		// keep the first and drop the rest.
		for (let i = 0; i < 20; i++) pointer("pointermove", i, i);
		const points = await capture.stop();
		expect(points.filter((point) => point.interactionType === "move").length).toBeLessThan(20);
	});

	it("returns points sorted by time", async () => {
		const capture = startCursorCapture();
		pointer("pointerdown", 1, 1);
		pointer("pointerup", 2, 2);
		pointer("pointerdown", 3, 3);
		const points = await capture.stop();
		const times = points.map((point) => point.timeMs);
		expect([...times].sort((a, b) => a - b)).toEqual(times);
	});

	it("stops listening once stopped", async () => {
		const capture = startCursorCapture();
		pointer("pointerdown", 1, 1);
		const points = await capture.stop();
		pointer("pointerdown", 2, 2);
		const after = await capture.stop();
		expect(after.length).toBe(points.length);
	});

	it("reports window-only coverage in a browser, and none when nothing moved", async () => {
		// Coverage is what stops the app claiming it watched the whole desktop
		// when it only ever saw its own window.
		const quiet = startCursorCapture();
		expect(quiet.coverage()).toBe("none");
		await quiet.stop();

		const busy = startCursorCapture();
		pointer("pointerdown", 1, 1);
		expect(busy.coverage()).toBe("window-only");
		await busy.stop();
	});

	it("prefers the native desktop hook when the bridge offers one", async () => {
		const samples = [{ timeMs: 5, cx: 0.5, cy: 0.5, interactionType: "click" }];
		(window as { electronAPI?: unknown }).electronAPI = {
			setRecordingState: vi.fn().mockResolvedValue(undefined),
			getPendingCursorTelemetry: vi.fn().mockResolvedValue({ samples }),
		};
		const capture = startCursorCapture();
		expect(capture.coverage()).toBe("desktop");
		// The window also saw this one; the native samples must still win, because
		// merging two clocks that started microseconds apart is worse than picking.
		pointer("pointerdown", 900, 900);
		expect(await capture.stop()).toEqual(samples);
	});

	it("falls back to what the window saw when the native hook fails", async () => {
		(window as { electronAPI?: unknown }).electronAPI = {
			setRecordingState: vi.fn().mockResolvedValue(undefined),
			getPendingCursorTelemetry: vi.fn().mockRejectedValue(new Error("hook died")),
		};
		const capture = startCursorCapture();
		pointer("pointerdown", 100, 100);
		const points = await capture.stop();
		// A dead hook costs the desktop coverage, not the whole recording.
		expect(points.length).toBeGreaterThan(0);
	});
});
