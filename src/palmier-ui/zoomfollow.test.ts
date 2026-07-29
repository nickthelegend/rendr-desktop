// The zoom camera following the cursor — Recordly's model, ported wholesale.
//
// The camera is deliberately *stateful*. It holds a position and only recenters
// when the cursor leaves an inner safe zone of the zoomed view, and it freezes
// where it is while zooming back out. A camera that simply pointed at the
// cursor would swim under a still hand and lurch on every small movement, which
// is the thing the safe zone exists to prevent — so these tests assert the
// holding as much as the following.

import { describe, expect, it } from "vitest";

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { ZoomRegionModel } from "./model";
import { createCursorFollowCameraState, resolveCamera } from "./zoom";

/**
 * The pointer sits on the region's focus, then jumps to the far corner at 5s.
 *
 * Starting it *on* the focus is deliberate: the camera only reacts once the
 * cursor leaves the safe zone, so a pointer that begins outside the zone would
 * make the "holds position" case untestable — it would recenter immediately and
 * correctly.
 */
function telemetry(): CursorTelemetryPoint[] {
	const points: CursorTelemetryPoint[] = [];
	for (let t = 0; t <= 10000; t += 100) {
		const late = t > 5000;
		points.push({
			timeMs: t,
			cx: late ? 0.85 : 0.35,
			cy: late ? 0.8 : 0.4,
			interactionType: "move",
		});
	}
	return points;
}

const region = (mode: "auto" | "manual"): ZoomRegionModel => ({
	id: "z1",
	startMs: 0,
	endMs: 10000,
	depth: 4,
	// Inside the legal range at this depth: a focus nearer an edge would be
	// clamped to keep the frame covered, which the clamp test covers separately.
	focus: { cx: 0.35, cy: 0.4 },
	mode,
});

const camera = (
	mode: "auto" | "manual",
	atMs: number,
	state?: ReturnType<typeof createCursorFollowCameraState>,
) => resolveCamera([region(mode)], atMs, 1920, 1080, telemetry(), state);

describe("the follow camera", () => {
	it("zooms at all", () => {
		expect(camera("auto", 3000).scale).toBeGreaterThan(1);
	});

	it("starts on the region's own focus", () => {
		// The first zoomed frame anchors where the region says, not wherever the
		// pointer happens to be at that instant.
		const state = createCursorFollowCameraState();
		const first = camera("auto", 2500, state);
		expect(first.focus.cx).toBeCloseTo(0.35, 5);
		expect(first.focus.cy).toBeCloseTo(0.4, 5);
	});

	it("holds position while the cursor stays inside the safe zone", () => {
		const state = createCursorFollowCameraState();
		const first = camera("auto", 2500, state);
		// More samples in the same place: the camera must not creep toward them.
		const later = camera("auto", 3000, state);
		expect(later.focus.cx).toBeCloseTo(first.focus.cx, 5);
		expect(later.focus.cy).toBeCloseTo(first.focus.cy, 5);
	});

	it("recenters once the cursor leaves the safe zone", () => {
		const state = createCursorFollowCameraState();
		const before = camera("auto", 2500, state);
		// The pointer jumps to the far corner at 5s, well outside the zone.
		const after = camera("auto", 8000, state);
		expect(after.focus.cx).toBeGreaterThan(before.focus.cx);
		expect(after.focus.cy).toBeGreaterThan(before.focus.cy);
	});

	it("keeps the focus inside the frame, so no edge is exposed", () => {
		const state = createCursorFollowCameraState();
		const shot = camera("auto", 8000, state);
		// At scale s the focus can only travel within 1/(2s) of the centre, or
		// the zoomed view would run off the picture.
		const halfSpan = 1 / (2 * shot.scale);
		expect(shot.focus.cx).toBeGreaterThanOrEqual(halfSpan - 1e-6);
		expect(shot.focus.cx).toBeLessThanOrEqual(1 - halfSpan + 1e-6);
		expect(shot.focus.cy).toBeGreaterThanOrEqual(halfSpan - 1e-6);
		expect(shot.focus.cy).toBeLessThanOrEqual(1 - halfSpan + 1e-6);
	});

	it("leaves a manual region on the focus it was given", () => {
		// Manual is a promise that the shot stays where it was put, whatever the
		// pointer does afterwards.
		const shot = camera("manual", 8000, createCursorFollowCameraState());
		expect(shot.focus.cx).toBeCloseTo(0.35, 5);
		expect(shot.focus.cy).toBeCloseTo(0.4, 5);
	});

	it("uses the region's focus when there is no telemetry to follow", () => {
		const state = createCursorFollowCameraState();
		const shot = resolveCamera([region("auto")], 3000, 1920, 1080, [], state);
		expect(shot.focus.cx).toBeCloseTo(0.35, 5);
	});

	it("uses the region's focus when the caller keeps no state", () => {
		// A single still has no travel to follow, so it renders the region as
		// authored rather than inventing a camera position for one frame.
		expect(camera("auto", 8000, undefined).focus.cx).toBeCloseTo(0.35, 5);
	});

	it("is neutral outside every region", () => {
		const shot = resolveCamera(
			[{ ...region("auto"), startMs: 0, endMs: 1000 }],
			8000,
			1920,
			1080,
			telemetry(),
			createCursorFollowCameraState(),
		);
		expect(shot.scale).toBe(1);
	});
});
