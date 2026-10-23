// The text and caption tools, driven through their real handlers against a
// fake editor: what matters is the timeline they commit and the receipt they
// hand back, so those are what's checked.

import { describe, expect, it, vi } from "vitest";

import { CAPTION_PRESET_NAMES } from "../../electron/mcp/toolDefinitions";
import { createAgentTools } from "./agentTools";
import { captionClips, placeCaptions } from "./captions";
import { type ClipModel, withDefaults } from "./model";
import type { TimelineModel } from "./reducers";
import type { EditorApi } from "./state";

function footage(): ClipModel {
	return withDefaults({
		id: "cam",
		name: "camera.mp4",
		mediaType: "video",
		assetId: "a",
		startFrame: 0,
		endFrame: 300,
	});
}

function timelineWith(clips: ClipModel[] = [footage()]): TimelineModel {
	return {
		id: "tl",
		name: "Main",
		fps: 30,
		width: 1080,
		height: 1920,
		tracks: [
			{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips },
			{ id: "a1", name: "A1", kind: "audio", muted: false, hidden: false, clips: [] },
		],
	};
}

function fakeApi(timeline: TimelineModel) {
	const commit = vi.fn();
	const applyCaptions = vi.fn(() => "g-new");
	const api = {
		state: { assets: [], playhead: 0 },
		timeline,
		commit,
		applyCaptions,
		transcribe: vi.fn(),
	} as unknown as EditorApi;
	return { tools: createAgentTools(api), commit, applyCaptions };
}

/** Applies what a handler committed to the timeline it started from. */
function committed(commit: ReturnType<typeof vi.fn>, from: TimelineModel): TimelineModel {
	expect(commit).toHaveBeenCalledTimes(1);
	const reduce = commit.mock.calls[0][1] as (t: TimelineModel) => TimelineModel;
	return reduce(from);
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const payload = (result: unknown) => JSON.parse((result as Result).content[0].text ?? "{}");
const isError = (result: unknown) => (result as Result).isError === true;

const textClips = (timeline: TimelineModel) =>
	timeline.tracks.flatMap((track) => track.clips).filter((clip) => clip.mediaType === "text");

describe("add_texts", () => {
	it("honours each entry's style, transform and animation", async () => {
		const start = timelineWith();
		const { tools, commit } = fakeApi(start);
		const result = await tools.add_texts({
			entries: [
				{
					startFrame: 0,
					endFrame: 60,
					content: "Hook line",
					style: { fontName: "Inter", outline: { width: 6 }, fontSize: 90 },
					transform: { centerY: 0.3, width: 0.8 },
					animation: "bounce",
				},
			],
		});
		expect(isError(result)).toBe(false);
		const [clip] = textClips(committed(commit, start));
		expect(clip.textStyle).toMatchObject({
			fontFamily: "Inter",
			fontSize: 90,
			strokeColor: "#000000",
			strokeWidth: 6,
			animation: "bounce",
		});
		expect(clip.transform).toMatchObject({ centerY: 0.3, width: 0.8, centerX: 0.5 });
	});

	it("stacks text on a new top track, above the footage", async () => {
		const start = timelineWith();
		const { tools, commit } = fakeApi(start);
		await tools.add_texts({
			entries: [
				{ startFrame: 0, endFrame: 60, content: "a" },
				{ startFrame: 30, endFrame: 90, content: "b" },
				{ startFrame: 100, endFrame: 160, content: "c" },
			],
		});
		const next = committed(commit, start);
		// Two overlapping entries need two lanes; the third shares the first.
		expect(next.tracks.map((track) => track.clips.length)).toEqual([1, 2, 1, 0]);
		expect(next.tracks[2].id).toBe("v1");
	});

	it("places entries on the named track, and refuses one that is occupied", async () => {
		const start = timelineWith();
		start.tracks.splice(1, 0, {
			id: "v2",
			name: "V2",
			kind: "video",
			muted: false,
			hidden: false,
			clips: [],
		});
		const { tools, commit } = fakeApi(start);
		await tools.add_texts({
			entries: [{ startFrame: 0, endFrame: 60, content: "a", trackIndex: 1 }],
		});
		expect(committed(commit, start).tracks[1].clips[0].content).toBe("a");

		const blocked = await fakeApi(start).tools.add_texts({
			entries: [{ startFrame: 0, endFrame: 60, content: "a", trackIndex: 0 }],
		});
		expect(isError(blocked)).toBe(true);
		const audio = await fakeApi(start).tools.add_texts({
			entries: [{ startFrame: 0, endFrame: 60, content: "a", trackIndex: 2 }],
		});
		expect(isError(audio)).toBe(true);
	});

	it("refuses trackIndex on some entries but not others", async () => {
		const { tools } = fakeApi(timelineWith());
		const result = await tools.add_texts({
			entries: [
				{ startFrame: 0, endFrame: 60, content: "a", trackIndex: 0 },
				{ startFrame: 0, endFrame: 60, content: "b" },
			],
		});
		expect(isError(result)).toBe(true);
	});

	it("reports style keys it could not use", async () => {
		const { tools } = fakeApi(timelineWith());
		const result = await tools.add_texts({
			entries: [{ startFrame: 0, endFrame: 60, content: "a", style: { underline: true } }],
		});
		expect(payload(result).ignoredStyleKeys).toEqual(["entries[0].style.underline"]);
	});
});

describe("update_text", () => {
	const withTitle = () => {
		const title = withDefaults({
			id: "t",
			name: "t",
			mediaType: "text",
			startFrame: 0,
			endFrame: 60,
			content: "Title",
		});
		return timelineWith([title]);
	};

	it("maps schema names instead of storing them raw", async () => {
		const start = withTitle();
		const { tools, commit } = fakeApi(start);
		const result = await tools.update_text({
			clipIds: ["t"],
			style: { fontName: "Inter", shadow: { blur: 4 }, widthScale: 1.3 },
		});
		const style = textClips(committed(commit, start))[0].textStyle as unknown as Record<
			string,
			unknown
		>;
		expect(style.fontFamily).toBe("Inter");
		expect(style.shadowBlur).toBe(4);
		expect(style).not.toHaveProperty("fontName");
		expect(style).not.toHaveProperty("shadow");
		expect(style).not.toHaveProperty("widthScale");
		expect(payload(result).ignoredStyleKeys).toEqual(["style.widthScale"]);
	});

	it("fails on an invalid value rather than storing it", async () => {
		const { tools, commit } = fakeApi(withTitle());
		expect(isError(await tools.update_text({ clipIds: ["t"], style: { color: "red" } }))).toBe(
			true,
		);
		expect(commit).not.toHaveBeenCalled();
	});
});

describe("style_captions", () => {
	const captioned = () =>
		placeCaptions(
			timelineWith(),
			[{ id: "c", startMs: 0, endMs: 3000, text: "this is a short form caption" }],
			{ groupId: "g", toFrame: (ms) => (ms / 1000) * 30 },
		).timeline;

	it("knows every preset the schema advertises", async () => {
		for (const preset of CAPTION_PRESET_NAMES) {
			const result = await fakeApi(captioned()).tools.style_captions({ preset });
			expect(isError(result), preset).toBe(false);
		}
	});

	it("applies bold_pop and lets explicit fields win", async () => {
		const start = captioned();
		const { tools, commit } = fakeApi(start);
		await tools.style_captions({ preset: "bold_pop", highlightColor: "#22C55E" });
		const [clip] = captionClips(committed(commit, start), "g");
		expect(clip.textStyle).toMatchObject({
			fontWeight: 900,
			uppercase: true,
			strokeColor: "#000000",
			activeWordScale: 1.15,
			highlightColor: "#22C55E",
		});
	});

	it("clears the last look's outline when switching to a preset without one", async () => {
		const start = captioned();
		const first = fakeApi(start);
		await first.tools.style_captions({ preset: "bold_pop" });
		const popped = committed(first.commit, start);
		const second = fakeApi(popped);
		await second.tools.style_captions({ preset: "subtle" });
		const [clip] = captionClips(committed(second.commit, popped), "g");
		expect(clip.textStyle?.strokeWidth).toBeUndefined();
		expect(clip.textStyle?.activeWordScale).toBeUndefined();
	});

	it("re-cuts the group to N words a caption", async () => {
		const start = captioned();
		const { tools, commit } = fakeApi(start);
		const result = await tools.style_captions({ preset: "highlight_box", wordsPerCaption: 2 });
		const clips = captionClips(committed(commit, start), "g");
		expect(clips.map((clip) => clip.content)).toEqual(["this is", "a short", "form caption"]);
		expect(clips.every((clip) => clip.textStyle?.activeWordBackground === "#7C3AED")).toBe(
			true,
		);
		expect(payload(result).clipCount).toBe(3);
	});

	it("rejects a bad colour with a reason", async () => {
		const result = await fakeApi(captioned()).tools.style_captions({ color: "yellow" });
		expect(isError(result)).toBe(true);
	});
});

describe("add_captions", () => {
	it("passes the parsed style and word cap through to placement", async () => {
		const { tools, applyCaptions } = fakeApi(timelineWith());
		const result = await tools.add_captions({
			subtitles: "1\n00:00:00,000 --> 00:00:02,000\nhello there friend\n",
			wordsPerCaption: 2,
			style: { outline: { width: 5 }, bogus: 1 },
			animation: "karaoke",
		});
		expect(isError(result)).toBe(false);
		const placement = (applyCaptions.mock.calls[0] as unknown[])[2] as {
			style: Record<string, unknown>;
			maxWords: number;
		};
		expect(placement.maxWords).toBe(2);
		expect(placement.style).toMatchObject({ strokeWidth: 5, animation: "karaoke" });
		expect(placement.style).not.toHaveProperty("bogus");
		expect(payload(result).ignoredStyleKeys).toEqual(["style.bogus"]);
	});
});
