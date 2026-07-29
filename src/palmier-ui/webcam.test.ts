import { describe, expect, it } from "vitest";

import { DEFAULT_WEBCAM, type WebcamSettings, webcamBox, webcamSourceRect } from "./webcam";

const on = (extra: Partial<WebcamSettings> = {}): WebcamSettings => ({
	...DEFAULT_WEBCAM,
	show: true,
	...extra,
});

const WIDE = 16 / 9;

describe("webcamBox", () => {
	it("draws nothing when the inset is off", () => {
		expect(webcamBox(DEFAULT_WEBCAM, WIDE)).toBeNull();
	});

	it("stays inside the frame in every position", () => {
		for (const position of [
			"top-left",
			"top",
			"top-right",
			"left",
			"center",
			"right",
			"bottom-left",
			"bottom",
			"bottom-right",
		] as const) {
			const box = webcamBox(on({ position }), WIDE);
			if (!box) throw new Error("expected a box");
			expect(box.x, position).toBeGreaterThanOrEqual(0);
			expect(box.y, position).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width, position).toBeLessThanOrEqual(1.0001);
			expect(box.y + box.height, position).toBeLessThanOrEqual(1.0001);
		}
	});

	it("puts each corner where its name says", () => {
		const topLeft = webcamBox(on({ position: "top-left" }), WIDE);
		const bottomRight = webcamBox(on({ position: "bottom-right" }), WIDE);
		expect(topLeft?.x).toBeLessThan(0.1);
		expect(topLeft?.y).toBeLessThan(0.1);
		expect((bottomRight?.x ?? 0) + (bottomRight?.width ?? 0)).toBeGreaterThan(0.9);
		expect((bottomRight?.y ?? 0) + (bottomRight?.height ?? 0)).toBeGreaterThan(0.9);
	});

	it("centres the centre cell", () => {
		const box = webcamBox(on({ position: "center" }), WIDE);
		if (!box) throw new Error("expected a box");
		expect(box.x + box.width / 2).toBeCloseTo(0.5, 5);
		expect(box.y + box.height / 2).toBeCloseTo(0.5, 5);
	});

	it("is the same physical size in a vertical project as a wide one", () => {
		// Sizing off the width would make a 9:16 project's bubble enormous.
		const wide = webcamBox(on(), WIDE);
		const tall = webcamBox(on(), 9 / 16);
		expect(wide?.height).toBeCloseTo(tall?.height ?? 0, 6);
	});

	it("grows during a punch-in only when asked to", () => {
		const reactive = webcamBox(on({ reactsToZoom: true }), WIDE, 3);
		const fixed = webcamBox(on({ reactsToZoom: false }), WIDE, 3);
		const resting = webcamBox(on({ reactsToZoom: true }), WIDE, 1);
		expect(reactive?.height ?? 0).toBeGreaterThan(resting?.height ?? 0);
		expect(fixed?.height).toBeCloseTo(resting?.height ?? 0, 6);
	});

	it("never grows to swallow the frame", () => {
		const box = webcamBox(on({ size: 1 }), WIDE, 10);
		expect(box?.height ?? 1).toBeLessThanOrEqual(1);
	});

	it("gives each shape its own corner radius", () => {
		expect(webcamBox(on({ shape: "circle" }), WIDE)?.radius).toBe(0.5);
		expect(webcamBox(on({ shape: "square" }), WIDE)?.radius).toBe(0);
		expect(webcamBox(on({ shape: "rounded" }), WIDE)?.radius).toBeGreaterThan(0);
	});
});

describe("webcamSourceRect", () => {
	it("covers the bubble without stretching", () => {
		// A 16:9 camera into a 1:1 bubble loses its sides, not its shape.
		const rect = webcamSourceRect(on(), 1920, 1080, 1);
		if (!rect) throw new Error("expected a rect");
		expect(rect.sw / rect.sh).toBeCloseTo(1, 5);
		expect(rect.sw).toBeLessThan(1920);
		expect(rect.sh).toBe(1080);
	});

	it("centres what it keeps", () => {
		const rect = webcamSourceRect(on(), 1920, 1080, 1);
		if (!rect) throw new Error("expected a rect");
		expect(rect.sx + rect.sw / 2).toBeCloseTo(960, 3);
	});

	it("applies the crop before covering", () => {
		const cropped = webcamSourceRect(
			on({ crop: { top: 0, right: 0.25, bottom: 0, left: 0.25 } }),
			1920,
			1080,
			1,
		);
		if (!cropped) throw new Error("expected a rect");
		// Only the middle half of the width was on offer to begin with.
		expect(cropped.sx).toBeGreaterThanOrEqual(480);
		expect(cropped.sx + cropped.sw).toBeLessThanOrEqual(1440.001);
	});

	it("never returns an empty rect, however extreme the crop", () => {
		const rect = webcamSourceRect(
			on({ crop: { top: 0.9, right: 0.9, bottom: 0.9, left: 0.9 } }),
			1920,
			1080,
			1,
		);
		expect(rect?.sw ?? 0).toBeGreaterThan(0);
		expect(rect?.sh ?? 0).toBeGreaterThan(0);
	});

	it("returns nothing for a camera with no frame yet", () => {
		expect(webcamSourceRect(on(), 0, 0, 1)).toBeNull();
	});
});
