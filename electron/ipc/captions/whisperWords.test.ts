// Word timing from whisper.cpp's `-ojf` output.
//
// The fixtures are real: whisper-cli 1.9.1 with ggml-small.en run over a macOS
// `say` recording of "Hey everyone, welcome back to the channel. Today we're
// testing word-level timestamps, and it's going to be great." and over four
// seconds of digital silence. (The model heard "more level", which is fine —
// the parser's job is the timing, not the spelling.) Token shapes worth
// pinning: control tokens like [_BEG_] and [_TT_240], zero-length punctuation
// tokens, contractions without a leading space, and one word split across
// three tokens.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseWhisperJsonCues } from "./parser";
import { mergeWhisperTokens, parseWhisperFullJsonWords, type WhisperToken } from "./whisperWords";

const fixture = (name: string) =>
	fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

const token = (text: string, fromMs: number, toMs = fromMs): WhisperToken => ({
	text,
	fromMs,
	toMs,
});

describe("parsing a real whisper.cpp transcript", () => {
	const words = parseWhisperFullJsonWords(fixture("whisper-ojf-small-en.json"));

	it("returns one entry per spoken word, with punctuation on the word before", () => {
		expect(words.map((word) => word.text)).toEqual([
			"Hey",
			"everyone,",
			"welcome",
			"back",
			"to",
			"the",
			"channel.",
			"Today",
			"we're",
			"testing",
			"more",
			"level",
			"timestamps,",
			"and",
			"it's",
			"going",
			"to",
			"be",
			"great.",
		]);
	});

	it("never surfaces control tokens as words", () => {
		expect(words.some((word) => word.text.includes("[_"))).toBe(false);
	});

	it("spans a split word from its first token to its last", () => {
		// " tim" 3970–4170, "est", "amps" 4360–4420.
		const timestamps = words.find((word) => word.text === "timestamps,");
		expect(timestamps?.startMs).toBe(3970);
		expect(timestamps?.endMs).toBe(4420);
	});

	it("doesn't stretch a word to where its punctuation was timed", () => {
		// "channel" ends at 1910; the "." token sits in the pause at 2240.
		const channel = words.find((word) => word.text === "channel.");
		expect(channel?.endMs).toBe(1910);
	});

	it("keeps words in order and every word a real span", () => {
		for (let index = 0; index < words.length; index++) {
			expect(words[index].endMs).toBeGreaterThan(words[index].startMs);
			if (index > 0) {
				expect(words[index].startMs).toBeGreaterThanOrEqual(words[index - 1].startMs);
			}
		}
	});

	it("merges across the segment boundary without losing a word", () => {
		// The first segment ends on "timestamps," and the second starts on " and".
		const and = words.find((word) => word.text === "and");
		expect(and?.startMs).toBe(4860);
	});

	it("reads digital silence as no words, not as '[BLANK_AUDIO]'", () => {
		expect(parseWhisperFullJsonWords(fixture("whisper-ojf-blank-audio.json"))).toEqual([]);
	});

	it("returns nothing for output that isn't JSON", () => {
		expect(parseWhisperFullJsonWords("not json")).toEqual([]);
		expect(parseWhisperFullJsonWords("{}")).toEqual([]);
	});

	it("now gives the auto-caption cues real words too", () => {
		// The old per-segment parser gave up on any zero-length token, which
		// every punctuation mark is — so cues never carried word timing.
		const cues = parseWhisperJsonCues(fixture("whisper-ojf-small-en.json"));
		expect(cues).toHaveLength(2);
		expect(cues[0].words?.[0]).toMatchObject({ text: "Hey", startMs: 60, endMs: 170 });
		expect(cues[1].text).toBe("and it's going to be great.");
	});
});

describe("merging tokens", () => {
	it("joins an opening quote onto the word it opens", () => {
		const words = mergeWhisperTokens([
			token(" She", 0, 100),
			token(" said", 100, 200),
			token(' "', 200),
			token("hi", 210, 300),
			token('."', 300),
		]);
		expect(words.map((word) => word.text)).toEqual(["She", "said", '"hi."']);
		expect(words[2].startMs).toBe(210);
	});

	it("keeps a hyphenated word whole", () => {
		const words = mergeWhisperTokens([
			token(" word", 0, 100),
			token("-", 100),
			token("level", 110, 300),
		]);
		expect(words).toEqual([
			{ text: "word-level", startMs: 0, endMs: 300, leadingSpace: false },
		]);
	});

	it("drops an annotation in the middle of speech", () => {
		const words = mergeWhisperTokens([
			token(" So", 0, 100),
			token(" (", 100),
			token("la", 120, 200),
			token("ughs", 200, 400),
			token(")", 400),
			token(" anyway", 500, 800),
		]);
		expect(words.map((word) => word.text)).toEqual(["So", "anyway"]);
	});

	it("holds an instant word until the next one starts", () => {
		const words = mergeWhisperTokens([token(" a", 1000), token(" cat", 1040, 1300)]);
		expect(words[0].endMs).toBe(1040);
	});

	it("drops stray leading punctuation rather than gluing it to the first word", () => {
		const words = mergeWhisperTokens([token(",", 0), token(" Right", 10, 200)]);
		expect(words.map((word) => word.text)).toEqual(["Right"]);
		expect(words[0].leadingSpace).toBe(false);
	});
});
