// Subtitles must survive a zoom.
//
// The camera transform scales and offsets everything drawn under it, which is
// the point for footage and wrong for a subtitle: at 1.5x a caption at
// centerY 0.86 lands at y 438 of a 405px frame and is off the bottom edge.
// That is exactly how narration subtitles came to be invisible in every zoomed
// take, while the drawn cursor — which is meant to magnify with the picture —
// rendered fine. These tests assert the caption lands on the canvas whether or
// not a zoom is running, by checking the matrix `fillText` actually committed.

import { describe, expect, it } from "vitest";

import { narrationCues, placeCaptions } from "./captions";
import { renderFrame } from "./export";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";

interface Draw {
	text: string;
	m: { a: number; d: number; e: number; f: number };
}

/** A context that tracks the transform, so an off-canvas draw is detectable. */
function trackingContext(width: number, height: number) {
	const draws: Draw[] = [];
	let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
	const stack: Array<typeof m> = [];
	const context = {
		canvas: { width, height },
		filter: "none",
		globalAlpha: 1,
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		font: "",
		textAlign: "center",
		textBaseline: "middle",
		save() {
			stack.push({ ...m });
		},
		restore() {
			m = stack.pop() ?? m;
		},
		setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
			m = { a, b, c, d, e, f };
		},
		getTransform: () => ({ ...m }),
		translate(x: number, y: number) {
			m.e += x * m.a;
			m.f += y * m.d;
		},
		scale(x: number, y: number) {
			m.a *= x;
			m.d *= y;
		},
		rotate() {},
		clearRect() {},
		fillRect() {},
		beginPath() {},
		rect() {},
		roundRect() {},
		clip() {},
		stroke() {},
		fill() {},
		drawImage() {},
		measureText: () => ({ width: 100 }),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		putImageData() {},
		fillText(text: string, x: number, y: number) {
			draws.push({
				text,
				m: { a: m.a, d: m.d, e: m.e + x * m.a, f: m.f + y * m.d },
			});
		},
	};
	return { context: context as unknown as CanvasRenderingContext2D, draws };
}

const cues = narrationCues(
	[{ commentId: "a", startFrame: 5, seconds: 4, text: "Rendr records the browser." }],
	30,
);
const toFrame = (ms: number) => Math.round((ms / 1000) * 30);

function timelineWith(zoom: boolean): TimelineModel {
	const take = withDefaults({
		id: "c1",
		name: "take",
		mediaType: "video",
		assetId: "a1",
		startFrame: 0,
		endFrame: 480,
		...(zoom
			? {
					zoomRegions: [
						{
							id: "z1",
							startMs: 0,
							endMs: 10000,
							depth: 2,
							focus: { cx: 0.5, cy: 0.5 },
							mode: "manual" as const,
						},
					],
				}
			: {}),
	});
	const base: TimelineModel = {
		id: "t",
		name: "T",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks: [
			{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips: [take] },
		],
	};
	return placeCaptions(base, cues, { groupId: "narration", toFrame }).timeline;
}

async function captionDraw(zoom: boolean, width = 720, height = 405) {
	const { context, draws } = trackingContext(width, height);
	await renderFrame(
		context,
		timelineWith(zoom),
		80,
		{ video: new Map(), image: new Map() },
		width,
		height,
	);
	return draws.find((d) => d.text.includes("Rendr"));
}

describe("subtitles under a zoom", () => {
	it("lands on the canvas with no zoom", async () => {
		const draw = await captionDraw(false);
		expect(draw).toBeDefined();
		if (!draw) return;
		expect(draw.m.f).toBeGreaterThan(0);
		expect(draw.m.f).toBeLessThan(405);
	});

	it("still lands on the canvas while zoomed", async () => {
		// The regression: the camera pushed this to y 438 of a 405px frame.
		const draw = await captionDraw(true);
		expect(draw).toBeDefined();
		if (!draw) return;
		expect(draw.m.f).toBeGreaterThan(0);
		expect(draw.m.f).toBeLessThan(405);
	});

	it("is drawn at the same place zoomed or not, and unscaled", async () => {
		const plain = await captionDraw(false);
		const zoomed = await captionDraw(true);
		expect(plain && zoomed).toBeTruthy();
		if (!plain || !zoomed) return;
		// A subtitle belongs to the finished frame, so a punch-in must not move
		// it or resize it.
		expect(zoomed.m.f).toBeCloseTo(plain.m.f, 3);
		expect(zoomed.m.e).toBeCloseTo(plain.m.e, 3);
		expect(zoomed.m.a).toBeCloseTo(1, 5);
		expect(zoomed.m.d).toBeCloseTo(1, 5);
	});
});
