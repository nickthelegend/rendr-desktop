import { describe, expect, it } from "vitest";

import { faceInFrame, frameFace, punchBox, punchedIndexes, pushKeyframes } from "./punchIns";

const full = { centerX: 0.5, centerY: 0.5, width: 1, height: 1 };
const WIDE = 16 / 9;

describe("faceInFrame", () => {
	it("is the identity when the footage matches the frame", () => {
		expect(faceInFrame(full, { x: 0.3, y: 0.4 }, WIDE, WIDE)).toEqual({ x: 0.3, y: 0.4 });
	});

	it("accounts for cover-fit: 16:9 footage in a 9:16 box is cropped at the sides", () => {
		// A 9:16 canvas showing the middle third of a 16:9 picture.
		const point = faceInFrame(full, { x: 0.5, y: 0.5 }, WIDE, 9 / 16);
		expect(point.x).toBeCloseTo(0.5);
		const edge = faceInFrame(full, { x: 0.25, y: 0.5 }, WIDE, 9 / 16);
		// A quarter of the way across the picture is off the left of the crop.
		expect(edge.x).toBeLessThan(0);
	});
});

describe("punchBox", () => {
	it("keeps the face where it was and makes everything bigger", () => {
		const face = { x: 0.4, y: 0.35 };
		const pushed = punchBox(full, face, 1.2);
		expect(pushed.width).toBeCloseTo(1.2);
		const after = faceInFrame(pushed, { x: 0.4, y: 0.35 }, WIDE, WIDE);
		expect(after.x).toBeCloseTo(0.4);
		expect(after.y).toBeCloseTo(0.35);
	});

	it("never uncovers an edge, even for a face at the very edge of frame", () => {
		const pushed = punchBox(full, { x: 0.02, y: 0.5 }, 1.2);
		expect(pushed.centerX - pushed.width / 2).toBeLessThanOrEqual(0 + 1e-9);
		expect(pushed.centerX + pushed.width / 2).toBeGreaterThanOrEqual(1 - 1e-9);
	});

	it("leaves an inset free to move, since it never covered the frame", () => {
		const inset = { centerX: 0.75, centerY: 0.75, width: 0.3, height: 0.3 };
		const pushed = punchBox(inset, { x: 0.75, y: 0.75 }, 1.2);
		expect(pushed.centerX).toBeCloseTo(0.75);
		expect(pushed.width).toBeCloseTo(0.36);
	});
});

describe("frameFace", () => {
	it("slides a vertical crop of wide footage onto the speaker", () => {
		// 16:9 footage reframed into 9:16: the box is 3.16 frames wide.
		const box = { centerX: 0.5, centerY: 0.5, width: WIDE / (9 / 16), height: 1 };
		const framed = frameFace(box, { x: 0.3, y: 0.3 }, WIDE, 9 / 16, { x: 0.5, y: 0.3 });
		const face = faceInFrame(framed, { x: 0.3, y: 0.3 }, WIDE, 9 / 16);
		expect(face.x).toBeCloseTo(0.5);
		// Still covering the frame.
		expect(framed.centerX - framed.width / 2).toBeLessThanOrEqual(0);
		expect(framed.centerX + framed.width / 2).toBeGreaterThanOrEqual(1);
	});
});

describe("patterns and pushes", () => {
	it("alternates wide and tight, starting wide", () => {
		expect(punchedIndexes(5, "alternate")).toEqual([1, 3]);
		expect(punchedIndexes(3, "alternate", "tight")).toEqual([0, 2]);
		expect(punchedIndexes(3, "every")).toEqual([0, 1, 2]);
	});

	it("writes a push as top-left position rows matched to the scale rows", () => {
		const to = punchBox(full, { x: 0.5, y: 0.4 }, 1.1);
		const { scale, position } = pushKeyframes(full, to, 90);
		expect(scale[1].values).toEqual([to.width, to.height]);
		expect(position[0].values).toEqual([0, 0]);
		expect(position[1].values[0]).toBeCloseTo(to.centerX - to.width / 2);
		expect(scale[1].frame).toBe(89);
	});
});

describe("face-centred reframing", () => {
	it("slides a 9:16 reframe onto the speaker instead of the middle", async () => {
		const { reframeTimeline } = await import("./workflowRun");
		const { withDefaults } = await import("./model");
		const clip = withDefaults({
			id: "c",
			name: "cam",
			mediaType: "video",
			assetId: "a",
			startFrame: 0,
			endFrame: 300,
		});
		const timeline = {
			id: "t",
			name: "Main",
			fps: 30,
			width: 1920,
			height: 1080,
			tracks: [
				{
					id: "v1",
					name: "V1",
					kind: "video" as const,
					muted: false,
					hidden: false,
					clips: [clip],
				},
			],
		};
		const faceTrack = {
			width: 1920,
			height: 1080,
			duration: 10,
			interval: 1,
			samples: [{ t: 1, faces: [{ x: 0.2, y: 0.2, w: 0.1, h: 0.2, confidence: 0.9 }] }],
		};
		const asset = {
			id: "a",
			name: "cam",
			type: "video" as const,
			durationSeconds: 10,
			width: 1920,
			height: 1080,
			hasAudio: true,
			url: "blob:a",
			faceTrack,
		};
		const vertical = reframeTimeline(timeline, 9 / 16, [asset]);
		const box = vertical.tracks[0].clips[0].transform;
		expect(vertical.width).toBe(1080);
		const face = faceInFrame(box, { x: 0.25, y: 0.3 }, 16 / 9, 9 / 16);
		expect(face.x).toBeCloseTo(0.5, 1);
		expect(box.centerX - box.width / 2).toBeLessThanOrEqual(0);
	});
});
