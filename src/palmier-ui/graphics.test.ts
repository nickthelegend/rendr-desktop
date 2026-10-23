import { describe, expect, it } from "vitest";

import {
	buildTemplate,
	easeOutBack,
	edgePoint,
	entrance,
	exitAlpha,
	type GraphicElement,
	layoutAround,
	qrModules,
	settleSeconds,
} from "./graphics";

describe("graphic timing", () => {
	it("enters from nothing to settled over its duration, and never before its time", () => {
		expect(entrance(1, 0.5, 0.35)).toBe(0);
		expect(entrance(1, 1.175, 0.35)).toBeCloseTo(0.5);
		expect(entrance(1, 5, 0.35)).toBe(1);
	});

	it("pops: overshoots, then lands exactly", () => {
		expect(easeOutBack(0)).toBeCloseTo(0);
		expect(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1);
		expect(easeOutBack(1)).toBeCloseTo(1);
	});

	it("fades out at the end of the clip, but not a blink-length one", () => {
		expect(exitAlpha(9.85, 10)).toBeCloseTo(0.5);
		expect(exitAlpha(5, 10)).toBe(1);
		expect(exitAlpha(0.9, 1)).toBe(1);
	});
});

describe("graphic geometry", () => {
	it("starts a connecting line at a card's edge, not its centre", () => {
		const rect = { x: 0, y: 0, w: 100, h: 40 };
		expect(edgePoint(rect, [250, 20])).toEqual([100, 20]);
		expect(edgePoint(rect, [50, -100])).toEqual([50, 0]);
	});

	it("lays a mind map out around the speaker, not on top of them", () => {
		const keepOut = { cx: 0.5, cy: 0.55, rx: 0.2, ry: 0.45 };
		const points = layoutAround(6, keepOut);
		expect(points).toHaveLength(6);
		for (const [x, y] of points) {
			const onSpeaker =
				Math.abs(x - keepOut.cx) < keepOut.rx && Math.abs(y - keepOut.cy) < keepOut.ry;
			expect(onSpeaker).toBe(false);
			expect(x).toBeGreaterThanOrEqual(0.12);
			expect(x).toBeLessThanOrEqual(0.88);
		}
		// Spread, not stacked.
		expect(new Set(points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)).size).toBe(6);
	});
});

describe("templates", () => {
	it("builds the reference mind map: staggered cards, lines once both ends are up", () => {
		const built = buildTemplate({
			template: "mind_map",
			nodes: [{ label: "Ideas" }, { label: "Storylines" }, { label: "Numbers" }],
			links: [
				[0, 1],
				["storylines", "numbers"],
			],
		});
		if ("error" in built) throw new Error(built.error);
		const boxes = built.elements.filter((element) => element.type === "box");
		const lines = built.elements.filter((element) => element.type === "line") as Extract<
			GraphicElement,
			{ type: "line" }
		>[];
		expect(boxes.map((box) => box.at)).toEqual([0, 0.45, 0.9]);
		expect(lines.map((line) => [line.from, line.to])).toEqual([
			["n0", "n1"],
			["n1", "n2"],
		]);
		expect(lines[1].at).toBeGreaterThan(0.9);
		expect(settleSeconds(built.elements)).toBeGreaterThan(1.2);
	});

	it("refuses links that don't name two nodes", () => {
		expect(
			buildTemplate({ template: "mind_map", nodes: [{ label: "A" }], links: [[0, 3]] }),
		).toHaveProperty("error");
		expect(buildTemplate({ template: "mind_map", nodes: [] })).toHaveProperty("error");
	});

	it("puts a QR code in the corner asked for", () => {
		const built = buildTemplate({
			template: "qr",
			data: "https://example.com",
			corner: "bottom_left",
		});
		if ("error" in built) throw new Error(built.error);
		expect(built.elements[0]).toMatchObject({ type: "qr", x: 0.13, y: 0.74 });
		expect(buildTemplate({ template: "qr" })).toHaveProperty("error");
	});

	it("builds lower thirds, key points and callouts", () => {
		expect(
			buildTemplate({ template: "lower_third", title: "Priya", subtitle: "Creator" }),
		).not.toHaveProperty("error");
		expect(
			buildTemplate({ template: "key_points", items: ["a", "b", "c"] }),
		).not.toHaveProperty("error");
		const callout = buildTemplate({ template: "callout", label: "Look", pointTo: [0.5, 0.5] });
		if ("error" in callout) throw new Error(callout.error);
		expect(callout.elements.some((element) => element.type === "line" && element.arrow)).toBe(
			true,
		);
		expect(buildTemplate({ template: "spinning_cube" })).toHaveProperty("error");
	});

	it("encodes a scannable QR matrix", () => {
		const modules = qrModules("https://github.com/rendr-app");
		expect(modules.length).toBeGreaterThanOrEqual(21);
		expect(modules.every((row) => row.length === modules.length)).toBe(true);
		// Finder pattern: the top-left 7×7 corner is a dark ring.
		expect(modules[0].slice(0, 7).every(Boolean)).toBe(true);
		expect(modules[6].slice(0, 7).every(Boolean)).toBe(true);
	});
});
