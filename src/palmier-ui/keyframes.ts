// Keyframes: properties that change over the length of a clip.
//
// Frames are clip-relative, so keyframes travel with the clip when it moves —
// the one decision that keeps animation from breaking on every trim.
//
// The resolver hands back a whole ClipModel with the animated values already
// substituted, so the preview and the encoder each read a single clip object
// and don't need to know which properties happen to be animated.

import {
	type ClipModel,
	type Crop,
	clamp01,
	clampTo,
	type FadeInterpolation,
	type Transform,
} from "./model";

export type Interp = "linear" | "hold" | "smooth";

export type KeyframeProperty = "volumeDb" | "opacity" | "rotation" | "position" | "scale" | "crop";

export interface Keyframe {
	/** Clip-relative; 0 is the clip's first frame. */
	frame: number;
	values: number[];
	interp: Interp;
}

export type KeyframeTracks = Partial<Record<KeyframeProperty, Keyframe[]>>;

/** How many numbers each property's rows carry after the frame. */
export const KEYFRAME_ARITY: Record<KeyframeProperty, number> = {
	volumeDb: 1,
	opacity: 1,
	rotation: 1,
	position: 2,
	scale: 2,
	crop: 4,
};

const INTERPS: Interp[] = ["linear", "hold", "smooth"];

export function isKeyframeProperty(value: string): value is KeyframeProperty {
	return value in KEYFRAME_ARITY;
}

/**
 * Parses the wire format — `[frame, ...values, interp?]` rows.
 *
 * Returns a message rather than throwing, because the caller is an agent that
 * needs to be told which row was wrong, not handed a stack trace.
 */
export function parseKeyframeRows(
	property: KeyframeProperty,
	rows: readonly unknown[],
): { ok: true; keyframes: Keyframe[] } | { ok: false; reason: string } {
	const arity = KEYFRAME_ARITY[property];
	const parsed: Keyframe[] = [];

	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!Array.isArray(row)) {
			return { ok: false, reason: `keyframes[${index}] must be an array.` };
		}
		const tail = row[row.length - 1];
		const hasInterp = typeof tail === "string";
		if (hasInterp && !INTERPS.includes(tail as Interp)) {
			return {
				ok: false,
				reason: `keyframes[${index}] ends with '${tail}', which isn't one of ${INTERPS.join(", ")}.`,
			};
		}
		const numbers = (hasInterp ? row.slice(0, -1) : row) as unknown[];
		if (numbers.length !== arity + 1) {
			return {
				ok: false,
				reason: `keyframes[${index}] needs ${arity + 1} numbers for ${property} ([frame, ${arity} value${arity === 1 ? "" : "s"}]), got ${numbers.length}.`,
			};
		}
		if (numbers.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
			return { ok: false, reason: `keyframes[${index}] contains a non-finite value.` };
		}
		const [frame, ...values] = numbers as number[];
		parsed.push({
			frame: Math.round(frame),
			values,
			interp: hasInterp ? (tail as Interp) : "smooth",
		});
	}

	// Sorting is stable in JS, so a later duplicate stays later — which is what
	// makes "the last row for a duplicate frame wins" true after the dedupe.
	parsed.sort((a, b) => a.frame - b.frame);
	const deduped: Keyframe[] = [];
	for (const keyframe of parsed) {
		if (deduped.length > 0 && deduped[deduped.length - 1].frame === keyframe.frame) {
			deduped[deduped.length - 1] = keyframe;
		} else {
			deduped.push(keyframe);
		}
	}
	return { ok: true, keyframes: deduped };
}

/** Rows back out in the wire format, so what you read is what you can pass in. */
export function keyframeRows(keyframes: readonly Keyframe[]): Array<Array<number | string>> {
	return keyframes.map((keyframe) => [keyframe.frame, ...keyframe.values, keyframe.interp]);
}

function ease(t: number, interp: Interp): number {
	if (interp === "hold") return 0;
	if (interp === "linear") return t;
	// Smoothstep — the same ease the zoom camera uses, so motion in this editor
	// has one feel rather than two.
	return t * t * (3 - 2 * t);
}

/** Samples one track at a clip-relative frame. Returns null for an empty track. */
export function sampleTrack(
	keyframes: readonly Keyframe[] | undefined,
	frame: number,
): number[] | null {
	if (!keyframes?.length) return null;
	if (frame <= keyframes[0].frame) return keyframes[0].values;
	const last = keyframes[keyframes.length - 1];
	if (frame >= last.frame) return last.values;

	for (let index = 0; index < keyframes.length - 1; index++) {
		const from = keyframes[index];
		const to = keyframes[index + 1];
		if (frame < from.frame || frame > to.frame) continue;
		const span = to.frame - from.frame;
		// The leading keyframe owns the segment's interpolation, which is what
		// makes `hold` mean "stay here until the next one".
		const t = span === 0 ? 1 : ease((frame - from.frame) / span, from.interp);
		return from.values.map((value, position) => value + (to.values[position] - value) * t);
	}
	return last.values;
}

/**
 * A clip with its animated values substituted at `timelineFrame`.
 *
 * Returns the clip itself when nothing is animated, so the common path costs
 * one property read and callers can compare by identity.
 */
export function clipAtFrame(clip: ClipModel, timelineFrame: number): ClipModel {
	const tracks = clip.keyframes;
	if (!tracks) return clip;
	const local = timelineFrame - clip.startFrame;

	let next: ClipModel | null = null;
	const draft = (): ClipModel => {
		if (!next) next = { ...clip };
		return next;
	};

	const opacity = sampleTrack(tracks.opacity, local);
	if (opacity) draft().opacity = clamp01(opacity[0]);

	const volume = sampleTrack(tracks.volumeDb, local);
	if (volume) draft().volumeDb = clampTo("volumeDb", volume[0]);

	const rotation = sampleTrack(tracks.rotation, local);
	const position = sampleTrack(tracks.position, local);
	const scale = sampleTrack(tracks.scale, local);
	if (rotation || position || scale) {
		const transform: Transform = { ...clip.transform };
		if (scale) {
			transform.width = scale[0];
			transform.height = scale[1];
		}
		if (position) {
			// Rows carry the top-left corner, but the model stores the centre —
			// the conversion needs the size, so it must run after scale.
			transform.centerX = position[0] + transform.width / 2;
			transform.centerY = position[1] + transform.height / 2;
		}
		if (rotation) transform.rotation = rotation[0];
		draft().transform = transform;
	}

	const crop = sampleTrack(tracks.crop, local);
	if (crop) {
		const [top, right, bottom, left] = crop;
		const box: Crop = {
			top: clamp01(top),
			right: clamp01(right),
			bottom: clamp01(bottom),
			left: clamp01(left),
		};
		// Opposite insets that meet would invert the crop; clamp the pair so a
		// runaway keyframe fades the clip out instead of drawing it mirrored.
		if (box.top + box.bottom > 0.98) box.bottom = Math.max(0, 0.98 - box.top);
		if (box.left + box.right > 0.98) box.right = Math.max(0, 0.98 - box.left);
		draft().crop = box;
	}

	return next ?? clip;
}

/**
 * How far into a fade this frame sits, 0–1, with 1 meaning "fully faded in".
 *
 * One resolver so a fade means the same thing to the picture and to the sound.
 * Before this, `fadeInFrames` moved the level but never touched the image, so a
 * fade set in the inspector was audible and invisible.
 */
export function fadeMultiplierAt(clip: ClipModel, timelineFrame: number): number {
	let multiplier = 1;

	const sinceStart = timelineFrame - clip.startFrame;
	if (clip.fadeInFrames > 0 && sinceStart < clip.fadeInFrames) {
		multiplier *= shape(Math.max(0, sinceStart / clip.fadeInFrames), clip.fadeInInterpolation);
	}

	// The last frame of the clip is the last frame of the fade, so the ramp is
	// measured against `endFrame - 1`: otherwise a fade-out never reaches zero.
	const untilEnd = clip.endFrame - 1 - timelineFrame;
	if (clip.fadeOutFrames > 0 && untilEnd < clip.fadeOutFrames) {
		multiplier *= shape(Math.max(0, untilEnd / clip.fadeOutFrames), clip.fadeOutInterpolation);
	}

	return multiplier;
}

function shape(t: number, interpolation: FadeInterpolation | undefined): number {
	return interpolation === "smooth" ? t * t * (3 - 2 * t) : t;
}

/** The opacity a clip should paint at: its own value times any fade. */
export function clipOpacityAt(clip: ClipModel, timelineFrame: number): number {
	return clamp01(
		clipAtFrame(clip, timelineFrame).opacity * fadeMultiplierAt(clip, timelineFrame),
	);
}

/** True when the clip animates anything at all. */
export function hasKeyframes(clip: ClipModel): boolean {
	const tracks = clip.keyframes;
	if (!tracks) return false;
	return Object.values(tracks).some((track) => (track?.length ?? 0) > 0);
}

/** Which properties are animated, for get_timeline and the inspector. */
export function animatedProperties(clip: ClipModel): KeyframeProperty[] {
	if (!clip.keyframes) return [];
	return (Object.keys(KEYFRAME_ARITY) as KeyframeProperty[]).filter(
		(property) => (clip.keyframes?.[property]?.length ?? 0) > 0,
	);
}
