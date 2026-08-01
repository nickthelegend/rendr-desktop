// Pure timeline reducers. Kept free of React so they can be tested directly and
// reused by the MCP tool handlers — Palmier's rule that UI and agent edits go
// through the same domain operations.

import type { ZoomFocus } from "@/components/video-editor/types";

import { type AppliedEffect, mergeEffects } from "./effects";
import type { Keyframe, KeyframeProperty, KeyframeTracks } from "./keyframes";
import type { Placement } from "./layout";
import {
	type ClipModel,
	clamp01,
	clampTo,
	type FadeInterpolation,
	withDefaults,
	type ZoomRegionModel,
} from "./model";

export interface TrackModel {
	id: string;
	name: string;
	kind: "video" | "audio";
	muted: boolean;
	hidden: boolean;
	/** When any track is soloed, only soloed tracks are heard. */
	solo?: boolean;
	clips: ClipModel[];
}

export interface TimelineModel {
	id: string;
	name: string;
	fps: number;
	width: number;
	height: number;
	tracks: TrackModel[];
}

/** Shortest zoom that doesn't read as a glitch — same floor the MCP tool enforces. */
export const MIN_ZOOM_REGION_MS = 600;

export function findClip(timeline: TimelineModel, clipId: string): ClipModel | null {
	for (const track of timeline.tracks) {
		const clip = track.clips.find((entry) => entry.id === clipId);
		if (clip) return clip;
	}
	return null;
}

export function totalFrames(timeline: TimelineModel): number {
	let max = 0;
	for (const track of timeline.tracks) {
		for (const clip of track.clips) {
			if (clip.endFrame > max) max = clip.endFrame;
		}
	}
	return max;
}

/** Applies `change` to every clip in `clipIds`, leaving the rest untouched. */
export function mapClips(
	timeline: TimelineModel,
	clipIds: readonly string[],
	change: (clip: ClipModel) => ClipModel,
): TimelineModel {
	const ids = new Set(clipIds);
	if (ids.size === 0) return timeline;

	let mutated = false;
	const tracks = timeline.tracks.map((track) => {
		let trackMutated = false;
		const clips = track.clips.map((clip) => {
			if (!ids.has(clip.id)) return clip;
			const next = change(clip);
			if (next !== clip) trackMutated = true;
			return next;
		});
		if (!trackMutated) return track;
		mutated = true;
		return { ...track, clips };
	});

	return mutated ? { ...timeline, tracks } : timeline;
}

// ── Clip properties ───────────────────────────────────────────────────

type NumericClipKey =
	| "opacity"
	| "volumeDb"
	| "speed"
	| "edgeRounding"
	| "edgeSoftness"
	| "denoiseStrength";

const NUMERIC_LIMIT: Record<NumericClipKey, Parameters<typeof clampTo>[0]> = {
	opacity: "opacity",
	volumeDb: "volumeDb",
	speed: "speed",
	edgeRounding: "edgeRounding",
	edgeSoftness: "edgeSoftness",
	denoiseStrength: "denoiseStrength",
};

/**
 * Setting a numeric clip property. Values are clamped, not rejected, because
 * these come from sliders and scrub fields where clamping is the contract.
 */
export function setClipNumber(
	timeline: TimelineModel,
	clipIds: readonly string[],
	key: NumericClipKey,
	value: number,
): TimelineModel {
	const next = clampTo(NUMERIC_LIMIT[key], value);
	return mapClips(timeline, clipIds, (clip) =>
		clip[key] === next ? clip : { ...clip, [key]: next },
	);
}

/** Timing fields are frame counts: integral, non-negative, and duration-bounded. */
export function setClipTiming(
	timeline: TimelineModel,
	clipIds: readonly string[],
	key: "trimStartFrame" | "trimEndFrame" | "fadeInFrames" | "fadeOutFrames",
	value: number,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) => {
		const duration = clip.endFrame - clip.startFrame;
		// Fades are clip-relative, so they cannot exceed the clip. Trims are
		// *source*-relative — an offset into the media, not into the timeline —
		// and clamping those to the clip's own length silently caps them: a
		// 222-frame window taken from 951 frames into a long recording came back
		// trimmed to 222 and played from the start of the source instead. That
		// breaks every short clip cut from a long take, so trims are only
		// floored at zero and left to the decoder, which already holds the last
		// frame when asked for one past the end.
		const isTrim = key === "trimStartFrame" || key === "trimEndFrame";
		const next = isTrim
			? Math.max(0, Math.round(value))
			: Math.max(0, Math.min(Math.round(value), duration));
		if (clip[key] === next) return clip;

		const updated = { ...clip, [key]: next };
		// Fades must fit inside the clip together, matching set_clip_properties.
		if (key === "fadeInFrames" && updated.fadeInFrames + updated.fadeOutFrames > duration) {
			updated.fadeOutFrames = duration - updated.fadeInFrames;
		}
		if (key === "fadeOutFrames" && updated.fadeInFrames + updated.fadeOutFrames > duration) {
			updated.fadeInFrames = duration - updated.fadeOutFrames;
		}
		return updated;
	});
}

/** Changing duration rescales the clip's end; start is move_clips' job. */
export function setClipDuration(
	timeline: TimelineModel,
	clipIds: readonly string[],
	frames: number,
): TimelineModel {
	const duration = Math.max(1, Math.round(frames));
	return mapClips(timeline, clipIds, (clip) => {
		const endFrame = clip.startFrame + duration;
		if (clip.endFrame === endFrame) return clip;
		// Fades and trims can't outlive the shorter clip.
		return {
			...clip,
			endFrame,
			fadeInFrames: Math.min(clip.fadeInFrames, duration),
			fadeOutFrames: Math.min(clip.fadeOutFrames, duration),
		};
	});
}

export function setClipTransform(
	timeline: TimelineModel,
	clipIds: readonly string[],
	patch: Partial<ClipModel["transform"]>,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) => {
		const transform = { ...clip.transform, ...patch };
		if (patch.rotation !== undefined) transform.rotation = clampTo("rotation", patch.rotation);
		for (const key of ["centerX", "centerY", "width", "height"] as const) {
			if (patch[key] !== undefined) transform[key] = clamp01(patch[key] as number);
		}
		// A zero-size clip would vanish with no way back through the UI.
		transform.width = Math.max(0.02, transform.width);
		transform.height = Math.max(0.02, transform.height);
		return { ...clip, transform };
	});
}

export function setClipCrop(
	timeline: TimelineModel,
	clipIds: readonly string[],
	patch: Partial<ClipModel["crop"]>,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) => {
		const crop = { ...clip.crop };
		for (const key of ["top", "right", "bottom", "left"] as const) {
			if (patch[key] !== undefined) crop[key] = clamp01(patch[key] as number);
		}
		// Opposite insets must leave something visible.
		if (crop.left + crop.right > 0.95) crop.right = 0.95 - crop.left;
		if (crop.top + crop.bottom > 0.95) crop.bottom = 0.95 - crop.top;
		return { ...clip, crop };
	});
}

export function setClipColor(
	timeline: TimelineModel,
	clipIds: readonly string[],
	patch: Partial<ClipModel["color"]>,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) => {
		const color = { ...clip.color };
		for (const [key, value] of Object.entries(patch)) {
			// Curves and balance are objects, and merge rather than replace so a
			// call that sets only `midsGamma` leaves the shadows where they were.
			if (key === "curves" || key === "balance") {
				if (!value || typeof value !== "object") continue;
				color[key] = { ...(color[key] ?? {}), ...(value as object) } as never;
				continue;
			}
			// Hue targets and the LUT replace rather than merge: a target list is
			// the whole qualified-correction stack, and half a cube is not a LUT.
			// Passing null or an empty list is how each is cleared.
			if (key === "hueCurves") {
				const targets = (value as { targets?: unknown } | null)?.targets;
				if (Array.isArray(targets) && targets.length > 0) {
					color.hueCurves = value as never;
				} else {
					color.hueCurves = undefined;
				}
				continue;
			}
			if (key === "lut") {
				color.lut = (value ?? undefined) as never;
				continue;
			}
			// Not one of CLIP_LIMITS' keys, so it can't go through clampTo —
			// which reads the limits table and would throw on a key not in it.
			if (key === "lutAmount") {
				if (typeof value !== "number" || !Number.isFinite(value)) continue;
				color.lutAmount = Math.min(1, Math.max(0, value));
				continue;
			}
			if (typeof value !== "number") continue;
			color[key as keyof typeof color] = clampTo(
				key as Parameters<typeof clampTo>[0],
				value,
			) as never;
		}
		return { ...clip, color };
	});
}

/** Which shape a fade's ramp takes. Linear is the default and stays implicit. */
export function setClipFadeShape(
	timeline: TimelineModel,
	clipIds: readonly string[],
	key: "fadeInInterpolation" | "fadeOutInterpolation",
	value: FadeInterpolation,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) =>
		clip[key] === value ? clip : { ...clip, [key]: value },
	);
}

export function setClipTextStyle(
	timeline: TimelineModel,
	clipIds: readonly string[],
	patch: Partial<NonNullable<ClipModel["textStyle"]>>,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) => {
		if (!clip.textStyle) return clip;
		const textStyle = { ...clip.textStyle, ...patch };
		if (patch.fontSize !== undefined) textStyle.fontSize = clampTo("fontSize", patch.fontSize);
		if (patch.tracking !== undefined) textStyle.tracking = clampTo("tracking", patch.tracking);
		return { ...clip, textStyle };
	});
}

/**
 * Re-times a caption's words across its own span, length-weighted.
 *
 * Longer words genuinely take longer to say, so an even split drifts audibly
 * on any real sentence. Frames are clip-relative, matching how captions store
 * them, so the timing survives moving the clip.
 */
function retimeWords(
	content: string,
	durationFrames: number,
): Array<{ text: string; startFrame: number; endFrame: number }> {
	const tokens = content.split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || durationFrames <= 0) return [];

	const totalChars = tokens.reduce((sum, token) => sum + token.length, 0);
	let cursor = 0;
	return tokens.map((token, index) => {
		const share =
			totalChars > 0
				? (token.length / totalChars) * durationFrames
				: durationFrames / tokens.length;
		const startFrame = Math.round(cursor);
		// The last word always lands exactly on the clip's end.
		cursor = index === tokens.length - 1 ? durationFrames : cursor + share;
		return { text: token, startFrame, endFrame: Math.round(cursor) };
	});
}

export function setClipContent(
	timeline: TimelineModel,
	clipIds: readonly string[],
	content: string,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) => {
		if (clip.mediaType !== "text") return clip;
		// A caption carries per-word timing for the karaoke renderer. Changing
		// the words without re-timing them leaves the highlight pointing at text
		// that is no longer there, so an edited subtitle desyncs from what it
		// says — and a word-count change breaks the per-word draw outright.
		if (clip.captionWords === undefined) return { ...clip, content };
		return {
			...clip,
			content,
			captionWords: retimeWords(content, clip.endFrame - clip.startFrame),
		};
	});
}

export function setClipFlag(
	timeline: TimelineModel,
	clipIds: readonly string[],
	key: "denoiseEnabled",
	value: boolean,
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) =>
		clip[key] === value ? clip : { ...clip, [key]: value },
	);
}

export function setClipBlendMode(
	timeline: TimelineModel,
	clipIds: readonly string[],
	blendMode: ClipModel["blendMode"],
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) =>
		// Blend modes are meaningless on audio, and Palmier rejects them there.
		clip.mediaType === "audio" ? clip : { ...clip, blendMode },
	);
}

/**
 * Merges an effect stack onto clips. Audio carries no picture, so it is left
 * alone rather than quietly storing a filter nothing will ever render.
 */
export function setClipEffects(
	timeline: TimelineModel,
	clipIds: readonly string[],
	incoming: readonly AppliedEffect[],
	remove: readonly string[] = [],
): TimelineModel {
	return mapClips(timeline, clipIds, (clip) => {
		if (clip.mediaType === "audio") return clip;
		const effects = mergeEffects(clip.effects ?? [], incoming, remove);
		if (effects.length === 0 && !clip.effects?.length) return clip;
		return effects.length === 0 ? { ...clip, effects: undefined } : { ...clip, effects };
	});
}

/**
 * Replaces one property's keyframe track. An empty list clears it, and clearing
 * the last track drops `keyframes` entirely so `hasKeyframes` stays honest.
 */
export function setClipKeyframes(
	timeline: TimelineModel,
	clipId: string,
	property: KeyframeProperty,
	keyframes: readonly Keyframe[],
): TimelineModel {
	return mapClips(timeline, [clipId], (clip) => {
		const tracks: KeyframeTracks = { ...clip.keyframes };
		if (keyframes.length === 0) delete tracks[property];
		else tracks[property] = [...keyframes];
		const any = Object.values(tracks).some((track) => (track?.length ?? 0) > 0);
		return { ...clip, keyframes: any ? tracks : undefined };
	});
}

/**
 * Places clips into a layout's slots, computing transform and crop together.
 *
 * Aspect ratios come from the clips' own assets — a layout computed against the
 * wrong source shape crops the wrong edge, so an unknown asset falls back to
 * the canvas ratio rather than guessing 16:9.
 */
export function layoutClips(
	timeline: TimelineModel,
	placements: ReadonlyMap<string, Placement>,
): TimelineModel {
	return mapClips(timeline, [...placements.keys()], (clip) => {
		const placement = placements.get(clip.id);
		if (!placement) return clip;
		return { ...clip, transform: placement.transform, crop: placement.crop };
	});
}

// ── Zoom regions ──────────────────────────────────────────────────────

export type ZoomResult =
	| { ok: true; timeline: TimelineModel; regionId?: string }
	| { ok: false; reason: string };

function sortRegions(regions: ZoomRegionModel[]): ZoomRegionModel[] {
	return [...regions].sort((a, b) => a.startMs - b.startMs);
}

function overlaps(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) {
	return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** Largest free span containing `atMs`, so "add zoom here" never has to fail. */
export function freeSpanAt(
	regions: readonly ZoomRegionModel[],
	atMs: number,
	limitMs: number,
): { startMs: number; endMs: number } | null {
	let start = 0;
	let end = limitMs;
	for (const region of regions) {
		if (region.endMs <= atMs) start = Math.max(start, region.endMs);
		if (region.startMs > atMs) end = Math.min(end, region.startMs);
		if (atMs >= region.startMs && atMs < region.endMs) return null;
	}
	return end - start >= MIN_ZOOM_REGION_MS ? { startMs: start, endMs: end } : null;
}

export function addZoomRegion(
	timeline: TimelineModel,
	clipId: string,
	atMs: number,
	durationMs: number,
	limitMs: number,
	focus: ZoomFocus = { cx: 0.5, cy: 0.5 },
): ZoomResult {
	const clip = findClip(timeline, clipId);
	if (!clip) return { ok: false, reason: `No clip '${clipId}'.` };

	const regions = clip.zoomRegions ?? [];
	const span = freeSpanAt(regions, atMs, limitMs);
	if (!span) {
		return {
			ok: false,
			reason: "The playhead is inside an existing zoom, or the gap is too short.",
		};
	}

	// Centre the new region on the playhead, then slide it inside the free span.
	const wanted = Math.max(MIN_ZOOM_REGION_MS, Math.min(durationMs, span.endMs - span.startMs));
	let startMs = Math.round(atMs - wanted / 2);
	if (startMs < span.startMs) startMs = span.startMs;
	if (startMs + wanted > span.endMs) startMs = span.endMs - wanted;

	const region: ZoomRegionModel = {
		id: `zoom-${clipId}-${Math.round(startMs)}`,
		startMs,
		endMs: startMs + wanted,
		depth: 2,
		focus: { cx: clamp01(focus.cx), cy: clamp01(focus.cy) },
		mode: "auto",
	};

	return {
		ok: true,
		regionId: region.id,
		timeline: mapClips(timeline, [clipId], (target) => ({
			...target,
			zoomRegions: sortRegions([...(target.zoomRegions ?? []), region]),
		})),
	};
}

export function updateZoomRegion(
	timeline: TimelineModel,
	clipId: string,
	regionId: string,
	patch: Partial<Omit<ZoomRegionModel, "id">>,
	limitMs: number,
): ZoomResult {
	const clip = findClip(timeline, clipId);
	if (!clip) return { ok: false, reason: `No clip '${clipId}'.` };

	const regions = clip.zoomRegions ?? [];
	const current = regions.find((region) => region.id === regionId);
	if (!current) return { ok: false, reason: `No zoom region '${regionId}'.` };

	const next: ZoomRegionModel = {
		...current,
		...patch,
		depth:
			patch.depth === undefined ? current.depth : Math.round(clampTo("depth", patch.depth)),
		focus: patch.focus
			? { cx: clamp01(patch.focus.cx), cy: clamp01(patch.focus.cy) }
			: current.focus,
	};

	next.startMs = Math.max(0, Math.round(next.startMs));
	next.endMs = Math.min(limitMs, Math.round(next.endMs));
	if (next.endMs - next.startMs < MIN_ZOOM_REGION_MS) {
		return { ok: false, reason: `A zoom must run at least ${MIN_ZOOM_REGION_MS}ms.` };
	}

	const clash = regions.find((region) => region.id !== regionId && overlaps(next, region));
	if (clash) return { ok: false, reason: "That would overlap another zoom region." };

	return {
		ok: true,
		regionId,
		timeline: mapClips(timeline, [clipId], (target) => ({
			...target,
			zoomRegions: sortRegions(
				(target.zoomRegions ?? []).map((region) =>
					region.id === regionId ? next : region,
				),
			),
		})),
	};
}

export function removeZoomRegion(
	timeline: TimelineModel,
	clipId: string,
	regionId: string,
): ZoomResult {
	const clip = findClip(timeline, clipId);
	if (!clip) return { ok: false, reason: `No clip '${clipId}'.` };
	if (!(clip.zoomRegions ?? []).some((region) => region.id === regionId)) {
		return { ok: false, reason: `No zoom region '${regionId}'.` };
	}
	return {
		ok: true,
		timeline: mapClips(timeline, [clipId], (target) => ({
			...target,
			zoomRegions: (target.zoomRegions ?? []).filter((region) => region.id !== regionId),
		})),
	};
}

// ── Tracks ────────────────────────────────────────────────────────────

export function setTrackFlag(
	timeline: TimelineModel,
	trackId: string,
	key: "muted" | "hidden",
	value: boolean,
): TimelineModel {
	return {
		...timeline,
		tracks: timeline.tracks.map((track) =>
			track.id === trackId ? { ...track, [key]: value } : track,
		),
	};
}

/** Splits every clip on a track that spans `frame`, the razor tool's operation. */
export function splitAt(timeline: TimelineModel, frame: number): TimelineModel {
	let mutated = false;
	const tracks = timeline.tracks.map((track) => {
		const clips: ClipModel[] = [];
		for (const clip of track.clips) {
			if (frame <= clip.startFrame || frame >= clip.endFrame) {
				clips.push(clip);
				continue;
			}
			mutated = true;
			const leftDuration = frame - clip.startFrame;
			clips.push(
				withDefaults({ ...clip, endFrame: frame, fadeOutFrames: 0 }),
				withDefaults({
					...clip,
					id: `${clip.id}-b${frame}`,
					startFrame: frame,
					fadeInFrames: 0,
					// The right half starts further into the source.
					trimStartFrame: clip.trimStartFrame + Math.round(leftDuration * clip.speed),
				}),
			);
		}
		return { ...track, clips };
	});
	return mutated ? { ...timeline, tracks } : timeline;
}

export function removeClips(timeline: TimelineModel, clipIds: readonly string[]): TimelineModel {
	const ids = new Set(clipIds);
	if (ids.size === 0) return timeline;
	return {
		...timeline,
		tracks: timeline.tracks.map((track) => ({
			...track,
			clips: track.clips.filter((clip) => !ids.has(clip.id)),
		})),
	};
}

// ── Direct manipulation ───────────────────────────────────────────────

/** Clears a landing region on one track, the way add_clips does. */
function clearRegion(clips: ClipModel[], region: ClipModel): ClipModel[] {
	const kept: ClipModel[] = [];
	for (const clip of clips) {
		if (clip.id === region.id) continue;
		// Fully covered: gone.
		if (clip.startFrame >= region.startFrame && clip.endFrame <= region.endFrame) continue;
		// Straddles the whole region: split into head and tail.
		if (clip.startFrame < region.startFrame && clip.endFrame > region.endFrame) {
			kept.push(
				{ ...clip, endFrame: region.startFrame },
				{
					...clip,
					id: `${clip.id}-t${region.endFrame}`,
					startFrame: region.endFrame,
					trimStartFrame:
						clip.trimStartFrame +
						Math.round((region.endFrame - clip.startFrame) * clip.speed),
				},
			);
			continue;
		}
		// Overlaps one edge: trim it back.
		if (clip.startFrame < region.startFrame && clip.endFrame > region.startFrame) {
			kept.push({ ...clip, endFrame: region.startFrame });
			continue;
		}
		if (clip.startFrame < region.endFrame && clip.endFrame > region.endFrame) {
			kept.push({
				...clip,
				startFrame: region.endFrame,
				trimStartFrame:
					clip.trimStartFrame +
					Math.round((region.endFrame - clip.startFrame) * clip.speed),
			});
			continue;
		}
		kept.push(clip);
	}
	return kept;
}

/** Moves a clip to a frame and optionally another track of the same kind. */
export function moveClip(
	timeline: TimelineModel,
	clipId: string,
	toFrame: number,
	toTrackId?: string,
): TimelineModel {
	const source = timeline.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
	const clip = source?.clips.find((entry) => entry.id === clipId);
	if (!source || !clip) return timeline;

	const target = toTrackId ? timeline.tracks.find((track) => track.id === toTrackId) : source;
	if (!target) return timeline;
	// Audio can't land on a video track, and vice versa.
	const wantsAudio = clip.mediaType === "audio";
	if ((target.kind === "audio") !== wantsAudio) return timeline;

	const duration = clip.endFrame - clip.startFrame;
	const startFrame = Math.max(0, Math.round(toFrame));
	if (startFrame === clip.startFrame && target.id === source.id) return timeline;

	const moved: ClipModel = { ...clip, startFrame, endFrame: startFrame + duration };

	return {
		...timeline,
		tracks: timeline.tracks.map((track) => {
			if (track.id === source.id && track.id === target.id) {
				return {
					...track,
					clips: [...clearRegion(track.clips, moved), moved].sort(byStart),
				};
			}
			if (track.id === source.id) {
				return { ...track, clips: track.clips.filter((entry) => entry.id !== clipId) };
			}
			if (track.id === target.id) {
				return {
					...track,
					clips: [...clearRegion(track.clips, moved), moved].sort(byStart),
				};
			}
			return track;
		}),
	};
}

function byStart(a: ClipModel, b: ClipModel) {
	return a.startFrame - b.startFrame;
}

/** Minimum a clip can be trimmed to — one frame would be unusable. */
export const MIN_CLIP_FRAMES = 2;

/**
 * Trims a clip's head. The start moves and the source offset moves with it, so
 * the visible content stays put rather than sliding.
 */
export function trimClipStart(
	timeline: TimelineModel,
	clipId: string,
	toFrame: number,
): TimelineModel {
	return mapClips(timeline, [clipId], (clip) => {
		const startFrame = Math.max(
			0,
			Math.min(Math.round(toFrame), clip.endFrame - MIN_CLIP_FRAMES),
		);
		if (startFrame === clip.startFrame) return clip;
		const delta = startFrame - clip.startFrame;
		return {
			...clip,
			startFrame,
			trimStartFrame: Math.max(0, clip.trimStartFrame + Math.round(delta * clip.speed)),
		};
	});
}

/** Trims a clip's tail. */
export function trimClipEnd(
	timeline: TimelineModel,
	clipId: string,
	toFrame: number,
): TimelineModel {
	return mapClips(timeline, [clipId], (clip) => {
		const endFrame = Math.max(clip.startFrame + MIN_CLIP_FRAMES, Math.round(toFrame));
		if (endFrame === clip.endFrame) return clip;
		const duration = endFrame - clip.startFrame;
		return {
			...clip,
			endFrame,
			fadeInFrames: Math.min(clip.fadeInFrames, duration),
			fadeOutFrames: Math.min(clip.fadeOutFrames, duration),
		};
	});
}

/** Frames worth snapping to: zero, the playhead, and every clip boundary. */
export function snapTargets(
	timeline: TimelineModel,
	playhead: number,
	exceptClipIds: readonly string[] = [],
): number[] {
	const skip = new Set(exceptClipIds);
	const targets = new Set<number>([0, Math.round(playhead)]);
	for (const track of timeline.tracks) {
		for (const clip of track.clips) {
			if (skip.has(clip.id)) continue;
			targets.add(clip.startFrame);
			targets.add(clip.endFrame);
		}
	}
	return [...targets].sort((a, b) => a - b);
}

/** Nearest snap target within `threshold`, or the original frame. */
export function snapFrame(
	frame: number,
	targets: readonly number[],
	threshold: number,
): { frame: number; snappedTo: number | null } {
	let best: number | null = null;
	let bestDistance = threshold;
	for (const target of targets) {
		const distance = Math.abs(target - frame);
		if (distance <= bestDistance) {
			best = target;
			bestDistance = distance;
		}
	}
	return best === null ? { frame, snappedTo: null } : { frame: best, snappedTo: best };
}

export function duplicateClips(
	timeline: TimelineModel,
	clipIds: readonly string[],
): { timeline: TimelineModel; newIds: string[] } {
	const ids = new Set(clipIds);
	const newIds: string[] = [];
	const tracks = timeline.tracks.map((track) => {
		const copies: ClipModel[] = [];
		for (const clip of track.clips) {
			if (!ids.has(clip.id)) continue;
			const duration = clip.endFrame - clip.startFrame;
			const copy: ClipModel = {
				...clip,
				id: `${clip.id}-copy${clip.endFrame}`,
				startFrame: clip.endFrame,
				endFrame: clip.endFrame + duration,
			};
			copies.push(copy);
			newIds.push(copy.id);
		}
		if (copies.length === 0) return track;
		let clips = track.clips;
		for (const copy of copies) clips = [...clearRegion(clips, copy), copy];
		return { ...track, clips: clips.sort(byStart) };
	});
	return newIds.length === 0
		? { timeline, newIds: [] }
		: { timeline: { ...timeline, tracks }, newIds };
}

/** Shifts a selection by whole frames, clamped so nothing crosses zero. */
export function nudgeClips(
	timeline: TimelineModel,
	clipIds: readonly string[],
	deltaFrames: number,
): TimelineModel {
	if (deltaFrames === 0 || clipIds.length === 0) return timeline;
	const ids = new Set(clipIds);
	let earliest = Number.POSITIVE_INFINITY;
	for (const track of timeline.tracks) {
		for (const clip of track.clips) {
			if (ids.has(clip.id)) earliest = Math.min(earliest, clip.startFrame);
		}
	}
	if (!Number.isFinite(earliest)) return timeline;
	const delta = Math.max(deltaFrames, -earliest);
	if (delta === 0) return timeline;
	return mapClips(timeline, clipIds, (clip) => ({
		...clip,
		startFrame: clip.startFrame + delta,
		endFrame: clip.endFrame + delta,
	}));
}

/** Pastes clips at a frame, keeping their relative offsets. */
export function pasteClips(
	timeline: TimelineModel,
	clips: readonly ClipModel[],
	atFrame: number,
	stamp: string,
): { timeline: TimelineModel; newIds: string[] } {
	if (clips.length === 0) return { timeline, newIds: [] };
	const origin = Math.min(...clips.map((clip) => clip.startFrame));
	const newIds: string[] = [];
	let next = timeline;

	for (const clip of clips) {
		const offset = clip.startFrame - origin;
		const duration = clip.endFrame - clip.startFrame;
		const startFrame = Math.max(0, Math.round(atFrame + offset));
		const copy: ClipModel = {
			...clip,
			id: `${clip.id}-p${stamp}`,
			startFrame,
			endFrame: startFrame + duration,
		};
		newIds.push(copy.id);
		const wantsAudio = copy.mediaType === "audio";
		const track = next.tracks.find((entry) => (entry.kind === "audio") === wantsAudio);
		if (!track) continue;
		next = {
			...next,
			tracks: next.tracks.map((entry) =>
				entry.id === track.id
					? { ...entry, clips: [...clearRegion(entry.clips, copy), copy].sort(byStart) }
					: entry,
			),
		};
	}
	return { timeline: next, newIds };
}

// ── Tracks ────────────────────────────────────────────────────────────

/** Adds a track above the others of its kind, numbered from the existing set. */
export function addTrack(timeline: TimelineModel, kind: "video" | "audio"): TimelineModel {
	const prefix = kind === "video" ? "V" : "A";
	const existing = timeline.tracks.filter((track) => track.kind === kind).length;
	const track: TrackModel = {
		id: `trk-${prefix.toLowerCase()}${existing + 1}-${timeline.tracks.length}`,
		name: `${prefix}${existing + 1}`,
		kind,
		muted: false,
		hidden: false,
		solo: false,
		clips: [],
	};
	// Video stacks upward (index 0 renders on top); audio appends below.
	const tracks =
		kind === "video"
			? [track, ...timeline.tracks]
			: [
					...timeline.tracks.filter((t) => t.kind === "video"),
					...timeline.tracks.filter((t) => t.kind === "audio"),
					track,
				];
	return { ...timeline, tracks };
}

export function removeTrack(timeline: TimelineModel, trackId: string): TimelineModel {
	// The last track of a kind is the floor; removing it leaves nowhere to drop.
	const track = timeline.tracks.find((entry) => entry.id === trackId);
	if (!track) return timeline;
	const sameKind = timeline.tracks.filter((entry) => entry.kind === track.kind);
	if (sameKind.length <= 1) return timeline;
	return { ...timeline, tracks: timeline.tracks.filter((entry) => entry.id !== trackId) };
}

/** Moves a track within its own kind's zone; crossing zones is refused. */
export function reorderTrack(
	timeline: TimelineModel,
	trackId: string,
	direction: -1 | 1,
): TimelineModel {
	const index = timeline.tracks.findIndex((track) => track.id === trackId);
	if (index < 0) return timeline;
	const target = index + direction;
	if (target < 0 || target >= timeline.tracks.length) return timeline;
	if (timeline.tracks[target].kind !== timeline.tracks[index].kind) return timeline;

	const tracks = [...timeline.tracks];
	[tracks[index], tracks[target]] = [tracks[target], tracks[index]];
	return { ...timeline, tracks };
}

export function renameTrack(timeline: TimelineModel, trackId: string, name: string): TimelineModel {
	const trimmed = name.trim();
	if (!trimmed) return timeline;
	return {
		...timeline,
		tracks: timeline.tracks.map((track) =>
			track.id === trackId ? { ...track, name: trimmed } : track,
		),
	};
}

/** Soloing one track implicitly silences its peers at playback time. */
export function toggleSolo(timeline: TimelineModel, trackId: string): TimelineModel {
	return {
		...timeline,
		tracks: timeline.tracks.map((track) =>
			track.id === trackId ? { ...track, solo: !track.solo } : track,
		),
	};
}

/** True when this track should be heard, accounting for any solo in the mix. */
export function isAudible(timeline: TimelineModel, track: TrackModel): boolean {
	if (track.muted) return false;
	const anySolo = timeline.tracks.some((entry) => entry.solo);
	return anySolo ? Boolean(track.solo) : true;
}

// ── Text ──────────────────────────────────────────────────────────────

/** Adds a text clip at the playhead on the topmost video track. */
/**
 * Adds a title, on a track where it doesn't destroy anything.
 *
 * A title is an overlay. This used to drop it onto the topmost video track and
 * clear whatever it landed on, so adding a caption over a screen recording cut
 * a hole in the footage — the export came back black for exactly the span the
 * title covered. Text goes on the first video track with room for it, and gets
 * a new track above everything when there is none.
 */
export function addTextClip(
	timeline: TimelineModel,
	atFrame: number,
	durationFrames: number,
	id: string,
	content = "Text",
): { timeline: TimelineModel; clipId: string } {
	if (!timeline.tracks.some((entry) => entry.kind === "video")) {
		return { timeline, clipId: "" };
	}

	const start = Math.max(0, Math.round(atFrame));
	const clip = withDefaults({
		id,
		name: content,
		mediaType: "text",
		startFrame: start,
		endFrame: start + Math.max(MIN_CLIP_FRAMES, durationFrames),
		content,
	});

	const free = timeline.tracks.find(
		(entry) =>
			entry.kind === "video" &&
			entry.clips.every(
				(existing) =>
					existing.endFrame <= clip.startFrame || existing.startFrame >= clip.endFrame,
			),
	);

	if (free) {
		return {
			timeline: {
				...timeline,
				tracks: timeline.tracks.map((entry) =>
					entry.id === free.id
						? { ...entry, clips: [...entry.clips, clip].sort(byStart) }
						: entry,
				),
			},
			clipId: id,
		};
	}

	// Index 0 is the top of the stack, which is where an overlay belongs.
	const track: TrackModel = {
		id: `trk-text-${id}`,
		name: "T1",
		kind: "video",
		muted: false,
		hidden: false,
		clips: [clip],
	};
	return {
		timeline: { ...timeline, tracks: [track, ...timeline.tracks] },
		clipId: id,
	};
}

// ── Ripple edits ──────────────────────────────────────────────────────

/**
 * Opens a gap at `atFrame` by pushing everything at or after it to the right.
 *
 * Every track shifts, not just the one being inserted into: a clip and its
 * separately-tracked audio must stay aligned, and there is no way to know which
 * pairs are linked without moving them together.
 */
export function rippleShift(
	timeline: TimelineModel,
	atFrame: number,
	byFrames: number,
	exemptTrackIds: readonly string[] = [],
): TimelineModel {
	if (byFrames === 0) return timeline;
	const exempt = new Set(exemptTrackIds);

	// A clip that begins before the point spans the join, so it stays where it
	// is: moving it would drag content from before the edit. On a track that was
	// cut, the tail of any straddling clip already begins exactly at the point.
	const moving = (clip: ClipModel) => clip.startFrame >= atFrame;

	// Nothing may be pushed past frame 0, and the whole group has to move by the
	// same amount or the cut opens back up somewhere else.
	let shift = byFrames;
	if (shift < 0) {
		for (const track of timeline.tracks) {
			if (exempt.has(track.id)) continue;
			for (const clip of track.clips) {
				if (moving(clip)) shift = Math.max(shift, -clip.startFrame);
			}
		}
	}
	if (shift === 0) return timeline;

	let mutated = false;
	const tracks = timeline.tracks.map((track) => {
		if (exempt.has(track.id)) return track;
		let trackMutated = false;
		const clips = track.clips.map((clip) => {
			if (!moving(clip)) return clip;
			trackMutated = true;
			return {
				...clip,
				startFrame: clip.startFrame + shift,
				endFrame: clip.endFrame + shift,
			};
		});
		if (!trackMutated) return track;
		mutated = true;
		return { ...track, clips: clips.sort(byStart) };
	});

	return mutated ? { ...timeline, tracks } : timeline;
}

/** Merges and sorts [start, end) ranges so overlapping cuts count once. */
export function mergeRanges(
	ranges: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
	const sorted = ranges
		.map(([start, end]) => [Math.round(Math.min(start, end)), Math.round(Math.max(start, end))])
		.filter(([start, end]) => end > start)
		.sort((a, b) => a[0] - b[0]) as Array<[number, number]>;

	const merged: Array<[number, number]> = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([range[0], range[1]]);
	}
	return merged;
}

/** Removes a [start, end) span from one track's clips without closing the gap. */
function cutSpan(clips: readonly ClipModel[], start: number, end: number): ClipModel[] {
	const kept: ClipModel[] = [];
	for (const clip of clips) {
		if (clip.endFrame <= start || clip.startFrame >= end) {
			kept.push(clip);
			continue;
		}
		// Wholly inside the cut.
		if (clip.startFrame >= start && clip.endFrame <= end) continue;
		// Straddles: keep a head and a tail.
		if (clip.startFrame < start && clip.endFrame > end) {
			if (start - clip.startFrame >= MIN_CLIP_FRAMES) {
				kept.push({ ...clip, endFrame: start, fadeOutFrames: 0 });
			}
			if (clip.endFrame - end >= MIN_CLIP_FRAMES) {
				kept.push({
					...clip,
					id: `${clip.id}-r${end}`,
					startFrame: end,
					fadeInFrames: 0,
					trimStartFrame:
						clip.trimStartFrame + Math.round((end - clip.startFrame) * clip.speed),
				});
			}
			continue;
		}
		// Cut takes the tail.
		if (clip.startFrame < start) {
			if (start - clip.startFrame >= MIN_CLIP_FRAMES) {
				kept.push({ ...clip, endFrame: start, fadeOutFrames: 0 });
			}
			continue;
		}
		// Cut takes the head.
		if (clip.endFrame - end >= MIN_CLIP_FRAMES) {
			kept.push({
				...clip,
				startFrame: end,
				fadeInFrames: 0,
				trimStartFrame:
					clip.trimStartFrame + Math.round((end - clip.startFrame) * clip.speed),
			});
		}
	}
	return kept.sort(byStart);
}

/**
 * Cuts ranges out of the timeline and closes every gap.
 *
 * By default the cut goes through every track. A rendr clip carries its own
 * audio rather than having a separate linked partner, so cutting only the
 * picture track would leave a music bed or a second camera running a hundred
 * frames long — which is exactly the desync this is meant to prevent. The
 * exempt list opts a track out of both the cut and the shift, for a bed that
 * should keep playing across the join.
 */
export function rippleDelete(
	timeline: TimelineModel,
	ranges: ReadonlyArray<readonly [number, number]>,
	options: { trackId?: string; exemptTrackIds?: readonly string[] } = {},
): { timeline: TimelineModel; removedFrames: number } {
	const merged = mergeRanges(ranges);
	if (merged.length === 0) return { timeline, removedFrames: 0 };

	const exempt = new Set(options.exemptTrackIds ?? []);
	let next = timeline;
	let removedFrames = 0;

	// Cut from the end backwards so earlier ranges keep their frame numbers.
	for (const [start, end] of [...merged].reverse()) {
		const length = end - start;
		const tracks = next.tracks.map((track) => {
			if (exempt.has(track.id)) return track;
			if (options.trackId && track.id !== options.trackId) return track;
			return { ...track, clips: cutSpan(track.clips, start, end) };
		});
		next = rippleShift({ ...next, tracks }, end, -length, [...exempt]);
		removedFrames += length;
	}

	return { timeline: next, removedFrames };
}

/**
 * Moves the in or out point of every selected clip to the playhead.
 *
 * Clips the playhead isn't inside are skipped, so a miss leaves no empty undo
 * step. Lives here rather than inside a button's onClick because the toolbar
 * and the keyboard shortcut both need it — and while it was inline, the "(Q)"
 * and "(W)" the buttons advertise led nowhere.
 */
export function trimSelectionToPlayhead(
	timeline: TimelineModel,
	clipIds: readonly string[],
	playhead: number,
	edge: "start" | "end",
): TimelineModel {
	let next = timeline;
	for (const id of clipIds) {
		const clip = next.tracks.flatMap((track) => track.clips).find((entry) => entry.id === id);
		if (!clip) continue;
		if (playhead <= clip.startFrame || playhead >= clip.endFrame) continue;
		next =
			edge === "start" ? trimClipStart(next, id, playhead) : trimClipEnd(next, id, playhead);
	}
	return next;
}

export interface TransitionResult {
	timeline: TimelineModel;
	/** Why it couldn't be added, when it couldn't. */
	error?: string;
	/** The pair it was applied between. */
	between?: [string, string];
	frames?: number;
}

/**
 * Cross-dissolves the cut between two touching clips.
 *
 * Built from fades rather than a new primitive: the two clips are overlapped by
 * `frames`, the outgoing one fades out across the overlap and the incoming one
 * fades in across it. Both already render — `clipOpacityAt` honours fades — so
 * a dissolve is composed of behaviour that is known to work rather than a new
 * code path that has to be made to work.
 *
 * The incoming clip is pulled *earlier* rather than the outgoing one extended,
 * because extending would require source footage past its out point that may
 * not exist.
 */
export function addTransition(
	timeline: TimelineModel,
	atFrame: number,
	frames: number,
): TransitionResult {
	const length = Math.round(frames);
	if (length <= 0) {
		return { timeline, error: "A transition needs a length of at least one frame." };
	}

	for (const track of timeline.tracks) {
		if (track.kind !== "video") continue;
		const ordered = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
		for (let index = 0; index < ordered.length - 1; index++) {
			const outgoing = ordered[index];
			const incoming = ordered[index + 1];
			// The cut this transition is for: the two clips must actually touch.
			if (outgoing.endFrame !== incoming.startFrame) continue;
			if (Math.abs(outgoing.endFrame - Math.round(atFrame)) > 2) continue;

			// Neither clip may be shortened below what the overlap consumes, or
			// the dissolve would outlast the clip it is dissolving.
			const outLength = outgoing.endFrame - outgoing.startFrame;
			const inLength = incoming.endFrame - incoming.startFrame;
			if (length >= outLength || length >= inLength) {
				return {
					timeline,
					error: `A ${length}-frame dissolve doesn't fit: the clips either side are ${outLength} and ${inLength} frames.`,
				};
			}
			// Pulling the incoming clip earlier needs source before its in point.
			if (incoming.trimStartFrame < length) {
				return {
					timeline,
					error: `'${incoming.name}' has only ${incoming.trimStartFrame} frames of source before its start, so it can't be pulled back ${length}.`,
				};
			}

			const tracks = timeline.tracks.map((entry) =>
				entry.id !== track.id
					? entry
					: {
							...entry,
							clips: entry.clips.map((clip) => {
								if (clip.id === outgoing.id) {
									return { ...clip, fadeOutFrames: length };
								}
								if (clip.id === incoming.id) {
									return {
										...clip,
										startFrame: clip.startFrame - length,
										trimStartFrame: clip.trimStartFrame - length,
										fadeInFrames: length,
									};
								}
								return clip;
							}),
						},
			);

			return {
				timeline: { ...timeline, tracks },
				between: [outgoing.id, incoming.id],
				frames: length,
			};
		}
	}

	return {
		timeline,
		error: `No cut at frame ${Math.round(atFrame)}. A transition goes between two clips that touch — split first, or move a clip so its edge meets another.`,
	};
}

/** Removes a dissolve, restoring the hard cut. */
export function removeTransition(timeline: TimelineModel, clipId: string): TimelineModel {
	return mapClips(timeline, [clipId], (clip) => ({
		...clip,
		fadeInFrames: 0,
		fadeOutFrames: 0,
	}));
}
