// Punch-ins and face framing for talking-head footage.
//
// The jump-cut punch-in is the talking-head editor's oldest trick: after the
// pauses are cut out, every other segment is pushed in ~15% on the speaker's
// face, so each cut reads as a deliberate camera change instead of a skip.
// Doing it by hand means measuring where the face is in each segment; with a
// face track it is arithmetic, and that arithmetic lives here.
//
// All geometry is in normalized frame units (0–1 across the canvas), the same
// space as a clip's transform. Footage is cover-fitted into its box by the
// compositor, so a face's position in the frame depends on the box and the
// picture's shape — `faceInFrame` is that mapping.

import type { Keyframe } from "./keyframes";
import type { AssetModel } from "./media";
import type { ClipModel, Transform } from "./model";
import { faceAt, typicalFace } from "./vision";

export interface Box {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
}

/**
 * Where a point of the footage (normalized source coordinates) lands in the
 * frame, given the clip's box and the shapes of picture and canvas.
 */
export function faceInFrame(
	box: Box,
	source: { x: number; y: number },
	pictureAspect: number,
	canvasAspect: number,
): { x: number; y: number } {
	// Work in canvas-height units so both axes share a scale.
	const boxW = box.width * canvasAspect;
	const boxH = box.height;
	const scale = Math.max(boxW / pictureAspect, boxH);
	const drawW = pictureAspect * scale;
	const drawH = scale;
	const left = box.centerX * canvasAspect - drawW / 2;
	const top = box.centerY - drawH / 2;
	return {
		x: (left + source.x * drawW) / canvasAspect,
		y: top + source.y * drawH,
	};
}

/** Keeps a box covering the frame on any axis it covered before. */
function cover(center: number, size: number, covered: boolean): number {
	if (!covered || size < 1) return center;
	return Math.min(size / 2, Math.max(1 - size / 2, center));
}

/**
 * The box after pushing in by `factor` on a point of the frame. Scaling about
 * the point keeps it still on screen, which is what makes a punch-in read as
 * the same shot, closer — then the box is nudged back if the push would have
 * uncovered an edge of the frame.
 */
export function punchBox(box: Box, focus: { x: number; y: number }, factor: number): Box {
	const width = box.width * factor;
	const height = box.height * factor;
	const coveredX =
		box.width >= 1 - 1e-6 && Math.abs(box.centerX - 0.5) <= (box.width - 1) / 2 + 1e-6;
	const coveredY =
		box.height >= 1 - 1e-6 && Math.abs(box.centerY - 0.5) <= (box.height - 1) / 2 + 1e-6;
	return {
		width,
		height,
		centerX: cover(focus.x + (box.centerX - focus.x) * factor, width, coveredX),
		centerY: cover(focus.y + (box.centerY - focus.y) * factor, height, coveredY),
	};
}

/**
 * The box that frames a face at a chosen spot — used when reframing footage
 * into a different shape (16:9 into 9:16), where the crop has room to move.
 * `target` is where the face should sit in the new frame; the box is then
 * clamped so it still covers the frame.
 */
export function frameFace(
	box: Box,
	source: { x: number; y: number },
	pictureAspect: number,
	canvasAspect: number,
	target: { x: number; y: number } = { x: 0.5, y: 0.4 },
): Box {
	const now = faceInFrame(box, source, pictureAspect, canvasAspect);
	return {
		...box,
		centerX: cover(box.centerX + (target.x - now.x), box.width, box.width >= 1),
		centerY: cover(box.centerY + (target.y - now.y), box.height, box.height >= 1),
	};
}

/** Which segments of a run get pushed in. */
export type PunchPattern = "alternate" | "every";

export function punchedIndexes(
	count: number,
	pattern: PunchPattern,
	startWith: "wide" | "tight" = "wide",
): number[] {
	if (pattern === "every") return Array.from({ length: count }, (_, index) => index);
	const offset = startWith === "wide" ? 1 : 0;
	return Array.from({ length: count }, (_, index) => index).filter(
		(index) => index % 2 === offset,
	);
}

/**
 * Keyframes for a slow push from one box to another across a clip — the
 * gentler alternative to a hard punch, for a single long take.
 * Position rows are the box's top-left corner, as keyframes.ts expects.
 */
export function pushKeyframes(
	from: Box,
	to: Box,
	durationFrames: number,
): { scale: Keyframe[]; position: Keyframe[] } {
	const end = Math.max(1, Math.round(durationFrames) - 1);
	const corner = (box: Box) => [box.centerX - box.width / 2, box.centerY - box.height / 2];
	return {
		scale: [
			{ frame: 0, values: [from.width, from.height], interp: "linear" },
			{ frame: end, values: [to.width, to.height], interp: "linear" },
		],
		position: [
			{ frame: 0, values: corner(from), interp: "linear" },
			{ frame: end, values: corner(to), interp: "linear" },
		],
	};
}

export function boxOf(transform: Transform): Box {
	return {
		centerX: transform.centerX,
		centerY: transform.centerY,
		width: transform.width,
		height: transform.height,
	};
}

/**
 * Where the speaker's face usually is during the part of the footage a clip
 * shows, in source coordinates. Null without a face track, or when nobody was
 * in shot for that stretch.
 */
export function clipFace(
	clip: ClipModel,
	asset: AssetModel | undefined,
	fps: number,
): { x: number; y: number } | null {
	if (!asset?.faceTrack) return null;
	const from = clip.trimStartFrame / fps;
	const to = (clip.trimStartFrame + (clip.endFrame - clip.startFrame) * clip.speed) / fps;
	const face = typicalFace(asset.faceTrack, from, to);
	return face ? { x: face.cx, y: face.cy } : null;
}

/**
 * Keyframes that keep a moving speaker in a tight crop — a vertical crop of
 * wide footage shows a third of the picture, and people lean, step and turn.
 *
 * A camera operator doesn't chase every movement: the crop holds still while
 * the face stays in its middle, and pans — smoothly, over about half a second —
 * only when the face drifts toward an edge. Returns [] when one framing holds
 * the whole clip, which is the usual case for someone sitting at a desk.
 * Rows are top-left corners, as keyframes.ts expects.
 */
export function faceFollowKeyframes(
	clip: ClipModel,
	box: Box,
	asset: AssetModel | undefined,
	fps: number,
	pictureAspect: number,
	canvasAspect: number,
	options: { deadZone?: number; panFrames?: number; target?: { x: number; y: number } } = {},
): Keyframe[] {
	if (!asset?.faceTrack || (box.width <= 1.001 && box.height <= 1.001)) return [];
	const deadZone = options.deadZone ?? 0.16;
	const panFrames = Math.max(4, Math.round(options.panFrames ?? fps * 0.5));
	const target = options.target ?? { x: 0.5, y: 0.38 };
	const span = clip.endFrame - clip.startFrame;
	const sourceAt = (local: number) => (clip.trimStartFrame + local * clip.speed) / fps;

	const corner = (framed: Box) => [
		framed.centerX - framed.width / 2,
		framed.centerY - framed.height / 2,
	];
	const keys: Keyframe[] = [];
	let current: Box | null = null;
	const step = Math.max(1, Math.round(fps * 0.2));
	for (let local = 0; local < span; local += step) {
		const point = faceAtSource(asset.faceTrack, sourceAt(local));
		if (!point) continue;
		if (!current) {
			current = frameFace(box, point, pictureAspect, canvasAspect, target);
			keys.push({ frame: 0, values: corner(current), interp: "smooth" });
			continue;
		}
		const onScreen = faceInFrame(current, point, pictureAspect, canvasAspect);
		if (
			Math.abs(onScreen.x - target.x) <= deadZone &&
			Math.abs(onScreen.y - target.y) <= deadZone * 1.5
		) {
			continue;
		}
		const next = frameFace(current, point, pictureAspect, canvasAspect, target);
		// Hold where we were until the pan starts, then ease to the new framing.
		const start = Math.max((keys[keys.length - 1]?.frame ?? 0) + 1, local - panFrames);
		const end = Math.min(span - 1, start + panFrames);
		// Too close to the clip's end (or the last pan) to fit another: keep the
		// rows in order rather than squeeze a pan in backwards.
		if (end <= start) continue;
		keys.push({ frame: start, values: corner(current), interp: "smooth" });
		keys.push({ frame: end, values: corner(next), interp: "smooth" });
		current = next;
	}
	// One keyframe is a static framing, which the transform already expresses.
	return keys.length > 1 ? keys : [];
}

function faceAtSource(
	track: NonNullable<AssetModel["faceTrack"]>,
	seconds: number,
): { x: number; y: number } | null {
	const face = faceAt(track, seconds, 0.6);
	return face ? { x: face.cx, y: face.cy } : null;
}
