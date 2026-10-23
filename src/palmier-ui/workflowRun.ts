// Running a workflow.
//
// The graph says what should happen; this performs it. Each node is a step that
// takes a timeline and returns one, so a run is a fold over `runOrder` — which
// is why the graph is constrained to a pipeline in the first place.
//
// Two rules the whole file is built around:
//
//   - Nothing is committed until every step has succeeded. A half-run workflow
//     leaves a project in a state nobody asked for and cannot easily undo, so a
//     failure at step five must leave the timeline exactly as it was.
//   - A step that cannot do its work says so and stops, rather than passing the
//     timeline through unchanged. A node that silently no-ops makes a workflow
//     that reports success and produced nothing.
//
// Steps that need something outside the timeline model — speech, an encode —
// are performed by the caller through `WorkflowHooks`, because those live in the
// renderer's world and this stays pure enough to test.

import { autoZoomRegions } from "./autoZoom";
import { narrationCues, placeCaptions, removeCaptionGroup } from "./captions";
import type { CommentModel } from "./comments";
import { boxSizeAt, positionRow } from "./keyframes";
import type { AssetModel } from "./media";
import { type ClipModel, type Transform, withDefaults, type ZoomRegionModel } from "./model";
import { clipFace, frameFace } from "./punchIns";
import { splitAt, type TimelineModel } from "./reducers";
import { nodeLabel, runOrder, type WorkflowModel, type WorkflowNode } from "./workflow";

/** Work a step cannot do itself, supplied by whoever is running the workflow. */
export interface WorkflowHooks {
	/** Speaks the notes and returns what was laid down. Absent means no voice. */
	narrate?: () => Promise<{ spoken: number; lines: NarratedLine[] }>;
	/**
	 * Writes a file. Absent means export cannot run.
	 *
	 * Handed the timeline the run has built, because nothing is committed until
	 * the run succeeds: an exporter that read the editor's own timeline would
	 * write the cut as it was before the workflow touched it.
	 */
	export?: (settings: {
		aspect?: string;
		timeline: TimelineModel;
	}) => Promise<{ path: string } | null>;
}

export interface NarratedLine {
	commentId: string;
	startFrame: number;
	seconds: number;
	text: string;
}

export interface RunContext {
	timeline: TimelineModel;
	assets: readonly AssetModel[];
	comments: readonly CommentModel[];
	telemetry: readonly { timeMs: number; cx: number; cy: number; interactionType?: string }[];
	hooks: WorkflowHooks;
}

export interface StepResult {
	nodeId: string;
	label: string;
	/** What the step did, in one line, for the run log. */
	detail: string;
	timeline: TimelineModel;
}

export interface RunReport {
	ok: boolean;
	steps: StepResult[];
	/** Why it stopped, when it stopped early. */
	error?: string;
	/** Only set on success — the timeline every step agreed on. */
	timeline?: TimelineModel;
	/** Where a file was written, if an export ran. */
	outputPath?: string;
}

/** Aspects a reframe understands, as width/height. */
export const ASPECTS: Record<string, number> = {
	"9:16": 9 / 16,
	"1:1": 1,
	"4:5": 4 / 5,
	"16:9": 16 / 9,
};

/** Encoders reject odd sizes, and anything under 16 px is not a frame. */
const even = (value: number) => Math.max(16, Math.round(value / 2) * 2);

/**
 * The canvas a reframe produces: the requested aspect at the project's short
 * edge, so 1920×1080 becomes 1080×1920 for 9:16 rather than a 608-wide
 * thumbnail, and a 4K project stays 4K.
 */
export function canvasForAspect(
	width: number,
	height: number,
	aspect: number,
): { width: number; height: number } {
	const shortEdge = Math.min(width, height);
	return aspect >= 1
		? { width: even(shortEdge * aspect), height: even(shortEdge) }
		: { width: even(shortEdge), height: even(shortEdge / aspect) };
}

type Box = Pick<Transform, "centerX" | "centerY" | "width" | "height">;

/** Whether a box fills the frame — the footage, as opposed to an inset over it. */
function fillsFrame(box: Box): boolean {
	const slack = 0.01;
	return (
		box.centerX - box.width / 2 <= slack &&
		box.centerY - box.height / 2 <= slack &&
		box.centerX + box.width / 2 >= 1 - slack &&
		box.centerY + box.height / 2 >= 1 - slack
	);
}

/** The picture's own aspect after its crop, or null when the asset can't say. */
function pictureAspect(clip: ClipModel, assets: readonly AssetModel[]): number | null {
	const asset = assets.find((entry) => entry.id === clip.assetId);
	if (!asset || asset.width <= 0 || asset.height <= 0) return null;
	const visibleW = asset.width * (1 - clip.crop.left - clip.crop.right);
	const visibleH = asset.height * (1 - clip.crop.top - clip.crop.bottom);
	return visibleW > 0 && visibleH > 0 ? visibleW / visibleH : null;
}

/**
 * Carries a clip's motion from its old box to its new one.
 *
 * Position and scale rows are absolute canvas values, so a Ken Burns written
 * for the landscape frame would, untouched, snap the picture back to its
 * landscape size the moment the reframed clip played. Each keyframed box is
 * mapped the same way the static box was — offset from the old centre, scaled
 * by how much the box grew — so the move survives relative to the picture.
 */
function remapMotion(clip: ClipModel, from: Box, to: Box): ClipModel["keyframes"] {
	const tracks = clip.keyframes;
	if (!tracks || (!tracks.position && !tracks.scale)) return tracks;
	if (from.width <= 0 || from.height <= 0) return tracks;
	const kx = to.width / from.width;
	const ky = to.height / from.height;
	const next = { ...tracks };
	if (tracks.position) {
		next.position = tracks.position.map((row) => {
			// The corner only means something against the size at that frame.
			const [w, h] = boxSizeAt(clip, row.frame);
			const cx = to.centerX + (row.values[0] + w / 2 - from.centerX) * kx;
			const cy = to.centerY + (row.values[1] + h / 2 - from.centerY) * ky;
			return { ...row, values: positionRow(cx, cy, w * kx, h * ky) };
		});
	}
	if (tracks.scale) {
		next.scale = tracks.scale.map((row) => ({
			...row,
			values: [row.values[0] * kx, row.values[1] * ky],
		}));
	}
	return next;
}

/**
 * Recomposes a timeline for a new aspect: the canvas itself changes size.
 *
 * Keeping the old canvas and widening the footage's box is what this used to
 * do, and on a 16:9 project it produced a zoomed landscape rather than a
 * vertical video — the box is clipped to the frame, so nothing about the
 * output's shape ever changed. The canvas now takes the target aspect at the
 * project's short edge, and the footage gets a box shaped like its own picture
 * that covers the new frame, centred. The renderer cover-fits into that box, so
 * the result is a centre crop, and because the box is the picture's own shape
 * a position track can pan it (that is what the cursor follow does).
 *
 * Insets — anything that did not fill the old frame — keep their size in
 * pixels and stay inside the new frame, so a picture-in-picture is still one.
 * Text is left alone; it is composed for the frame rather than cropped from a
 * source.
 */
export function reframeTimeline(
	timeline: TimelineModel,
	aspect: number,
	assets: readonly AssetModel[],
): TimelineModel {
	const canvas = canvasForAspect(timeline.width, timeline.height, aspect);
	const canvasAspect = canvas.width / canvas.height;
	// Normalised units are fractions of the canvas, so holding an inset's pixel
	// size means rescaling by how much each axis of the canvas changed.
	const keepX = timeline.width / canvas.width;
	const keepY = timeline.height / canvas.height;
	const inside = (center: number, size: number) =>
		size >= 1 ? center : Math.min(1 - size / 2, Math.max(size / 2, center));

	const refit = (clip: ClipModel): ClipModel => {
		const from = clip.transform;
		let to: Box;
		if (fillsFrame(from)) {
			// An offline asset can't say how wide it is, but the box it filled
			// was drawn at the shape the viewer saw, which is the next best thing.
			const picture =
				pictureAspect(clip, assets) ??
				(from.width * timeline.width) / (from.height * timeline.height);
			to =
				picture >= canvasAspect
					? { centerX: 0.5, centerY: 0.5, width: picture / canvasAspect, height: 1 }
					: { centerX: 0.5, centerY: 0.5, width: 1, height: canvasAspect / picture };
			// A centre crop of a talking head often cuts the speaker in half; with
			// a face track the crop slides to them instead, face in the upper third.
			const face = clipFace(
				clip,
				assets.find((asset) => asset.id === clip.assetId),
				timeline.fps,
			);
			if (face) to = frameFace(to, face, picture, canvasAspect, { x: 0.5, y: 0.38 });
		} else {
			const width = from.width * keepX;
			const height = from.height * keepY;
			to = {
				centerX: inside(from.centerX, width),
				centerY: inside(from.centerY, height),
				width,
				height,
			};
		}
		return {
			...clip,
			transform: { ...clip.transform, ...to },
			keyframes: remapMotion(clip, from, to),
		};
	};

	return {
		...timeline,
		width: canvas.width,
		height: canvas.height,
		tracks: timeline.tracks.map((track) =>
			track.kind !== "video"
				? track
				: {
						...track,
						clips: track.clips.map((clip) =>
							// Graphics are drawn in frame coordinates, so they follow
							// the new canvas on their own; refitting would distort them.
							clip.mediaType === "text" ||
							clip.mediaType === "audio" ||
							clip.mediaType === "graphic"
								? clip
								: refit(clip),
						),
					},
		),
	};
}

/** The video clip a step should work on: the first one on screen. */
function hostClip(timeline: TimelineModel): ClipModel | undefined {
	for (const track of timeline.tracks) {
		if (track.kind !== "video") continue;
		const clip = track.clips.find((entry) => entry.mediaType === "video");
		if (clip) return clip;
	}
	return undefined;
}

/**
 * Moments worth keeping, from the cursor. Stored as zoom regions to cut at.
 *
 * `reason` is a receipt field on a proposal, not part of a region, so it is
 * dropped here rather than carried onto the clip.
 */
function highlightsFor(context: RunContext, timeline: TimelineModel) {
	const host = hostClip(timeline);
	if (!host) return null;
	const totalMs = ((host.endFrame - host.startFrame) * host.speed * 1000) / timeline.fps;
	const proposals = autoZoomRegions(context.telemetry as never, { totalMs });
	const regions: ZoomRegionModel[] = proposals.map((proposal, index) => ({
		id: `wf-${host.id}-${index}`,
		startMs: proposal.startMs,
		endMs: proposal.endMs,
		depth: proposal.depth,
		focus: proposal.focus,
		mode: proposal.mode,
	}));
	return { host, regions };
}

async function runStep(
	node: WorkflowNode,
	timeline: TimelineModel,
	context: RunContext,
): Promise<{ timeline: TimelineModel; detail: string } | { error: string }> {
	switch (node.kind) {
		case "source": {
			// The source is the project as it stands. It has no work of its own,
			// but it does have a precondition worth failing on early.
			const host = hostClip(timeline);
			if (!host) {
				return {
					error: "Nothing on the timeline to work on. Place a recording first.",
				};
			}
			return { timeline, detail: `from ${host.name}` };
		}

		case "detect-highlights": {
			const found = highlightsFor(context, timeline);
			if (!found) return { error: "No video clip to read highlights from." };
			if (found.regions.length === 0) {
				return {
					error: "No highlights found — the pointer never settled anywhere and never clicked, so there is nothing to cut to.",
				};
			}
			// Recorded on the clip so later steps can read them.
			return {
				timeline: {
					...timeline,
					tracks: timeline.tracks.map((track) => ({
						...track,
						clips: track.clips.map((clip) =>
							clip.id === found.host.id
								? { ...clip, zoomRegions: found.regions }
								: clip,
						),
					})),
				},
				detail: `${found.regions.length} highlights`,
			};
		}

		case "split-clips": {
			const host = hostClip(timeline);
			const regions = host?.zoomRegions ?? [];
			if (!host || regions.length === 0) {
				return {
					error: "Nothing to cut at. Put a Find highlights before this.",
				};
			}
			// Split at each highlight's start, so every moment becomes its own clip.
			let next = timeline;
			for (const region of regions) {
				const frame = Math.round(
					host.startFrame + ((region.startMs / 1000) * timeline.fps) / host.speed,
				);
				if (frame > host.startFrame && frame < host.endFrame) next = splitAt(next, frame);
			}
			const before = timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
			const after = next.tracks.reduce((n, t) => n + t.clips.length, 0);
			return { timeline: next, detail: `${after - before} new cuts` };
		}

		case "reframe": {
			const name = typeof node.params.aspect === "string" ? node.params.aspect : "9:16";
			const aspect = ASPECTS[name];
			if (!aspect) {
				return {
					error: `No aspect '${name}'. Use one of: ${Object.keys(ASPECTS).join(", ")}.`,
				};
			}
			const next = reframeTimeline(timeline, aspect, context.assets);
			return { timeline: next, detail: `to ${name} (${next.width}×${next.height})` };
		}

		case "auto-zoom": {
			/*
			 * Every video clip, against its own source window.
			 *
			 * Looking only at the first clip breaks the moment anything has been
			 * cut: after split-clips the first clip is a fraction of the take, so
			 * a whole-take telemetry read finds nothing in it and the step fails
			 * on a timeline that is full of zoomable material. Each clip carries
			 * its own trim, so each gets the regions that fall inside it,
			 * rebased to that clip's source time.
			 */
			const videoClips = timeline.tracks
				.filter((track) => track.kind === "video")
				.flatMap((track) => track.clips)
				.filter((clip) => clip.mediaType === "video");
			if (videoClips.length === 0) return { error: "No video clip to zoom." };

			let zoomed = 0;
			const next = {
				...timeline,
				tracks: timeline.tracks.map((track) => ({
					...track,
					clips: track.clips.map((clip) => {
						if (clip.mediaType !== "video") return clip;
						const fromMs = (clip.trimStartFrame / timeline.fps) * 1000;
						const spanMs =
							((clip.endFrame - clip.startFrame) * clip.speed * 1000) / timeline.fps;
						const window = context.telemetry
							.filter(
								(point) =>
									point.timeMs >= fromMs && point.timeMs <= fromMs + spanMs,
							)
							.map((point) => ({ ...point, timeMs: point.timeMs - fromMs }));
						const regions = autoZoomRegions(window as never, { totalMs: spanMs }).map(
							(proposal, index) => ({
								id: `wf-${clip.id}-${index}`,
								startMs: proposal.startMs,
								endMs: proposal.endMs,
								depth: proposal.depth,
								focus: proposal.focus,
								mode: proposal.mode,
							}),
						);
						if (regions.length === 0) return clip;
						zoomed += regions.length;
						return { ...clip, zoomRegions: regions };
					}),
				})),
			};

			if (zoomed === 0) return { error: "No cursor activity to cut zooms from." };
			return { timeline: next, detail: `${zoomed} zooms across ${videoClips.length} clips` };
		}

		case "narrate": {
			if (!context.hooks.narrate) {
				return {
					error: "Narration needs the desktop voice, which this window has no bridge to.",
				};
			}
			const spoken = await context.hooks.narrate();
			if (spoken.spoken === 0) {
				return {
					error: "Nothing was narrated. Write the script as notes on the timeline first.",
				};
			}
			// The hook committed the audio itself; the timeline it returns to us
			// is read back by the caller after the run.
			return { timeline, detail: `${spoken.spoken} lines` };
		}

		case "subtitle": {
			const script = context.comments.filter(
				(comment) => !comment.resolved && comment.text.trim().length > 0,
			);
			if (script.length === 0) {
				return {
					error: "No notes to subtitle. Subtitles are cut from the narration script.",
				};
			}
			const cues = narrationCues(
				script.map((comment) => ({
					commentId: comment.id,
					startFrame: comment.frame,
					// A note that has been spoken knows its real length; one that
					// hasn't is estimated from the words.
					seconds: comment.voice
						? Math.max(1, comment.text.split(/\s+/).length / 2.75)
						: Math.max(1, comment.text.split(/\s+/).length / 2.75),
					text: comment.text,
				})),
				timeline.fps,
			);
			const placed = placeCaptions(removeCaptionGroup(timeline, "narration"), cues, {
				groupId: "narration",
				toFrame: (sourceMs) => Math.round((sourceMs / 1000) * timeline.fps),
				style: { animation: "fade" },
			});
			return { timeline: placed.timeline, detail: `${placed.clipCount} cues` };
		}

		case "grade": {
			// A look is a per-clip colour change; the node carries the values.
			const saturation = Number(node.params.saturation ?? 1.05);
			const contrast = Number(node.params.contrast ?? 1.03);
			return {
				timeline: {
					...timeline,
					tracks: timeline.tracks.map((track) => ({
						...track,
						clips: track.clips.map((clip) =>
							clip.mediaType === "text"
								? clip
								: withDefaults({
										...clip,
										color: { ...clip.color, saturation, contrast },
									}),
						),
					})),
				},
				detail: `saturation ${saturation}, contrast ${contrast}`,
			};
		}

		case "export": {
			if (!context.hooks.export) {
				return { error: "Export needs the encoder, which this window has no access to." };
			}
			const aspect = typeof node.params.aspect === "string" ? node.params.aspect : undefined;
			const written = await context.hooks.export({ aspect, timeline });
			if (!written) return { error: "The export produced no file." };
			return { timeline, detail: written.path };
		}

		default:
			return { error: `Unknown node type '${node.kind}'.` };
	}
}

/**
 * Runs a workflow, committing nothing until every step has succeeded.
 *
 * The timeline is threaded through the steps and only returned on success, so a
 * failure at step five leaves the caller's project exactly as it was rather
 * than half-edited.
 */
export async function runWorkflow(
	workflow: WorkflowModel,
	context: RunContext,
): Promise<RunReport> {
	const order = runOrder(workflow);
	if (!order) {
		return { ok: false, steps: [], error: "This workflow has a loop, so it has no run order." };
	}

	const steps: StepResult[] = [];
	let timeline = context.timeline;
	let outputPath: string | undefined;

	for (const node of order) {
		if (node.disabled) continue;
		const result = await runStep(node, timeline, { ...context, timeline });
		if ("error" in result) {
			return {
				ok: false,
				steps,
				error: `${nodeLabel(node)}: ${result.error}`,
			};
		}
		timeline = result.timeline;
		if (node.kind === "export") outputPath = result.detail;
		steps.push({
			nodeId: node.id,
			label: nodeLabel(node),
			detail: result.detail,
			timeline,
		});
	}

	return {
		ok: true,
		steps,
		timeline,
		...(outputPath ? { outputPath } : {}),
	};
}

/**
 * Where the crop should sit, frame by frame, to keep the cursor in shot.
 *
 * Centring a 16:9 recording into 9:16 shows the middle of the screen, which is
 * often not where the work is happening — a sidebar click or a button in the
 * corner falls outside the crop entirely. The telemetry already says where the
 * pointer was, so the crop can follow it.
 *
 * Sampled sparsely and smoothed rather than keyed per frame: a crop that tracks
 * every jitter is unwatchable, and the point of following is to keep the
 * subject in shot, not to mirror the mouse. Returns position keyframes in the
 * transform's own units, clamped so the crop never runs off the footage.
 *
 * Rows carry the box's top-left corner, as every position row does. The pan is
 * planned in centres and converted on the way out; handing the centre over
 * as-is put the footage's left edge at mid-frame.
 */
export function followKeyframes(
	telemetry: readonly { timeMs: number; cx: number; cy: number }[],
	options: {
		clipStartFrame: number;
		clipEndFrame: number;
		trimStartFrame: number;
		fps: number;
		/** How wide the footage is, in frames of the output. 1 means it fits. */
		width: number;
		/** How tall the footage's box is, in frames of the output. Default 1. */
		height?: number;
		/** Frames between samples. Larger is calmer. */
		everyFrames?: number;
	},
): Array<{ frame: number; values: [number, number]; interp: "smooth" }> {
	const { clipStartFrame, clipEndFrame, trimStartFrame, fps, width, height = 1 } = options;
	const step = Math.max(1, Math.round(options.everyFrames ?? 12));
	if (telemetry.length === 0 || width <= 1) return [];

	// The crop can only travel this far before it exposes an edge.
	const reach = (width - 1) / 2;

	const sampleAt = (sourceMs: number) => {
		let nearest = telemetry[0];
		let best = Number.POSITIVE_INFINITY;
		for (const point of telemetry) {
			const distance = Math.abs(point.timeMs - sourceMs);
			if (distance < best) {
				best = distance;
				nearest = point;
			}
		}
		return nearest;
	};

	const raw: Array<{ frame: number; cx: number }> = [];
	for (let frame = 0; frame <= clipEndFrame - clipStartFrame; frame += step) {
		const sourceMs = ((trimStartFrame + frame) / fps) * 1000;
		raw.push({ frame, cx: sampleAt(sourceMs).cx });
	}
	if (raw.length === 0) return [];

	// A moving average over five samples, so a flick of the wrist doesn't pan
	// the whole frame. This is what separates following from mirroring.
	const smoothed = raw.map((point, index) => {
		const from = Math.max(0, index - 2);
		const to = Math.min(raw.length - 1, index + 2);
		let sum = 0;
		for (let i = from; i <= to; i++) sum += raw[i].cx;
		return { frame: point.frame, cx: sum / (to - from + 1) };
	});

	return smoothed.map((point) => {
		// The pointer sits at cx of the source; the crop centres on it, held
		// inside the footage so no edge is ever exposed.
		const wanted = 0.5 + (0.5 - point.cx) * (width - 1);
		const centerX = Math.min(0.5 + reach, Math.max(0.5 - reach, wanted));
		const [left, top] = positionRow(centerX, 0.5, width, height);
		return {
			frame: point.frame,
			values: [Number(left.toFixed(4)), Number(top.toFixed(4))] as [number, number],
			interp: "smooth" as const,
		};
	});
}
