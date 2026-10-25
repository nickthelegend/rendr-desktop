// Text animation.
//
// The presets were a dropdown that stored a value and animated nothing. This
// resolves a preset to concrete per-frame state, and both the preview and the
// canvas export read it — so what you see is what encodes. Keeping it a pure
// function of (preset, frame) rather than CSS keyframes is what makes that
// possible: the exporter has no CSS engine, only a 2D context.

import type { ClipModel, TextAnimation, TextStyle } from "./model";

/** How long an entrance runs, in frames at 30fps. Scaled by the real fps. */
const ENTRANCE_FRAMES = 12;

export interface WordState {
	text: string;
	/** 0–1; below 1 means the word is still arriving. */
	progress: number;
	/** True while this word is the one being spoken. */
	active: boolean;
	/** True once the word has been reached at all. */
	revealed: boolean;
}

export interface TextRender {
	/** Whole-block opacity multiplier. */
	opacity: number;
	/** Vertical offset as a fraction of the block's own height. */
	offsetY: number;
	/** Uniform scale about the block's centre. */
	scale: number;
	/** Per-word state; empty when the preset animates the block as a whole. */
	words: WordState[];
	/** Text to draw when the preset reveals characters rather than words. */
	visibleText: string | null;
}

const NEUTRAL: TextRender = {
	opacity: 1,
	offsetY: 0,
	scale: 1,
	words: [],
	visibleText: null,
};

function easeOut(t: number): number {
	return 1 - (1 - t) ** 3;
}

/** Overshoot-and-settle, for `pop`. */
function easeBack(t: number): number {
	const c = 1.70158 + 1;
	return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

/** A ball dropped onto the floor: three diminishing rebounds, then rest. */
function easeBounce(t: number): number {
	const n = 7.5625;
	const d = 2.75;
	if (t < 1 / d) return n * t * t;
	if (t < 2 / d) return n * (t - 1.5 / d) ** 2 + 0.75;
	if (t < 2.5 / d) return n * (t - 2.25 / d) ** 2 + 0.9375;
	return n * (t - 2.625 / d) ** 2 + 0.984375;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Resolves a text clip's animation at a timeline frame.
 *
 * `frame` is absolute; the clip's own start is subtracted here so callers don't
 * have to agree on a convention.
 */
export function resolveTextAnimation(clip: ClipModel, frame: number, fps: number): TextRender {
	const preset: TextAnimation = clip.textStyle?.animation ?? "off";
	const local = frame - clip.startFrame;
	const duration = clip.endFrame - clip.startFrame;
	if (local < 0 || local >= duration) return NEUTRAL;

	// Entrances scale with the project's frame rate so 60fps isn't twice as fast.
	const entrance = Math.max(1, Math.round((ENTRANCE_FRAMES * fps) / 30));
	const t = clamp01(local / entrance);

	switch (preset) {
		case "off":
			return NEUTRAL;

		case "fade":
			return { ...NEUTRAL, opacity: easeOut(t) };

		case "slide_up":
			return { ...NEUTRAL, opacity: easeOut(t), offsetY: (1 - easeOut(t)) * 0.6 };

		case "pop":
			// Scale overshoots; opacity settles faster so it doesn't ghost.
			return { ...NEUTRAL, opacity: clamp01(t * 2), scale: 0.7 + easeBack(t) * 0.3 };

		case "bounce": {
			// Drops in from above and settles. It runs half again as long as the
			// other entrances, because the rebounds need room to read as rebounds
			// rather than as a jitter.
			const fall = clamp01(local / Math.round(entrance * 1.5));
			return {
				...NEUTRAL,
				opacity: clamp01(fall * 4),
				offsetY: -(1 - easeBounce(fall)) * 0.6,
			};
		}

		case "typewriter": {
			const text = clip.content ?? "";
			// Reveal across the first two thirds, then hold.
			const revealFrames = Math.max(1, Math.round(duration * 0.66));
			const shown = Math.round(clamp01(local / revealFrames) * text.length);
			return { ...NEUTRAL, visibleText: text.slice(0, shown) };
		}

		case "word_by_word":
		case "karaoke": {
			const words = clip.captionWords ?? [];
			if (words.length === 0) {
				// Without word timing the preset degrades to a fade rather than
				// doing nothing, which would look like a bug.
				return { ...NEUTRAL, opacity: easeOut(t) };
			}
			return {
				...NEUTRAL,
				words: words.map((word) => {
					const revealed = local >= word.startFrame;
					const active = local >= word.startFrame && local < word.endFrame;
					const span = Math.max(1, word.endFrame - word.startFrame);
					return {
						text: word.text,
						progress: clamp01((local - word.startFrame) / Math.min(span, entrance)),
						active,
						revealed,
					};
				}),
			};
		}

		default:
			return NEUTRAL;
	}
}

/**
 * Colour for one word.
 *
 * `karaoke` keeps every word visible and highlights the one being spoken;
 * `word_by_word` reveals them as they arrive.
 */
export function wordColor(
	preset: TextAnimation,
	word: WordState,
	baseColor: string,
	highlightColor: string,
): { color: string; opacity: number } {
	if (preset === "karaoke") {
		return {
			color: word.active ? highlightColor : baseColor,
			opacity: word.revealed ? 1 : 0.45,
		};
	}
	// word_by_word
	return { color: baseColor, opacity: word.revealed ? word.progress : 0 };
}

export interface WordPaint {
	color: string;
	opacity: number;
	/** Scale about the word's own centre; above 1 while an active word pops. */
	scale: number;
	/** A box drawn behind the word, or null for none. */
	background: string | null;
}

/**
 * Everything one word is drawn with: its colour and opacity from `wordColor`,
 * plus the active-word pop and highlight box.
 *
 * The pop eases in with the word's own arrival progress and overshoots a
 * little before settling, which is what reads as a beat rather than a jump.
 */
export function wordPaint(
	preset: TextAnimation,
	word: WordState,
	style: Partial<TextStyle> | undefined,
): WordPaint {
	const base = style?.color ?? "#FFFFFF";
	const highlight = style?.highlightColor ?? "#F29933";
	const paint = wordColor(preset, word, base, highlight);
	let color = paint.color;
	let opacity = paint.opacity;
	if (preset === "karaoke") {
		if (!word.active && word.revealed && style?.spokenColor) color = style.spokenColor;
		if (!word.revealed) opacity = clamp01(style?.upcomingOpacity ?? 0.45);
	}
	const pop = style?.activeWordScale ?? 1;
	return {
		color,
		opacity,
		scale: word.active && pop !== 1 ? 1 + (pop - 1) * easeBack(word.progress) : 1,
		background: word.active ? (style?.activeWordBackground ?? null) : null,
	};
}

/** True when the preset draws word-by-word rather than as one block. */
export function isPerWord(preset: TextAnimation): boolean {
	return preset === "karaoke" || preset === "word_by_word";
}
