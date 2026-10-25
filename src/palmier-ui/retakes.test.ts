import { describe, expect, it } from "vitest";

import { findRetakes, normalizeWord, type RetakeWord, sentenceStarts } from "./retakes";

/** Builds a transcript from text, ~0.3 s a word; "|" marks a long pause. */
function transcript(text: string): RetakeWord[] {
	const words: RetakeWord[] = [];
	let frame = 0;
	for (const token of text.split(/\s+/).filter(Boolean)) {
		if (token === "|") {
			frame += 30;
			continue;
		}
		words.push({ index: words.length, text: token, startFrame: frame, endFrame: frame + 8 });
		frame += 9;
	}
	return words;
}

const fps = 30;

describe("findRetakes", () => {
	it("cuts the abandoned start of a line and keeps the last attempt", () => {
		const words = transcript(
			"So today we're going to | so today we're going to look at three editing tricks.",
		);
		const [retake] = findRetakes(words, { fps });
		expect(retake).toMatchObject({ kind: "restart", removeFrom: 0, removeTo: 4 });
		expect(retake.removedText).toBe("So today we're going to");
		expect(retake.keptText.startsWith("so today we're going to")).toBe(true);
	});

	it("finds a restart Whisper joined to its retry with a comma", () => {
		// Real output from a local transcription of a take with a restart in it.
		const words = transcript(
			"Hi everyone, so today we are going to, so today we are going to look at 3 editing tricks.",
		);
		const [retake] = findRetakes(words, { fps });
		expect(retake).toMatchObject({ kind: "restart", removeFrom: 2, removeTo: 7 });
		expect(retake.removedText).toBe("so today we are going to,");
	});

	it("cuts both earlier attempts when a line is tried three times", () => {
		const words = transcript(
			"The first thing you | the first thing you need | the first thing you need is a hook.",
		);
		const retakes = findRetakes(words, { fps });
		expect(retakes.map((retake) => [retake.removeFrom, retake.removeTo])).toEqual([
			[0, 3],
			[4, 8],
		]);
	});

	it("catches a stutter inside a sentence", () => {
		const words = transcript("I think I think this is the best way to do it.");
		const [retake] = findRetakes(words, { fps });
		expect(retake).toMatchObject({ kind: "stutter", removeFrom: 0, removeTo: 1 });
	});

	it("leaves deliberate repetition and different sentences alone", () => {
		expect(findRetakes(transcript("No no, that's very very wrong."), { fps })).toEqual([]);
		expect(
			findRetakes(transcript("We want to win, we want to grow, we want to last."), { fps }),
		).toEqual([]);
		expect(
			findRetakes(
				transcript("So today we look at hooks. | So tomorrow we look at endings."),
				{ fps },
			),
		).toEqual([]);
	});

	it("doesn't reach for a matching opening far later in the video", () => {
		const far = transcript(
			`Let me show you this. ${"filler ".repeat(120)} | Let me show you this again.`,
		);
		expect(
			findRetakes(far, { fps, maxGapSeconds: 10 }).filter(
				(retake) => retake.kind === "restart",
			),
		).toEqual([]);
	});

	it("compares words without case or punctuation, and finds sentence starts", () => {
		expect(normalizeWord("Today,")).toBe("today");
		expect(normalizeWord("We’re")).toBe("were");
		expect(sentenceStarts(transcript("One two. Three four | five, six"), fps)).toEqual([
			0, 2, 4, 5,
		]);
	});
});
