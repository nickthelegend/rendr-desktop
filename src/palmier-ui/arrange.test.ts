// The invariant under every arranging tool.
//
// align, distribute, stagger and close_gaps all reduce to `placeAt`, and they
// are only safe to chain because it cannot change a duration. A mover that
// resizes while it moves is invisible until an export runs long, so that is
// what these pin. `overlapNote` is the other half: overlap is legal here, and
// the danger is committing it silently, because a clip hidden under another is
// simply absent from the render with nothing else to say so.

import { describe, expect, it } from "vitest";

import { overlapNote, placeAt } from "./agentTools";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";

const clip = (id: string, start: number, end: number) =>
	withDefaults({
		id,
		name: id,
		mediaType: "video" as const,
		assetId: "a1",
		startFrame: start,
		endFrame: end,
	});

const timeline = (...clips: ReturnType<typeof clip>[]): TimelineModel => ({
	id: "t",
	name: "Main",
	fps: 30,
	width: 1920,
	height: 1080,
	tracks: [{ id: "v1", name: "V1", kind: "video", muted: false, hidden: false, clips }],
});

describe("placeAt", () => {
	it("moves a clip without changing how long it is", () => {
		const before = timeline(clip("a", 10, 100));
		const after = placeAt(before, new Map([["a", 40]]));
		const moved = after.tracks[0].clips[0];
		expect(moved.startFrame).toBe(40);
		expect(moved.endFrame).toBe(130);
	});

	it("keeps the duration even when asked to start before zero", () => {
		// Clamping the start without carrying the end would silently shorten the
		// clip — the exact bug this function exists to make impossible.
		const after = placeAt(timeline(clip("a", 10, 100)), new Map([["a", -50]]));
		const moved = after.tracks[0].clips[0];
		expect(moved.startFrame).toBe(0);
		expect(moved.endFrame - moved.startFrame).toBe(90);
	});

	it("leaves clips it was not asked about alone", () => {
		const before = timeline(clip("a", 0, 30), clip("b", 60, 90));
		const after = placeAt(before, new Map([["a", 10]]));
		expect(after.tracks[0].clips[1].startFrame).toBe(60);
	});

	it("is a no-op when a clip is already where it is going", () => {
		const before = timeline(clip("a", 10, 100));
		expect(placeAt(before, new Map([["a", 10]]))).toBe(before);
	});

	it("rounds a fractional frame rather than storing one", () => {
		const after = placeAt(timeline(clip("a", 0, 30)), new Map([["a", 12.7]]));
		expect(after.tracks[0].clips[0].startFrame).toBe(13);
	});
});

describe("overlapNote", () => {
	it("says nothing when clips do not touch", () => {
		expect(overlapNote(timeline(clip("a", 0, 30), clip("b", 30, 60)), ["a"])).toEqual({});
	});

	it("names both clips when a move stacked them", () => {
		const stacked = timeline(clip("a", 0, 50), clip("b", 20, 70));
		const note = overlapNote(stacked, ["b"]);
		expect(note.warnings).toBeDefined();
		expect(String(note.warnings)).toContain("a / b");
	});

	it("ignores an overlap that was already there before this move", () => {
		// Reporting pre-existing overlap on every call would train a caller to
		// ignore the warning, which is worse than not warning at all.
		const stacked = timeline(clip("a", 0, 50), clip("b", 20, 70), clip("c", 200, 230));
		expect(overlapNote(stacked, ["c"])).toEqual({});
	});
});
