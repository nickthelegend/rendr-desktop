// Text layout and drawing, shared by the preview and the encoder.
//
// Text used to be drawn twice: the preview styled a <div> and let CSS wrap it,
// and the encoder split on "\n" and called fillText. The two agreed on short
// titles and nowhere else — a long caption wrapped onto two lines in the
// preview and ran off both edges of the exported file, tracking existed only
// on screen, and per-word captions were always one line in the export.
//
// So there is one implementation. `layoutText` is pure given a measure
// function, which is what makes the wrapping testable without a canvas, and
// `drawTextClip` is the only thing that ever paints a text clip: export.ts
// calls it into the frame being encoded, and the preview calls it into a
// <canvas> (panels/TextClipCanvas.tsx). Neither can drift from the other,
// because there is no other.

import type { ClipModel, TextStyle } from "./model";
import { isPerWord, resolveTextAnimation, type WordPaint, wordPaint } from "./textAnimation";

/** Baseline-to-baseline distance, as a multiple of the font size. */
export const LINE_HEIGHT = 1.15;

/** How much of the box a line may fill before it wraps, by default. */
export const DEFAULT_MAX_WIDTH = 0.92;

/** The active-word box's padding, as fractions of the font size. */
const ACTIVE_BOX_PAD_X = 0.16;
const ACTIVE_BOX_PAD_Y = 0.1;

export interface LaidWord {
	/** Index into the token list the layout was built from. */
	index: number;
	text: string;
	/** Left edge, relative to the block's centre. */
	x: number;
	/** Vertical centre of the word's line, relative to the block's centre. */
	y: number;
	width: number;
	line: number;
}

export interface LaidLine {
	/** Left edge, relative to the block's centre. */
	x: number;
	y: number;
	width: number;
	words: LaidWord[];
}

export interface TextLayout {
	lines: LaidLine[];
	/** Every word, in token order. */
	words: LaidWord[];
	/** The widest line. */
	width: number;
	/** From the top of the first line's em box to the bottom of the last. */
	height: number;
	lineHeight: number;
}

export interface LayoutOptions {
	/** Measures one run of text in the same units as every other length here. */
	measure: (text: string) => number;
	/** The column lines align within. */
	columnWidth: number;
	/** Lines wrap past this; Infinity never wraps. */
	wrapWidth: number;
	fontSize: number;
	/** Extra space between lines, added to LINE_HEIGHT × fontSize. */
	lineSpacing: number;
	alignment: TextStyle["alignment"];
	/** Extra space between words, on top of the font's own space. Default 0. */
	wordGap?: number;
}

/** A token, and whether a hard line break comes before it. */
export interface LayoutToken {
	text: string;
	breakBefore?: boolean;
}

/** Splits text into words, keeping "\n" as hard breaks. Blank lines survive. */
export function tokenize(text: string): LayoutToken[] {
	const tokens: LayoutToken[] = [];
	let pendingBreak = false;
	text.split("\n").forEach((paragraph, index) => {
		if (index > 0) pendingBreak = true;
		const words = paragraph.split(/\s+/).filter(Boolean);
		if (words.length === 0 && index > 0) {
			// An empty paragraph is a deliberate blank line; an empty token
			// carries it so the line count matches what was typed.
			tokens.push({ text: "", breakBefore: true });
			pendingBreak = false;
			return;
		}
		for (const word of words) {
			tokens.push({ text: word, breakBefore: pendingBreak || undefined });
			pendingBreak = false;
		}
	});
	return tokens;
}

/**
 * Greedy word wrap, then alignment and vertical centring.
 *
 * A word wider than the wrap width sits alone on its line rather than being
 * broken mid-word: a caption split inside a word reads as a typo.
 */
export function layoutText(tokens: readonly LayoutToken[], options: LayoutOptions): TextLayout {
	const { measure, fontSize } = options;
	const space = measure(" ") + (options.wordGap ?? 0);
	const lineHeight = fontSize * LINE_HEIGHT + options.lineSpacing;

	const rows: Array<Array<{ index: number; text: string; width: number }>> = [];
	let row: Array<{ index: number; text: string; width: number }> = [];
	let rowWidth = 0;
	tokens.forEach((token, index) => {
		const width = token.text ? measure(token.text) : 0;
		const next = row.length === 0 ? width : rowWidth + space + width;
		if (row.length > 0 && (token.breakBefore || next > options.wrapWidth)) {
			rows.push(row);
			row = [];
			rowWidth = 0;
		}
		rowWidth = row.length === 0 ? width : rowWidth + space + width;
		row.push({ index, text: token.text, width });
	});
	if (row.length > 0 || rows.length === 0) rows.push(row);

	const lines: LaidLine[] = [];
	const words: LaidWord[] = [];
	rows.forEach((entries, lineIndex) => {
		const visible = entries.filter((entry) => entry.text);
		const width =
			visible.reduce((sum, entry) => sum + entry.width, 0) +
			space * Math.max(0, visible.length - 1);
		const x =
			options.alignment === "left"
				? -options.columnWidth / 2
				: options.alignment === "right"
					? options.columnWidth / 2 - width
					: -width / 2;
		const y = (lineIndex - (rows.length - 1) / 2) * lineHeight;
		const line: LaidLine = { x, y, width, words: [] };
		let cursor = x;
		for (const entry of visible) {
			const word: LaidWord = {
				index: entry.index,
				text: entry.text,
				x: cursor,
				y,
				width: entry.width,
				line: lineIndex,
			};
			line.words.push(word);
			words.push(word);
			cursor += entry.width + space;
		}
		lines.push(line);
	});

	return {
		lines,
		words: words.sort((a, b) => a.index - b.index),
		width: Math.max(0, ...lines.map((line) => line.width)),
		height: (lines.length - 1) * lineHeight + fontSize,
		lineHeight,
	};
}

/** The CSS font shorthand both renderers set, with a fallback that exists. */
export function fontFor(style: Partial<TextStyle> | undefined, sizePx: number): string {
	const weight = style?.fontWeight ?? (style?.bold ? 700 : 400);
	const family = (style?.fontFamily ?? "").replace(/["\\]/g, "").trim();
	// The named family is quoted so a name starting with a digit still parses,
	// and system-ui backs it: "SF Pro Display" is not addressable by name on
	// most Macs, and without a fallback the canvas silently drops to a serif.
	const families = family ? `"${family}", system-ui, sans-serif` : "system-ui, sans-serif";
	return `${style?.italic ? "italic " : ""}${weight} ${sizePx}px ${families}`;
}

/**
 * Room between words for what is drawn outside the glyphs.
 *
 * A font's space is sized for bare glyphs. An outline eats into it from both
 * sides, a popped word grows into it, and a highlight box pads past it — and
 * with all three on, the short-form look's defining combination, neighbouring
 * words ran together into one block.
 */
function wordGap(
	style: Partial<TextStyle> | undefined,
	size: number,
	unit: number,
	perWord: boolean,
): number {
	let gap =
		(style?.strokeWidth ?? 0) > 0 && style?.strokeColor ? (style.strokeWidth ?? 0) * unit : 0;
	if (perWord && style?.activeWordBackground) gap += size * ACTIVE_BOX_PAD_X * 2;
	if (perWord && (style?.activeWordScale ?? 1) > 1)
		gap += ((style?.activeWordScale ?? 1) - 1) * size * 2;
	return gap;
}

/** Where and how big a frame is, for one draw. */
export interface TextDrawTarget {
	/** The pixel size being drawn into: the encoded frame, or the preview canvas. */
	width: number;
	height: number;
	/** The timeline's own height, which is what every point size is relative to. */
	timelineHeight: number;
	frame: number;
	fps: number;
	/** The clip's resolved opacity, fades included. */
	opacity: number;
}

function roundedRect(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	const radius = Math.max(0, Math.min(r, w / 2, h / 2));
	// roundRect is not everywhere; the manual path draws the same shape in the
	// encoder and the preview regardless.
	context.beginPath();
	context.moveTo(x + radius, y);
	context.lineTo(x + w - radius, y);
	context.quadraticCurveTo(x + w, y, x + w, y + radius);
	context.lineTo(x + w, y + h - radius);
	context.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
	context.lineTo(x + radius, y + h);
	context.quadraticCurveTo(x, y + h, x, y + h - radius);
	context.lineTo(x, y + radius);
	context.quadraticCurveTo(x, y, x + radius, y);
	context.closePath();
}

interface PaintedWord {
	word: LaidWord;
	/** What is drawn, which under typewriter may be a prefix of the word. */
	text: string;
	paint: WordPaint;
}

/**
 * Paints one text clip into a frame.
 *
 * `clip` must already be resolved at this frame (clipAtFrame), so keyframed
 * placement lands here the same way it does for footage. The context is left
 * as it was found.
 */
export function drawTextClip(
	context: CanvasRenderingContext2D,
	clip: ClipModel,
	target: TextDrawTarget,
): void {
	const { transform } = clip;
	const boxW = transform.width * target.width;
	const boxH = transform.height * target.height;
	context.save();
	// The same box transform renderFrame applies to every clip, so the encoder
	// can call drawTextInBox from inside its own and land on the same pixels.
	context.translate(
		(transform.centerX - transform.width / 2) * target.width + boxW / 2,
		(transform.centerY - transform.height / 2) * target.height + boxH / 2,
	);
	if (transform.rotation) context.rotate((transform.rotation * Math.PI) / 180);
	context.scale(transform.flipHorizontal ? -1 : 1, transform.flipVertical ? -1 : 1);
	context.translate(-boxW / 2, -boxH / 2);
	drawTextInBox(context, clip, target);
	context.restore();
}

/**
 * Paints a text clip with the context already mapped onto its box: the origin
 * at the box's top-left corner, rotation and flips applied.
 */
export function drawTextInBox(
	context: CanvasRenderingContext2D,
	clip: ClipModel,
	target: TextDrawTarget,
): void {
	const style = clip.textStyle;
	const anim = resolveTextAnimation(clip, target.frame, target.fps);
	const preset = style?.animation ?? "off";
	// Every length on a text style is in the timeline's own pixels, so a
	// preview canvas a third the size draws exactly a third the size.
	const unit = target.height / Math.max(1, target.timelineHeight);
	const size = (style?.fontSize ?? 48) * unit;
	if (size <= 0) return;
	const { transform } = clip;
	const boxW = transform.width * target.width;
	const boxH = transform.height * target.height;
	const cased = (value: string) => (style?.uppercase ? value.toUpperCase() : value);

	context.save();
	context.filter = "none";
	// Entrance offset and scale apply about the block's centre.
	context.translate(boxW / 2, boxH / 2 + anim.offsetY * boxH);
	context.scale(anim.scale, anim.scale);

	context.font = fontFor(style, size);
	context.textBaseline = "middle";
	context.textAlign = "left";
	// Canvas tracking matches CSS letter-spacing: space after every glyph, and
	// counted by measureText — so the layout and the draw agree on widths.
	const tracking = (style?.tracking ?? 0) * unit;
	const spaced = context as CanvasRenderingContext2D & { letterSpacing?: string };
	if ("letterSpacing" in spaced) spaced.letterSpacing = `${tracking}px`;

	const perWord = isPerWord(preset) && anim.words.length > 0;
	const tokens: LayoutToken[] = perWord
		? anim.words.map((word) => ({ text: cased(word.text) }))
		: tokenize(cased(clip.content ?? ""));
	const columnWidth = boxW * Math.min(1, Math.max(0.05, style?.maxWidth ?? DEFAULT_MAX_WIDTH));
	const layout = layoutText(tokens, {
		measure: (text) => context.measureText(text).width,
		columnWidth,
		wrapWidth: style?.wrap === false ? Number.POSITIVE_INFINITY : columnWidth,
		fontSize: size,
		// A highlight box and a popped word both run taller than the line;
		// without the extra lead they cover the top of the line below.
		lineSpacing:
			(style?.lineSpacing ?? 0) * unit +
			(perWord && style?.activeWordBackground ? size * ACTIVE_BOX_PAD_Y * 2 : 0) +
			(perWord ? Math.max(0, (style?.activeWordScale ?? 1) - 1) * size : 0),
		alignment: style?.alignment ?? "center",
		wordGap: wordGap(style, size, unit, perWord),
	});

	// Typewriter reveals characters of the full layout rather than laying out
	// the visible prefix, so words never jump between lines as they type.
	let remaining =
		anim.visibleText === null
			? Number.POSITIVE_INFINITY
			: anim.visibleText.replace(/\s+/g, "").length;
	const baseOpacity = target.opacity * anim.opacity;
	const painted: PaintedWord[] = [];
	for (const word of layout.words) {
		if (remaining <= 0) break;
		const text = remaining >= word.text.length ? word.text : word.text.slice(0, remaining);
		remaining -= word.text.length;
		const state = perWord ? anim.words[word.index] : null;
		const paint: WordPaint = state
			? wordPaint(preset, state, style)
			: { color: style?.color ?? "#FFFFFF", opacity: 1, scale: 1, background: null };
		if (paint.opacity <= 0) continue;
		painted.push({ word, text, paint });
	}
	// The active word goes last, so a popped word sits over its neighbours
	// instead of under them.
	painted.sort((a, b) => Number(a.paint.scale > 1) - Number(b.paint.scale > 1));

	// 1. The plate, sized from the whole laid-out block.
	if (style?.backgroundColor && layout.width > 0) {
		const pad = size * (style.backgroundPadding ?? 0.35);
		const left = Math.min(...layout.lines.filter((l) => l.width > 0).map((l) => l.x));
		const w = layout.width + pad * 2;
		const h = layout.height + pad * 2;
		context.globalAlpha = baseOpacity * (style.backgroundOpacity ?? 1);
		context.fillStyle = style.backgroundColor;
		roundedRect(context, left - pad, -h / 2, w, h, h * (style.backgroundRadius ?? 0.25));
		context.fill();
	}

	const atWord = (entry: PaintedWord, draw: (x: number) => void) => {
		const { word, paint } = entry;
		context.save();
		context.globalAlpha = baseOpacity * paint.opacity;
		if (paint.scale !== 1) {
			const cx = word.x + word.width / 2;
			context.translate(cx, word.y);
			context.scale(paint.scale, paint.scale);
			context.translate(-cx, -word.y);
		}
		draw(word.x);
		context.restore();
	};

	// 2. Highlight boxes behind active words.
	for (const entry of painted) {
		if (!entry.paint.background) continue;
		atWord(entry, (x) => {
			const padX = size * ACTIVE_BOX_PAD_X;
			const padY = size * ACTIVE_BOX_PAD_Y;
			context.fillStyle = entry.paint.background ?? "";
			roundedRect(
				context,
				x - padX,
				entry.word.y - size / 2 - padY,
				entry.word.width + padX * 2,
				size + padY * 2,
				size * 0.22,
			);
			context.fill();
		});
	}

	// Canvas shadows ignore the current transform, so their lengths are scaled
	// by it by hand. In the preview the camera is a CSS transform on the canvas
	// and in the export it is on the context; either way the shadow ends up the
	// same size relative to the glyphs.
	const matrix = context.getTransform();
	const contextScale = Math.hypot(matrix.a, matrix.b) || 1;
	const hasShadow = Boolean(style?.shadowColor);
	const applyShadow = () => {
		context.shadowColor = style?.shadowColor ?? "transparent";
		context.shadowBlur = (style?.shadowBlur ?? 0) * unit * contextScale;
		context.shadowOffsetX = (style?.shadowOffsetX ?? 0) * unit * contextScale;
		context.shadowOffsetY = (style?.shadowOffsetY ?? 0) * unit * contextScale;
	};
	const stroke = (style?.strokeWidth ?? 0) > 0 && style?.strokeColor;

	// 3. Outlines, carrying the shadow. Stroked at twice the width behind the
	// fill, so the visible outline is exactly strokeWidth outside each glyph.
	if (stroke) {
		for (const entry of painted) {
			atWord(entry, (x) => {
				if (hasShadow) applyShadow();
				context.lineJoin = "round";
				context.miterLimit = 2;
				context.lineWidth = (style?.strokeWidth ?? 0) * unit * 2;
				context.strokeStyle = style?.strokeColor ?? "#000000";
				context.strokeText(entry.text, x, entry.word.y);
			});
		}
	}

	// 4. Fills. With no outline to carry it, the shadow goes on the fill.
	for (const entry of painted) {
		atWord(entry, (x) => {
			if (hasShadow && !stroke) applyShadow();
			context.fillStyle = entry.paint.color;
			context.fillText(entry.text, x, entry.word.y);
		});
	}

	context.restore();
}
