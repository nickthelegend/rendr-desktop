// The agent contract's pure edges.
//
// Most of agentTools.ts needs a live editor, but two pieces carry the contract
// on their own: `describeClip` is what every read tool returns, and
// `parseHueCurves` is the validator standing between an agent's arbitrary JSON
// and the renderer. Both are worth pinning, because a change to either is a
// silent change to what every MCP client sees.

import { describe, expect, it } from "vitest";

import { describeClip, parseHueCurves } from "./agentTools";
import { withDefaults } from "./model";

const clip = (over: Record<string, unknown> = {}) =>
	withDefaults({
		id: "c1",
		name: "Take.mp4",
		mediaType: "video",
		assetId: "a1",
		startFrame: 0,
		endFrame: 90,
		...over,
	});

describe("describeClip", () => {
	it("omits everything that is at its default", () => {
		// The contract promises defaults are omitted; a receipt that echoed
		// every neutral value back would bury what actually changed.
		const out = describeClip(clip(), 30);
		expect(out.id).toBe("c1");
		expect(out.frames).toEqual([0, 90]);
		expect(out).not.toHaveProperty("speed");
		expect(out).not.toHaveProperty("opacity");
		expect(out).not.toHaveProperty("volumeDb");
		expect(out).not.toHaveProperty("color");
	});

	it("reports a value that has moved off its default", () => {
		expect(describeClip(clip({ opacity: 0.5 }), 30).opacity).toBe(0.5);
		expect(describeClip(clip({ speed: 2 }), 30).speed).toBe(2);
	});

	it("reports a grade only once it would change the picture", () => {
		expect(describeClip(clip(), 30)).not.toHaveProperty("color");
		expect(
			describeClip(clip({ color: { ...clip().color, contrast: 1.4 } }), 30),
		).toHaveProperty("color");
	});

	it("carries effects in the shape apply_effect accepts", () => {
		const out = describeClip(
			clip({ effects: [{ type: "blur", params: { amount: 0.4 }, enabled: true }] }),
			30,
		);
		expect(out.effects).toEqual([{ type: "blur", params: { amount: 0.4 } }]);
	});

	it("marks a disabled effect rather than dropping it", () => {
		const out = describeClip(
			clip({ effects: [{ type: "blur", params: { amount: 0.4 }, enabled: false }] }),
			30,
		);
		expect(out.effects).toEqual([{ type: "blur", params: { amount: 0.4 }, enabled: false }]);
	});
});

describe("parseHueCurves", () => {
	it("reads a target and clamps it into range", () => {
		const parsed = parseHueCurves({
			targets: [{ targetHue: 30, hueShift: 90, satScale: 5, lumShift: -3 }],
		});
		expect(typeof parsed).not.toBe("string");
		if (typeof parsed === "string") return;
		expect(parsed.targets[0]).toEqual({
			targetHue: 30,
			hueShift: 30,
			satScale: 2,
			lumShift: -0.5,
		});
	});

	it("wraps a hue outside 0–360 instead of refusing it", () => {
		const parsed = parseHueCurves({ targets: [{ targetHue: 400, satScale: 0.5 }] });
		if (typeof parsed === "string") throw new Error(parsed);
		expect(parsed.targets[0].targetHue).toBe(40);
		const negative = parseHueCurves({ targets: [{ targetHue: -30, satScale: 0.5 }] });
		if (typeof negative === "string") throw new Error(negative);
		expect(negative.targets[0].targetHue).toBe(330);
	});

	it("clears the targets for null or an empty list", () => {
		expect(parseHueCurves(null)).toEqual({ targets: [] });
		expect(parseHueCurves({ targets: [] })).toEqual({ targets: [] });
	});

	it("refuses a target that changes nothing, rather than storing a no-op", () => {
		const parsed = parseHueCurves({ targets: [{ targetHue: 30 }] });
		expect(typeof parsed).toBe("string");
		expect(parsed).toMatch(/changes nothing/);
	});

	it("names the index of a bad target", () => {
		const parsed = parseHueCurves({ targets: [{ targetHue: 30, satScale: 0.5 }, {}] });
		expect(parsed).toMatch(/targets\[1\]/);
	});

	it("refuses a target with no targetHue", () => {
		expect(parseHueCurves({ targets: [{ satScale: 0.5 }] })).toMatch(/targetHue/);
	});

	it("refuses shapes that aren't a targets array", () => {
		expect(parseHueCurves("nope")).toMatch(/targets/);
		expect(parseHueCurves({ hueVsSat: [] })).toMatch(/targets/);
	});
});
