// The editable clip model, shaped after Palmier Pro's Clip and carrying
// Recordly's ZoomRegion verbatim so the two halves share one vocabulary.
//
// Every property the inspector edits lives here. Defaults are the identity
// values Palmier omits from get_timeline; `withDefaults` fills them in so the
// UI and the preview never disagree about what "unset" means.

import type { ZoomFocus } from "@/components/video-editor/types";
import { type ColorBalance, hasBalance, hasCurves, type ToneCurves } from "./curves";
import type { AppliedEffect } from "./effects";
import type { KeyframeTracks } from "./keyframes";
import { type CubeLut, type HueCurves, needsPixelGrade } from "./pixelGrade";

export type MediaType = "video" | "audio" | "image" | "text" | "sequence";

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "softLight" | "difference";

export type FadeInterpolation = "linear" | "smooth";

export type TextAnimation =
	| "off"
	| "fade"
	| "slide_up"
	| "pop"
	| "typewriter"
	| "word_by_word"
	| "karaoke";

/** Normalized canvas placement — 0-1 across the canvas, like Palmier's transform. */
export interface Transform {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	/** Clockwise degrees. */
	rotation: number;
	flipHorizontal: boolean;
	flipVertical: boolean;
}

/** Side insets as a fraction of the source, matching set_keyframes' crop rows. */
export interface Crop {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** apply_color's knobs, in its own vocabulary. */
export interface ColorGrade {
	/** Tone curves, when the basic knobs aren't shape enough. */
	curves?: ToneCurves;
	/** Lift / gamma / gain, per tonal range. */
	balance?: ColorBalance;
	/**
	 * Hue-keyed curves and a 3D LUT.
	 *
	 * Everything above is a per-channel transfer, which the preview runs as an
	 * SVG filter and the encoder as a lookup table. These two need a whole pixel
	 * at once, so both renderers run them through pixelGrade.ts instead.
	 */
	hueCurves?: HueCurves;
	lut?: CubeLut;
	/** 0–1 dry/wet on the LUT. Absent means fully applied. */
	lutAmount?: number;
	exposure: number;
	contrast: number;
	saturation: number;
	vibrance: number;
	temperature: number;
	tint: number;
	highlights: number;
	shadows: number;
	whites: number;
	blacks: number;
}

export interface TextStyle {
	fontFamily: string;
	fontSize: number;
	tracking: number;
	color: string;
	bold: boolean;
	italic: boolean;
	uppercase: boolean;
	alignment: "left" | "center" | "right";
	animation: TextAnimation;
	highlightColor: string;
}

/** Recordly's zoom region, plus the focus point its camera reads. */
export interface ZoomRegionModel {
	id: string;
	/** Source milliseconds, end exclusive. */
	startMs: number;
	endMs: number;
	/** 1-6, mapping to ZOOM_DEPTH_SCALES. */
	depth: number;
	focus: ZoomFocus;
	mode: "auto" | "manual";
}

export interface ClipModel {
	id: string;
	name: string;
	mediaType: MediaType;
	/** Library asset this clip draws from. Text clips have none. */
	assetId?: string;
	/** Timeline frames, end exclusive. */
	startFrame: number;
	endFrame: number;

	// Timing
	speed: number;
	trimStartFrame: number;
	trimEndFrame: number;

	// Audio
	volumeDb: number;
	fadeInFrames: number;
	fadeOutFrames: number;
	/** Shape of each fade's ramp. Absent means linear, the default. */
	fadeInInterpolation?: FadeInterpolation;
	fadeOutInterpolation?: FadeInterpolation;
	denoiseStrength: number;
	denoiseEnabled: boolean;

	// Visual
	opacity: number;
	transform: Transform;
	crop: Crop;
	edgeRounding: number;
	edgeSoftness: number;
	blendMode: BlendMode;
	color: ColorGrade;
	/** The non-colour effect stack, in canonical render order. */
	effects?: AppliedEffect[];
	/** Animated properties, clip-relative. Absent means "static value only". */
	keyframes?: KeyframeTracks;

	// Text
	content?: string;
	textStyle?: TextStyle;
	/** Set on clips made by one transcription, so a group restyles together. */
	captionGroupId?: string;
	/** Clip-relative word timing, so karaoke survives moving and trimming. */
	captionWords?: Array<{ text: string; startFrame: number; endFrame: number }>;

	/** Screen recordings only. */
	zoomRegions?: ZoomRegionModel[];
}

const IDENTITY_TRANSFORM: Transform = {
	centerX: 0.5,
	centerY: 0.5,
	width: 1,
	height: 1,
	rotation: 0,
	flipHorizontal: false,
	flipVertical: false,
};

const IDENTITY_CROP: Crop = { top: 0, right: 0, bottom: 0, left: 0 };

export const NEUTRAL_GRADE: ColorGrade = {
	exposure: 0,
	contrast: 1,
	saturation: 1,
	vibrance: 0,
	temperature: 6500,
	tint: 0,
	highlights: 0,
	shadows: 0,
	whites: 0,
	blacks: 0,
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
	fontFamily: "SF Pro Display",
	fontSize: 48,
	tracking: 0,
	color: "#FFFFFF",
	bold: true,
	italic: false,
	uppercase: false,
	alignment: "center",
	animation: "off",
	highlightColor: "#F29933",
};

/** Ranges the inspector clamps to. Single source of truth for UI and reducers. */
export const CLIP_LIMITS = {
	volumeDb: { min: -60, max: 15 },
	opacity: { min: 0, max: 1 },
	speed: { min: 0.1, max: 8 },
	edgeRounding: { min: 0, max: 1 },
	edgeSoftness: { min: 0, max: 1 },
	rotation: { min: -180, max: 180 },
	exposure: { min: -3, max: 3 },
	contrast: { min: 0.5, max: 1.5 },
	saturation: { min: 0, max: 2 },
	vibrance: { min: -1, max: 1 },
	temperature: { min: 2000, max: 11000 },
	tint: { min: -100, max: 100 },
	highlights: { min: -1, max: 1 },
	shadows: { min: -1, max: 1 },
	whites: { min: -1, max: 1 },
	blacks: { min: -1, max: 1 },
	depth: { min: 1, max: 6 },
	fontSize: { min: 12, max: 300 },
	tracking: { min: -20, max: 100 },
	denoiseStrength: { min: 0, max: 1 },
} as const;

export type ClipLimitKey = keyof typeof CLIP_LIMITS;

export function clampTo(key: ClipLimitKey, value: number): number {
	const { min, max } = CLIP_LIMITS[key];
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export type ClipSeed = Pick<ClipModel, "id" | "name" | "mediaType" | "startFrame" | "endFrame"> &
	Partial<ClipModel>;

/** Fills identity defaults so nothing downstream has to guess at `undefined`. */
export function withDefaults(seed: ClipSeed): ClipModel {
	const isText = seed.mediaType === "text";
	return {
		speed: 1,
		trimStartFrame: 0,
		trimEndFrame: 0,
		volumeDb: 0,
		fadeInFrames: 0,
		fadeOutFrames: 0,
		denoiseStrength: 0.6,
		denoiseEnabled: false,
		opacity: 1,
		transform: { ...IDENTITY_TRANSFORM },
		crop: { ...IDENTITY_CROP },
		edgeRounding: 0,
		edgeSoftness: 0,
		blendMode: "normal",
		color: { ...NEUTRAL_GRADE },
		...(isText ? { content: seed.name, textStyle: { ...DEFAULT_TEXT_STYLE } } : {}),
		...seed,
	};
}

/** True when the grade would visibly change the image. */
export function isGraded(color: ColorGrade): boolean {
	if (hasCurves(color.curves) || hasBalance(color.balance)) return true;
	if (needsPixelGrade(color)) return true;
	return (
		color.exposure !== 0 ||
		color.contrast !== 1 ||
		color.saturation !== 1 ||
		color.vibrance !== 0 ||
		color.temperature !== 6500 ||
		color.tint !== 0 ||
		color.highlights !== 0 ||
		color.shadows !== 0 ||
		color.whites !== 0 ||
		color.blacks !== 0
	);
}
