import { describe, expect, it } from "vitest";

import { type ClipModel, DEFAULT_TEXT_STYLE, type TextStyle, withDefaults } from "./model";
import { drawTextClip, fontFor, LINE_HEIGHT, layoutText, tokenize } from "./textLayout";

// jsdom has no 2D context, so the draw is checked through a recording fake:
// every glyph run is 10 units per character, and each call is logged with the
// state it was made under. What matters is what gets painted where, in what
// order — the same calls the preview canvas and the encoder both receive.

const measure = (text: string) => text.length * 10;

const layout = (text: string, over: Partial<Parameters<typeof layoutText>[1]> = {}) =>
	layoutText(tokenize(text), {
		measure,
		columnWidth: 200,
		wrapWidth: 200,
		fontSize: 40,
		lineSpacing: 0,
		alignment: "center",
		...over,
	});

describe("layoutText", () => {
	it("wraps at the column width instead of running off the edge", () => {
		// "aaaa bbbb cccc dddd" is 190 wide on one line; a 100 column forces two.
		const result = layout("aaaa bbbb cccc dddd", { columnWidth: 100, wrapWidth: 100 });
		expect(result.lines.map((line) => line.words.map((word) => word.text))).toEqual([
			["aaaa", "bbbb"],
			["cccc", "dddd"],
		]);
		expect(result.width).toBe(90);
	});

	it("keeps a word wider than the column whole, on a line of its own", () => {
		const result = layout("a supercalifragilistic b", { columnWidth: 50, wrapWidth: 50 });
		expect(result.lines.map((line) => line.words.length)).toEqual([1, 1, 1]);
	});

	it("honours hard breaks and blank lines", () => {
		const result = layout("one\n\ntwo");
		expect(result.lines).toHaveLength(3);
		expect(result.lines[1].words).toHaveLength(0);
	});

	it("never wraps when the wrap width is infinite", () => {
		const result = layout("aaaa bbbb cccc dddd", {
			columnWidth: 50,
			wrapWidth: Number.POSITIVE_INFINITY,
		});
		expect(result.lines).toHaveLength(1);
	});

	it("aligns lines within the column", () => {
		const left = layout("ab", { alignment: "left" });
		const right = layout("ab", { alignment: "right" });
		const center = layout("ab");
		expect(left.lines[0].x).toBe(-100);
		expect(right.lines[0].x).toBe(100 - 20);
		expect(center.lines[0].x).toBe(-10);
	});

	it("centres the block vertically and adds line spacing between lines", () => {
		const result = layout("a\nb", { lineSpacing: 10 });
		const step = 40 * LINE_HEIGHT + 10;
		expect(result.lines[0].y).toBeCloseTo(-step / 2);
		expect(result.lines[1].y).toBeCloseTo(step / 2);
		expect(result.height).toBeCloseTo(step + 40);
	});

	it("places words left to right with a space between", () => {
		const result = layout("ab cd", { alignment: "left" });
		expect(result.words.map((word) => word.x)).toEqual([-100, -100 + 20 + 10]);
	});
});

describe("fontFor", () => {
	it("quotes the family and backs it with the system font", () => {
		expect(fontFor({ ...DEFAULT_TEXT_STYLE }, 40)).toBe(
			'700 40px "SF Pro Display", system-ui, sans-serif',
		);
	});

	it("lets fontWeight override bold", () => {
		expect(fontFor({ ...DEFAULT_TEXT_STYLE, fontWeight: 900, italic: true }, 10)).toMatch(
			/^italic 900 10px/,
		);
	});
});

interface Call {
	op: string;
	text?: string;
	x?: number;
	y?: number;
	fill?: string;
	alpha: number;
	lineWidth: number;
	shadow: string;
	scale: number;
}

/** A 2D context that records what it is asked to paint. */
function recordingContext() {
	const calls: Call[] = [];
	const stack: Array<{ alpha: number; scale: number; shadow: string }> = [];
	const state = {
		globalAlpha: 1,
		fillStyle: "#000" as string,
		strokeStyle: "#000" as string,
		lineWidth: 1,
		shadowColor: "transparent",
		shadowBlur: 0,
		shadowOffsetX: 0,
		shadowOffsetY: 0,
		font: "",
		letterSpacing: "0px",
		textAlign: "left",
		textBaseline: "alphabetic",
		filter: "none",
		lineJoin: "miter",
		miterLimit: 10,
		scaleNow: 1,
	};
	const log = (op: string, extra: Partial<Call> = {}) =>
		calls.push({
			op,
			alpha: state.globalAlpha,
			lineWidth: state.lineWidth,
			shadow: state.shadowColor,
			scale: state.scaleNow,
			...extra,
		});
	const context = Object.assign(state, {
		save: () =>
			stack.push({
				alpha: state.globalAlpha,
				scale: state.scaleNow,
				shadow: state.shadowColor,
			}),
		restore: () => {
			const top = stack.pop();
			if (!top) return;
			state.globalAlpha = top.alpha;
			state.scaleNow = top.scale;
			state.shadowColor = top.shadow;
		},
		translate: () => undefined,
		rotate: () => undefined,
		scale: (x: number) => {
			state.scaleNow *= Math.abs(x);
		},
		getTransform: () => ({ a: state.scaleNow, b: 0 }),
		measureText: (text: string) => ({ width: text.length * 10 }),
		beginPath: () => undefined,
		moveTo: () => undefined,
		lineTo: () => undefined,
		quadraticCurveTo: () => undefined,
		closePath: () => undefined,
		fill: () => log("fill", { fill: state.fillStyle }),
		fillText: (text: string, x: number, y: number) =>
			log("fillText", { text, x, y, fill: state.fillStyle }),
		strokeText: (text: string, x: number, y: number) =>
			log("strokeText", { text, x, y, fill: state.strokeStyle }),
	});
	return { context: context as unknown as CanvasRenderingContext2D, calls };
}

function textClip(style: Partial<TextStyle>, over: Partial<ClipModel> = {}): ClipModel {
	return withDefaults({
		id: "t",
		name: "t",
		mediaType: "text",
		startFrame: 0,
		endFrame: 90,
		content: "one two three",
		textStyle: { ...DEFAULT_TEXT_STYLE, ...style },
		...over,
	});
}

const target = { width: 1000, height: 1000, timelineHeight: 1000, frame: 10, fps: 30, opacity: 1 };

const karaokeWords = [
	{ text: "one", startFrame: 0, endFrame: 5 },
	{ text: "two", startFrame: 5, endFrame: 15 },
	{ text: "three", startFrame: 15, endFrame: 30 },
];

describe("drawTextClip", () => {
	it("draws the outline behind the fill, at twice the width so strokeWidth shows outside", () => {
		const { context, calls } = recordingContext();
		drawTextClip(context, textClip({ strokeColor: "#000000", strokeWidth: 5 }), target);
		const strokes = calls.filter((call) => call.op === "strokeText");
		const fills = calls.filter((call) => call.op === "fillText");
		expect(strokes.map((call) => call.text)).toEqual(["one", "two", "three"]);
		expect(strokes[0].lineWidth).toBe(10);
		expect(calls.indexOf(strokes[2])).toBeLessThan(calls.indexOf(fills[0]));
	});

	it("scales point sizes to the frame, so a half-size preview draws half-size", () => {
		const { context, calls } = recordingContext();
		drawTextClip(context, textClip({ strokeColor: "#000000", strokeWidth: 5 }), {
			...target,
			width: 500,
			height: 500,
		});
		expect(calls.find((call) => call.op === "strokeText")?.lineWidth).toBe(5);
	});

	it("puts the shadow on the outline when there is one, and on the fill otherwise", () => {
		const outlined = recordingContext();
		drawTextClip(
			outlined.context,
			textClip({ strokeColor: "#000000", strokeWidth: 4, shadowColor: "#00000080" }),
			target,
		);
		expect(outlined.calls.find((call) => call.op === "strokeText")?.shadow).toBe("#00000080");
		expect(outlined.calls.find((call) => call.op === "fillText")?.shadow).toBe("transparent");

		const plain = recordingContext();
		drawTextClip(plain.context, textClip({ shadowColor: "#00000080" }), target);
		expect(plain.calls.find((call) => call.op === "fillText")?.shadow).toBe("#00000080");
	});

	it("pops the spoken word, boxes it, and draws it last", () => {
		const { context, calls } = recordingContext();
		drawTextClip(
			context,
			textClip(
				{
					animation: "karaoke",
					highlightColor: "#FFE14D",
					activeWordScale: 1.15,
					activeWordBackground: "#7C3AED",
				},
				{ captionWords: karaokeWords },
			),
			target,
		);
		const fills = calls.filter((call) => call.op === "fillText");
		const spoken = fills[fills.length - 1];
		expect(spoken.text).toBe("two");
		expect(spoken.fill).toBe("#FFE14D");
		expect(spoken.scale).toBeGreaterThan(1);
		expect(fills.find((call) => call.text === "one")?.scale).toBe(1);
		const box = calls.find((call) => call.op === "fill" && call.fill === "#7C3AED");
		expect(box).toBeDefined();
		// The box is under every word, not just under the spoken one.
		expect(calls.indexOf(box as Call)).toBeLessThan(calls.indexOf(fills[0]));
	});

	it("fills the line in two tones when spokenColor is set", () => {
		const { context, calls } = recordingContext();
		drawTextClip(
			context,
			textClip(
				{
					animation: "karaoke",
					color: "#FFFFFF",
					highlightColor: "#FFE14D",
					spokenColor: "#22C55E",
					upcomingOpacity: 1,
				},
				{ captionWords: karaokeWords },
			),
			target,
		);
		const byText = Object.fromEntries(
			calls.filter((call) => call.op === "fillText").map((call) => [call.text, call]),
		);
		expect(byText.one.fill).toBe("#22C55E");
		expect(byText.two.fill).toBe("#FFE14D");
		expect(byText.three.fill).toBe("#FFFFFF");
		expect(byText.three.alpha).toBe(1);
	});

	it("wraps per-word captions, which used to be forced onto one line", () => {
		const { context, calls } = recordingContext();
		// A 100-unit box at maxWidth 1: "one two" is 70 wide, "three" goes below.
		drawTextClip(
			context,
			textClip(
				{ animation: "karaoke", maxWidth: 1 },
				{
					captionWords: karaokeWords,
					transform: {
						centerX: 0.5,
						centerY: 0.5,
						width: 0.1,
						height: 0.1,
						rotation: 0,
						flipHorizontal: false,
						flipVertical: false,
					},
				},
			),
			{ ...target, timelineHeight: 4000 },
		);
		const ys = new Set(
			calls.filter((call) => call.op === "fillText").map((call) => Math.round(call.y ?? 0)),
		);
		expect(ys.size).toBe(2);
	});

	it("types out over the full layout, so words do not jump lines as they appear", () => {
		const { context, calls } = recordingContext();
		// Frame 10 of 90 under typewriter shows round(10/59 × 13) = 2 characters.
		drawTextClip(context, textClip({ animation: "typewriter" }), target);
		const fills = calls.filter((call) => call.op === "fillText");
		expect(fills.map((call) => call.text)).toEqual(["on"]);
		// Drawn where the whole line's first word sits, not re-centred.
		expect(fills[0].x).toBe(-((3 + 1 + 3 + 1 + 5) * 10) / 2);
	});

	it("paints a plate under the text when backgroundColor is set", () => {
		const { context, calls } = recordingContext();
		drawTextClip(
			context,
			textClip({ backgroundColor: "#000000", backgroundOpacity: 0.5 }),
			target,
		);
		expect(calls[0]).toMatchObject({ op: "fill", fill: "#000000", alpha: 0.5 });
	});
});
