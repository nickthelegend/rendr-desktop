// @vitest-environment jsdom
//
// A whole session, end to end, through the real editor state.
//
// Every other suite tests one piece. This one does what a user does — import,
// place, cut, zoom, grade, undo, save, reopen — in order, against the actual
// `useEditorState` with nothing stubbed but the browser APIs jsdom lacks. It
// exists because the pieces have all passed individually before while the
// sequence still broke: a reducer that works alone can still leave the timeline
// in a state the next step mishandles.

import { act, renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import type { AssetModel } from "./media";
import { parseProject } from "./project";
import { splitAt } from "./reducers";
import { useEditorState } from "./state";

beforeAll(() => {
	// jsdom has no object URLs and no media decode; nothing under test needs
	// either, but the code paths call them.
	if (!URL.createObjectURL) {
		URL.createObjectURL = () => "blob:test";
		URL.revokeObjectURL = () => undefined;
	}
});

const asset = (over: Partial<AssetModel> = {}): AssetModel => ({
	id: "take-1",
	name: "Screen recording.webm",
	type: "video",
	durationSeconds: 10,
	width: 1920,
	height: 1080,
	hasAudio: false,
	url: "blob:take-1",
	fromRecording: true,
	hasCursorTelemetry: true,
	...over,
});

/** Every clip on the active timeline, in track order. */
function clipsOf(api: ReturnType<typeof useEditorState>) {
	return api.timeline.tracks.flatMap((track) => track.clips);
}

describe("a full editing session", () => {
	it("carries a take from import to a saved project and back", () => {
		const { result } = renderHook(() => useEditorState());

		// ── 1. A new project is genuinely empty ─────────────────────────
		expect(clipsOf(result.current)).toHaveLength(0);
		expect(result.current.state.assets).toHaveLength(0);
		expect(result.current.state.dirty).toBe(false);

		// ── 2. Import ───────────────────────────────────────────────────
		act(() => result.current.addAssets([asset()]));
		expect(result.current.state.assets).toHaveLength(1);

		// ── 3. Place it on the timeline ─────────────────────────────────
		act(() => result.current.placeAsset("take-1", 0));
		const placed = clipsOf(result.current);
		expect(placed).toHaveLength(1);
		// 10s at the project's fps, not a guessed default.
		expect(placed[0].endFrame - placed[0].startFrame).toBe(10 * result.current.timeline.fps);
		expect(result.current.state.dirty).toBe(true);

		// ── 4. Split it at the playhead ─────────────────────────────────
		act(() => result.current.patch({ playhead: 90 }));
		act(() => result.current.commit("Split at playhead", (t) => splitAt(t, 90)));
		const afterSplit = clipsOf(result.current);
		expect(afterSplit).toHaveLength(2);
		// The cut is exact and leaves no gap: one ends where the next begins.
		const [left, right] = [...afterSplit].sort((a, b) => a.startFrame - b.startFrame);
		expect(left.endFrame).toBe(90);
		expect(right.startFrame).toBe(90);
		// The second half reads from further into the source, or it would
		// replay the first half's footage.
		expect(right.trimStartFrame).toBeGreaterThan(left.trimStartFrame);

		// ── 5. Undo puts it back as one clip ────────────────────────────
		act(() => result.current.undo());
		expect(clipsOf(result.current)).toHaveLength(1);
		act(() => result.current.redo());
		expect(clipsOf(result.current)).toHaveLength(2);

		// ── 6. Select and grade ─────────────────────────────────────────
		const target = clipsOf(result.current)[0];
		act(() => result.current.selectClip(target.id));
		expect(result.current.state.selectedClipIds).toContain(target.id);
		act(() =>
			result.current.commit("Grade", (t) => ({
				...t,
				tracks: t.tracks.map((track) => ({
					...track,
					clips: track.clips.map((clip) =>
						clip.id === target.id
							? { ...clip, color: { ...clip.color, contrast: 1.3 } }
							: clip,
					),
				})),
			})),
		);
		expect(clipsOf(result.current).find((c) => c.id === target.id)?.color.contrast).toBe(1.3);

		// ── 7. Take-wide settings ───────────────────────────────────────
		act(() =>
			result.current.patch({
				cursor: { ...result.current.state.cursor, size: 3.5, spotlight: 0.4 },
				background: { ...result.current.state.background, kind: "gradient", padding: 0.1 },
				cursorTelemetry: [
					{ timeMs: 0, cx: 0.2, cy: 0.3, interactionType: "click" },
					{ timeMs: 900, cx: 0.7, cy: 0.6, interactionType: "click" },
				],
			}),
		);

		// ── 8. Save, and read the file back ─────────────────────────────
		const saved = result.current.snapshot();
		const reopened = parseProject(JSON.stringify(saved));

		expect(reopened.timelines[0].tracks.flatMap((t) => t.clips)).toHaveLength(2);
		// The grade survives the round trip.
		const graded = reopened.timelines[0].tracks
			.flatMap((t) => t.clips)
			.find((c) => c.id === target.id);
		expect(graded?.color.contrast).toBe(1.3);
		// So do the take-wide settings and the pointer path — losing the
		// telemetry would silently disable zoom suggestions on reopen.
		expect(reopened.cursor?.size).toBe(3.5);
		expect(reopened.cursor?.spotlight).toBe(0.4);
		expect(reopened.background?.kind).toBe("gradient");
		expect(reopened.cursorTelemetry).toHaveLength(2);
		// Media is referenced, not embedded, so it comes back needing a relink.
		expect(reopened.assets).toHaveLength(1);
		expect(reopened.assets[0].id).toBe("take-1");
	});

	it("keeps the timeline usable after deleting everything on it", () => {
		const { result } = renderHook(() => useEditorState());
		act(() => result.current.addAssets([asset()]));
		act(() => result.current.placeAsset("take-1", 0));
		const clip = clipsOf(result.current)[0];

		act(() => result.current.selectClip(clip.id));
		act(() => result.current.deleteSelection());
		expect(clipsOf(result.current)).toHaveLength(0);
		expect(result.current.totalFrames).toBe(0);
		// The tracks stay, so the next drop has somewhere to land.
		expect(result.current.timeline.tracks.length).toBeGreaterThan(0);

		// And the whole thing is still undoable back to a working timeline.
		act(() => result.current.undo());
		expect(clipsOf(result.current)).toHaveLength(1);
	});

	it("drops the clips of an asset removed from the library", () => {
		const { result } = renderHook(() => useEditorState());
		act(() => result.current.addAssets([asset()]));
		act(() => result.current.placeAsset("take-1", 0));
		expect(clipsOf(result.current)).toHaveLength(1);

		act(() => result.current.removeAsset("take-1"));
		// A clip pointing at media that no longer exists renders nothing, so it
		// goes with the asset rather than staying as an invisible hole.
		expect(clipsOf(result.current)).toHaveLength(0);
		expect(result.current.state.assets).toHaveLength(0);
	});

	it("starts a new project clean after work has been done", () => {
		const { result } = renderHook(() => useEditorState());
		act(() => result.current.addAssets([asset()]));
		act(() => result.current.placeAsset("take-1", 0));
		act(() => result.current.newProject());

		expect(clipsOf(result.current)).toHaveLength(0);
		expect(result.current.state.assets).toHaveLength(0);
		expect(result.current.state.dirty).toBe(false);
		// Undo must not reach across a new project into the last one.
		expect(result.current.canUndo).toBe(false);
	});
});
