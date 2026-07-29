// @vitest-environment jsdom
//
// Timeline drag geometry.
//
// Everything else on the timeline goes through a reducer that can be tested on
// its own. This doesn't: it turns pointer pixels into frames, decides when a
// press has become a drag, snaps to neighbours, and shows a live preview that
// must match what gets committed on release. Those are the parts that only
// break under a real gesture, which is why this drives one.

import { act, renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";
import type { EditorApi } from "./state";
import { useTimelineDrag } from "./useTimelineDrag";

beforeAll(() => {
	// jsdom has no hit testing. A move drag asks what track is under the pointer
	// so it can drop across tracks; without this it throws mid-gesture and the
	// drag silently does nothing — which is a gap in the environment, not the
	// hook. Returning nothing means "same track", the single-track case here.
	if (!document.elementsFromPoint) {
		document.elementsFromPoint = () => [];
	}
});

const PX_PER_FRAME = 4;
const ORIGIN_X = 100;

function timelineWith(clips: Array<Record<string, unknown>>): TimelineModel {
	return {
		id: "tl",
		name: "Main",
		fps: 30,
		width: 1920,
		height: 1080,
		tracks: [
			{
				id: "v1",
				name: "V1",
				kind: "video",
				muted: false,
				hidden: false,
				clips: clips.map((over) =>
					withDefaults({
						id: "c1",
						name: "Take.mp4",
						mediaType: "video",
						assetId: "a1",
						startFrame: 0,
						endFrame: 60,
						...over,
					}),
				),
			},
		],
	};
}

/** A minimal editor whose commits are captured rather than applied. */
function harness(timeline: TimelineModel) {
	const commits: Array<{ label: string; result: TimelineModel }> = [];
	let current = timeline;
	// A move drags the *selection*, so the harness has to actually select —
	// a spy that records the call and changes nothing would make every move
	// silently no-op and the test pass for the wrong reason.
	const state = { playhead: 0, selectedClipIds: [] as string[], selectedZoomRegionId: null };
	const api = {
		state,
		get timeline() {
			return current;
		},
		commit: vi.fn((label: string, fn: (t: TimelineModel) => TimelineModel) => {
			current = fn(current);
			commits.push({ label, result: current });
		}),
		patch: vi.fn(),
		selectClip: vi.fn((id: string) => {
			state.selectedClipIds = [id];
		}),
	} as unknown as EditorApi;
	return { api, commits, latest: () => current };
}

/** A React-style pointer event carrying only what the hook reads. */
function pointerEvent(clientX: number, clientY = 0) {
	return {
		clientX,
		clientY,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as React.PointerEvent;
}

/** Moves the real window pointer, which is what the hook listens on. */
function movePointer(clientX: number, clientY = 0) {
	window.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY, bubbles: true }));
}

function releasePointer(clientX: number, clientY = 0) {
	window.dispatchEvent(new PointerEvent("pointerup", { clientX, clientY, bubbles: true }));
}

const geometry = () => ({ pxPerFrame: PX_PER_FRAME, originX: ORIGIN_X, fps: 30 });

function firstClip(timeline: TimelineModel) {
	return timeline.tracks[0].clips[0];
}

describe("useTimelineDrag", () => {
	it("treats a press with no movement as a click, not a drag", () => {
		const { api, commits } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => result.current.beginClipDrag(pointerEvent(200), "c1", "move"));
		act(() => releasePointer(200));

		// A click selects; it must not commit an edit of zero frames.
		expect(commits).toHaveLength(0);
		expect(result.current.drag).toBeNull();
	});

	it("ignores movement below the drag threshold", () => {
		const { api, commits } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => result.current.beginClipDrag(pointerEvent(200), "c1", "move"));
		// Two pixels: hand tremor while clicking, not an intent to move.
		act(() => movePointer(202));
		act(() => releasePointer(202));
		expect(commits).toHaveLength(0);
	});

	it("converts pixels into frames at the timeline's zoom", () => {
		const { api, commits, latest } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => api.selectClip("c1"));
		act(() => result.current.beginClipDrag(pointerEvent(200), "c1", "move"));
		// 40px at 4px/frame is 10 frames, whatever the zoom happens to be.
		act(() => movePointer(240));
		act(() => releasePointer(240));

		expect(commits).toHaveLength(1);
		expect(firstClip(latest()).startFrame).toBe(10);
		expect(firstClip(latest()).endFrame).toBe(70);
	});

	it("shows a live preview that matches what it commits", () => {
		const { api, latest } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => api.selectClip("c1"));
		act(() => result.current.beginClipDrag(pointerEvent(200), "c1", "move"));
		act(() => movePointer(240));

		// The preview is what the user is looking at mid-drag; if it disagrees
		// with the commit, the clip jumps on release.
		const previewed = firstClip(result.current.displayed).startFrame;
		act(() => releasePointer(240));
		expect(previewed).toBe(firstClip(latest()).startFrame);
	});

	it("never drags a clip before frame zero", () => {
		const { api, latest } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => api.selectClip("c1"));
		act(() => result.current.beginClipDrag(pointerEvent(200), "c1", "move"));
		// Far past the left edge of the timeline.
		act(() => movePointer(-500));
		act(() => releasePointer(-500));

		expect(firstClip(latest()).startFrame).toBeGreaterThanOrEqual(0);
	});

	it("trims the in point without moving the out point", () => {
		const { api, latest } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => result.current.beginClipDrag(pointerEvent(ORIGIN_X), "c1", "trim-start"));
		act(() => movePointer(ORIGIN_X + 40));
		act(() => releasePointer(ORIGIN_X + 40));

		const clip = firstClip(latest());
		expect(clip.startFrame).toBe(10);
		expect(clip.endFrame).toBe(60);
		// Trimming the head must advance into the source, or the picture jumps.
		expect(clip.trimStartFrame).toBeGreaterThan(0);
	});

	it("trims the out point without moving the in point", () => {
		const { api, latest } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => result.current.beginClipDrag(pointerEvent(ORIGIN_X + 240), "c1", "trim-end"));
		act(() => movePointer(ORIGIN_X + 200));
		act(() => releasePointer(ORIGIN_X + 200));

		const clip = firstClip(latest());
		expect(clip.startFrame).toBe(0);
		expect(clip.endFrame).toBe(50);
	});

	it("never trims a clip to nothing", () => {
		const { api, latest } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => result.current.beginClipDrag(pointerEvent(ORIGIN_X + 240), "c1", "trim-end"));
		// Dragging the out point past the in point.
		act(() => movePointer(ORIGIN_X - 400));
		act(() => releasePointer(ORIGIN_X - 400));

		const clip = firstClip(latest());
		expect(clip.endFrame).toBeGreaterThan(clip.startFrame);
	});

	it("clears the drag state on release, so the next gesture starts clean", () => {
		const { api } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => api.selectClip("c1"));
		act(() => result.current.beginClipDrag(pointerEvent(200), "c1", "move"));
		act(() => movePointer(240));
		expect(result.current.drag).not.toBeNull();
		act(() => releasePointer(240));
		expect(result.current.drag).toBeNull();
	});

	it("marquees a rectangle from press to release", () => {
		const { api } = harness(timelineWith([{}]));
		const { result } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => result.current.beginMarquee(pointerEvent(120, 40)));
		act(() => movePointer(300, 90));

		const box = result.current.marquee;
		expect(box).not.toBeNull();
		expect(box?.x1).toBe(120);
		expect(box?.x2).toBe(300);
		act(() => releasePointer(300, 90));
		expect(result.current.marquee).toBeNull();
	});

	it("stops listening after unmount", () => {
		const { api, commits } = harness(timelineWith([{}]));
		const { result, unmount } = renderHook(() => useTimelineDrag(api, geometry));

		act(() => result.current.beginClipDrag(pointerEvent(200), "c1", "move"));
		unmount();
		// A window listener left behind would keep editing a timeline whose
		// editor is gone.
		act(() => movePointer(400));
		act(() => releasePointer(400));
		expect(commits).toHaveLength(0);
	});
});
