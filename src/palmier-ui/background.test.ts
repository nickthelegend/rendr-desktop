import { describe, expect, it } from "vitest";

import {
	type BackgroundSettings,
	backgroundCss,
	DEFAULT_BACKGROUND,
	footageBox,
	hasBackground,
	shadowFor,
} from "./background";

const settings = (over: Partial<BackgroundSettings> = {}): BackgroundSettings => ({
	...DEFAULT_BACKGROUND,
	...over,
});

describe("footageBox", () => {
	it("fills the frame when there is no padding", () => {
		const box = footageBox(settings({ padding: 0 }), 1920, 1080);
		expect(box).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
	});

	it("insets equally on all four sides in real pixels", () => {
		// 6% of the short edge (1080) is 64.8px — the same margin left/right as
		// top/bottom, which is the point of measuring off the short edge.
		const box = footageBox(settings({ padding: 0.06 }), 1920, 1080);
		expect(box.x * 1920).toBeCloseTo(64.8, 3);
		expect(box.y * 1080).toBeCloseTo(64.8, 3);
		expect(box.width * 1920).toBeCloseTo(1920 - 64.8 * 2, 3);
		expect(box.height * 1080).toBeCloseTo(1080 - 64.8 * 2, 3);
	});

	it("gives a vertical project the same visual margin as a wide one", () => {
		const wide = footageBox(settings({ padding: 0.06 }), 1920, 1080);
		const tall = footageBox(settings({ padding: 0.06 }), 1080, 1920);
		// Same pixel inset in both, rather than one getting a thin band.
		expect(wide.x * 1920).toBeCloseTo(tall.y * 1920, 3);
	});

	it("clamps padding so the footage can never invert", () => {
		const box = footageBox(settings({ padding: 5 }), 1920, 1080);
		expect(box.width).toBeGreaterThan(0);
		expect(box.height).toBeGreaterThan(0);
	});

	it("scales the corner radius with the inset footage, not the canvas", () => {
		const none = footageBox(settings({ padding: 0, radius: 1 }), 1920, 1080);
		const padded = footageBox(settings({ padding: 0.2, radius: 1 }), 1920, 1080);
		// More padding means smaller footage, so the same radius setting is a
		// smaller number of pixels — the corner stays proportional.
		expect(padded.radiusPx).toBeLessThan(none.radiusPx);
		expect(footageBox(settings({ radius: 0 }), 1920, 1080).radiusPx).toBe(0);
	});
});

describe("shadowFor", () => {
	it("is absent at zero rather than a shadow of nothing", () => {
		expect(shadowFor(settings({ shadow: 0 }), 1080)).toBeNull();
	});

	it("scales with the canvas so a 720p and a 4K export match", () => {
		const at1080 = shadowFor(settings({ shadow: 1 }), 1080);
		const at2160 = shadowFor(settings({ shadow: 1 }), 2160);
		expect(at2160?.blur).toBeCloseTo((at1080?.blur ?? 0) * 2, 5);
		expect(at2160?.offsetY).toBeCloseTo((at1080?.offsetY ?? 0) * 2, 5);
		// Opacity is not a length, so it must not scale.
		expect(at2160?.alpha).toBeCloseTo(at1080?.alpha ?? 0, 5);
	});
});

describe("hasBackground", () => {
	it("is false for nothing at all", () => {
		expect(hasBackground(undefined)).toBe(false);
		expect(hasBackground(settings({ kind: "none", padding: 0, shadow: 0 }))).toBe(false);
	});

	it("counts padding on its own as a background", () => {
		// Inset footage over black is still a different frame.
		expect(hasBackground(settings({ kind: "none", padding: 0.06, shadow: 0 }))).toBe(true);
	});
});

describe("backgroundCss", () => {
	it("writes a gradient the way CSS reads angles", () => {
		expect(backgroundCss(settings({ kind: "gradient" }))).toBe(
			"linear-gradient(135deg, #3B5BFD, #B14CF0)",
		);
	});

	it("falls back to the colour when an image backdrop has no image yet", () => {
		expect(backgroundCss(settings({ kind: "image", imageUrl: undefined }))).toBe("#101014");
	});

	it("covers, rather than stretching, a custom image", () => {
		const css = backgroundCss(settings({ kind: "image", imageUrl: "blob:x" }));
		expect(css).toContain("cover");
		expect(css).toContain("blob:x");
	});
});
