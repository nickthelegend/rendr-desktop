// Time, both ways.
//
// `frameToClipSourceMs` decides which frame of the source file every renderer
// reaches for, and `clipSourceMsToFrame` is its inverse — the one the zoom
// track, the caption placer and `remove_silence` all use to put a source-time
// event back on the timeline. If the two disagree, a zoom drawn at 4s plays at
// 4.2s and nothing in the UI explains it.

import { describe, expect, it } from "vitest";

import { withDefaults } from "./model";
import { clipSourceMsToFrame, formatClock, formatTimecode, frameToClipSourceMs } from "./state";

const clip = (over: Record<string, unknown> = {}) =>
	withDefaults({
		id: "c1",
		name: "Take.mp4",
		mediaType: "video",
		assetId: "a1",
		startFrame: 0,
		endFrame: 300,
		...over,
	});

describe("frameToClipSourceMs", () => {
	it("reads from the head of the file for an untrimmed clip at its start", () => {
		expect(frameToClipSourceMs(clip(), 0, 30)).toBe(0);
	});

	it("advances one frame of source per frame of timeline at speed 1", () => {
		expect(frameToClipSourceMs(clip(), 30, 30)).toBeCloseTo(1000, 6);
	});

	it("offsets by the trim, so a trimmed clip starts later in the file", () => {
		expect(frameToClipSourceMs(clip({ trimStartFrame: 60 }), 0, 30)).toBeCloseTo(2000, 6);
	});

	it("accounts for the clip's own position on the timeline", () => {
		// Frame 90 of a clip that starts at 60 is its 30th frame — one second in.
		expect(frameToClipSourceMs(clip({ startFrame: 60 }), 90, 30)).toBeCloseTo(1000, 6);
	});

	it("runs through the source faster at double speed", () => {
		expect(frameToClipSourceMs(clip({ speed: 2 }), 30, 30)).toBeCloseTo(2000, 6);
	});
});

describe("clipSourceMsToFrame", () => {
	it("is the exact inverse of frameToClipSourceMs", () => {
		// Every combination that has ever caused a bug here: trims, offsets,
		// speeds, and the fps values a project can actually use.
		const cases = [
			{},
			{ trimStartFrame: 60 },
			{ startFrame: 45 },
			{ speed: 2 },
			{ speed: 0.5 },
			{ trimStartFrame: 37, startFrame: 91, speed: 1.5 },
		];
		for (const over of cases) {
			for (const fps of [24, 25, 30, 60]) {
				const model = clip(over);
				for (const frame of [0, 1, 17, 120, 299]) {
					const ms = frameToClipSourceMs(model, frame, fps);
					expect(clipSourceMsToFrame(model, ms, fps)).toBeCloseTo(frame, 6);
				}
			}
		}
	});

	it("maps a source-time event onto the timeline where it belongs", () => {
		// A zoom stored at 2s of source, on a clip trimmed by 1s and starting at
		// frame 30, belongs one second after the clip's own start.
		const model = clip({ trimStartFrame: 30, startFrame: 30 });
		expect(clipSourceMsToFrame(model, 2000, 30)).toBeCloseTo(60, 6);
	});
});

describe("formatTimecode", () => {
	it("writes hours:minutes:seconds:frames", () => {
		expect(formatTimecode(0, 30)).toBe("00:00:00:00");
		expect(formatTimecode(29, 30)).toBe("00:00:00:29");
		expect(formatTimecode(30, 30)).toBe("00:00:01:00");
		expect(formatTimecode(30 * 60, 30)).toBe("00:01:00:00");
		expect(formatTimecode(30 * 60 * 60, 30)).toBe("01:00:00:00");
	});

	it("respects the project's own frame rate", () => {
		// The same frame index is a different time at a different rate.
		expect(formatTimecode(24, 24)).toBe("00:00:01:00");
		expect(formatTimecode(24, 30)).toBe("00:00:00:24");
	});

	it("does not produce a negative timecode", () => {
		expect(formatTimecode(-5, 30)).toBe("00:00:00:00");
	});
});

describe("formatClock", () => {
	it("writes the elapsed time a recording shows", () => {
		expect(formatClock(0)).toBe("00:00");
		expect(formatClock(59)).toBe("00:59");
		expect(formatClock(60)).toBe("01:00");
		expect(formatClock(3599)).toBe("59:59");
	});

	it("carries past an hour rather than wrapping to zero", () => {
		// A long take must not read as "00:00" after sixty minutes.
		expect(formatClock(3600)).not.toBe("00:00");
	});
});
