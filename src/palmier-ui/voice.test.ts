import { describe, expect, it } from "vitest";

import { createComment } from "./comments";
import { estimateSeconds, overrunWarnings, planNarration } from "./voice";

const note = (frame: number, text: string, over: Record<string, unknown> = {}) => ({
	...createComment({ frame, text }),
	...over,
});

describe("planning narration", () => {
	it("speaks every unresolved note, in timeline order", () => {
		const plan = planNarration([
			note(90, "and here is the export"),
			note(0, "this is Rendr"),
			note(30, "it records your screen"),
		]);
		expect(plan.map((entry) => entry.startFrame)).toEqual([0, 30, 90]);
		expect(plan.every((entry) => entry.skipped === undefined)).toBe(true);
	});

	it("skips a note already voiced from the same words", () => {
		// Re-speaking would burn a minute of CPU to produce the identical file,
		// and would replace a take the user may have placed by hand.
		const plan = planNarration([
			note(0, "this is Rendr", {
				voice: { assetId: "a1", fromText: "this is Rendr", voiceId: "af_heart" },
			}),
		]);
		expect(plan[0].skipped).toBe("already voiced from this text");
	});

	it("re-speaks a note whose wording changed", () => {
		const plan = planNarration([
			note(0, "this is Rendr, a screen recorder", {
				voice: { assetId: "a1", fromText: "this is Rendr", voiceId: "af_heart" },
			}),
		]);
		expect(plan[0].skipped).toBeUndefined();
	});

	it("re-speaks everything when asked to regenerate", () => {
		const plan = planNarration(
			[
				note(0, "same words", {
					voice: { assetId: "a1", fromText: "same words", voiceId: "af_heart" },
				}),
			],
			{ regenerate: true },
		);
		expect(plan[0].skipped).toBeUndefined();
	});
});

describe("estimating a line", () => {
	it("scales with the number of words", () => {
		const short = estimateSeconds("hello there");
		const long = estimateSeconds(
			"hello there and welcome to a considerably longer sentence that keeps going",
		);
		expect(long).toBeGreaterThan(short);
	});

	it("is zero for nothing to say", () => {
		expect(estimateSeconds("   ")).toBe(0);
	});

	it("shortens as the delivery speeds up", () => {
		const line = "the camera follows your cursor through the punch in";
		expect(estimateSeconds(line, 2)).toBeLessThan(estimateSeconds(line, 1));
	});
});

describe("overrun warnings", () => {
	it("flags a line that runs into the next note", () => {
		// Two notes a third of a second apart, with a long line on the first.
		const warnings = overrunWarnings(
			[
				note(
					0,
					"this is a deliberately long line of narration that will certainly not fit into a third of a second",
				),
				note(10, "next"),
			],
			30,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].overrunSeconds).toBeGreaterThan(0);
	});

	it("says nothing when the notes are far enough apart", () => {
		expect(overrunWarnings([note(0, "short"), note(300, "also short")], 30)).toEqual([]);
	});

	it("never flags the last note, which has nothing to run into", () => {
		expect(
			overrunWarnings([note(0, "a very long closing line that goes on and on and on")], 30),
		).toEqual([]);
	});

	it("prefers the real duration over the estimate once a line is spoken", () => {
		// The estimate is a guess for laying out a timeline before generating.
		// Once the audio exists, reporting the guess overstates the overrun —
		// which is how a warning gets ignored.
		const comments = [
			note(0, "a fairly long line that the estimator will overshoot"),
			note(60, "next"),
		];
		const guessed = overrunWarnings(comments, 30);
		const known = overrunWarnings(comments, 30, 1, new Map([[comments[0].id, 1.2]]));
		expect(guessed[0].overrunSeconds).toBeGreaterThan(0);
		// 1.2s spoken against a 2s gap fits, so the real numbers clear it.
		expect(known).toEqual([]);
	});

	it("still flags a line that genuinely overruns, measured", () => {
		const comments = [note(0, "short"), note(30, "next")];
		const known = overrunWarnings(comments, 30, 1, new Map([[comments[0].id, 4]]));
		expect(known).toHaveLength(1);
		expect(known[0].overrunSeconds).toBeCloseTo(3, 2);
	});
});
