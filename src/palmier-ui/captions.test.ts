import { describe, expect, it } from "vitest";

import {
	captionGroups,
	formatTimestamp,
	groupWordsIntoCues,
	inferWordTiming,
	isFiller,
	narrationCues,
	parseSubtitles,
	parseTimestamp,
	placeCaptions,
	removeCaptionGroup,
	SubtitleParseError,
	toSrt,
	toVtt,
	transcriptText,
	transcriptWords,
} from "./captions";
import type { TimelineModel } from "./reducers";

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there

2
00:00:04,000 --> 00:00:06,000
Second line
across two rows
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
<v Speaker>Hello there</v>
`;

const empty = (): TimelineModel => ({
	id: "tl",
	name: "Main",
	fps: 30,
	width: 1920,
	height: 1080,
	tracks: [{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips: [] }],
});

describe("timestamps", () => {
	it("parses both SRT commas and VTT dots", () => {
		expect(parseTimestamp("00:00:01,500")).toBe(1500);
		expect(parseTimestamp("00:00:01.500")).toBe(1500);
		expect(parseTimestamp("01:02:03,004")).toBe(3_723_004);
	});

	it("pads a short fraction rather than misreading it", () => {
		expect(parseTimestamp("00:00:01,5")).toBe(1500);
	});

	it("returns null for anything that isn't a timestamp", () => {
		expect(parseTimestamp("nonsense")).toBeNull();
	});

	it("round-trips through the formatter", () => {
		expect(parseTimestamp(formatTimestamp(3_723_004))).toBe(3_723_004);
	});
});

describe("parseSubtitles", () => {
	it("reads SRT, keeping multi-row text", () => {
		const cues = parseSubtitles(SRT);
		expect(cues).toHaveLength(2);
		expect(cues[0]).toMatchObject({ startMs: 1000, endMs: 3500, text: "Hello there" });
		expect(cues[1].text).toBe("Second line\nacross two rows");
	});

	it("reads VTT and strips its inline tags", () => {
		const cues = parseSubtitles(VTT);
		expect(cues[0].text).toBe("Hello there");
	});

	it("skips a cue whose end is before its start", () => {
		const cues = parseSubtitles(`1\n00:00:05,000 --> 00:00:01,000\nbad\n\n${SRT}`);
		expect(cues.every((cue) => cue.endMs > cue.startMs)).toBe(true);
	});

	it("refuses a file with no cues instead of returning nothing", () => {
		expect(() => parseSubtitles("just some text")).toThrow(SubtitleParseError);
	});

	it("returns cues in time order", () => {
		const cues = parseSubtitles(SRT);
		expect(cues[0].startMs).toBeLessThan(cues[1].startMs);
	});
});

describe("serialising", () => {
	it("round-trips SRT", () => {
		const cues = parseSubtitles(SRT);
		expect(parseSubtitles(toSrt(cues))).toHaveLength(cues.length);
	});

	it("writes a VTT header", () => {
		expect(toVtt(parseSubtitles(SRT)).startsWith("WEBVTT")).toBe(true);
	});
});

describe("inferWordTiming", () => {
	it("weights by word length rather than splitting evenly", () => {
		const words = inferWordTiming({ id: "1", startMs: 0, endMs: 1000, text: "a longerword" });
		expect(words).toHaveLength(2);
		// "longerword" is far longer, so it should own most of the span.
		expect(words[1].endMs - words[1].startMs).toBeGreaterThan(
			words[0].endMs - words[0].startMs,
		);
	});

	it("lands the last word exactly on the cue's end", () => {
		const words = inferWordTiming({ id: "1", startMs: 0, endMs: 1000, text: "one two three" });
		expect(words[words.length - 1].endMs).toBe(1000);
	});

	it("keeps timing the source already had", () => {
		const given = [{ text: "hi", startMs: 10, endMs: 20 }];
		expect(inferWordTiming({ id: "1", startMs: 0, endMs: 100, text: "hi", words: given })).toBe(
			given,
		);
	});

	it("returns nothing for an empty cue", () => {
		expect(inferWordTiming({ id: "1", startMs: 0, endMs: 100, text: "   " })).toEqual([]);
	});
});

describe("placeCaptions", () => {
	const place = () =>
		placeCaptions(empty(), parseSubtitles(SRT), {
			groupId: "g1",
			toFrame: (ms) => (ms / 1000) * 30,
		});

	it("puts captions on their own track above the edit", () => {
		const { timeline, clipCount } = place();
		expect(clipCount).toBe(2);
		expect(timeline.tracks[0].name).toBe("CC");
		expect(timeline.tracks[0].clips).toHaveLength(2);
	});

	it("converts cue milliseconds to timeline frames", () => {
		const clip = place().timeline.tracks[0].clips[0];
		expect(clip.startFrame).toBe(30);
		expect(clip.endFrame).toBe(105);
	});

	it("stores word timing clip-relative so it survives moving", () => {
		const clip = place().timeline.tracks[0].clips[0];
		expect(clip.captionWords?.[0].startFrame).toBe(0);
		expect(clip.captionWords?.length).toBe(2);
	});

	it("tags every clip with the group so they restyle together", () => {
		const { timeline } = place();
		expect(timeline.tracks[0].clips.every((clip) => clip.captionGroupId === "g1")).toBe(true);
		expect(captionGroups(timeline)).toEqual(["g1"]);
	});

	it("does nothing when there are no cues", () => {
		const base = empty();
		expect(placeCaptions(base, [], { groupId: "g", toFrame: (ms) => ms }).timeline).toBe(base);
	});
});

describe("reading and removing", () => {
	const placed = () =>
		placeCaptions(empty(), parseSubtitles(SRT), {
			groupId: "g1",
			toFrame: (ms) => (ms / 1000) * 30,
		}).timeline;

	it("reads the transcript back as prose", () => {
		expect(transcriptText(placed())).toBe("Hello there Second line across two rows");
	});

	it("indexes every word globally, in timeline order", () => {
		const words = transcriptWords(placed());
		expect(words[0]).toMatchObject({ index: 0, text: "Hello" });
		expect(words.map((word) => word.index)).toEqual(words.map((_, index) => index));
	});

	it("removes a group and its now-empty track", () => {
		const next = removeCaptionGroup(placed(), "g1");
		expect(captionGroups(next)).toEqual([]);
		expect(next.tracks.some((track) => track.name === "CC")).toBe(false);
	});
});

describe("filler words", () => {
	it("matches fillers regardless of case or punctuation", () => {
		expect(isFiller("Um,")).toBe(true);
		expect(isFiller("uh")).toBe(true);
		expect(isFiller("however")).toBe(false);
	});
});

describe("groupWordsIntoCues", () => {
	const words = (spec: Array<[string, number, number]>) =>
		spec.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

	it("gathers words into one readable cue", () => {
		const cues = groupWordsIntoCues(
			words([
				["Record", 0, 400],
				["and", 400, 600],
				["edit", 600, 1000],
			]),
		);
		expect(cues).toHaveLength(1);
		expect(cues[0].text).toBe("Record and edit");
		expect(cues[0]).toMatchObject({ startMs: 0, endMs: 1000 });
	});

	it("breaks on sentence-final punctuation", () => {
		const cues = groupWordsIntoCues(
			words([
				["Done.", 0, 400],
				["Next", 400, 700],
			]),
		);
		expect(cues).toHaveLength(2);
		expect(cues[0].text).toBe("Done.");
	});

	it("breaks on a real pause", () => {
		const cues = groupWordsIntoCues(
			words([
				["one", 0, 200],
				["two", 2000, 2200],
			]),
			{ pauseMs: 700 },
		);
		expect(cues).toHaveLength(2);
	});

	it("breaks a line that would be too long to read", () => {
		const long = Array.from({ length: 20 }, (_, index) => [
			"word",
			index * 100,
			index * 100 + 90,
		]) as Array<[string, number, number]>;
		const cues = groupWordsIntoCues(words(long), { maxChars: 20 });
		expect(cues.length).toBeGreaterThan(1);
		for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(24);
	});

	it("breaks a cue that would run too long even without a pause", () => {
		const many = Array.from({ length: 30 }, (_, index) => [
			"a",
			index * 300,
			index * 300 + 280,
		]) as Array<[string, number, number]>;
		const cues = groupWordsIntoCues(words(many), { maxMs: 2000, maxChars: 999 });
		for (const cue of cues) expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(2400);
	});

	it("keeps the word timing on each cue, so karaoke has real data", () => {
		const cues = groupWordsIntoCues(words([["hello", 0, 500]]));
		expect(cues[0].words).toHaveLength(1);
		expect(cues[0].words?.[0]).toMatchObject({ text: "hello", startMs: 0 });
	});

	it("returns nothing for no words", () => {
		expect(groupWordsIntoCues([])).toEqual([]);
	});
});

describe("subtitles cut from narration", () => {
	const lines = [
		{
			commentId: "a",
			startFrame: 0,
			seconds: 4,
			text: "Rendr records your screen and edits it here.",
		},
		{ commentId: "b", startFrame: 240, seconds: 3, text: "The zoom follows your cursor." },
	];

	it("covers each line's exact spoken span", () => {
		const cues = narrationCues(lines, 30);
		expect(cues.length).toBeGreaterThanOrEqual(2);
		expect(cues[0].startMs).toBe(0);
		// The last cue of the run ends when the last line's audio ends.
		expect(cues[cues.length - 1].endMs).toBeCloseTo(8000 + 3000, 0);
	});

	it("never merges two narration lines into one cue", () => {
		// The 4s gap between line a's end and line b's start reads as a pause.
		const cues = narrationCues(lines, 30);
		const crossing = cues.find((cue) => cue.startMs < 4001 && cue.endMs > 8000);
		expect(crossing).toBeUndefined();
	});

	it("carries word timing for the karaoke renderer", () => {
		const cues = narrationCues(lines, 30);
		for (const cue of cues) {
			expect(cue.words?.length).toBeGreaterThan(0);
			// Words tile the cue without gaps, so the highlight never stalls.
			const words = cue.words ?? [];
			for (let i = 1; i < words.length; i++) {
				expect(words[i].startMs).toBeCloseTo(words[i - 1].endMs, 5);
			}
		}
	});

	it("returns nothing for no lines", () => {
		expect(narrationCues([], 30)).toEqual([]);
	});
});

describe("placing captions twice", () => {
	const bare = {
		id: "t",
		name: "T",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks: [] as never[],
	} as unknown as import("./reducers").TimelineModel;
	const cues = narrationCues(
		[{ commentId: "a", startFrame: 5, seconds: 4, text: "one two three four five" }],
		30,
	);
	const toFrame = (ms: number) => Math.round((ms / 1000) * 30);

	it("replaces the group's track instead of adding a second one", () => {
		// A state updater may run more than once for a single commit, so this
		// has to be safe to repeat. It wasn't: two tracks ended up sharing
		// `trk-cc-narration`, which React keys as duplicates and the compositor
		// cannot tell apart — the captions vanished from the render entirely.
		const once = placeCaptions(bare, cues, { groupId: "narration", toFrame }).timeline;
		const twice = placeCaptions(once, cues, { groupId: "narration", toFrame }).timeline;

		const ccTracks = twice.tracks.filter((t) => t.id === "trk-cc-narration");
		expect(ccTracks).toHaveLength(1);
		expect(new Set(twice.tracks.map((t) => t.id)).size).toBe(twice.tracks.length);
		expect(ccTracks[0].clips.length).toBeGreaterThan(0);
	});

	it("leaves other tracks alone", () => {
		const withVideo = {
			...bare,
			tracks: [
				{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips: [] },
			],
		} as unknown as import("./reducers").TimelineModel;
		const out = placeCaptions(withVideo, cues, { groupId: "narration", toFrame }).timeline;
		expect(out.tracks.map((t) => t.id)).toContain("v1");
	});
});
