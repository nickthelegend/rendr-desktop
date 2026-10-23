import { describe, expect, it } from "vitest";

import { lumaToAlpha, parseBackground } from "./matte";
import {
	compactFaceTrack,
	type FaceTrack,
	faceAt,
	faceCoverage,
	primaryFace,
	typicalFace,
} from "./vision";

const face = (x: number, y: number, size = 0.2, confidence = 0.9) => ({
	x,
	y,
	w: size,
	h: size,
	confidence,
});

function track(samples: FaceTrack["samples"]): FaceTrack {
	return { width: 1920, height: 1080, duration: 10, interval: 0.5, samples };
}

describe("face track", () => {
	it("picks the speaker: the largest confident face", () => {
		expect(
			primaryFace([face(0, 0, 0.1), face(0.5, 0.5, 0.3), face(0.2, 0.2, 0.5, 0.2)]),
		).toEqual(face(0.5, 0.5, 0.3));
		expect(primaryFace([face(0, 0, 0.4, 0.3)])).toBeNull();
	});

	it("interpolates between samples instead of jumping", () => {
		const t = track([
			{ t: 0, faces: [face(0.1, 0.4)] },
			{ t: 1, faces: [face(0.5, 0.4)] },
		]);
		const middle = faceAt(t, 0.5);
		expect(middle?.cx).toBeCloseTo(0.4);
		expect(middle?.cy).toBeCloseTo(0.5);
		expect(faceAt(t, 0)?.cx).toBeCloseTo(0.2);
	});

	it("bridges a missed detection but gives up across a long gap", () => {
		const t = track([
			{ t: 0, faces: [face(0.4, 0.4)] },
			{ t: 0.5, faces: [] },
			{ t: 1, faces: [face(0.4, 0.4)] },
			{ t: 5, faces: [] },
		]);
		expect(faceAt(t, 0.5)?.cx).toBeCloseTo(0.5);
		expect(faceAt(t, 4)).toBeNull();
	});

	it("finds where the speaker usually sits, ignoring a moment out of frame", () => {
		const t = track([
			{ t: 0, faces: [face(0.4, 0.3)] },
			{ t: 1, faces: [face(0.4, 0.3)] },
			{ t: 2, faces: [face(0.9, 0.9, 0.05)] },
			{ t: 3, faces: [face(0.4, 0.3)] },
		]);
		expect(typicalFace(t)?.cx).toBeCloseTo(0.5);
		expect(faceCoverage(t)).toBe(1);
		expect(
			faceCoverage(
				track([
					{ t: 0, faces: [] },
					{ t: 1, faces: [face(0, 0)] },
				]),
			),
		).toBe(0.5);
	});

	it("compacts a track for the project file", () => {
		const compact = compactFaceTrack(
			track([
				{
					t: 0.123456,
					faces: [
						{ x: 0.123456789, y: 0.2, w: 0.3, h: 0.3, confidence: 0.98765 },
						face(0, 0, 0.1, 0.1),
					],
				},
			]),
		);
		expect(compact.samples[0].faces).toEqual([
			{ x: 0.1235, y: 0.2, w: 0.3, h: 0.3, confidence: 0.99 },
		]);
		expect(compact.samples[0].t).toBe(0.123);
	});
});

describe("background", () => {
	it("turns a greyscale matte into alpha", () => {
		const data = new Uint8ClampedArray([200, 200, 200, 255, 0, 0, 0, 255]);
		lumaToAlpha(data);
		expect([...data]).toEqual([255, 255, 255, 200, 255, 255, 255, 0]);
	});

	it("validates each mode's requirements", () => {
		expect(parseBackground({ mode: "color", color: "#0B4F3C" })).toEqual({
			background: { mode: "color", color: "#0B4F3C" },
		});
		expect(parseBackground({ mode: "blur" })).toEqual({
			background: { mode: "blur", blur: 24 },
		});
		expect(parseBackground({ mode: "remove", feather: 3 })).toEqual({
			background: { mode: "remove", feather: 3 },
		});
		expect(parseBackground({ mode: "color" })).toHaveProperty("error");
		expect(parseBackground({ mode: "image" })).toHaveProperty("error");
		expect(parseBackground({ mode: "chroma" })).toHaveProperty("error");
		expect(parseBackground({ mode: "blur", blur: 9999 })).toHaveProperty("error");
	});
});
