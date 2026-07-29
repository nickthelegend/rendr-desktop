import { describe, expect, it } from "vitest";

import { type ClipModel, withDefaults } from "./model";
import {
	addTextClip,
	addTrack,
	addZoomRegion,
	duplicateClips,
	findClip,
	freeSpanAt,
	isAudible,
	MIN_CLIP_FRAMES,
	MIN_ZOOM_REGION_MS,
	moveClip,
	nudgeClips,
	pasteClips,
	removeClips,
	removeTrack,
	removeZoomRegion,
	renameTrack,
	reorderTrack,
	setClipBlendMode,
	setClipColor,
	setClipContent,
	setClipCrop,
	setClipDuration,
	setClipNumber,
	setClipTextStyle,
	setClipTiming,
	setClipTransform,
	setTrackFlag,
	snapFrame,
	snapTargets,
	splitAt,
	type TimelineModel,
	toggleSolo,
	totalFrames,
	trimClipEnd,
	trimClipStart,
	updateZoomRegion,
} from "./reducers";

function timelineWith(clips: Partial<ClipModel>[] = []): TimelineModel {
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
				clips: [
					withDefaults({
						id: "c1",
						name: "Screen recording",
						mediaType: "video",
						startFrame: 0,
						endFrame: 300,
						...clips[0],
					}),
				],
			},
			{
				id: "a1",
				name: "A1",
				kind: "audio",
				muted: false,
				hidden: false,
				clips: [
					withDefaults({
						id: "c2",
						name: "Audio",
						mediaType: "audio",
						startFrame: 0,
						endFrame: 300,
					}),
				],
			},
		],
	};
}

const clipOf = (timeline: TimelineModel, id: string) => {
	const clip = findClip(timeline, id);
	if (!clip) throw new Error(`missing clip ${id}`);
	return clip;
};

describe("clip properties", () => {
	it("clamps opacity into range rather than rejecting it", () => {
		const next = setClipNumber(timelineWith(), ["c1"], "opacity", 3);
		expect(clipOf(next, "c1").opacity).toBe(1);
	});

	it("clamps volume to the −60…+15 dB window", () => {
		expect(clipOf(setClipNumber(timelineWith(), ["c1"], "volumeDb", -200), "c1").volumeDb).toBe(
			-60,
		);
		expect(clipOf(setClipNumber(timelineWith(), ["c1"], "volumeDb", 99), "c1").volumeDb).toBe(
			15,
		);
	});

	it("returns the same timeline when nothing changes, so no undo step is recorded", () => {
		const timeline = timelineWith();
		expect(setClipNumber(timeline, ["c1"], "opacity", 1)).toBe(timeline);
	});

	it("leaves unselected clips untouched", () => {
		const next = setClipNumber(timelineWith(), ["c1"], "opacity", 0.5);
		expect(clipOf(next, "c2").opacity).toBe(1);
	});

	it("applies one value across a multi-clip selection", () => {
		const next = setClipNumber(timelineWith(), ["c1", "c2"], "opacity", 0.25);
		expect(clipOf(next, "c1").opacity).toBe(0.25);
		expect(clipOf(next, "c2").opacity).toBe(0.25);
	});

	it("refuses to shrink a clip to nothing through transform", () => {
		const next = setClipTransform(timelineWith(), ["c1"], { width: 0, height: -1 });
		expect(clipOf(next, "c1").transform.width).toBeGreaterThan(0);
		expect(clipOf(next, "c1").transform.height).toBeGreaterThan(0);
	});

	it("clamps rotation to ±180°", () => {
		expect(
			clipOf(setClipTransform(timelineWith(), ["c1"], { rotation: 400 }), "c1").transform
				.rotation,
		).toBe(180);
	});

	it("keeps opposite crops from hiding the whole frame", () => {
		const next = setClipCrop(timelineWith(), ["c1"], { left: 0.8, right: 0.8 });
		const { crop } = clipOf(next, "c1");
		expect(crop.left + crop.right).toBeLessThanOrEqual(0.95);
	});

	it("clamps grade knobs to apply_color's documented ranges", () => {
		const next = setClipColor(timelineWith(), ["c1"], {
			exposure: 99,
			contrast: 0,
			temperature: 0,
		});
		const { color } = clipOf(next, "c1");
		expect(color.exposure).toBe(3);
		expect(color.contrast).toBe(0.5);
		expect(color.temperature).toBe(2000);
	});

	it("merges a partial grade instead of replacing it", () => {
		let timeline = setClipColor(timelineWith(), ["c1"], { exposure: 1 });
		timeline = setClipColor(timeline, ["c1"], { saturation: 1.4 });
		const { color } = clipOf(timeline, "c1");
		expect(color.exposure).toBe(1);
		expect(color.saturation).toBe(1.4);
	});

	it("refuses a blend mode on audio, as Palmier does", () => {
		const next = setClipBlendMode(timelineWith(), ["c2"], "multiply");
		expect(clipOf(next, "c2").blendMode).toBe("normal");
	});

	it("keeps fades inside the clip duration", () => {
		let timeline = setClipTiming(timelineWith(), ["c1"], "fadeInFrames", 250);
		timeline = setClipTiming(timeline, ["c1"], "fadeOutFrames", 250);
		const clip = clipOf(timeline, "c1");
		expect(clip.fadeInFrames + clip.fadeOutFrames).toBeLessThanOrEqual(300);
	});

	it("shortens fades when the clip is shortened", () => {
		let timeline = setClipTiming(timelineWith(), ["c1"], "fadeInFrames", 200);
		timeline = setClipDuration(timeline, ["c1"], 50);
		expect(clipOf(timeline, "c1").fadeInFrames).toBeLessThanOrEqual(50);
	});

	it("edits text content only on text clips", () => {
		const next = setClipContent(timelineWith(), ["c1"], "hello");
		expect(clipOf(next, "c1").content).toBeUndefined();
	});

	it("clamps font size when styling text", () => {
		const timeline = timelineWith([{ mediaType: "text", content: "hi" }]);
		const next = setClipTextStyle(timeline, ["c1"], { fontSize: 9999 });
		expect(clipOf(next, "c1").textStyle?.fontSize).toBe(300);
	});
});

describe("tracks and clips", () => {
	it("mutes a track without touching its clips", () => {
		const next = setTrackFlag(timelineWith(), "a1", "muted", true);
		expect(next.tracks.find((track) => track.id === "a1")?.muted).toBe(true);
		expect(clipOf(next, "c2").volumeDb).toBe(0);
	});

	it("splits a clip at the playhead and advances the right half's source offset", () => {
		const next = splitAt(timelineWith(), 120);
		const video = next.tracks[0].clips;
		expect(video).toHaveLength(2);
		expect(video[0].endFrame).toBe(120);
		expect(video[1].startFrame).toBe(120);
		expect(video[1].trimStartFrame).toBe(120);
	});

	it("does not split at a clip boundary", () => {
		const timeline = timelineWith();
		expect(splitAt(timeline, 0)).toBe(timeline);
		expect(splitAt(timeline, 300)).toBe(timeline);
	});

	it("removes clips by id", () => {
		const next = removeClips(timelineWith(), ["c1"]);
		expect(findClip(next, "c1")).toBeNull();
		expect(findClip(next, "c2")).not.toBeNull();
	});

	it("reports the timeline's last frame", () => {
		expect(totalFrames(timelineWith())).toBe(300);
	});
});

describe("zoom regions", () => {
	const withZoom = () =>
		timelineWith([
			{
				zoomRegions: [
					{
						id: "z1",
						startMs: 2000,
						endMs: 4000,
						depth: 2,
						focus: { cx: 0.5, cy: 0.5 },
						mode: "auto",
					},
				],
			},
		]);

	it("adds a region centred on the playhead", () => {
		const result = addZoomRegion(timelineWith(), "c1", 5000, 2000, 10_000);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const region = clipOf(result.timeline, "c1").zoomRegions?.[0];
		expect(region?.startMs).toBe(4000);
		expect(region?.endMs).toBe(6000);
	});

	it("slides a new region inside the free span rather than overlapping", () => {
		const result = addZoomRegion(withZoom(), "c1", 4200, 3000, 10_000);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const regions = clipOf(result.timeline, "c1").zoomRegions ?? [];
		expect(regions).toHaveLength(2);
		expect(regions[1].startMs).toBeGreaterThanOrEqual(4000);
	});

	it("refuses to add inside an existing region", () => {
		const result = addZoomRegion(withZoom(), "c1", 3000, 2000, 10_000);
		expect(result.ok).toBe(false);
	});

	it("keeps regions sorted by start time", () => {
		const result = addZoomRegion(withZoom(), "c1", 800, 1200, 10_000);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const regions = clipOf(result.timeline, "c1").zoomRegions ?? [];
		expect(regions.map((region) => region.startMs)).toEqual(
			[...regions.map((region) => region.startMs)].sort((a, b) => a - b),
		);
	});

	it("clamps depth to 1–6 on update", () => {
		const result = updateZoomRegion(withZoom(), "c1", "z1", { depth: 99 }, 10_000);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(clipOf(result.timeline, "c1").zoomRegions?.[0].depth).toBe(6);
	});

	it("clamps a focus point into the canvas", () => {
		const result = updateZoomRegion(
			withZoom(),
			"c1",
			"z1",
			{ focus: { cx: 1.8, cy: -0.4 } },
			10_000,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(clipOf(result.timeline, "c1").zoomRegions?.[0].focus).toEqual({ cx: 1, cy: 0 });
	});

	it("refuses an update that would make the region too short", () => {
		const result = updateZoomRegion(withZoom(), "c1", "z1", { endMs: 2100 }, 10_000);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain(String(MIN_ZOOM_REGION_MS));
	});

	it("refuses an update that would overlap a neighbour, changing nothing", () => {
		const base = addZoomRegion(withZoom(), "c1", 7000, 2000, 10_000);
		expect(base.ok).toBe(true);
		if (!base.ok) return;
		const result = updateZoomRegion(base.timeline, "c1", "z1", { endMs: 6500 }, 10_000);
		expect(result.ok).toBe(false);
	});

	it("removes a region by id", () => {
		const result = removeZoomRegion(withZoom(), "c1", "z1");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(clipOf(result.timeline, "c1").zoomRegions).toHaveLength(0);
	});

	it("refuses to remove an unknown region", () => {
		expect(removeZoomRegion(withZoom(), "c1", "nope").ok).toBe(false);
	});

	it("finds the free span around a point", () => {
		const regions = clipOf(withZoom(), "c1").zoomRegions ?? [];
		expect(freeSpanAt(regions, 6000, 10_000)).toEqual({ startMs: 4000, endMs: 10_000 });
		expect(freeSpanAt(regions, 3000, 10_000)).toBeNull();
	});
});

describe("moving clips", () => {
	const twoClips = () => {
		let t = timelineWith();
		t = {
			...t,
			tracks: t.tracks.map((track) =>
				track.id === "v1"
					? {
							...track,
							clips: [
								...track.clips,
								withDefaults({
									id: "c3",
									name: "Second",
									mediaType: "video",
									startFrame: 400,
									endFrame: 600,
								}),
							],
						}
					: track,
			),
		};
		return t;
	};

	it("moves a clip along its track", () => {
		const next = moveClip(timelineWith(), "c1", 120);
		const clip = clipOf(next, "c1");
		expect(clip.startFrame).toBe(120);
		expect(clip.endFrame).toBe(420);
	});

	it("clamps a move at frame zero", () => {
		expect(clipOf(moveClip(timelineWith(), "c1", -500), "c1").startFrame).toBe(0);
	});

	it("moves a clip to another track of the same kind", () => {
		let t = addTrack(timelineWith(), "video");
		const target = t.tracks.find((track) => track.kind === "video" && track.clips.length === 0);
		t = moveClip(t, "c1", 0, target?.id);
		const holder = t.tracks.find((track) => track.clips.some((clip) => clip.id === "c1"));
		expect(holder?.id).toBe(target?.id);
	});

	it("refuses to move audio onto a video track", () => {
		const t = timelineWith();
		expect(moveClip(t, "c2", 0, "v1")).toBe(t);
	});

	it("trims a neighbour it partly lands on", () => {
		// c1 is 0-300 and c3 is 400-600; landing c1 at 500 covers c3's tail half.
		const next = moveClip(twoClips(), "c1", 500);
		const second = clipOf(next, "c3");
		expect(second.startFrame).toBe(400);
		expect(second.endFrame).toBe(500);
	});

	it("consumes a neighbour it lands on top of entirely", () => {
		// Landing c1 (300 frames long) at 300 spans 300-600, covering c3 whole.
		const next = moveClip(twoClips(), "c1", 300);
		expect(findClip(next, "c3")).toBeNull();
	});

	it("is a no-op when nothing changes", () => {
		const t = timelineWith();
		expect(moveClip(t, "c1", 0)).toBe(t);
	});
});

describe("trimming clips", () => {
	it("moves the source offset with the head so content stays put", () => {
		const next = trimClipStart(timelineWith(), "c1", 60);
		const clip = clipOf(next, "c1");
		expect(clip.startFrame).toBe(60);
		expect(clip.trimStartFrame).toBe(60);
	});

	it("refuses to trim the head past the tail", () => {
		const clip = clipOf(trimClipStart(timelineWith(), "c1", 999), "c1");
		expect(clip.endFrame - clip.startFrame).toBeGreaterThanOrEqual(MIN_CLIP_FRAMES);
	});

	it("trims the tail", () => {
		expect(clipOf(trimClipEnd(timelineWith(), "c1", 120), "c1").endFrame).toBe(120);
	});

	it("refuses to trim the tail past the head", () => {
		const clip = clipOf(trimClipEnd(timelineWith(), "c1", -10), "c1");
		expect(clip.endFrame - clip.startFrame).toBeGreaterThanOrEqual(MIN_CLIP_FRAMES);
	});

	it("shortens fades that no longer fit", () => {
		let t = setClipTiming(timelineWith(), ["c1"], "fadeOutFrames", 200);
		t = trimClipEnd(t, "c1", 50);
		expect(clipOf(t, "c1").fadeOutFrames).toBeLessThanOrEqual(50);
	});
});

describe("snapping", () => {
	it("offers zero, the playhead and every clip edge", () => {
		const targets = snapTargets(timelineWith(), 42);
		expect(targets).toContain(0);
		expect(targets).toContain(42);
		expect(targets).toContain(300);
	});

	it("excludes the clip being dragged", () => {
		const targets = snapTargets(timelineWith(), 0, ["c1"]);
		// c2 still contributes 300, so check the dragged clip's own start is not
		// the only source of a target.
		expect(snapTargets(timelineWith(), 0, ["c1", "c2"])).toEqual([0]);
		expect(targets.length).toBeGreaterThan(1);
	});

	it("snaps to the nearest target inside the threshold", () => {
		expect(snapFrame(298, [0, 300], 8)).toEqual({ frame: 300, snappedTo: 300 });
	});

	it("leaves the frame alone outside the threshold", () => {
		expect(snapFrame(280, [0, 300], 8)).toEqual({ frame: 280, snappedTo: null });
	});
});

describe("duplicate, nudge and paste", () => {
	it("duplicates a clip immediately after itself", () => {
		const { timeline: next, newIds } = duplicateClips(timelineWith(), ["c1"]);
		expect(newIds).toHaveLength(1);
		expect(clipOf(next, newIds[0]).startFrame).toBe(300);
	});

	it("nudges a selection by whole frames", () => {
		const next = nudgeClips(timelineWith(), ["c1"], 5);
		expect(clipOf(next, "c1").startFrame).toBe(5);
	});

	it("refuses to nudge a selection past zero", () => {
		const next = nudgeClips(timelineWith(), ["c1"], -20);
		expect(clipOf(next, "c1").startFrame).toBe(0);
	});

	it("pastes at a frame keeping relative offsets", () => {
		const source = [clipOf(timelineWith(), "c1"), clipOf(timelineWith(), "c2")];
		const { timeline: next, newIds } = pasteClips(timelineWith(), source, 500, "x");
		expect(newIds).toHaveLength(2);
		expect(clipOf(next, newIds[0]).startFrame).toBe(500);
	});
});

describe("tracks", () => {
	it("adds a video track above the others", () => {
		const next = addTrack(timelineWith(), "video");
		expect(next.tracks[0].kind).toBe("video");
		expect(next.tracks.filter((t) => t.kind === "video")).toHaveLength(2);
	});

	it("adds an audio track below the others", () => {
		const next = addTrack(timelineWith(), "audio");
		expect(next.tracks[next.tracks.length - 1].kind).toBe("audio");
	});

	it("refuses to remove the last track of a kind", () => {
		const t = timelineWith();
		expect(removeTrack(t, "v1")).toBe(t);
	});

	it("removes a track once there is a spare", () => {
		const t = addTrack(timelineWith(), "video");
		const extra = t.tracks.find((track) => track.kind === "video" && track.id !== "v1");
		expect(removeTrack(t, extra?.id ?? "").tracks).toHaveLength(t.tracks.length - 1);
	});

	it("reorders within a kind but not across zones", () => {
		const t = addTrack(timelineWith(), "video");
		const moved = reorderTrack(t, t.tracks[0].id, 1);
		expect(moved.tracks[1].id).toBe(t.tracks[0].id);
		// v1 is the last video track; moving it down would cross into audio.
		const blocked = reorderTrack(t, t.tracks[1].id, 1);
		expect(blocked).toBe(t);
	});

	it("renames a track and ignores blank names", () => {
		expect(renameTrack(timelineWith(), "v1", " Cam A ").tracks[0].name).toBe("Cam A");
		const t = timelineWith();
		expect(renameTrack(t, "v1", "   ").tracks[0].name).toBe("V1");
	});

	it("treats every track as audible until something is soloed", () => {
		const t = timelineWith();
		expect(isAudible(t, t.tracks[0])).toBe(true);
		const soloed = toggleSolo(t, "a1");
		expect(isAudible(soloed, soloed.tracks[0])).toBe(false);
		expect(isAudible(soloed, soloed.tracks[1])).toBe(true);
	});

	it("never treats a muted track as audible", () => {
		const t = setTrackFlag(timelineWith(), "a1", "muted", true);
		expect(isAudible(t, t.tracks[1])).toBe(false);
	});
});

describe("text clips", () => {
	it("adds a text clip at the playhead on a video track", () => {
		const { timeline: next, clipId } = addTextClip(timelineWith(), 100, 90, "tx1", "Hello");
		const clip = clipOf(next, clipId);
		expect(clip.mediaType).toBe("text");
		expect(clip.startFrame).toBe(100);
		expect(clip.endFrame).toBe(190);
		expect(clip.content).toBe("Hello");
		expect(clip.textStyle).toBeDefined();
	});
});
