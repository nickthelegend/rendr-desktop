// Editing a subtitle has to re-time it.
//
// A caption carries per-word timing for the karaoke renderer. Changing the
// words without re-timing leaves the highlight pointing at text that is no
// longer there, and a word-count change breaks the per-word draw outright — so
// the generated subtitles would look editable and quietly not be.

import { describe, expect, it } from "vitest";

import { narrationCues, placeCaptions } from "./captions";
import { withDefaults } from "./model";
import { setClipContent, type TimelineModel } from "./reducers";

const bare: TimelineModel = {
	id: "t",
	name: "T",
	fps: 30,
	width: 1920,
	height: 1080,
	tracks: [],
};

function captionTimeline() {
	const cues = narrationCues(
		[{ commentId: "a", startFrame: 0, seconds: 4, text: "one two three four" }],
		30,
	);
	return placeCaptions(bare, cues, {
		groupId: "narration",
		toFrame: (ms) => Math.round((ms / 1000) * 30),
	}).timeline;
}

const captionClip = (t: TimelineModel) =>
	t.tracks.flatMap((track) => track.clips).find((c) => c.captionGroupId !== undefined);

describe("editing a caption", () => {
	it("re-times the words to match the new text", () => {
		const before = captionTimeline();
		const clip = captionClip(before);
		// Whatever the grouper produced, it carries word timing to begin with.
		expect((clip?.captionWords ?? []).length).toBeGreaterThan(0);

		const after = setClipContent(before, [clip?.id ?? ""], "alpha beta");
		const edited = captionClip(after);
		expect(edited?.content).toBe("alpha beta");
		expect(edited?.captionWords?.map((w) => w.text)).toEqual(["alpha", "beta"]);
	});

	it("keeps the words inside the clip and tiling without gaps", () => {
		const before = captionTimeline();
		const clip = captionClip(before);
		const duration = (clip?.endFrame ?? 0) - (clip?.startFrame ?? 0);

		const after = setClipContent(
			before,
			[clip?.id ?? ""],
			"a much longer replacement line here",
		);
		const words = captionClip(after)?.captionWords ?? [];

		expect(words.length).toBe(6);
		expect(words[0].startFrame).toBe(0);
		// The last word lands exactly on the clip's end, so nothing spills over.
		expect(words[words.length - 1].endFrame).toBe(duration);
		for (let i = 1; i < words.length; i++) {
			expect(words[i].startFrame).toBe(words[i - 1].endFrame);
		}
	});

	it("weights longer words with more time", () => {
		const before = captionTimeline();
		const clip = captionClip(before);
		const after = setClipContent(before, [clip?.id ?? ""], "a extraordinarily");
		const words = captionClip(after)?.captionWords ?? [];
		const span = (w: { startFrame: number; endFrame: number }) => w.endFrame - w.startFrame;
		expect(span(words[1])).toBeGreaterThan(span(words[0]));
	});

	it("leaves a plain text clip's content editable without inventing timings", () => {
		const t: TimelineModel = {
			...bare,
			tracks: [
				{
					id: "v1",
					name: "V1",
					kind: "video",
					muted: false,
					hidden: false,
					clips: [
						withDefaults({
							id: "title",
							name: "Title",
							mediaType: "text",
							startFrame: 0,
							endFrame: 60,
							content: "Hello",
						}),
					],
				},
			],
		};
		const after = setClipContent(t, ["title"], "Goodbye");
		const clip = after.tracks[0].clips[0];
		expect(clip.content).toBe("Goodbye");
		expect(clip.captionWords).toBeUndefined();
	});

	it("handles clearing the text", () => {
		const before = captionTimeline();
		const clip = captionClip(before);
		const after = setClipContent(before, [clip?.id ?? ""], "   ");
		expect(captionClip(after)?.captionWords).toEqual([]);
	});
});
