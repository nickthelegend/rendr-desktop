import { describe, expect, it } from "vitest";

import { balanceLines, bestFaceMoment } from "./thumbnail";

describe("thumbnail layout", () => {
	it("breaks a title into even blocks of at most three lines", () => {
		expect(balanceLines("I edited this with AI")).toEqual(["I edited", "this with AI"]);
		expect(balanceLines("Stop")).toEqual(["Stop"]);
		const long = balanceLines("The one editing trick nobody tells you about when starting out");
		expect(long.length).toBeLessThanOrEqual(3);
		expect(long.join(" ")).toBe(
			"The one editing trick nobody tells you about when starting out",
		);
	});

	it("takes the speaker from the moment they're closest to camera", () => {
		const face = (h: number, x = 0.45) => ({ x, y: 0.2, w: h, h, confidence: 0.9 });
		const track = {
			width: 1920,
			height: 1080,
			duration: 10,
			interval: 1,
			samples: [
				{ t: 1, faces: [face(0.2)] },
				{ t: 2, faces: [face(0.35)] },
				{ t: 3, faces: [] },
				{ t: 4, faces: [face(0.25)] },
			],
		};
		expect(bestFaceMoment(track)).toBe(2);
		expect(bestFaceMoment(track, 3, 10)).toBe(4);
		expect(bestFaceMoment({ ...track, samples: [{ t: 0, faces: [] }] })).toBeNull();
	});
});
