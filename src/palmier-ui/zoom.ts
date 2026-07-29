// The zoom camera, driven by Recordly's own modules rather than a lookalike.
//
// `findDominantRegion` resolves which region owns a moment and how far the
// punch-in has eased (its lead-in overlap, early zoom-out, and easing curves all
// come from Recordly), and `computeZoomTransform` turns that into the scale and
// offset the canvas applies. Using them directly is the point: the Palmier
// interface and Recordly's player agree by construction, not by coincidence.

import type { CursorTelemetryPoint, ZoomFocus, ZoomRegion } from "@/components/video-editor/types";
import {
	DEFAULT_ZOOM_IN_DURATION_MS,
	DEFAULT_ZOOM_OUT_DURATION_MS,
	ZOOM_DEPTH_SCALES,
} from "@/components/video-editor/types";
import {
	type CursorFollowCameraState,
	computeCursorFollowFocus,
	createCursorFollowCameraState,
	resetCursorFollowCamera,
	SNAP_TO_EDGES_RATIO_AUTO,
} from "@/components/video-editor/videoPlayback/cursorFollowCamera";
import {
	createSpringState,
	getZoomSpringConfig,
	resetSpringState,
	type SpringState,
	stepSpringValue,
} from "@/components/video-editor/videoPlayback/motionSmoothing";
import { findDominantRegion } from "@/components/video-editor/videoPlayback/zoomRegionUtils";
import { computeZoomTransform } from "@/components/video-editor/videoPlayback/zoomTransform";

import type { ZoomRegionModel } from "./model";

export { ZOOM_DEPTH_SCALES };

export function scaleForDepth(depth: number): number {
	return ZOOM_DEPTH_SCALES[depth as keyof typeof ZOOM_DEPTH_SCALES] ?? 1;
}

export interface CameraState {
	/** 1 when fully zoomed out. */
	scale: number;
	/** Canvas offset in stage pixels. */
	x: number;
	y: number;
	/** 0-1 easing progress of the active region. */
	strength: number;
	region: ZoomRegionModel | null;
	focus: ZoomFocus;
}

/** How far either side of the moment the follow averages, in milliseconds. */
const FOCUS_WINDOW_MS = 700;

/**
 * Where the cursor is, averaged over a window around a moment.
 *
 * A raw sample makes the camera twitch with every hand tremor. Averaging over
 * about a second either side keeps the punch-in on what the pointer is *doing*
 * rather than exactly where it is on any one frame — which is the difference
 * between a zoom that reads as intentional and one that reads as motion
 * sickness. Samples nearer the moment count for more.
 */
export function cursorFocusAt(
	telemetry: readonly CursorTelemetryPoint[],
	sourceMs: number,
): ZoomFocus | null {
	let weight = 0;
	let cx = 0;
	let cy = 0;

	for (const point of telemetry) {
		const distance = Math.abs(point.timeMs - sourceMs);
		if (distance > FOCUS_WINDOW_MS) continue;
		// Triangular falloff, and a click counts double — a click is the clearest
		// statement of where the attention actually is.
		const nearness = 1 - distance / FOCUS_WINDOW_MS;
		const w =
			nearness *
			(point.interactionType === "click" || point.interactionType === "right-click" ? 2 : 1);
		cx += point.cx * w;
		cy += point.cy * w;
		weight += w;
	}

	if (weight === 0) return null;
	return {
		cx: Math.min(1, Math.max(0, cx / weight)),
		cy: Math.min(1, Math.max(0, cy / weight)),
	};
}

const NEUTRAL: CameraState = {
	scale: 1,
	x: 0,
	y: 0,
	strength: 0,
	region: null,
	focus: { cx: 0.5, cy: 0.5 },
};

/**
 * Resolve the camera at a moment in the clip's source timeline.
 *
 * `stageWidth`/`stageHeight` are the canvas's pixel size. The base mask is the
 * footage rect inside it — here the two are the same because the preview letters
 * the footage to fill, but the parameter is kept so a padded stage behaves the
 * way Recordly's player does.
 */
/**
 * How a zoom moves in and out — Recordly's timing, to the millisecond.
 *
 * These were being left at the defaults inside `findDominantRegion` because
 * Rendr never passed the options through, which meant the panel could show a
 * duration nobody could change. They are settings on the take, like the cursor
 * and the camera.
 */
/**
 * 0–1. Higher is floatier: lower stiffness and more mass, so the camera takes
 * longer to settle. Recordly's own default sits in the middle.
 */
export const DEFAULT_ZOOM_SMOOTHNESS = 0.5;

export interface ZoomTiming {
	/** How long a punch-in takes to reach full strength. */
	zoomInDurationMs: number;
	/** How long it takes to release. */
	zoomOutDurationMs: number;
	/**
	 * Two zooms closer together than the gap become one continuous move that
	 * pans between them instead of releasing and punching in again.
	 */
	connectZooms: boolean;
	/**
	 * 0–1. How much the camera's spring eases toward the zoom curve. Higher is
	 * floatier — lower stiffness, more mass, longer to settle. 0 snaps, which is
	 * Recordly's "classic" mode.
	 */
	smoothness: number;
}

export const DEFAULT_ZOOM_TIMING: ZoomTiming = {
	zoomInDurationMs: DEFAULT_ZOOM_IN_DURATION_MS,
	zoomOutDurationMs: DEFAULT_ZOOM_OUT_DURATION_MS,
	connectZooms: true,
	smoothness: DEFAULT_ZOOM_SMOOTHNESS,
};

export const ZOOM_TIMING_LIMITS = {
	smoothness: { min: 0, max: 1, step: 0.01 },
	zoomInDurationMs: { min: 200, max: 4000, step: 10 },
	zoomOutDurationMs: { min: 200, max: 4000, step: 10 },
} as const;

/**
 * The camera's spring, carried between frames.
 *
 * Recordly does not move the camera straight to where the zoom curve says it
 * should be. It springs the *final transform* — scale, x and y — toward that
 * value with a damped harmonic oscillator, which is what gives the punch-in its
 * weight and stops every recentre from being a hard cut. Porting the target
 * maths without this is why Rendr's zoom felt stepped: the targets were right
 * and nothing eased between them.
 */
export interface CameraSpringState {
	scale: SpringState;
	x: SpringState;
	y: SpringState;
	/** Playback position at the last step, to derive the frame delta. */
	lastMs: number | null;
}

export function createCameraSpringState(): CameraSpringState {
	return {
		scale: createSpringState(1),
		x: createSpringState(0),
		y: createSpringState(0),
		lastMs: null,
	};
}

export function resetCameraSpring(spring: CameraSpringState): void {
	resetSpringState(spring.scale, 1);
	resetSpringState(spring.x, 0);
	resetSpringState(spring.y, 0);
	spring.lastMs = null;
}

/**
 * Eases a camera toward its target.
 *
 * Snapping is correct when scrubbing or paused — a spring would drag the
 * picture behind the playhead and make the frame you are looking at the wrong
 * one. It is only while time is running forward that the spring is the truth.
 */
export function springCamera(
	target: CameraState,
	spring: CameraSpringState,
	deltaMs: number,
	smoothness = DEFAULT_ZOOM_SMOOTHNESS,
): CameraState {
	const config = getZoomSpringConfig(smoothness);
	return {
		...target,
		scale: stepSpringValue(spring.scale, target.scale, deltaMs, config),
		x: stepSpringValue(spring.x, target.x, deltaMs, config),
		y: stepSpringValue(spring.y, target.y, deltaMs, config),
	};
}

/** Snaps a camera to its target and forgets the spring's momentum. */
export function snapCamera(target: CameraState, spring: CameraSpringState): CameraState {
	resetSpringState(spring.scale, target.scale);
	resetSpringState(spring.x, target.x);
	resetSpringState(spring.y, target.y);
	spring.lastMs = null;
	return target;
}

export function resolveCamera(
	regions: readonly ZoomRegionModel[],
	sourceMs: number,
	stageWidth: number,
	stageHeight: number,
	/** The take's cursor samples. An `auto` region follows them. */
	telemetry?: readonly CursorTelemetryPoint[],
	/**
	 * Carried between frames by the caller — the preview holds one in a ref, an
	 * export holds one for the run. Recordly's follow camera is deliberately
	 * stateful: it holds a position and only moves when the cursor leaves a safe
	 * zone, which is what stops the picture swimming under a still hand. Without
	 * a state the follow degrades to "point at the cursor", which is the thing
	 * the safe zone exists to avoid.
	 */
	followState?: CursorFollowCameraState,
	/** How the punch-in and release are timed. Defaults to Recordly's. */
	timing: ZoomTiming = DEFAULT_ZOOM_TIMING,
): CameraState {
	if (regions.length === 0 || stageWidth <= 0 || stageHeight <= 0) return NEUTRAL;

	const { region, strength, blendedScale } = findDominantRegion(
		regions as unknown as ZoomRegion[],
		sourceMs,
		{
			connectZooms: timing.connectZooms,
			zoomInDurationMs: timing.zoomInDurationMs,
			zoomOutDurationMs: timing.zoomOutDurationMs,
		},
	);
	if (!region || strength <= 0) return NEUTRAL;

	const zoomScale = blendedScale ?? scaleForDepth(region.depth);
	// An `auto` region punches in on whatever the cursor is doing — that is what
	// makes a zoom follow the work rather than sitting on the middle of the
	// screen. A `manual` region keeps the focus it was given.
	const regionFocus = region.focus ?? { cx: 0.5, cy: 0.5 };
	const followed =
		region.mode !== "manual" && telemetry && telemetry.length > 0 && followState
			? computeCursorFollowFocus(
					followState,
					telemetry as CursorTelemetryPoint[],
					sourceMs,
					zoomScale,
					strength,
					regionFocus,
					{ snapToEdgesRatio: SNAP_TO_EDGES_RATIO_AUTO },
				)
			: null;
	const focus = followed ?? regionFocus;

	const transform = computeZoomTransform({
		stageSize: { width: stageWidth, height: stageHeight },
		baseMask: { x: 0, y: 0, width: stageWidth, height: stageHeight },
		zoomScale,
		zoomProgress: strength,
		focusX: focus.cx,
		focusY: focus.cy,
	});

	return {
		scale: transform.scale,
		x: transform.x,
		y: transform.y,
		strength,
		region: region as unknown as ZoomRegionModel,
		focus,
	};
}

// Re-exported so callers don't reach into Recordly's tree for the state type:
// the follow camera is Rendr's zoom behaviour, and this module owns it.
export { type CursorFollowCameraState, createCursorFollowCameraState, resetCursorFollowCamera };
