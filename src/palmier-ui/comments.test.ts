import { describe, expect, it } from "vitest";

import {
	commentCovers,
	commentsForTrack,
	createComment,
	narratableComments,
	parseComments,
	shiftComments,
	sortComments,
	voiceIsStale,
} from "./comments";

const note = (over: Partial<ReturnType<typeof createComment>> = {}) => ({
	...createComment({ frame: 0, text: "note" }),
	...over,
});

describe("comments", () => {
	it("pins a note to a whole frame", () => {
		const comment = createComment({ frame: 12.7, text: "  spacing looks off  " });
		expect(comment.frame).toBe(13);
		expect(comment.text).toBe("spacing looks off");
		expect(comment.durationFrames).toBe(0);
		expect(comment.author).toBe("user");
	});

	it("orders by frame, then stably", () => {
		const ordered = sortComments([
			note({ id: "b", frame: 90, createdAt: "2026-01-01T00:00:01Z" }),
			note({ id: "a", frame: 10, createdAt: "2026-01-01T00:00:00Z" }),
			note({ id: "c", frame: 90, createdAt: "2026-01-01T00:00:00Z" }),
		]);
		expect(ordered.map((entry) => entry.id)).toEqual(["a", "c", "b"]);
	});

	it("keeps a track's notes apart from the rest", () => {
		const all = [
			note({ id: "v", frame: 10, trackId: "trk-v1" }),
			note({ id: "a", frame: 20, trackId: "trk-a1" }),
			note({ id: "loose", frame: 30 }),
		];
		expect(commentsForTrack(all, "trk-v1").map((entry) => entry.id)).toEqual(["v"]);
		// Timeline-wide notes are opt-in, so a track's list isn't polluted by
		// every general remark about the cut.
		expect(commentsForTrack(all, "trk-v1", true).map((entry) => entry.id)).toEqual([
			"v",
			"loose",
		]);
	});

	it("covers only its own frame when it has no duration", () => {
		const marker = note({ frame: 40 });
		expect(commentCovers(marker, 40)).toBe(true);
		expect(commentCovers(marker, 41)).toBe(false);

		const span = note({ frame: 40, durationFrames: 30 });
		expect(commentCovers(span, 69)).toBe(true);
		// Exclusive at the end, like every other range on the timeline.
		expect(commentCovers(span, 70)).toBe(false);
	});

	it("knows when the audio no longer matches the words", () => {
		const voiced = note({
			text: "welcome to Rendr",
			voice: { assetId: "a1", fromText: "welcome to Rendr", voiceId: "af_heart" },
		});
		expect(voiceIsStale(voiced)).toBe(false);
		// Editing the wording must not leave the old take passing as current —
		// that mismatch is invisible until somebody plays the export.
		expect(voiceIsStale({ ...voiced, text: "welcome to Rendr, the recorder" })).toBe(true);
		expect(voiceIsStale(note())).toBe(false);
	});

	it("skips resolved and empty notes when narrating", () => {
		const script = narratableComments([
			note({ id: "keep", frame: 0, text: "first" }),
			note({ id: "done", frame: 30, text: "second", resolved: true }),
			note({ id: "blank", frame: 60, text: "   " }),
			note({ id: "also", frame: 90, text: "third" }),
		]);
		expect(script.map((entry) => entry.id)).toEqual(["keep", "also"]);
	});

	it("moves notes after a ripple, and leaves earlier ones alone", () => {
		const shifted = shiftComments(
			[note({ id: "before", frame: 10 }), note({ id: "after", frame: 100 })],
			50,
			-20,
		);
		expect(shifted.find((entry) => entry.id === "before")?.frame).toBe(10);
		expect(shifted.find((entry) => entry.id === "after")?.frame).toBe(80);
	});

	it("never shifts a note past the start of the timeline", () => {
		const shifted = shiftComments([note({ frame: 10 })], 0, -500);
		expect(shifted[0].frame).toBe(0);
	});

	it("drops malformed stored notes instead of throwing", () => {
		const parsed = parseComments([
			{ id: "ok", frame: 5, text: "fine" },
			{ id: "no-frame", text: "missing frame" },
			{ frame: 9, text: "missing id" },
			"not an object",
			null,
		]);
		// One bad entry must not cost the user the whole project.
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("ok");
	});

	it("round-trips a voiced note", () => {
		const parsed = parseComments([
			{
				id: "v",
				frame: 30,
				text: "the zoom follows your cursor",
				durationFrames: 60,
				author: "agent",
				createdAt: "2026-01-01T00:00:00Z",
				voice: {
					assetId: "a9",
					fromText: "the zoom follows your cursor",
					voiceId: "af_heart",
				},
			},
		]);
		expect(parsed[0].voice?.assetId).toBe("a9");
		expect(parsed[0].author).toBe("agent");
		expect(voiceIsStale(parsed[0])).toBe(false);
	});
});
