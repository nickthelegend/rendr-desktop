// The rendered cursor.
//
// A screen recording captures the pointer as a few hard pixels that vanish at
// any zoom. Recordly draws its own instead, from the telemetry captured
// alongside the take — which is why the pointer can be scaled up, smoothed,
// blurred along its travel, and bounced on a click.
//
// Everything here is pure: given telemetry and settings it returns where the
// cursor is and how big, so the preview and the encoder draw the same pointer.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import {
	createSpringState,
	getCursorSpringConfig,
	resetSpringState,
	type SpringState,
	stepSpringValue,
} from "@/components/video-editor/videoPlayback/motionSmoothing";

/** The pointer shapes the picker offers. */
export type CursorStyle = "arrow" | "arrow-shadow" | "arrow-solid" | "dot" | "pointer";

export interface CursorSettings {
	show: boolean;
	style: CursorStyle;
	/** Multiplier on the system pointer's size. */
	size: number;
	/** 0–1; how much the drawn pointer lags the raw samples. */
	smoothing: number;
	/**
	 * 0–1; how far the pointer smears *along its own travel*.
	 *
	 * Directional, not a symmetric blur — smearing equally in every direction
	 * doesn't look like speed, it looks like the pointer is out of focus.
	 */
	motionBlur: number;
	/** Multiplier on the pop a click produces. */
	clickBounce: number;
	/** How long that pop lasts, in milliseconds. */
	bounceSpeed: number;
	/** 0–1; a slight drift perpendicular to travel, so motion isn't robotic. */
	sway: number;
	/** Replays the telemetry from the start when the take outlives it. */
	loop: boolean;
	/**
	 * Paint over the pointer the capture burnt in.
	 *
	 * Only needed where the platform ignores `cursor: "never"` — macOS does, on
	 * every capture path. Defaults on: a take with two pointers in it is worse
	 * than a small patch where one of them was.
	 */
	maskCapturedCursor?: boolean;
	/**
	 * 0–1. Dims everything outside a soft circle around the pointer, so the eye
	 * goes where the hand is. Recordly's spotlight.
	 */
	spotlight: number;
	/** Radius of that circle, as a fraction of the frame's short edge. */
	spotlightSize: number;
	/** A ring that expands and fades from each click. */
	clickRing: boolean;
	/** Colour of that ring. */
	ringColor: string;
}

/**
 * Recordly's own preset values, kept to the digit.
 *
 * These are the numbers its "Focused" and "Smooth" presets share, so a take
 * recorded in Recordly and one recorded here have the same pointer feel.
 */
export const DEFAULT_CURSOR: CursorSettings = {
	show: true,
	style: "arrow-shadow",
	size: 2.5,
	smoothing: 0.67,
	// Recordly ships this at 0. A blurred pointer reads as a rendering fault
	// rather than as motion, so it is opt-in.
	motionBlur: 0,
	clickBounce: 3.5,
	bounceSpeed: 350,
	sway: 0.2,
	loop: false,
	spotlight: 0,
	spotlightSize: 0.28,
	clickRing: true,
	ringColor: "#FFFFFF",
};

export const CURSOR_LIMITS = {
	size: { min: 0.5, max: 6, step: 0.05 },
	smoothing: { min: 0, max: 1, step: 0.01 },
	motionBlur: { min: 0, max: 1, step: 0.01 },
	clickBounce: { min: 0, max: 8, step: 0.05 },
	bounceSpeed: { min: 80, max: 1200, step: 10 },
	sway: { min: 0, max: 1, step: 0.01 },
	spotlight: { min: 0, max: 1, step: 0.01 },
	spotlightSize: { min: 0.08, max: 0.8, step: 0.01 },
} as const;

export const CURSOR_STYLES: Array<{ id: CursorStyle; label: string }> = [
	{ id: "arrow", label: "Arrow" },
	{ id: "arrow-shadow", label: "Arrow with shadow" },
	{ id: "arrow-solid", label: "Solid arrow" },
	{ id: "dot", label: "Dot" },
	{ id: "pointer", label: "Pointer" },
];

export interface CursorFrame {
	/** 0–1 of the canvas. */
	cx: number;
	cy: number;
	/** Final size multiplier, click bounce included. */
	scale: number;
	/** Pixels of smear, and the direction to smear along. */
	blur: number;
	angle: number;
	/** 0–1; fades in as telemetry begins and out when it ends. */
	opacity: number;
	clicking: boolean;
	/**
	 * The unsmoothed sample position, 0–1 of the canvas.
	 *
	 * The drawn pointer lags this — that lag is what smoothing *is* — so on
	 * macOS, where the capture burns the real pointer in and ignores
	 * `cursor: "never"`, the real one pokes out ahead of the drawn one while
	 * moving. This is where it actually is, so it can be covered.
	 */
	rawCx: number;
	rawCy: number;
	/**
	 * 0–1 through the click ring's life, or null when no ring is showing.
	 * The ring outlives the bounce, so it is timed separately.
	 */
	ring: number | null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** How long a click ring takes to expand and fade out. */
const RING_MS = 520;

/** The ring's radius and opacity at a point in its life. */
export function ringAt(progress: number, shortEdgePx: number): { radius: number; alpha: number } {
	// Ease-out: fast at the start, so the ring reads as a response to the click
	// rather than as something that drifted outward on its own.
	const eased = 1 - (1 - progress) ** 3;
	return {
		radius: shortEdgePx * (0.012 + eased * 0.055),
		alpha: (1 - progress) * 0.55,
	};
}

/** Samples telemetry at a time, interpolating between the two nearest points. */
function sampleAt(
	telemetry: readonly CursorTelemetryPoint[],
	timeMs: number,
): { cx: number; cy: number; index: number } | null {
	if (telemetry.length === 0) return null;
	if (timeMs <= telemetry[0].timeMs) {
		return { cx: telemetry[0].cx, cy: telemetry[0].cy, index: 0 };
	}
	const last = telemetry[telemetry.length - 1];
	if (timeMs >= last.timeMs) {
		return { cx: last.cx, cy: last.cy, index: telemetry.length - 1 };
	}

	// Telemetry is sorted, so a linear walk from a proportional guess is close.
	let index = Math.min(
		telemetry.length - 2,
		Math.max(0, Math.floor((timeMs / Math.max(1, last.timeMs)) * (telemetry.length - 1))),
	);
	while (index > 0 && telemetry[index].timeMs > timeMs) index--;
	while (index < telemetry.length - 2 && telemetry[index + 1].timeMs <= timeMs) index++;

	const from = telemetry[index];
	const to = telemetry[index + 1];
	const span = to.timeMs - from.timeMs;
	const t = span > 0 ? (timeMs - from.timeMs) / span : 0;
	return {
		cx: from.cx + (to.cx - from.cx) * t,
		cy: from.cy + (to.cy - from.cy) * t,
		index,
	};
}

/** The most recent click at or before a time, and how long ago it was. */
function lastClickBefore(
	telemetry: readonly CursorTelemetryPoint[],
	timeMs: number,
): number | null {
	let best: number | null = null;
	for (const point of telemetry) {
		if (point.timeMs > timeMs) break;
		if (point.interactionType === "click" || point.interactionType === "right-click") {
			best = point.timeMs;
		}
	}
	return best === null ? null : timeMs - best;
}

/**
 * Where the pointer is, and how it looks, at one moment of the recording.
 *
 * Returns null when there is nothing to draw — no telemetry, the cursor turned
 * off, or a time outside what was captured.
 */
/**
 * The drawn pointer's spring, carried between frames.
 *
 * Recordly does not place the pointer at a lagged sample — it springs it toward
 * the raw position with the same damped oscillator the camera uses. That is
 * what turns hardware sampling into a glide, and what a fixed lag cannot do:
 * a lag reproduces every jitter faithfully, just late.
 */
export interface CursorSpringState {
	x: SpringState;
	y: SpringState;
	lastMs: number | null;
}

export function createCursorSpringState(): CursorSpringState {
	return { x: createSpringState(0.5), y: createSpringState(0.5), lastMs: null };
}

export function resetCursorSpring(spring: CursorSpringState): void {
	resetSpringState(spring.x, 0.5);
	resetSpringState(spring.y, 0.5);
	spring.lastMs = null;
}

export function resolveCursor(
	telemetry: readonly CursorTelemetryPoint[],
	timeMs: number,
	settings: CursorSettings,
	/**
	 * Carried by the caller across frames. Without one the pointer falls back to
	 * a fixed lag, which is right for a single still — a one-frame render has no
	 * previous position to spring from.
	 */
	spring?: CursorSpringState,
	/** Time since the last frame. Defaults to 60 Hz. */
	deltaMs = 1000 / 60,
): CursorFrame | null {
	if (!settings.show || telemetry.length === 0) return null;

	const span = telemetry[telemetry.length - 1].timeMs;
	// Looping replays the captured travel under a longer take rather than
	// leaving the pointer parked wherever the samples ran out.
	const at = settings.loop && span > 0 ? timeMs % span : timeMs;
	if (!settings.loop && (at < 0 || at > span + 500)) return null;

	const now = sampleAt(telemetry, at);
	if (!now) return null;

	// Smoothing springs the drawn pointer toward the raw sample rather than
	// lagging it. `smoothing` is 0–1 here and Recordly's curve is 0–2, so it is
	// scaled onto that range: 1 gives the floatiest glide the solver offers.
	let cx: number;
	let cy: number;
	if (spring) {
		const config = getCursorSpringConfig(settings.smoothing * 2);
		// The spring is born at the middle of the frame, so on its very first
		// step it would glide in from the centre toward wherever the pointer
		// actually was — a second or so at the head of every take where the
		// cursor points at nothing. Seed it with the first real sample instead;
		// smoothing is for movement between samples, not for arriving.
		if (spring.lastMs === null) {
			resetSpringState(spring.x, now.cx);
			resetSpringState(spring.y, now.cy);
		}
		cx = clamp01(stepSpringValue(spring.x, now.cx, deltaMs, config));
		cy = clamp01(stepSpringValue(spring.y, now.cy, deltaMs, config));
	} else {
		const lagged = sampleAt(telemetry, at - settings.smoothing * 120) ?? now;
		cx = clamp01(lagged.cx);
		cy = clamp01(lagged.cy);
	}

	// Travel over a short window gives both the blur length and its direction.
	const before = sampleAt(telemetry, at - 40) ?? now;
	const dx = now.cx - before.cx;
	const dy = now.cy - before.cy;
	const speed = Math.hypot(dx, dy);
	const angle = speed > 0.0002 ? Math.atan2(dy, dx) : 0;

	// Sway nudges the pointer across its own direction of travel, scaled by how
	// fast it is moving, so a still cursor never drifts.
	const swayPhase = Math.sin(at / 260);
	const swayAmount = settings.sway * speed * 0.35 * swayPhase;

	let scale = settings.size;
	let clicking = false;
	const sinceClick = lastClickBefore(telemetry, at);
	if (sinceClick !== null && sinceClick < settings.bounceSpeed && settings.clickBounce > 0) {
		const t = sinceClick / settings.bounceSpeed;
		// A single decaying half-sine: one pop, no ringing.
		const pop = Math.sin(t * Math.PI) * (1 - t);
		scale *= 1 + (settings.clickBounce / 100) * pop;
		clicking = t < 0.5;
	}

	// The ring runs longer than the bounce — it is the thing you actually see
	// on a fast click, where the pop is over before the eye lands on it.
	const ring =
		settings.clickRing && sinceClick !== null && sinceClick < RING_MS
			? sinceClick / RING_MS
			: null;

	return {
		cx: clamp01(cx - Math.sin(angle) * swayAmount),
		cy: clamp01(cy + Math.cos(angle) * swayAmount),
		scale,
		blur: settings.motionBlur * speed * 900,
		angle,
		opacity: 1,
		clicking,
		ring,
		rawCx: clamp01(now.cx),
		rawCy: clamp01(now.cy),
	};
}

/** The pointer's outline in a 24×24 box, so both renderers draw one shape. */
export function cursorPath(style: CursorStyle): string {
	switch (style) {
		case "dot":
			return "M12 5 A7 7 0 1 1 11.99 5 Z";
		case "pointer":
			// A slimmer, more upright arrow.
			return "M6 2 L6 19 L10.2 15.2 L12.8 21 L15.6 19.7 L13 14 L18.4 13.8 Z";
		default:
			return "M5 2 L5 18.5 L9.4 14.4 L12.2 20.6 L15.4 19.2 L12.6 13.2 L18.6 13 Z";
	}
}

export function cursorFill(style: CursorStyle): { fill: string; stroke: string } {
	if (style === "arrow-solid") return { fill: "#000000", stroke: "#FFFFFF" };
	if (style === "dot") return { fill: "#FFFFFF", stroke: "rgba(0,0,0,0.45)" };
	return { fill: "#FFFFFF", stroke: "#000000" };
}
