// Where a new graphic goes in the track stack.
//
// "front" is an overlay — a lower third, a QR code — on top of everything.
// "behind" is the creator look from the reference: cards and lines between a
// coloured backdrop and the speaker. It goes on its own track directly under
// the footage, and if that footage was sitting on a flat colour, the colour
// moves down onto the graphic and the footage turns transparent — otherwise
// the colour would hide the very cards just put behind the person.

import type { GraphicSpec, KeepOut } from "./graphics";
import { type ClipModel, withDefaults } from "./model";
import { type Box, faceInFrame } from "./punchIns";
import type { TimelineModel, TrackModel } from "./reducers";
import type { FaceTrack } from "./vision";
import { typicalFace } from "./vision";

export type GraphicLayer = "front" | "behind";

const overlaps = (clip: ClipModel, start: number, end: number) =>
	clip.startFrame < end && clip.endFrame > start;

/** The top-most footage clip on screen across [start, end), and its track's index. */
export function footageUnder(
	timeline: TimelineModel,
	start: number,
	end: number,
): { clip: ClipModel; trackIndex: number } | null {
	for (let index = 0; index < timeline.tracks.length; index++) {
		const track = timeline.tracks[index];
		if (track.kind !== "video" || track.hidden) continue;
		const clip = track.clips.find(
			(entry) => entry.mediaType === "video" && overlaps(entry, start, end),
		);
		if (clip) return { clip, trackIndex: index };
	}
	return null;
}

/**
 * The region a layout should keep clear: the speaker, from their face down.
 * Falls back to a centred figure when there's no face track.
 */
export function keepOutFromFaces(
	track: FaceTrack | undefined,
	/**
	 * How the footage sits in the frame. The face track is in the source
	 * picture's coordinates; on a cropped or reframed clip (16:9 shown 9:16)
	 * those aren't the frame's, so the region is mapped through the clip's box.
	 */
	frame?: { box: Box; pictureAspect: number; canvasAspect: number },
): KeepOut | undefined {
	const face = track ? typicalFace(track) : null;
	if (!face) return undefined;
	const top = Math.max(0, face.cy - face.size * 0.8);
	// Half the speaker's width, in source x units (face size is in height units).
	const halfWidth = Math.max(0.16, face.size * 1.4);
	if (!frame) {
		return { cx: face.cx, cy: (top + 1) / 2, rx: halfWidth, ry: (1 - top) / 2 };
	}
	const at = (x: number, y: number) =>
		faceInFrame(frame.box, { x, y }, frame.pictureAspect, frame.canvasAspect);
	const left = at(face.cx - halfWidth, face.cy).x;
	const right = at(face.cx + halfWidth, face.cy).x;
	const topInFrame = Math.max(0, at(face.cx, top).y);
	return {
		cx: (left + right) / 2,
		cy: (topInFrame + 1) / 2,
		rx: Math.max(0.12, (right - left) / 2),
		ry: (1 - topInFrame) / 2,
	};
}

export interface PlaceGraphicInput {
	id: string;
	name: string;
	spec: GraphicSpec;
	startFrame: number;
	endFrame: number;
	layer: GraphicLayer;
}

export function placeGraphic(
	timeline: TimelineModel,
	input: PlaceGraphicInput,
): {
	timeline: TimelineModel;
	clipId: string;
	trackId: string;
	movedBackgroundFrom?: string;
	backdropClipId?: string;
} {
	let spec = input.spec;
	const clip = (graphic: GraphicSpec) =>
		withDefaults({
			id: input.id,
			name: input.name,
			mediaType: "graphic",
			startFrame: input.startFrame,
			endFrame: input.endFrame,
			graphic,
		});
	const track = (clips: ClipModel[]): TrackModel => ({
		id: `trk-graphic-${input.id}`,
		name: input.layer === "behind" ? "Graphics (behind)" : "Graphics",
		kind: "video",
		muted: false,
		hidden: false,
		clips,
	});

	if (input.layer === "front") {
		const placed = clip(spec);
		return {
			timeline: { ...timeline, tracks: [track([placed]), ...timeline.tracks] },
			clipId: placed.id,
			trackId: `trk-graphic-${input.id}`,
		};
	}

	const under = footageUnder(timeline, input.startFrame, input.endFrame);
	if (!under) {
		// Nothing to go behind: the bottom of the stack is the honest equivalent.
		const placed = clip(spec);
		return {
			timeline: { ...timeline, tracks: [...timeline.tracks, track([placed])] },
			clipId: placed.id,
			trackId: `trk-graphic-${input.id}`,
		};
	}

	let movedBackgroundFrom: string | undefined;
	let backdrop: ClipModel | null = null;
	let tracks = timeline.tracks;
	const background = under.clip.background;
	if (background?.mode === "color" && background.color) {
		// The colour has to come out from behind the speaker, or the graphic
		// would be hidden under it. It moves onto a backdrop of its own spanning
		// every clip of the footage that wore it — not onto this graphic, which
		// may only last a few seconds and would leave the speaker on black.
		const color = background.color;
		const wearers = timeline.tracks[under.trackIndex].clips.filter(
			(entry) => entry.background?.mode === "color" && entry.background.color === color,
		);
		movedBackgroundFrom = under.clip.id;
		const ids = new Set(wearers.map((entry) => entry.id));
		tracks = tracks.map((entry, index) =>
			index === under.trackIndex
				? {
						...entry,
						clips: entry.clips.map((existing) =>
							ids.has(existing.id)
								? {
										...existing,
										background: {
											...background,
											mode: "remove" as const,
											color: undefined,
										},
									}
								: existing,
						),
					}
				: entry,
		);
		backdrop = withDefaults({
			id: `${input.id}-backdrop`,
			name: "Backdrop",
			mediaType: "graphic",
			startFrame: Math.min(...wearers.map((entry) => entry.startFrame)),
			endFrame: Math.max(...wearers.map((entry) => entry.endFrame)),
			graphic: { template: "backdrop", elements: [], style: spec.style, background: color },
		});
	}
	const placed = clip(spec);
	const next = [...tracks];
	// Index 0 is the top of the stack; directly below the footage is one further down,
	// and the backdrop (when one was made) goes below the graphic.
	next.splice(under.trackIndex + 1, 0, track([placed]));
	if (backdrop) {
		next.splice(under.trackIndex + 2, 0, {
			id: `trk-graphic-${input.id}-backdrop`,
			name: "Backdrop",
			kind: "video",
			muted: false,
			hidden: false,
			clips: [backdrop],
		});
	}
	return {
		timeline: { ...timeline, tracks: next },
		clipId: placed.id,
		trackId: `trk-graphic-${input.id}`,
		movedBackgroundFrom,
		backdropClipId: backdrop?.id,
	};
}
