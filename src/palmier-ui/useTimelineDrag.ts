// Timeline pointer gestures: move a clip, trim either edge, move or resize a
// zoom region, and marquee-select.
//
// One gesture is one undo step. The drag runs on a local preview so the
// timeline follows the pointer at frame rate, and only commits when the pointer
// comes up — otherwise every pixel of a drag would be its own history entry.

import { useCallback, useEffect, useRef, useState } from "react";

import {
	moveClip,
	snapFrame,
	snapTargets,
	type TimelineModel,
	trimClipEnd,
	trimClipStart,
	updateZoomRegion,
} from "./reducers";
import type { EditorApi } from "./state";

/** Pixels of slop before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;
/** How close, in pixels, a boundary has to be to snap. */
const SNAP_THRESHOLD_PX = 8;
/** Grab zone on each clip edge. */
export const TRIM_HANDLE_PX = 7;

export type DragKind = "move" | "trim-start" | "trim-end" | "zoom-move" | "zoom-start" | "zoom-end";

export interface DragState {
	kind: DragKind;
	clipId: string;
	regionId?: string;
	/** Live preview of the timeline mid-drag. */
	preview: TimelineModel;
	snappedTo: number | null;
}

export interface MarqueeState {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

interface Geometry {
	pxPerFrame: number;
	/** Client X of frame 0. */
	originX: number;
	fps: number;
}

export function useTimelineDrag(api: EditorApi, geometry: () => Geometry) {
	const { state, timeline, commit, patch, selectClip } = api;
	const [drag, setDrag] = useState<DragState | null>(null);
	const [marquee, setMarquee] = useState<MarqueeState | null>(null);
	const dragRef = useRef<DragState | null>(null);
	dragRef.current = drag;

	/**
	 * Detaches whatever a gesture in flight has attached to the window.
	 *
	 * A drag adds its own pointermove/pointerup and removes them on release. If
	 * the editor unmounts mid-drag, that release never comes — the listeners
	 * outlive the component and keep committing edits to a timeline nobody is
	 * looking at any more.
	 */
	const detachRef = useRef<(() => void) | null>(null);
	useEffect(() => () => detachRef.current?.(), []);

	/**
	 * Starts a clip gesture. `edge` decides whether this trims or moves, and is
	 * resolved by the caller from where in the clip the pointer landed.
	 */
	const beginClipDrag = useCallback(
		(
			event: React.PointerEvent,
			clipId: string,
			kind: Extract<DragKind, "move" | "trim-start" | "trim-end">,
		) => {
			const { pxPerFrame, originX } = geometry();
			const clip = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
			if (!clip) return;

			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const startY = event.clientY;
			const grabOffsetFrames = (event.clientX - originX) / pxPerFrame - clip.startFrame;
			// Snap against everything except the clip being dragged.
			const targets = snapTargets(timeline, state.playhead, [clipId]);
			let moved = false;
			let latest: TimelineModel | null = null;
			let latestSnap: number | null = null;
			let targetTrackId: string | undefined;

			const onMove = (moveEvent: PointerEvent) => {
				if (!moved) {
					if (
						Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD_PX &&
						Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX
					) {
						return;
					}
					moved = true;
				}

				const rawFrame = (moveEvent.clientX - originX) / pxPerFrame;
				const threshold = SNAP_THRESHOLD_PX / pxPerFrame;

				if (kind === "move") {
					const wanted = rawFrame - grabOffsetFrames;
					const snapped = snapFrame(wanted, targets, threshold);
					// Dropping onto another track is decided by what is under the pointer.
					const row = document
						.elementsFromPoint(moveEvent.clientX, moveEvent.clientY)
						.find((node) => node instanceof HTMLElement && node.dataset.trackId) as
						| HTMLElement
						| undefined;
					targetTrackId = row?.dataset.trackId;
					latest = moveClip(timeline, clipId, Math.max(0, snapped.frame), targetTrackId);
					latestSnap = snapped.snappedTo;
				} else if (kind === "trim-start") {
					const snapped = snapFrame(rawFrame, targets, threshold);
					latest = trimClipStart(timeline, clipId, snapped.frame);
					latestSnap = snapped.snappedTo;
				} else {
					const snapped = snapFrame(rawFrame, targets, threshold);
					latest = trimClipEnd(timeline, clipId, snapped.frame);
					latestSnap = snapped.snappedTo;
				}

				setDrag({ kind, clipId, preview: latest, snappedTo: latestSnap });
			};

			const onUp = (upEvent: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				setDrag(null);

				if (!moved) {
					// A press that never moved is a selection, not an edit.
					selectClip(clipId, upEvent.metaKey || upEvent.shiftKey);
					return;
				}
				const result = latest;
				if (!result) return;
				const label =
					kind === "move"
						? "Move clip"
						: kind === "trim-start"
							? "Trim head"
							: "Trim tail";
				commit(label, () => result);
			};

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			detachRef.current = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
		},
		[commit, geometry, selectClip, state.playhead, timeline],
	);

	/** Zoom regions are edited in source milliseconds, so gestures convert. */
	const beginZoomDrag = useCallback(
		(
			event: React.PointerEvent,
			clipId: string,
			regionId: string,
			kind: Extract<DragKind, "zoom-move" | "zoom-start" | "zoom-end">,
		) => {
			const { pxPerFrame, fps } = geometry();
			const clip = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
			const region = clip?.zoomRegions?.find((entry) => entry.id === regionId);
			if (!clip || !region) return;

			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const origin = { startMs: region.startMs, endMs: region.endMs };
			// One timeline pixel is this many source milliseconds for this clip.
			const msPerPx = (clip.speed / (pxPerFrame * fps)) * 1000;
			let moved = false;
			let latest: TimelineModel | null = null;

			const onMove = (moveEvent: PointerEvent) => {
				const deltaPx = moveEvent.clientX - startX;
				if (!moved && Math.abs(deltaPx) < DRAG_THRESHOLD_PX) return;
				moved = true;
				const deltaMs = deltaPx * msPerPx;

				const patchRegion =
					kind === "zoom-move"
						? { startMs: origin.startMs + deltaMs, endMs: origin.endMs + deltaMs }
						: kind === "zoom-start"
							? { startMs: origin.startMs + deltaMs }
							: { endMs: origin.endMs + deltaMs };

				const result = updateZoomRegion(
					timeline,
					clipId,
					regionId,
					patchRegion,
					Number.MAX_SAFE_INTEGER,
				);
				// A refused edit (overlap, too short) simply doesn't move the preview.
				if (result.ok) {
					latest = result.timeline;
					setDrag({ kind, clipId, regionId, preview: result.timeline, snappedTo: null });
				}
			};

			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				setDrag(null);
				if (!moved) {
					selectClip(clipId, false);
					patch({ selectedZoomRegionId: regionId });
					return;
				}
				const result = latest;
				if (result)
					commit(kind === "zoom-move" ? "Move zoom" : "Resize zoom", () => result);
			};

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			detachRef.current = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
		},
		[commit, geometry, patch, selectClip, timeline],
	);

	/** Rubber-band selection across tracks. */
	const beginMarquee = useCallback(
		(event: React.PointerEvent) => {
			const startX = event.clientX;
			const startY = event.clientY;
			let moved = false;

			const onMove = (moveEvent: PointerEvent) => {
				if (
					!moved &&
					Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD_PX &&
					Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX
				) {
					return;
				}
				moved = true;
				setMarquee({
					x1: startX,
					y1: startY,
					x2: moveEvent.clientX,
					y2: moveEvent.clientY,
				});
			};

			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				if (!moved) {
					setMarquee(null);
					return;
				}
				// Hit-test the drawn rect against the clips on screen.
				const box = {
					left: Math.min(startX, lastX.current),
					right: Math.max(startX, lastX.current),
					top: Math.min(startY, lastY.current),
					bottom: Math.max(startY, lastY.current),
				};
				const hits: string[] = [];
				for (const node of document.querySelectorAll<HTMLElement>("[data-clip-id]")) {
					const rect = node.getBoundingClientRect();
					const intersects =
						rect.left < box.right &&
						rect.right > box.left &&
						rect.top < box.bottom &&
						rect.bottom > box.top;
					if (intersects && node.dataset.clipId) hits.push(node.dataset.clipId);
				}
				patch({ selectedClipIds: hits, selectedZoomRegionId: null });
				setMarquee(null);
			};

			const lastX = { current: startX };
			const lastY = { current: startY };
			const track = (moveEvent: PointerEvent) => {
				lastX.current = moveEvent.clientX;
				lastY.current = moveEvent.clientY;
			};
			window.addEventListener("pointermove", track);
			window.addEventListener("pointermove", onMove);
			window.addEventListener(
				"pointerup",
				() => window.removeEventListener("pointermove", track),
				{ once: true },
			);
			window.addEventListener("pointerup", onUp);
		},
		[patch],
	);

	/** The timeline to draw: the drag preview while one is live, else the real one. */
	const displayed = drag?.preview ?? timeline;

	return { drag, marquee, displayed, beginClipDrag, beginZoomDrag, beginMarquee };
}
