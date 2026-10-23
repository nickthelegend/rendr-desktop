// Where dropped footage lands, and what shape the project takes from it.
//
// Two decisions that look like details and decide whether a phone video edits
// at all. A project that starts 1920×1080 and keeps that shape centre-crops
// vertical footage to a landscape strip of a face. And "the first video track"
// stops meaning the footage track the moment captions exist: the caption track
// is a video track stacked on top, so a drop landed there and cleared the
// captions it overlapped.

import type { AssetModel } from "./media";
import type { TimelineModel, TrackModel } from "./reducers";

/** The shape a new project starts in, before any footage says otherwise. */
export const DEFAULT_CANVAS = { width: 1920, height: 1080, fps: 30 } as const;

/** Frame rates footage is actually shot at; a measured rate snaps to the nearest. */
const STANDARD_FPS = [24, 25, 30, 48, 50, 60, 120];

/**
 * A measured frame rate as a project frame rate.
 *
 * Phone footage is variable-rate and averages a little under its nominal rate
 * (29.6 for "30"), and NTSC rates are fractional (29.97), but the timeline
 * counts whole frames. Anything within 3% of a standard rate is that rate;
 * anything else is rounded, so an odd rate is still honoured.
 */
export function snapFps(fps: number): number {
	if (!Number.isFinite(fps) || fps <= 0) return DEFAULT_CANVAS.fps;
	const nearest = STANDARD_FPS.reduce((best, rate) =>
		Math.abs(rate - fps) < Math.abs(best - fps) ? rate : best,
	);
	if (Math.abs(nearest - fps) / nearest <= 0.03) return nearest;
	return Math.max(1, Math.min(120, Math.round(fps)));
}

/**
 * The project's shape, taken from the first footage placed on it.
 *
 * Only while the timeline is empty and still in the default shape: once there
 * are clips, their framing was composed for the canvas they are on, and a
 * canvas someone chose with set_project_settings is a decision, not a default.
 * Sizes are rounded to even numbers, which encoders require, and held to a 4K
 * short edge so a 6K phone master doesn't make every export a 6K encode.
 */
export function adoptFootageFormat(timeline: TimelineModel, asset: AssetModel): TimelineModel {
	if (asset.type !== "video" || asset.width <= 0 || asset.height <= 0) return timeline;
	if (timeline.tracks.some((track) => track.clips.length > 0)) return timeline;
	if (
		timeline.width !== DEFAULT_CANVAS.width ||
		timeline.height !== DEFAULT_CANVAS.height ||
		timeline.fps !== DEFAULT_CANVAS.fps
	) {
		return timeline;
	}

	// The project takes the footage's shape, but never drops below 1080 on its
	// short edge: a 360p stock clip shouldn't make a 360p project, and graphics
	// and captions drawn at the project's size would come out soft. Above 4K is
	// capped for the same reason in reverse.
	const shortEdge = Math.min(asset.width, asset.height);
	const scale = Math.min(2160 / shortEdge, Math.max(1, 1080 / shortEdge));
	const even = (value: number) => Math.max(16, Math.round((value * scale) / 2) * 2);
	const width = even(asset.width);
	const height = even(asset.height);
	const fps = asset.fps ? snapFps(asset.fps) : timeline.fps;
	if (width === timeline.width && height === timeline.height && fps === timeline.fps) {
		return timeline;
	}
	return { ...timeline, width, height, fps };
}

/**
 * Whether a video track holds overlays rather than footage.
 *
 * Caption and title tracks are video tracks — they composite — but nothing
 * dropped from the library belongs on one, and clearing the space a clip
 * lands in would delete the words.
 */
export function isOverlayTrack(track: TrackModel): boolean {
	if (track.kind !== "video") return false;
	if (
		track.id.startsWith("trk-cc-") ||
		track.id.startsWith("trk-text-") ||
		track.id.startsWith("trk-graphic-")
	) {
		return true;
	}
	if (track.clips.some((clip) => clip.captionGroupId)) return true;
	// Drawn graphics too: a mind map placed behind the speaker sits *below* the
	// footage, so without this it would be taken for the main footage track
	// and a dropped clip would clear the cards out of its way.
	return (
		track.clips.length > 0 &&
		track.clips.every((clip) => clip.mediaType === "text" || clip.mediaType === "graphic")
	);
}

/**
 * The main footage track: the lowest video track that isn't an overlay,
 * preferring one that already carries footage. -1 when there is none.
 *
 * Lowest, because index 0 paints on top: the base of the stack is where the
 * take lives, and B-roll and titles are stacked above it.
 */
export function footageTrackIndex(timeline: TimelineModel): number {
	let empty = -1;
	for (let index = timeline.tracks.length - 1; index >= 0; index--) {
		const track = timeline.tracks[index];
		if (track.kind !== "video" || isOverlayTrack(track)) continue;
		if (track.clips.some((clip) => clip.mediaType === "video" || clip.mediaType === "image"))
			return index;
		if (empty < 0) empty = index;
	}
	return empty;
}

/**
 * The footage track, made if there isn't one.
 *
 * Added below every other video track rather than above, so the captions and
 * titles that were already on top stay on top of the footage.
 */
export function withFootageTrack(timeline: TimelineModel): {
	timeline: TimelineModel;
	index: number;
} {
	const found = footageTrackIndex(timeline);
	if (found >= 0) return { timeline, index: found };

	const videoCount = timeline.tracks.filter((track) => track.kind === "video").length;
	let lastVideo = -1;
	timeline.tracks.forEach((track, index) => {
		if (track.kind === "video") lastVideo = index;
	});
	const track: TrackModel = {
		id: `trk-v${videoCount + 1}-${timeline.tracks.length}`,
		name: `V${videoCount + 1}`,
		kind: "video",
		muted: false,
		hidden: false,
		clips: [],
	};
	const index = lastVideo + 1;
	const tracks = [...timeline.tracks];
	tracks.splice(index, 0, track);
	return { timeline: { ...timeline, tracks }, index };
}
