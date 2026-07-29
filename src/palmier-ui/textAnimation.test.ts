import { describe, expect, it } from "vitest";

import { type ClipModel, withDefaults } from "./model";
import { isPerWord, resolveTextAnimation, wordColor } from "./textAnimation";

function textClip(over: Partial<ClipModel> = {}): ClipModel {
	return withDefaults({
		id: "t1",
		name: "Title",
		mediaType: "text",
		startFrame: 100,
		endFrame: 190,
		content: "one two three",
		...over,
	});
}

const withPreset = (animation: string, over: Partial<ClipModel> = {}) =>
	textClip({
		...over,
		textStyle: { ...textClip().textStyle!, animation: animation as never },
	});

describe("resolveTextAnimation", () => {
	it("is neutral outside the clip's own span", () => {
		const clip = withPreset("fade");
		expect(resolveTextAnimation(clip, 50, 30).opacity).toBe(1);
		expect(resolveTextAnimation(clip, 500, 30).opacity).toBe(1);
	});

	it("leaves everything alone when the preset is off", () => {
		expect(resolveTextAnimation(withPreset("off"), 105, 30)).toMatchObject({
			opacity: 1,
			offsetY: 0,
			scale: 1,
		});
	});

	it("fades in and reaches full opacity", () => {
		const clip = withPreset("fade");
		expect(resolveTextAnimation(clip, 100, 30).opacity).toBe(0);
		expect(resolveTextAnimation(clip, 103, 30).opacity).toBeGreaterThan(0);
		expect(resolveTextAnimation(clip, 160, 30).opacity).toBe(1);
	});

	it("slides up as it fades, settling at zero offset", () => {
		const clip = withPreset("slide_up");
		expect(resolveTextAnimation(clip, 100, 30).offsetY).toBeGreaterThan(0);
		expect(resolveTextAnimation(clip, 160, 30).offsetY).toBeCloseTo(0, 5);
	});

	it("overshoots on pop, then settles at 1", () => {
		const clip = withPreset("pop");
		const samples = [102, 104, 106, 108, 110].map(
			(frame) => resolveTextAnimation(clip, frame, 30).scale,
		);
		expect(Math.max(...samples)).toBeGreaterThan(1);
		expect(resolveTextAnimation(clip, 160, 30).scale).toBeCloseTo(1, 5);
	});

	it("reveals characters for typewriter and holds the full text", () => {
		const clip = withPreset("typewriter");
		expect(resolveTextAnimation(clip, 100, 30).visibleText).toBe("");
		const mid = resolveTextAnimation(clip, 130, 30).visibleText ?? "";
		expect(mid.length).toBeGreaterThan(0);
		expect(mid.length).toBeLessThan("one two three".length);
		expect(resolveTextAnimation(clip, 185, 30).visibleText).toBe("one two three");
	});

	it("scales the entrance with the project's frame rate", () => {
		const clip = withPreset("fade");
		// Six frames in: a third of the way at 30fps, a sixth at 60fps.
		const at30 = resolveTextAnimation(clip, 106, 30).opacity;
		const at60 = resolveTextAnimation(clip, 106, 60).opacity;
		expect(at30).toBeGreaterThan(at60);
	});

	it("degrades word presets to a fade when there is no word timing", () => {
		const clip = withPreset("karaoke");
		const state = resolveTextAnimation(clip, 103, 30);
		expect(state.words).toEqual([]);
		expect(state.opacity).toBeGreaterThan(0);
		expect(state.opacity).toBeLessThan(1);
	});

	it("marks the spoken word active and earlier words revealed", () => {
		const clip = withPreset("karaoke", {
			captionWords: [
				{ text: "one", startFrame: 0, endFrame: 10 },
				{ text: "two", startFrame: 10, endFrame: 20 },
				{ text: "three", startFrame: 20, endFrame: 30 },
			],
		});
		const state = resolveTextAnimation(clip, 115, 30);
		expect(state.words.map((word) => word.active)).toEqual([false, true, false]);
		expect(state.words.map((word) => word.revealed)).toEqual([true, true, false]);
	});
});

describe("wordColor", () => {
	const word = { text: "hi", progress: 1, active: true, revealed: true };

	it("highlights the spoken word for karaoke and keeps the rest visible", () => {
		expect(wordColor("karaoke", word, "#fff", "#f90").color).toBe("#f90");
		expect(wordColor("karaoke", { ...word, active: false }, "#fff", "#f90").color).toBe("#fff");
		expect(
			wordColor("karaoke", { ...word, revealed: false }, "#fff", "#f90").opacity,
		).toBeLessThan(1);
	});

	it("hides unreached words for word_by_word rather than tinting them", () => {
		expect(
			wordColor("word_by_word", { ...word, revealed: false }, "#fff", "#f90").opacity,
		).toBe(0);
		expect(wordColor("word_by_word", word, "#fff", "#f90").color).toBe("#fff");
	});
});

describe("isPerWord", () => {
	it("is true only for the presets that draw word by word", () => {
		expect(isPerWord("karaoke")).toBe(true);
		expect(isPerWord("word_by_word")).toBe(true);
		expect(isPerWord("fade")).toBe(false);
		expect(isPerWord("off")).toBe(false);
	});
});
