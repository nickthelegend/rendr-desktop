// MCP tool handlers for this editor.
//
// Palmier's rule is that agent and UI edits go through the same domain
// operations, so every one of these calls the reducers the panels call. An
// agent cannot reach state the UI can't, and can't bypass a validation the UI
// enforces.
//
// Tools that have no engine behind them still return `not_implemented` — see
// registry.ts. Nothing here fakes a success.

import {
	BEAT_CONFIDENCE_FLOOR,
	detectBeats,
	detectSilence,
	findSyncOffset,
	measureLoudness,
	measureNoiseFloor,
	normalizationGainDb,
	suggestedDenoiseStrength,
} from "./analysis";
import { decodeAudio, monoSamples } from "./audio";
import { autoZoomRegions, detectDeadAir } from "./autoZoom";
import {
	BACKGROUND_LIMITS,
	type BackgroundSettings,
	DEFAULT_BACKGROUND,
	hasBackground,
} from "./background";
import {
	type Cue,
	captionClips,
	captionGroups,
	groupWordsIntoCues,
	isFiller,
	parseSubtitles,
	placeCaptions,
	removeCaptionGroup,
	toSrt,
	toVtt,
	transcriptText,
	transcriptWords,
} from "./captions";
import { type CommentModel, shiftComments, sortComments, voiceIsStale } from "./comments";
import { CURSOR_LIMITS, CURSOR_STYLES, type CursorSettings, DEFAULT_CURSOR } from "./cursor";
import { type ColorBalance, parseCurve, type ToneCurves } from "./curves";
import { type AppliedEffect, EFFECTS, effectCatalog, normalizeEffect } from "./effects";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings, exportDimensions } from "./export";
import {
	canvasToBase64Png,
	canvasToPngBlob,
	renderAssetFrame,
	renderFrameToCanvas,
	stampFrameNumber,
} from "./frames";
import { toFcpxml, toXmeml } from "./interchange";
import {
	animatedProperties,
	isKeyframeProperty,
	KEYFRAME_ARITY,
	keyframeRows,
	parseKeyframeRows,
} from "./keyframes";
import {
	ANCHORS,
	type LayoutFit,
	type LayoutName,
	placeInSlot,
	type Slot,
	slotNames,
	slotsFor,
} from "./layout";
import { findLook, freshLookId, type LookModel, sortLooks } from "./looks";
import { folderChain, formatDuration, SUPPORTED_SUMMARY } from "./media";
import { buildDuckPlan, encodeWavBytes, renderTimelineAudio } from "./mixdown";
import {
	CLIP_LIMITS,
	type ClipModel,
	clampTo,
	type FadeInterpolation,
	isGraded,
	withDefaults,
} from "./model";
import { offlineExportSupport } from "./offlineExport";
import { type HueCurves, type HueTarget, LutParseError, parseCubeLut } from "./pixelGrade";
import { listSources } from "./Recording";
import {
	addTextClip,
	addTrack,
	addTransition,
	addZoomRegion,
	totalFrames as computeTotalFrames,
	duplicateClips,
	findClip,
	layoutClips,
	mapClips,
	mergeRanges,
	moveClip,
	nudgeClips,
	removeClips,
	removeTrack,
	removeTransition,
	removeZoomRegion,
	renameTrack,
	reorderTrack,
	rippleDelete,
	rippleShift,
	setClipBlendMode,
	setClipColor,
	setClipContent,
	setClipCrop,
	setClipDuration,
	setClipEffects,
	setClipFadeShape,
	setClipFlag,
	setClipKeyframes,
	setClipNumber,
	setClipTextStyle,
	setClipTiming,
	setClipTransform,
	setTrackFlag,
	splitAt,
	type TimelineModel,
	toggleSolo,
	trimClipEnd,
	trimClipStart,
	trimSelectionToPlayhead,
	updateZoomRegion,
} from "./reducers";
import {
	compareScopes,
	correctionFor,
	HUE_BIN_NAMES,
	measureScopes,
	type Scopes,
	worthCorrecting,
} from "./scopes";
import { type CaptureSource, clipSourceMsToFrame, type EditorApi, formatTimecode } from "./state";
import {
	DEFAULT_VOICE,
	getVoiceStatus,
	installVoice,
	overrunWarnings,
	planNarration,
	voiceSupported,
} from "./voice";
import {
	DEFAULT_WEBCAM,
	WEBCAM_LIMITS,
	WEBCAM_POSITIONS,
	WEBCAM_SHAPES,
	type WebcamPosition,
	type WebcamSettings,
} from "./webcam";
import {
	canRun,
	clipsWorkflow,
	connect,
	connectionError,
	createNode,
	createWorkflow,
	describeRun,
	disconnect,
	moveNode,
	NODE_SPECS,
	type NodeKind,
	nodeLabel,
	nodeSpec,
	removeNode,
	runOrder,
	setNodeParams,
	type WorkflowModel,
	workflowIssues,
} from "./workflow";
import { ASPECTS, followKeyframes, reframeClips, runWorkflow } from "./workflowRun";
import { cursorFocusAt, DEFAULT_ZOOM_TIMING, scaleForDepth, ZOOM_TIMING_LIMITS } from "./zoom";

export interface ToolResult {
	content: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	>;
	isError?: boolean;
}

/** A handler may need to decode or render, so results are awaited. */
export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

function ok(payload: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: code, message }, null, 2) }],
		isError: true,
	};
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
/** Backdrops ride inside the project file, so one has to stay a sane size. */
const MAX_BACKDROP_DATA_URI = 11_000_000;

const asNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Reads the hue targets `apply_color` declares.
 *
 * Ranges are clamped rather than rejected — a hueShift of 90° is a request for
 * something the ±30 range deliberately doesn't do, and clamping it produces the
 * strongest legal version of what was asked for instead of nothing.
 */
export function parseHueCurves(input: unknown): HueCurves | string {
	if (input === null) return { targets: [] };
	if (typeof input !== "object") {
		return "hueCurves must be an object with a `targets` array.";
	}
	const raw = (input as Record<string, unknown>).targets;
	if (!Array.isArray(raw)) {
		return "hueCurves.targets must be an array of {targetHue, hueShift?, satScale?, lumShift?}.";
	}
	if (raw.length === 0) return { targets: [] };

	const targets: HueTarget[] = [];
	for (const [index, entry] of raw.entries()) {
		if (!entry || typeof entry !== "object") {
			return `hueCurves.targets[${index}] must be an object.`;
		}
		const source = entry as Record<string, unknown>;
		const targetHue = asNumber(source.targetHue);
		if (targetHue === null) {
			return `hueCurves.targets[${index}] needs targetHue, 0–360.`;
		}
		const hueShift = asNumber(source.hueShift);
		const satScale = asNumber(source.satScale);
		const lumShift = asNumber(source.lumShift);
		if (hueShift === null && satScale === null && lumShift === null) {
			return `hueCurves.targets[${index}] changes nothing — pass hueShift, satScale, or lumShift.`;
		}
		targets.push({
			targetHue: ((targetHue % 360) + 360) % 360,
			...(hueShift !== null ? { hueShift: Math.min(30, Math.max(-30, hueShift)) } : {}),
			...(satScale !== null ? { satScale: Math.min(2, Math.max(0, satScale)) } : {}),
			...(lumShift !== null ? { lumShift: Math.min(0.5, Math.max(-0.5, lumShift)) } : {}),
		});
	}
	return { targets };
}

/** get_timeline's clip shape: defaults omitted, exactly as the contract says. */
export function describeClip(clip: ClipModel, fps: number) {
	const out: Record<string, unknown> = {
		id: clip.id,
		name: clip.name,
		frames: [clip.startFrame, clip.endFrame],
	};
	if (clip.mediaType !== "video") out.mediaType = clip.mediaType;
	if (clip.assetId) out.mediaRef = clip.assetId;
	if (clip.speed !== 1) out.speed = clip.speed;
	if (clip.volumeDb !== 0) out.volumeDb = clip.volumeDb;
	if (clip.opacity !== 1) out.opacity = clip.opacity;
	if (clip.trimStartFrame !== 0) out.trimStartFrame = clip.trimStartFrame;
	if (clip.trimEndFrame !== 0) out.trimEndFrame = clip.trimEndFrame;
	if (clip.fadeInFrames !== 0) out.fadeInFrames = clip.fadeInFrames;
	if (clip.fadeOutFrames !== 0) out.fadeOutFrames = clip.fadeOutFrames;
	if (clip.edgeRounding !== 0) out.edgeRounding = clip.edgeRounding;
	if (clip.edgeSoftness !== 0) out.edgeSoftness = clip.edgeSoftness;
	if (clip.blendMode !== "normal") out.blendMode = clip.blendMode;

	const t = clip.transform;
	if (
		t.centerX !== 0.5 ||
		t.centerY !== 0.5 ||
		t.width !== 1 ||
		t.height !== 1 ||
		t.rotation !== 0
	) {
		out.transform = {
			centerX: t.centerX,
			centerY: t.centerY,
			width: t.width,
			height: t.height,
			...(t.rotation ? { rotation: t.rotation } : {}),
			...(t.flipHorizontal ? { flipHorizontal: true } : {}),
			...(t.flipVertical ? { flipVertical: true } : {}),
		};
	}
	const c = clip.crop;
	if (c.top || c.right || c.bottom || c.left) out.crop = c;
	if (isGraded(clip.color)) out.color = clip.color;
	if (clip.effects?.length) {
		out.effects = clip.effects.map((effect) => ({
			type: effect.type,
			params: effect.params,
			...(effect.enabled === false ? { enabled: false } : {}),
		}));
	}
	const animated = animatedProperties(clip);
	if (animated.length) out.animated = animated;
	if (clip.denoiseEnabled) out.denoise = { strength: clip.denoiseStrength };
	if (clip.mediaType === "text") {
		out.content = clip.content;
		out.textStyle = clip.textStyle;
	}
	if (clip.zoomRegions?.length) {
		out.zoomRegions = clip.zoomRegions.map((region) => ({
			id: region.id,
			startMs: Math.round(region.startMs),
			endMs: Math.round(region.endMs),
			depth: region.depth,
			scale: scaleForDepth(region.depth),
			focus: region.focus,
			mode: region.mode,
		}));
		out.durationSeconds = ((clip.endFrame - clip.startFrame) * clip.speed) / fps;
	}
	return out;
}

/** Gaps on a track, so an agent can place a clip without guessing. */
function gapsOf(clips: readonly ClipModel[], end: number): Array<[number, number]> {
	const gaps: Array<[number, number]> = [];
	let cursor = 0;
	for (const clip of [...clips].sort((a, b) => a.startFrame - b.startFrame)) {
		if (clip.startFrame > cursor) gaps.push([cursor, clip.startFrame]);
		cursor = Math.max(cursor, clip.endFrame);
	}
	if (cursor < end) gaps.push([cursor, end]);
	return gaps;
}

/**
 * A neutral world, for correcting toward when there is no reference clip.
 *
 * Mid-grey at 0.5 with the full range present and no colour cast. Correcting
 * toward this is what fixes the usual screen-recording faults — a washed-out
 * capture sitting in a narrow band, a display running warm — without needing a
 * second clip to compare against.
 */
const NEUTRAL_SCOPES: Scopes = {
	blackPoint: 0,
	whitePoint: 1,
	clippedShadows: 0,
	clippedHighlights: 0,
	meanLuma: 0.5,
	mean: { r: 0.5, g: 0.5, b: 0.5 },
	shadows: 0.2,
	midtones: 0.5,
	highlights: 0.8,
	saturation: 0.25,
	warmCool: 0,
	greenMagenta: 0,
	hueHistogram: new Array(12).fill(0),
};

/**
 * How different two sampled frames are, as one 0–1 number.
 *
 * compareScopes answers "which knob would close this gap", which is the right
 * shape for grading and the wrong one for cut detection. A cut needs a single
 * magnitude, so the channels are combined — exposure and contrast dominate
 * because a hard cut nearly always moves them, while a colour-only shift is
 * usually a lighting change within one shot rather than a new one.
 */
function sceneDistance(gap: ReturnType<typeof compareScopes>): number {
	const chroma = Math.hypot(gap.warmCool, gap.greenMagenta);
	return Math.min(
		1,
		Math.abs(gap.exposure) * 1.6 +
			Math.abs(gap.contrast) * 1.2 +
			Math.abs(gap.saturation) * 0.6 +
			chroma * 0.4,
	);
}

/** `clipIds`-style arguments, filtered to the strings that are actually there. */
const stringList = (value: unknown): string[] =>
	asArray(value).filter((entry): entry is string => typeof entry === "string");

/**
 * Moves clips to new start frames, keeping every duration exactly.
 *
 * The arranging tools all reduce to this. Duration is recomputed from the clip
 * in hand rather than passed in, so no caller can move a clip and resize it in
 * the same step — a bug that is invisible until an export runs long.
 */
export function placeAt(
	timeline: TimelineModel,
	starts: ReadonlyMap<string, number>,
): TimelineModel {
	return mapClips(timeline, [...starts.keys()], (clip) => {
		const start = starts.get(clip.id);
		if (start === undefined || start === clip.startFrame) return clip;
		const span = clip.endFrame - clip.startFrame;
		const from = Math.max(0, Math.round(start));
		return { ...clip, startFrame: from, endFrame: from + span };
	});
}

/**
 * Whether moving these clips left any of them stacked on a trackmate.
 *
 * Overlap is legal — stacking is sometimes the point — so this reports rather
 * than refuses. Silence would be worse: two clips on one track at one frame
 * means one of them is not in the export, and nothing else says so.
 */
export function overlapNote(
	timeline: TimelineModel,
	movedIds: readonly string[],
): Record<string, unknown> {
	const moved = new Set(movedIds);
	const collisions: string[] = [];
	for (const track of timeline.tracks) {
		const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
		for (let i = 1; i < sorted.length; i++) {
			const previous = sorted[i - 1];
			const clip = sorted[i];
			if (clip.startFrame >= previous.endFrame) continue;
			if (!moved.has(clip.id) && !moved.has(previous.id)) continue;
			collisions.push(`${previous.name} / ${clip.name}`);
		}
	}
	return collisions.length
		? {
				warnings: [
					`Now overlapping on the same track: ${collisions.join(", ")}. The later clip covers the earlier one.`,
				],
			}
		: {};
}

export function createAgentTools(api: EditorApi) {
	const { state, timeline, commit } = api;

	/**
	 * The take's overlays, in the shape the renderer wants.
	 *
	 * Anything that shows an agent a finished frame passes these, so what it
	 * looks at carries the same drawn pointer and camera inset the export will.
	 */
	const overlays = () => ({
		cursor: {
			telemetry: state.cursorTelemetry,
			settings: state.cursor ?? DEFAULT_CURSOR,
		},
		webcam: { settings: state.webcam ?? DEFAULT_WEBCAM, assets: state.assets },
	});

	/**
	 * Runs a reducer and reports what the timeline became.
	 *
	 * The result is computed here, before committing, rather than read back out
	 * of `commit`. React runs a state updater when it schedules, not when it is
	 * called, so reading afterwards reports the state as it was — which made
	 * successful edits come back as "changed: false".
	 */
	const mutate = (
		label: string,
		reduce: (t: TimelineModel) => TimelineModel,
		receipt: (next: TimelineModel) => unknown,
	): ToolResult => {
		const next = reduce(timeline);
		if (next === timeline) {
			return ok({ changed: false, note: "That request left the timeline unchanged." });
		}
		// `commit` re-runs against whatever the current timeline is, so a human
		// edit landing in the same tick isn't clobbered by a stale snapshot.
		commit(label, (current) => (current === timeline ? next : reduce(current)));
		return ok(receipt(next));
	};

	/**
	 * Measures one clip's picture at its midpoint.
	 *
	 * Renders the clip on its own rather than the composited timeline, so what
	 * is measured is that clip's colour and not whatever happens to be layered
	 * over it. inspect_color does the same thing for a single call; the colour
	 * tools that work across many clips share this.
	 */
	const scopesForClip = async (
		clipId: string,
	): Promise<{ ok: true; scopes: Scopes } | { ok: false; reason: string }> => {
		const clip = findClip(timeline, clipId);
		if (!clip) return { ok: false, reason: `No clip '${clipId}'.` };
		const frame = Math.floor((clip.startFrame + clip.endFrame) / 2);
		// Measuring one clip means measuring it alone: the stack above it would
		// otherwise be what the numbers describe. Rendered without the overlays
		// too, since a white pointer would pull the scopes toward a grade
		// nobody made.
		const isolated: TimelineModel = {
			...timeline,
			tracks: timeline.tracks.map((track) => ({
				...track,
				hidden: false,
				clips: track.clips.filter((entry) => entry.id === clip.id),
			})),
		};
		const result = await renderFrameToCanvas(isolated, state.assets, frame, 640);
		if (!result)
			return { ok: false, reason: `Couldn't render '${clip.name}' at frame ${frame}.` };
		const context = result.canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return { ok: false, reason: "Couldn't read the rendered frame." };
		const scopes = measureScopes(context.getImageData(0, 0, result.width, result.height).data);
		// Two black frames measure identical, which is what made match_color
		// call them a match. The same guard belongs on every reader.
		if (scopes.whitePoint < 0.02)
			return {
				ok: false,
				reason: `'${clip.name}' is black at frame ${frame} — there is nothing to measure.`,
			};
		return { ok: true, scopes };
	};

	/** Source aspect for a clip; the canvas ratio is the honest fallback. */
	const aspectOf = (clip: ClipModel | null, canvasAspect: number): number => {
		const asset = state.assets.find((entry) => entry.id === clip?.assetId);
		return asset && asset.width > 0 && asset.height > 0
			? asset.width / asset.height
			: canvasAspect;
	};

	const handlers: Record<string, ToolHandler> = {
		get_timeline(args) {
			const end = computeTotalFrames(timeline);
			// A window keeps a long cut's payload readable; without one the whole
			// timeline is returned, which is what most calls want.
			const from = asNumber(args.startFrame);
			const to = asNumber(args.endFrame);
			const windowed = from !== null || to !== null;
			const start = Math.max(0, Math.round(from ?? 0));
			const stop = Math.round(to ?? end);
			const inWindow = (clip: ClipModel) =>
				!windowed || (clip.endFrame > start && clip.startFrame < stop);

			// Caption clips are many and short; collapsing them to one row per
			// group is what keeps a captioned timeline legible.
			const detailed = args.captionDetail === true;
			const rowsFor = (clips: readonly ClipModel[]) => {
				const shown = clips.filter(inWindow);
				if (detailed) return shown.map((clip) => describeClip(clip, timeline.fps));
				const rows: Array<Record<string, unknown>> = [];
				const collapsed = new Map<string, { count: number; from: number; to: number }>();
				for (const clip of shown) {
					if (!clip.captionGroupId) {
						rows.push(describeClip(clip, timeline.fps));
						continue;
					}
					const entry = collapsed.get(clip.captionGroupId);
					if (entry) {
						entry.count += 1;
						entry.from = Math.min(entry.from, clip.startFrame);
						entry.to = Math.max(entry.to, clip.endFrame);
					} else {
						collapsed.set(clip.captionGroupId, {
							count: 1,
							from: clip.startFrame,
							to: clip.endFrame,
						});
					}
				}
				for (const [groupId, entry] of collapsed) {
					rows.push({
						captionGroupId: groupId,
						captions: entry.count,
						frames: [entry.from, entry.to],
						note: "Collapsed. Pass captionDetail:true for each caption clip, or call get_transcript.",
					});
				}
				return rows;
			};

			return ok({
				fps: timeline.fps,
				resolution: [timeline.width, timeline.height],
				totalFrames: end,
				durationSeconds: end / timeline.fps,
				projectName: state.projectName,
				timelineId: timeline.id,
				canGenerate: false,
				...(windowed ? { window: [start, stop] } : {}),
				tracks: timeline.tracks.map((track, index) => ({
					trackId: track.id,
					index,
					name: track.name,
					type: track.kind,
					...(track.muted ? { muted: true } : {}),
					...(track.hidden ? { hidden: true } : {}),
					// Reported whenever set, so a caller can tell a track is
					// silent because of solo elsewhere rather than its own mute.
					...(track.solo ? { solo: true } : {}),
					...(track.solo ? { solo: true } : {}),
					clips: rowsFor(track.clips),
					...(track.clips.length ? { gaps: gapsOf(track.clips, end) } : {}),
				})),
			});
		},

		get_media(args) {
			const ids = asArray(args.ids).filter(
				(value): value is string => typeof value === "string",
			);
			// `folder` includes subfolders, as the contract says.
			const folder = asString(args.folder);
			let assets = ids.length
				? state.assets.filter((asset) => ids.includes(asset.id))
				: state.assets;
			if (folder) {
				assets = assets.filter(
					(asset) => asset.folder === folder || asset.folder?.startsWith(`${folder}/`),
				);
			}
			return ok({
				assets: assets.map((asset) => ({
					id: asset.id,
					name: asset.name,
					type: asset.type,
					durationSeconds: asset.durationSeconds,
					width: asset.width,
					height: asset.height,
					hasAudio: asset.hasAudio,
					...(asset.folder ? { folder: asset.folder } : {}),
					...(asset.hasCursorTelemetry ? { hasCursorTelemetry: true } : {}),
					// Which takes have a camera to composite, and which assets
					// are that camera rather than something to edit.
					...(asset.webcamAssetId ? { webcamAssetId: asset.webcamAssetId } : {}),
					...(asset.isWebcam ? { isWebcam: true } : {}),
					...(asset.offline
						? { offline: true, note: "Needs relinking — import the file." }
						: {}),
				})),
				folders: [
					...new Set(state.assets.flatMap((asset) => folderChain(asset.folder))),
				].sort(),
				timelines: state.timelines.map((entry) => ({
					timelineId: entry.id,
					name: entry.name,
					active: entry.id === timeline.id,
				})),
				...(args.pending === true
					? {
							pending: [],
							note: "Rendr's imports finish inline — nothing is ever left unresolved, so this is always empty.",
						}
					: {}),
			});
		},

		add_clips(args) {
			const entries = asArray(args.entries);
			if (entries.length === 0)
				return fail("invalid_argument", "entries must be a non-empty array.");

			// Validate the whole batch before touching anything.
			const planned: Array<{ assetId: string; startFrame: number }> = [];
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index] as Record<string, unknown>;
				const mediaRef = asString(entry.mediaRef);
				const startFrame = asNumber(entry.startFrame);
				if (!mediaRef)
					return fail("invalid_argument", `entries[${index}] needs a mediaRef.`);
				if (startFrame === null || startFrame < 0) {
					return fail(
						"invalid_argument",
						`entries[${index}] needs a non-negative startFrame.`,
					);
				}
				const asset = state.assets.find((item) => item.id === mediaRef);
				if (!asset)
					return fail("unknown_media", `No asset '${mediaRef}'. Call get_media first.`);
				if (asset.offline) {
					return fail(
						"media_offline",
						`'${asset.name}' was restored from a project file and has no source yet. Import the file to relink it.`,
					);
				}
				planned.push({ assetId: mediaRef, startFrame: Math.round(startFrame) });
			}

			for (const entry of planned) api.placeAsset(entry.assetId, entry.startFrame);
			return ok({
				added: planned.length,
				note: "Re-read get_timeline for the resulting clip ids.",
			});
		},

		remove_clips(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);
			return mutate(
				"Remove clips",
				(t) => removeClips(t, clipIds),
				() => ({
					removedClipIds: clipIds,
				}),
			);
		},

		move_clips(args) {
			const moves = asArray(args.moves);
			if (moves.length === 0)
				return fail("invalid_argument", "moves must be a non-empty array.");
			for (let index = 0; index < moves.length; index++) {
				const move = moves[index] as Record<string, unknown>;
				const clipId = asString(move.clipId);
				if (!clipId) return fail("invalid_argument", `moves[${index}] needs a clipId.`);
				if (!findClip(timeline, clipId))
					return fail("unknown_clip", `No clip '${clipId}'.`);
			}
			return mutate(
				"Move clips",
				(t) => {
					let next = t;
					for (const move of moves as Array<Record<string, unknown>>) {
						const clipId = asString(move.clipId) as string;
						const toFrame = asNumber(move.toFrame);
						const toTrack = asNumber(move.toTrack);
						const trackId =
							toTrack !== null ? next.tracks[Math.round(toTrack)]?.id : undefined;
						const clip = findClip(next, clipId);
						if (!clip) continue;
						next = moveClip(next, clipId, toFrame ?? clip.startFrame, trackId);
					}
					return next;
				},
				(next) => ({
					clips: moves.map((move) => {
						const clipId = asString((move as Record<string, unknown>).clipId) as string;
						const clip = findClip(next, clipId);
						return clip ? describeClip(clip, next.fps) : { id: clipId, missing: true };
					}),
				}),
			);
		},

		split_clips(args) {
			const frames = asArray(args.frames)
				.map(asNumber)
				.filter((value): value is number => value !== null);
			const splits = asArray(args.splits);

			const points = splits.length
				? splits
						.map((entry) => asNumber((entry as Record<string, unknown>).atFrame))
						.filter((value): value is number => value !== null)
				: frames;
			if (points.length === 0) {
				return fail(
					"invalid_argument",
					"Pass splits with atFrame, or trackIndex with frames.",
				);
			}
			return mutate(
				"Split clips",
				(t) => points.reduce((acc, frame) => splitAt(acc, Math.round(frame)), t),
				(next) => ({ cuts: points.length, totalFrames: computeTotalFrames(next) }),
			);
		},

		set_clip_properties(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			return mutate(
				"Set clip properties",
				(t) => {
					let next = t;
					for (const key of [
						"opacity",
						"volumeDb",
						"speed",
						"edgeRounding",
						"edgeSoftness",
					] as const) {
						const value = asNumber(args[key]);
						if (value !== null) next = setClipNumber(next, clipIds, key, value);
					}
					// Duration first: fades and trims are clamped against it, so a
					// call that changes both has to resize before it clamps.
					const durationFrames = asNumber(args.durationFrames);
					if (durationFrames !== null) {
						next = setClipDuration(next, clipIds, durationFrames);
					}
					for (const key of [
						"trimStartFrame",
						"trimEndFrame",
						"fadeInFrames",
						"fadeOutFrames",
					] as const) {
						const value = asNumber(args[key]);
						if (value !== null) next = setClipTiming(next, clipIds, key, value);
					}
					for (const key of ["fadeInInterpolation", "fadeOutInterpolation"] as const) {
						const value = asString(args[key]);
						if (value === "linear" || value === "smooth") {
							next = setClipFadeShape(next, clipIds, key, value);
						}
					}
					if (args.transform && typeof args.transform === "object") {
						next = setClipTransform(next, clipIds, args.transform as never);
					}
					if (args.crop && typeof args.crop === "object") {
						next = setClipCrop(next, clipIds, args.crop as never);
					}
					const blendMode = asString(args.blendMode);
					if (blendMode) next = setClipBlendMode(next, clipIds, blendMode as never);
					return next;
				},
				(next) => ({
					clips: clipIds.map((id) => {
						const clip = findClip(next, id);
						return clip ? describeClip(clip, next.fps) : { id, missing: true };
					}),
				}),
			);
		},

		async apply_color(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");

			// Both of these need a pixel's *other* channels to decide its result,
			// so neither is a CSS filter or an SVG transfer function. They run
			// through pixelGrade.ts in the encoder and in the preview alike, so
			// what is on screen is what lands in the file.
			const pixelPatch: Record<string, unknown> = {};

			if (args.hueCurves !== undefined) {
				const parsed = parseHueCurves(args.hueCurves);
				if (typeof parsed === "string") return fail("invalid_argument", parsed);
				pixelPatch.hueCurves = parsed;
			}

			if (args.lut !== undefined) {
				if (args.lut === null) {
					pixelPatch.lut = undefined;
				} else {
					const source = args.lut as Record<string, unknown>;
					const text = asString(source.cube);
					const path = asString(source.path);
					let cubeText = text;
					if (!cubeText && path) {
						const bridge = window.electronAPI;
						if (!bridge?.readLocalFile) {
							return fail(
								"unsupported",
								"Reading a .cube from a path needs Rendr's desktop bridge, which isn't available in this window. Pass the file's contents as `cube` instead.",
							);
						}
						const read = await bridge.readLocalFile(path);
						if (!read?.success || !read.data) {
							return fail(
								"unknown_media",
								`Couldn't read '${path}': ${read?.error ?? "no such file"}.`,
							);
						}
						cubeText = new TextDecoder().decode(read.data);
					}
					if (!cubeText) {
						return fail(
							"invalid_argument",
							"lut needs either `cube` (the .cube file's text) or `path` (a file on disk). Pass null to remove one.",
						);
					}
					try {
						pixelPatch.lut = parseCubeLut(
							cubeText,
							asString(source.name) ?? path?.split("/").pop() ?? "LUT",
						);
					} catch (error) {
						return fail(
							"invalid_argument",
							error instanceof LutParseError
								? error.message
								: "That isn't a readable .cube file.",
						);
					}
					const amount = asNumber(source.strength) ?? asNumber(source.amount);
					if (amount !== null) {
						pixelPatch.lutAmount = Math.min(1, Math.max(0, amount));
					}
				}
			}

			const patch: Record<string, unknown> = {};
			for (const key of [
				"exposure",
				"contrast",
				"saturation",
				"vibrance",
				"temperature",
				"tint",
				"highlights",
				"shadows",
				"whites",
				"blacks",
			] as const) {
				const value = asNumber(args[key]);
				if (value !== null) patch[key] = clampTo(key as keyof typeof CLIP_LIMITS, value);
			}

			// Tone curves: master shapes everything, then each channel's own.
			const curves: ToneCurves = {};
			for (const [key, field] of [
				["masterCurve", "master"],
				["redCurve", "red"],
				["greenCurve", "green"],
				["blueCurve", "blue"],
			] as const) {
				if (args[key] === undefined) continue;
				const parsed = parseCurve(key, args[key]);
				if (!parsed.ok) return fail("invalid_argument", parsed.reason);
				curves[field] = parsed.points;
			}
			if (Object.keys(curves).length > 0) patch.curves = curves;

			// Lift / gamma / gain, one tonal range at a time.
			const balance: ColorBalance = {};
			const BALANCE_LIMITS: Record<string, [number, number]> = {
				shadowsHue: [0, 360],
				shadowsAmount: [0, 1],
				shadowsLum: [-1, 1],
				midsHue: [0, 360],
				midsAmount: [0, 1],
				midsGamma: [0.1, 4],
				highsHue: [0, 360],
				highsAmount: [0, 1],
				highsGain: [0, 4],
			};
			for (const [key, [min, max]] of Object.entries(BALANCE_LIMITS)) {
				const value = asNumber(args[key]);
				if (value === null) continue;
				balance[key as keyof ColorBalance] = Math.min(max, Math.max(min, value));
			}
			if (Object.keys(balance).length > 0) patch.balance = balance;

			Object.assign(patch, pixelPatch);

			if (Object.keys(patch).length === 0 && args.reset !== true) {
				return fail(
					"invalid_argument",
					"Pass at least one colour knob, a curve, a balance value, or reset:true.",
				);
			}
			return mutate(
				"Apply colour",
				(t) => setClipColor(t, clipIds, patch),
				(next) => ({
					clips: clipIds.map((id) => {
						const clip = findClip(next, id);
						if (!clip) return { id, missing: true };
						// A 33-cube is 107,811 numbers. Echoing the table back
						// would drown the receipt, so it is described instead.
						const { lut, ...rest } = clip.color;
						return {
							id,
							color: {
								...rest,
								...(lut
									? {
											lut: {
												name: lut.name,
												size: lut.size,
												amount: clip.color.lutAmount ?? 1,
											},
										}
									: {}),
							},
						};
					}),
					...(pixelPatch.lut || pixelPatch.hueCurves
						? {
								note: "Hue curves and 3D LUTs are applied per pixel, in the preview and the export alike. They cost a readback per frame, so a clip carrying one renders more slowly than one shaped by tone curves.",
							}
						: {}),
				}),
			);
		},

		add_texts(args) {
			const entries = asArray(args.entries);
			if (entries.length === 0)
				return fail("invalid_argument", "entries must be a non-empty array.");
			const ids: string[] = [];
			return mutate(
				"Add text",
				(t) => {
					let next = t;
					entries.forEach((raw, index) => {
						const entry = raw as Record<string, unknown>;
						const content = asString(entry.content) ?? "Text";
						const startFrame = asNumber(entry.startFrame) ?? 0;
						const endFrame = asNumber(entry.endFrame) ?? startFrame + next.fps * 3;
						const id = `text-agent-${Date.now()}-${index}`;
						ids.push(id);
						next = addTextClip(
							next,
							startFrame,
							Math.max(2, Math.round(endFrame - startFrame)),
							id,
							content,
						).timeline;
					});
					return next;
				},
				(next) => ({
					clips: ids.map((id) => {
						const clip = findClip(next, id);
						return clip ? describeClip(clip, next.fps) : { id, missing: true };
					}),
				}),
			);
		},

		update_text(args) {
			if (asString(args.fillMode)) {
				return fail(
					"not_supported",
					"Rendr draws text in one colour; it can't stencil the layers below through the letters. Set style.color instead.",
				);
			}

			// A caption group addresses every caption from one transcription at
			// once, which is how a whole caption track gets restyled.
			const groupId = asString(args.captionGroupId);
			const clipIds = groupId
				? captionClips(timeline, groupId).map((clip) => clip.id)
				: asArray(args.clipIds).filter(
						(value): value is string => typeof value === "string",
					);
			if (clipIds.length === 0) {
				return fail(
					"invalid_argument",
					groupId
						? `No captions belong to group '${groupId}'. get_transcript lists the groups.`
						: "Pass clipIds or captionGroupId.",
				);
			}

			const content = asString(args.content);
			const style = { ...((args.style ?? {}) as Record<string, unknown>) };
			// Animation and highlight colour live on the text style, so an agent
			// can pass them at either level and mean the same thing.
			const animation = asString(args.animation);
			if (animation) style.animation = animation;
			const highlightColor = asString(args.highlightColor);
			if (highlightColor) style.highlightColor = highlightColor;

			return mutate(
				"Update text",
				(t) => {
					let next = t;
					if (content !== null) next = setClipContent(next, clipIds, content);
					if (Object.keys(style).length > 0)
						next = setClipTextStyle(next, clipIds, style as never);
					if (args.transform && typeof args.transform === "object") {
						next = setClipTransform(next, clipIds, args.transform as never);
					}
					return next;
				},
				(next) => ({
					clips: clipIds.map((id) => {
						const clip = findClip(next, id);
						return clip ? describeClip(clip, next.fps) : { id, missing: true };
					}),
				}),
			);
		},

		manage_tracks(args) {
			const add = asString(args.add);
			const removeId = asString(args.removeTrackId);
			const rename = args.rename as { trackId?: string; name?: string } | undefined;
			const set = asArray(args.set);
			const reorder = asArray(args.reorder) as Array<Record<string, unknown>>;

			if (!add && !removeId && !rename && set.length === 0 && reorder.length === 0) {
				return fail(
					"invalid_argument",
					"Pass add, removeTrackId, rename, set, or reorder.",
				);
			}
			return mutate(
				"Manage tracks",
				(t) => {
					let next = t;
					if (add === "video" || add === "audio") next = addTrack(next, add);
					for (const raw of set as Array<Record<string, unknown>>) {
						const trackId =
							asString(raw.trackId) ??
							next.tracks[Math.round(asNumber(raw.index) ?? -1)]?.id ??
							null;
						if (!trackId) continue;
						if (typeof raw.muted === "boolean") {
							next = setTrackFlag(next, trackId, "muted", raw.muted);
						}
						if (typeof raw.hidden === "boolean") {
							next = setTrackFlag(next, trackId, "hidden", raw.hidden);
						}
						if (raw.solo === true) next = toggleSolo(next, trackId);
					}
					if (rename?.trackId && rename.name) {
						next = renameTrack(next, rename.trackId, rename.name);
					}
					// Reordering swaps one neighbour at a time, so a move of
					// several places is that many swaps in the right direction.
					for (const raw of reorder) {
						const trackId =
							asString(raw.trackId) ??
							next.tracks[Math.round(asNumber(raw.from) ?? -1)]?.id ??
							null;
						const to = asNumber(raw.to) ?? asNumber(raw.toIndex);
						if (!trackId || to === null) continue;
						const target = Math.max(
							0,
							Math.min(next.tracks.length - 1, Math.round(to)),
						);
						for (let guard = 0; guard < next.tracks.length; guard++) {
							const at = next.tracks.findIndex((track) => track.id === trackId);
							if (at < 0 || at === target) break;
							const moved = reorderTrack(next, trackId, at < target ? 1 : -1);
							if (moved === next) break;
							next = moved;
						}
					}
					if (removeId) next = removeTrack(next, removeId);
					return next;
				},
				(next) => ({
					tracks: next.tracks.map((track, index) => ({
						trackId: track.id,
						index,
						name: track.name,
						type: track.kind,
					})),
				}),
			);
		},

		add_zoom_regions(args) {
			const regions = asArray(args.regions);
			if (regions.length === 0)
				return fail("invalid_argument", "regions must be a non-empty array.");
			const clipId =
				asString(args.clipId) ??
				timeline.tracks.flatMap((t) => t.clips).find((c) => c.mediaType === "video")?.id;
			if (!clipId) return fail("no_target", "There is no video clip to attach a zoom to.");

			const clip = findClip(timeline, clipId);
			if (!clip) return fail("unknown_clip", `No clip '${clipId}'.`);
			const limitMs = ((clip.endFrame - clip.startFrame) * clip.speed * 1000) / timeline.fps;

			let refusal: string | null = null;
			const added: string[] = [];
			const result = mutate(
				"Add zoom regions",
				(t) => {
					let next = t;
					for (const raw of regions as Array<Record<string, unknown>>) {
						const startMs = asNumber(raw.startMs);
						const endMs = asNumber(raw.endMs);
						const depth = asNumber(raw.depth) ?? 2;
						if (startMs === null || endMs === null) {
							refusal = "Every region needs finite startMs and endMs.";
							return t;
						}
						// Without an explicit focus, start where the cursor was —
						// an auto region then follows it from there.
						const focus = (raw.focus ??
							cursorFocusAt(state.cursorTelemetry, (startMs + endMs) / 2) ?? {
								cx: 0.5,
								cy: 0.5,
							}) as { cx: number; cy: number };
						const outcome = addZoomRegion(
							next,
							clipId,
							(startMs + endMs) / 2,
							endMs - startMs,
							limitMs,
							focus,
						);
						if (!outcome.ok) {
							refusal = outcome.reason;
							return t;
						}
						if (outcome.regionId) {
							added.push(outcome.regionId);
							const depthOutcome = updateZoomRegion(
								outcome.timeline,
								clipId,
								outcome.regionId,
								{
									depth: Math.round(depth),
									mode: (asString(raw.mode) ?? "auto") as never,
								},
								limitMs,
							);
							next = depthOutcome.ok ? depthOutcome.timeline : outcome.timeline;
						} else {
							next = outcome.timeline;
						}
					}
					return next;
				},
				(next) => {
					const target = findClip(next, clipId);
					return {
						added: added.length,
						zoomRegions: target?.zoomRegions?.map((region) => ({
							id: region.id,
							startMs: Math.round(region.startMs),
							endMs: Math.round(region.endMs),
							depth: region.depth,
							scale: scaleForDepth(region.depth),
							focus: region.focus,
							mode: region.mode,
						})),
					};
				},
			);
			return refusal ? fail("refused", refusal) : result;
		},

		update_zoom_regions(args) {
			const clipId =
				asString(args.clipId) ??
				timeline.tracks.flatMap((t) => t.clips).find((c) => c.zoomRegions?.length)?.id;
			if (!clipId) return fail("no_target", "No clip carries zoom regions.");
			const set = asArray(args.set);
			const remove = asArray(args.remove).filter(
				(value): value is string => typeof value === "string",
			);
			if (set.length === 0 && remove.length === 0) {
				return fail("invalid_argument", "Pass set or remove.");
			}

			let refusal: string | null = null;
			const result = mutate(
				"Update zoom regions",
				(t) => {
					let next = t;
					for (const raw of set as Array<Record<string, unknown>>) {
						const regionId = asString(raw.regionId);
						if (!regionId) {
							refusal = "Every set entry needs a regionId.";
							return t;
						}
						const patch: Record<string, unknown> = {};
						for (const key of ["startMs", "endMs", "depth"] as const) {
							const value = asNumber(raw[key]);
							if (value !== null) patch[key] = value;
						}
						if (raw.focus) patch.focus = raw.focus;
						const mode = asString(raw.mode);
						if (mode) patch.mode = mode;
						const outcome = updateZoomRegion(
							next,
							clipId,
							regionId,
							patch as never,
							Number.MAX_SAFE_INTEGER,
						);
						if (!outcome.ok) {
							refusal = outcome.reason;
							return t;
						}
						next = outcome.timeline;
					}
					for (const regionId of remove) {
						const outcome = removeZoomRegion(next, clipId, regionId);
						if (!outcome.ok) {
							refusal = outcome.reason;
							return t;
						}
						next = outcome.timeline;
					}
					return next;
				},
				(next) => ({
					zoomRegions: findClip(next, clipId)?.zoomRegions?.length ?? 0,
					removed: remove,
				}),
			);
			return refusal ? fail("refused", refusal) : result;
		},

		undo() {
			if (!api.canUndo) return fail("nothing_to_undo", "The history is empty.");
			api.undo();
			return ok({
				undone: true,
				note: "Re-read get_timeline; ids and frames may have moved.",
			});
		},

		async export_project(args) {
			const mode = asString(args.mode) ?? "video";
			if (!["video", "xml", "fcpxml", "rendr"].includes(mode)) {
				return fail("invalid_argument", "mode must be video, xml, fcpxml, or rendr.");
			}

			// A timelineId picks which cut to write; rendr mode packages them all.
			const timelineId = asString(args.timelineId);
			if (timelineId && mode === "rendr") {
				return fail(
					"invalid_argument",
					"rendr mode packages every timeline, so timelineId doesn't apply.",
				);
			}
			const target = timelineId
				? state.timelines.find((entry) => entry.id === timelineId)
				: timeline;
			if (timelineId && !target) {
				return fail("unknown_timeline", `No timeline '${timelineId}'.`);
			}
			const cut = target ?? timeline;

			if (mode === "rendr") {
				api.saveProject();
				return ok({
					status: "started",
					mode,
					format: "rendr",
					destination: `${state.projectName}.rendr`,
					note: "The lossless format: every timeline, zoom regions, effects and keyframes included. It downloads through the browser, so Rendr can't choose the folder — outputPath and overwrite don't apply.",
				});
			}

			if (mode === "video") {
				if (computeTotalFrames(cut) === 0) {
					return fail("empty_timeline", "There's nothing on the timeline to export.");
				}
				if (cut.id !== timeline.id) {
					return fail(
						"wrong_timeline",
						`The encoder renders whatever is active. Call set_active_timeline with '${cut.id}' first.`,
					);
				}

				// Rendr encodes WebM/VP9. The codec names in the contract come from
				// Palmier's native encoder and have no equivalent here, so an
				// explicit ask is answered rather than quietly ignored.
				const codec = asString(args.codec);
				if (codec && codec !== "H.264") {
					return fail(
						"unsupported_codec",
						`Rendr encodes WebM/VP9 through the browser's own encoder — ${codec} would need a native encoder it doesn't bundle. Omit codec, or use mode 'fcpxml' and encode in the target app.`,
					);
				}
				const resolution = asString(args.resolution);
				const RESOLUTIONS: Record<string, ExportSettings["resolution"]> = {
					"Match Timeline": "source",
					"1080p": "1080p",
					"720p": "720p",
				};
				if (resolution && !RESOLUTIONS[resolution]) {
					return fail(
						"unsupported_resolution",
						`Rendr renders at the timeline's own size, 1080p, or 720p. ${resolution} would be an upscale of pixels that aren't there.`,
					);
				}

				try {
					// Which encoder will take it decides both the container and
					// how long this runs, so it is reported rather than guessed.
					const { width, height } = exportDimensions(
						timeline,
						resolution
							? { ...DEFAULT_EXPORT_SETTINGS, resolution: RESOLUTIONS[resolution] }
							: DEFAULT_EXPORT_SETTINGS,
					);
					const offline = await offlineExportSupport(width, height, timeline.fps);
					const jobId = await api.agentExport(
						resolution ? { resolution: RESOLUTIONS[resolution] } : {},
					);
					return ok({
						status: "started",
						mode,
						jobId,
						destination: `${state.projectName}.${offline.supported ? "mp4" : "webm"}`,
						format: offline.supported ? "MP4 (H.264/AAC)" : "WebM (VP9)",
						encoder: offline.supported ? "webcodecs-offline" : "mediarecorder-realtime",
						note: offline.supported
							? "Encoded offline with WebCodecs: frame timestamps come from the timeline, so the file's duration is exact. It runs as fast as frames can be composited — usually bounded by seeking the source media, so roughly real time for a screen recording and much faster for simple timelines. Poll manage_exports for progress; the file downloads when it finishes."
							: "No WebCodecs encoder took this size, so the real-time path runs: it walks the timeline at playback speed and takes about as long as the video runs. Poll manage_exports for progress; the file downloads when it finishes.",
					});
				} catch (error) {
					return fail(
						"export_failed",
						error instanceof Error ? error.message : "The export couldn't be started.",
					);
				}
			}

			const result =
				mode === "xml"
					? toXmeml(cut, state.assets, state.projectName)
					: toFcpxml(
							cut,
							state.assets,
							state.projectName,
							(asString(args.fcpxmlTarget) ?? "resolve") as "resolve" | "fcp",
						);

			const extension = mode === "xml" ? "xml" : "fcpxml";
			const filename = `${state.projectName.replace(/[/\\?%*:|"<>]/g, "-")}.${extension}`;
			api.downloadText(result.xml, filename, "application/xml");

			return ok({
				status: "started",
				mode,
				timelineId: cut.id,
				destination: filename,
				bytes: result.xml.length,
				...(result.warnings.length ? { warnings: result.warnings } : {}),
				note: "Written and downloaded. Rendr writes through the browser's download flow, so it can't choose the folder — outputPath and overwrite don't apply.",
			});
		},

		set_cursor(args) {
			const current = state.cursor ?? DEFAULT_CURSOR;
			const next: CursorSettings = { ...current };
			const rejected: string[] = [];

			if (typeof args.show === "boolean") next.show = args.show;
			if (typeof args.loop === "boolean") next.loop = args.loop;
			if (typeof args.clickRing === "boolean") next.clickRing = args.clickRing;
			const ringColor = asString(args.ringColor);
			if (ringColor !== null) next.ringColor = ringColor;
			const style = asString(args.style);
			if (style !== null) {
				if (!CURSOR_STYLES.some((entry) => entry.id === style)) {
					return fail(
						"invalid_argument",
						`No cursor style '${style}'. This build offers: ${CURSOR_STYLES.map((entry) => entry.id).join(", ")}.`,
					);
				}
				next.style = style as CursorSettings["style"];
			}
			// Out-of-range values are clamped and named, rather than silently
			// accepted — a size of 40 would otherwise "succeed" and draw nothing
			// recognisable.
			for (const key of [
				"size",
				"smoothing",
				"motionBlur",
				"clickBounce",
				"bounceSpeed",
				"sway",
				"spotlight",
				"spotlightSize",
			] as const) {
				const value = asNumber(args[key]);
				if (value === null) continue;
				const limit = CURSOR_LIMITS[key];
				const clamped = Math.min(limit.max, Math.max(limit.min, value));
				if (clamped !== value) rejected.push(`${key} ${value} → ${clamped}`);
				next[key] = clamped;
			}

			api.patch({ cursor: next });

			const telemetry = state.cursorTelemetry.length;
			return ok({
				cursor: next,
				...(rejected.length ? { clamped: rejected } : {}),
				telemetrySamples: telemetry,
				note:
					telemetry === 0
						? "No cursor telemetry in this project, so nothing is drawn yet. Record with captureCursor:true, or open a project whose recording carried it."
						: "Applied to playback and export.",
			});
		},

		set_webcam(args) {
			const current = state.webcam ?? DEFAULT_WEBCAM;
			const next: WebcamSettings = { ...current, crop: { ...current.crop } };
			const rejected: string[] = [];

			if (typeof args.show === "boolean") next.show = args.show;
			if (typeof args.mirror === "boolean") next.mirror = args.mirror;
			if (typeof args.reactsToZoom === "boolean") next.reactsToZoom = args.reactsToZoom;
			const deviceId = asString(args.deviceId);
			if (deviceId !== null) next.deviceId = deviceId;

			const position = asString(args.position);
			if (position !== null) {
				if (!WEBCAM_POSITIONS.some((row) => row.includes(position as WebcamPosition))) {
					return fail(
						"invalid_argument",
						`No webcam position '${position}'. Use one of: ${WEBCAM_POSITIONS.flat().join(", ")}.`,
					);
				}
				next.position = position as WebcamPosition;
			}
			const shape = asString(args.shape);
			if (shape !== null) {
				if (!WEBCAM_SHAPES.some((entry) => entry.id === shape)) {
					return fail(
						"invalid_argument",
						`No webcam shape '${shape}'. Use one of: ${WEBCAM_SHAPES.map((entry) => entry.id).join(", ")}.`,
					);
				}
				next.shape = shape as WebcamSettings["shape"];
			}

			for (const key of ["size", "margin"] as const) {
				const value = asNumber(args[key]);
				if (value === null) continue;
				const limit = WEBCAM_LIMITS[key];
				const clamped = Math.min(limit.max, Math.max(limit.min, value));
				if (clamped !== value) rejected.push(`${key} ${value} → ${clamped}`);
				next[key] = clamped;
			}

			const crop = args.crop;
			if (crop && typeof crop === "object") {
				for (const side of ["top", "right", "bottom", "left"] as const) {
					const value = asNumber((crop as Record<string, unknown>)[side]);
					if (value === null) continue;
					const clamped = Math.min(0.9, Math.max(0, value));
					if (clamped !== value) rejected.push(`crop.${side} ${value} → ${clamped}`);
					next.crop[side] = clamped;
				}
			}

			// Pairing an already-recorded camera file with a screen take. The
			// normal path records both at once, but a camera shot separately is
			// just as valid a source for the inset.
			const pairWith = asString(args.pairCameraAsset);
			const pairFor = asString(args.pairForAsset);
			if (pairWith !== null || pairFor !== null) {
				if (pairFor === null) {
					return fail(
						"invalid_argument",
						"pairForAsset is required — a camera file has to be paired with the screen take it was shot alongside.",
					);
				}
				const screen = state.assets.find((entry) => entry.id === pairFor);
				if (!screen) return fail("unknown_media", `No asset '${pairFor}'.`);
				if (screen.type !== "video") {
					return fail("wrong_media_type", `'${screen.name}' is not video.`);
				}
				if (pairWith !== null) {
					const camera = state.assets.find((entry) => entry.id === pairWith);
					if (!camera) return fail("unknown_media", `No asset '${pairWith}'.`);
					if (camera.type !== "video") {
						return fail("wrong_media_type", `'${camera.name}' is not video.`);
					}
					if (camera.id === screen.id) {
						return fail(
							"invalid_argument",
							"A take cannot be its own camera — the inset would recurse.",
						);
					}
				}
				api.pairCamera(pairFor, pairWith);
			}

			api.patch({ webcam: next });

			return ok({
				webcam: next,
				...(rejected.length ? { clamped: rejected } : {}),
				note: next.show
					? "The camera is being opened for the preview and will be recorded to its own file alongside the next capture. Opening is asynchronous: if no camera can be opened the switch goes back off and the reason is shown in the app — call get_recording_status to see whether it stayed on before starting a recording. Takes recorded before this was turned on have no camera to composite."
					: "Camera off. Takes already recorded keep their camera file; turning this back on composites it again.",
			});
		},

		async set_background(args) {
			const current = state.background ?? DEFAULT_BACKGROUND;
			const next: BackgroundSettings = { ...current, gradient: { ...current.gradient } };
			const clamped: string[] = [];

			// The image can arrive as a data URI or as a path Rendr reads itself.
			// Backdrops are embedded in the project file, so it is capped.
			const imageDataUri = asString(args.imageDataUri);
			const imagePath = asString(args.imagePath);
			if (imageDataUri !== null || imagePath !== null) {
				if (imageDataUri !== null) {
					if (!/^data:image\/[a-z.+-]+;base64,/i.test(imageDataUri)) {
						return fail(
							"invalid_argument",
							"imageDataUri must be a base64 data URI of an image, e.g. 'data:image/png;base64,…'.",
						);
					}
					if (imageDataUri.length > MAX_BACKDROP_DATA_URI) {
						return fail(
							"invalid_argument",
							`That backdrop is ${(imageDataUri.length / 1e6).toFixed(1)} MB as a data URI. Backdrops ride inside the project file, so they're capped at ${MAX_BACKDROP_DATA_URI / 1e6} MB — scale it down first.`,
						);
					}
					next.imageUrl = imageDataUri;
				} else if (imagePath !== null) {
					const bridge = window.electronAPI;
					if (!bridge?.readLocalFile) {
						return fail(
							"unsupported",
							"Reading a backdrop from a path needs Rendr's desktop bridge, which isn't available in this window. Pass imageDataUri instead.",
						);
					}
					const read = await bridge.readLocalFile(imagePath);
					if (!read?.success || !read.data) {
						return fail(
							"unknown_media",
							`Couldn't read '${imagePath}': ${read?.error ?? "no such file"}.`,
						);
					}
					if (read.data.length > MAX_BACKDROP_DATA_URI * 0.72) {
						return fail(
							"invalid_argument",
							`'${imagePath}' is too large to embed as a backdrop. Scale it down first.`,
						);
					}
					const extension = imagePath.split(".").pop()?.toLowerCase() ?? "png";
					const mime = extension === "jpg" ? "jpeg" : extension;
					let binary = "";
					for (const byte of read.data) binary += String.fromCharCode(byte);
					next.imageUrl = `data:image/${mime};base64,${btoa(binary)}`;
				}
				// Supplying a picture is asking for it to be shown.
				next.kind = "image";
			}

			const kind = asString(args.kind);
			if (kind !== null) {
				if (!["none", "color", "gradient", "image"].includes(kind)) {
					return fail(
						"invalid_argument",
						`No backdrop kind '${kind}'. Use none, color, gradient, or image.`,
					);
				}
				if (kind === "image" && !next.imageUrl) {
					return fail(
						"invalid_argument",
						"kind 'image' needs a picture. Pass imageDataUri or imagePath in the same call, or pick one from the Background panel.",
					);
				}
				next.kind = kind as BackgroundSettings["kind"];
			}

			const color = asString(args.color);
			if (color !== null) next.color = color;
			const from = asString(args.gradientFrom);
			if (from !== null) next.gradient.from = from;
			const to = asString(args.gradientTo);
			if (to !== null) next.gradient.to = to;
			const angle = asNumber(args.gradientAngle);
			if (angle !== null) next.gradient.angle = ((angle % 360) + 360) % 360;

			for (const key of ["padding", "radius", "shadow"] as const) {
				const value = asNumber(args[key]);
				if (value === null) continue;
				const limit = BACKGROUND_LIMITS[key];
				const bounded = Math.min(limit.max, Math.max(limit.min, value));
				if (bounded !== value) clamped.push(`${key} ${value} → ${bounded}`);
				next[key] = bounded;
			}

			// Zoom motion rides along here: it is the same class of thing — a
			// property of the take rather than of any one clip — and splitting it
			// into its own tool would mean two calls to set up one look.
			const timing = { ...(state.zoomTiming ?? DEFAULT_ZOOM_TIMING) };
			for (const key of ["zoomInDurationMs", "zoomOutDurationMs"] as const) {
				const value = asNumber(args[key]);
				if (value === null) continue;
				const limit = ZOOM_TIMING_LIMITS[key];
				const bounded = Math.min(limit.max, Math.max(limit.min, value));
				if (bounded !== value) clamped.push(`${key} ${value} → ${bounded}`);
				timing[key] = bounded;
			}
			if (typeof args.connectZooms === "boolean") timing.connectZooms = args.connectZooms;
			const smoothness = asNumber(args.zoomSmoothness);
			if (smoothness !== null) {
				const bounded = Math.min(1, Math.max(0, smoothness));
				if (bounded !== smoothness) {
					clamped.push(`zoomSmoothness ${smoothness} → ${bounded}`);
				}
				timing.smoothness = bounded;
			}

			api.patch({ background: next, zoomTiming: timing });

			return ok({
				// The data URI is thousands of characters; the receipt names it
				// rather than echoing it back.
				background: {
					...next,
					...(next.imageUrl
						? { imageUrl: `<embedded, ${(next.imageUrl.length / 1024).toFixed(0)} KB>` }
						: {}),
				},
				zoomTiming: timing,
				...(clamped.length ? { clamped } : {}),
				note: hasBackground(next)
					? "Applied to the preview and the export alike. The backdrop sits behind the zoom camera, so a punch-in magnifies the footage without moving the backdrop."
					: "No backdrop: the footage fills the frame edge to edge.",
			});
		},

		manage_comments(args) {
			const action = asString(args.action) ?? "list";
			const describe = (comment: CommentModel) => ({
				commentId: comment.id,
				frame: comment.frame,
				timecode: formatTimecode(comment.frame, timeline.fps),
				text: comment.text,
				...(comment.trackId ? { trackId: comment.trackId } : {}),
				...(comment.durationFrames > 0 ? { durationFrames: comment.durationFrames } : {}),
				author: comment.author,
				...(comment.resolved ? { resolved: true } : {}),
				...(comment.voice
					? { voiced: { voiceId: comment.voice.voiceId, stale: voiceIsStale(comment) } }
					: {}),
			});

			if (action === "list") {
				return ok({
					comments: sortComments(state.comments).map(describe),
					note: "Notes are the narration script — narrate_timeline speaks the unresolved ones in order.",
				});
			}

			if (action === "add") {
				const text = asString(args.text);
				if (!text) return fail("invalid_argument", "text is required to add a note.");
				const frame = asNumber(args.frame);
				if (frame === null) {
					return fail(
						"invalid_argument",
						"frame is required — a note is pinned to a moment, not to the timeline as a whole.",
					);
				}
				const trackId = asString(args.trackId);
				if (trackId && !timeline.tracks.some((track) => track.id === trackId)) {
					return fail("unknown_track", `No track '${trackId}'.`);
				}
				const comment = api.addComment({
					frame: Math.max(0, Math.round(frame)),
					text,
					...(trackId ? { trackId } : {}),
					durationFrames: asNumber(args.durationFrames) ?? 0,
					author: "agent",
				});
				return ok({ added: describe(comment) });
			}

			const commentId = asString(args.commentId);
			if (!commentId) return fail("invalid_argument", `commentId is required to ${action}.`);
			const existing = state.comments.find((comment) => comment.id === commentId);
			if (!existing) return fail("unknown_comment", `No note '${commentId}'.`);

			if (action === "remove") {
				api.removeComment(commentId);
				return ok({ removed: commentId });
			}
			if (action === "resolve" || action === "unresolve") {
				api.updateComment(commentId, { resolved: action === "resolve" });
				return ok({ [action === "resolve" ? "resolved" : "reopened"]: commentId });
			}
			if (action === "update") {
				const text = asString(args.text);
				const durationFrames = asNumber(args.durationFrames);
				const frame = asNumber(args.frame);
				api.updateComment(commentId, {
					...(text !== null ? { text } : {}),
					...(durationFrames !== null
						? { durationFrames: Math.max(0, Math.round(durationFrames)) }
						: {}),
					...(frame !== null ? { frame: Math.max(0, Math.round(frame)) } : {}),
				});
				return ok({
					updated: describe({
						...existing,
						...(text !== null ? { text } : {}),
						...(frame !== null ? { frame: Math.max(0, Math.round(frame)) } : {}),
					}),
					...(text !== null && existing.voice
						? {
								warning:
									"The wording changed, so this note's audio no longer matches. Run narrate_timeline to re-speak it.",
							}
						: {}),
				});
			}

			return fail(
				"invalid_argument",
				`No action '${action}'. Use list, add, update, remove, resolve, or unresolve.`,
			);
		},

		async setup_voice(args) {
			if (!voiceSupported()) {
				return fail(
					"unsupported",
					"Speech runs in Rendr's desktop process, which this window has no bridge to. Narration isn't available in the browser build.",
				);
			}

			const status = await getVoiceStatus();
			if (args.install !== true) {
				return ok({
					installed: status.installed,
					modelId: status.modelId,
					megabytes: Number((status.bytes / 1_000_000).toFixed(1)),
					cacheDir: status.cacheDir,
					...(status.error ? { error: status.error } : {}),
					note: status.installed
						? "Ready. narrate_timeline can run."
						: "Not installed. Call again with install:true — it downloads about 90 MB and takes a minute or two.",
				});
			}

			const result = await installVoice();
			const after = await getVoiceStatus();
			if (after.error) {
				return fail(
					"install_failed",
					`Couldn't install the speech model: ${after.error}. It downloads from Hugging Face, so this usually means no network.`,
				);
			}
			// The download runs in the background rather than blocking this call:
			// a first install outruns most tool timeouts, and a caller that saw a
			// timeout would read a working download as a failure.
			if (!result.ok) {
				return ok({
					installed: false,
					installing: true,
					modelId: after.modelId,
					megabytes: Number((after.bytes / 1_000_000).toFixed(1)),
					note: "Downloading — about 90 MB, usually a minute or two. Call setup_voice again to check; it reports installed:true when the model is ready, and narrate_timeline will refuse until then.",
				});
			}
			return ok({
				installed: true,
				modelId: after.modelId,
				megabytes: Number((after.bytes / 1_000_000).toFixed(1)),
				note: "Kokoro-82M is on this machine and runs locally. narrate_timeline can now speak the timeline's notes.",
			});
		},

		async narrate_timeline(args) {
			if (!voiceSupported()) {
				return fail(
					"unsupported",
					"Speech runs in Rendr's desktop process, which this window has no bridge to.",
				);
			}
			const status = await getVoiceStatus();
			if (!status.installed) {
				return fail(
					"not_installed",
					"The speech model isn't on this machine yet. Call setup_voice with install:true first — it downloads about 90 MB, once.",
				);
			}

			const only = asArray(args.commentIds).filter(
				(value): value is string => typeof value === "string",
			);
			const speed = Math.min(2, Math.max(0.5, asNumber(args.speed) ?? 1));
			const voice = asString(args.voice) ?? DEFAULT_VOICE;
			const regenerate = args.regenerate === true;

			const wanted = only.length
				? state.comments.filter((comment) => only.includes(comment.id))
				: state.comments;
			if (only.length) {
				const missing = only.filter(
					(id) => !state.comments.some((comment) => comment.id === id),
				);
				if (missing.length) {
					return fail("unknown_comment", `No note: ${missing.join(", ")}.`);
				}
			}

			const plan = planNarration(wanted, { regenerate });
			const todo = plan.filter((entry) => !entry.skipped);
			if (todo.length === 0) {
				return ok({
					spoken: 0,
					skipped: plan.length,
					note:
						plan.length === 0
							? "There are no notes to speak. Write the script with manage_comments first — one note per beat of the demo."
							: "Every note already has audio generated from its current text. Pass regenerate:true to re-speak them.",
				});
			}

			// The same path the inspector's button runs, so an agent-generated
			// voiceover is byte-for-byte the one a person would get.
			let result: Awaited<ReturnType<typeof api.runNarration>>;
			try {
				result = await api.runNarration({
					voice,
					speed,
					regenerate,
					subtitles: args.subtitles !== false,
					...(only.length ? { commentIds: only } : {}),
				});
			} catch (error) {
				return fail(
					"speech_failed",
					`Couldn't generate the narration: ${
						error instanceof Error ? error.message : String(error)
					}. Nothing was placed.`,
				);
			}

			// From the real durations, not the estimate — the lines exist now.
			const measured = new Map(result.lines.map((line) => [line.commentId, line.seconds]));
			const overruns = overrunWarnings(state.comments, timeline.fps, speed, measured);
			return ok({
				spoken: result.spoken,
				skipped: result.skipped,
				voice: result.voice,
				speed,
				track: "Narration",
				...(args.subtitles !== false ? { subtitles: "CC track, karaoke word timing" } : {}),
				lines: result.lines,
				...(overruns.length
					? {
							overruns,
							warning:
								"Some lines run past the note that follows them, so the narration will overlap. Shorten the wording or move the notes apart.",
						}
					: {}),
				note: "Generated on this machine with Kokoro. The lines are on the narration track, each starting at its note's frame.",
			});
		},

		trim_dead_air(args) {
			if (state.cursorTelemetry.length === 0) {
				return fail(
					"no_telemetry",
					"This take carries no cursor data, so there is no way to tell activity from stillness. Record with captureCursor:true, or trim by hand with trim_clips.",
				);
			}
			const host = timeline.tracks
				.filter((track) => track.kind === "video")
				.flatMap((track) => track.clips)
				.find((clip) => clip.mediaType === "video");
			if (!host) return fail("nothing_to_trim", "There is no footage on the timeline.");

			const totalMs = ((host.endFrame - host.startFrame) * host.speed * 1000) / timeline.fps;
			const dead = detectDeadAir(state.cursorTelemetry, totalMs);
			const headFrames = Math.round((dead.headMs / 1000) * timeline.fps);
			const tailFrames = Math.round((dead.tailMs / 1000) * timeline.fps);

			if (headFrames <= 0 && tailFrames <= 0) {
				return ok({
					changed: false,
					note: "This take starts and ends busy, so there is nothing to trim.",
				});
			}

			const report = {
				headSeconds: Number((dead.headMs / 1000).toFixed(2)),
				tailSeconds: Number((dead.tailMs / 1000).toFixed(2)),
				firstActivitySeconds: Number((dead.firstActivityMs / 1000).toFixed(2)),
				lastActivitySeconds: Number((dead.lastActivityMs / 1000).toFixed(2)),
			};
			if (args.measureOnly === true) {
				return ok({ measureOnly: true, ...report, note: "Nothing was changed." });
			}

			return mutate(
				"Trim dead air",
				(t) => {
					// The tail first: trimming the head moves every later frame,
					// so a tail frame computed against the original would land in
					// the wrong place.
					let next = t;
					if (tailFrames > 0) {
						next = trimClipEnd(next, host.id, host.endFrame - tailFrames);
					}
					if (headFrames > 0) {
						next = trimClipStart(next, host.id, host.startFrame + headFrames);
					}
					return next;
				},
				(next) => {
					const clip = findClip(next, host.id);
					return {
						...report,
						frames: clip ? [clip.startFrame, clip.endFrame] : [],
						note: "A beat was left either side, so the cut doesn't land mid-gesture. The clip's other content is untouched — use ripple_delete_ranges if you want the timeline to close up.",
					};
				},
			);
		},

		fit_to_duration(args) {
			const seconds = asNumber(args.seconds);
			if (seconds === null || seconds <= 0) {
				return fail("invalid_argument", "seconds must be a positive number.");
			}
			const current = computeTotalFrames(timeline) / timeline.fps;
			if (current <= 0) {
				return fail("empty_timeline", "There is nothing on the timeline to retime.");
			}

			// Speed and duration are inverse: to halve the length, double the
			// speed. Getting this backwards is the easy mistake here.
			const factor = current / seconds;
			const limits = CLIP_LIMITS.speed;

			const retimable = timeline.tracks
				.filter((track) => args.includeNarration === true || track.name !== "Narration")
				.flatMap((track) => track.clips)
				.filter((clip) => clip.mediaType !== "text");
			if (retimable.length === 0) {
				return fail("nothing_to_retime", "No clip on the timeline can be retimed.");
			}

			// Refused rather than clamped silently: landing at a different length
			// than asked for, without saying so, is the failure this guards.
			const wanted = retimable.map((clip) => clip.speed * factor);
			const outOfRange = wanted.filter((speed) => speed < limits.min || speed > limits.max);
			if (outOfRange.length > 0) {
				const bounded = wanted.map((speed) =>
					Math.min(limits.max, Math.max(limits.min, speed)),
				);
				const achievable = current / (bounded[0] / retimable[0].speed);
				return fail(
					"out_of_range",
					`That needs ${factor.toFixed(2)}x, past the ${limits.min}-${limits.max}x limit. The closest this timeline can reach is about ${achievable.toFixed(1)}s. Cut something instead, or pick a length nearer that.`,
				);
			}

			return mutate(
				"Fit to duration",
				(t) =>
					retimable.reduce(
						(acc, clip) => setClipNumber(acc, [clip.id], "speed", clip.speed * factor),
						t,
					),
				(next) => {
					const landed = computeTotalFrames(next) / next.fps;
					/*
					 * Anything left at its own speed still governs the length.
					 *
					 * Leaving narration alone is the right default, but it means
					 * the timeline can land past the target — and a receipt
					 * carrying two different numbers without saying why reads as
					 * a tool that quietly missed.
					 */
					const missedBy = landed - seconds;
					const heldBy =
						Math.abs(missedBy) > 0.25 && args.includeNarration !== true
							? "narration"
							: null;
					return {
						targetSeconds: seconds,
						actualSeconds: Number(landed.toFixed(2)),
						factor: Number(factor.toFixed(3)),
						retimed: retimable.length,
						...(heldBy ? { missedTargetBy: Number(missedBy.toFixed(2)), heldBy } : {}),
						// A list, because there can be more than one thing worth
						// saying and a single `warning` key silently loses all
						// but the last.
						...(() => {
							const warnings: string[] = [];
							if (heldBy) {
								warnings.push(
									`The timeline is ${landed.toFixed(1)}s, not ${seconds}s: the narration track wasn't retimed and now runs longest. Pass includeNarration:true to retime it too — which re-pitches the voice — or shorten the script.`,
								);
							}
							if (factor > 1.2) {
								warnings.push(
									`Picture is playing at ${factor.toFixed(2)}x. Any audio riding with it is pitched up audibly, so consider cutting instead of retiming.`,
								);
							}
							return warnings.length > 0 ? { warnings } : {};
						})(),
						note:
							args.includeNarration === true
								? "Every clip took the same factor, so the rhythm of the edit survives."
								: "Narration was left at its own speed, since re-pitching a generated voice is worse than letting it sit slightly early. Every other clip took the same factor.",
					};
				},
			);
		},

		export_subtitles(args) {
			const format = asString(args.format) === "vtt" ? "vtt" : "srt";
			const groups = [
				...new Set(
					timeline.tracks
						.flatMap((track) => track.clips)
						.map((clip) => clip.captionGroupId)
						.filter((id): id is string => id !== undefined),
				),
			];
			if (groups.length === 0) {
				return fail(
					"no_captions",
					"This timeline has no captions. Run add_captions, or narrate_timeline which writes them from the script.",
				);
			}

			const groupId = asString(args.groupId) ?? (groups.length === 1 ? groups[0] : null);
			if (!groupId) {
				return fail(
					"ambiguous_group",
					`This project has more than one caption group: ${groups.join(", ")}. Pass groupId to say which.`,
				);
			}
			if (!groups.includes(groupId)) {
				return fail("unknown_group", `No caption group '${groupId}'.`);
			}

			// Timings come from where the clips actually sit, so a caption that
			// was moved on the timeline moves its cue too.
			const cues: Cue[] = timeline.tracks
				.flatMap((track) => track.clips)
				.filter((clip) => clip.captionGroupId === groupId)
				.sort((a, b) => a.startFrame - b.startFrame)
				.map((clip, index) => ({
					id: String(index + 1),
					startMs: (clip.startFrame / timeline.fps) * 1000,
					endMs: (clip.endFrame / timeline.fps) * 1000,
					text: clip.content ?? "",
				}));
			if (cues.length === 0) {
				return fail("empty_group", `Caption group '${groupId}' has no clips.`);
			}

			/*
			 * Overlapping cues are legal in the file and a mess on screen.
			 *
			 * Most players show both stacked or pick one arbitrarily, so a
			 * subtitle track that reads fine on this timeline can be unreadable
			 * on a platform. Reported rather than fixed: trimming one cue is a
			 * timing decision, and silently shortening somebody's subtitle to
			 * make a validator happy is not this tool's call.
			 */
			const overlapping = cues.filter(
				(cue, index) => index > 0 && cue.startMs < cues[index - 1].endMs,
			);

			const text = format === "vtt" ? toVtt(cues) : toSrt(cues);
			const filename = `${state.projectName}.${format}`;
			if (args.download !== false) api.downloadText(filename, text);

			return ok({
				format,
				groupId,
				cues: cues.length,
				...(args.download === false ? {} : { filename }),
				text,
				...(overlapping.length
					? {
							overlapping: overlapping.length,
							warning: `${overlapping.length} ${overlapping.length === 1 ? "cue overlaps the one" : "cues overlap the ones"} before ${overlapping.length === 1 ? "it" : "them"}. That is legal in the file but shows as stacked or dropped subtitles on most players — usually it means two notes sit too close together on the timeline.`,
						}
					: {}),
				note: "Cues are taken from the caption clips as they stand, so anything edited on the timeline is in the file.",
			});
		},

		async match_color(args) {
			const clipId = asString(args.clipId);
			const referenceClipId = asString(args.referenceClipId);
			if (!clipId || !referenceClipId) {
				return fail("invalid_argument", "clipId and referenceClipId are both required.");
			}
			if (clipId === referenceClipId) {
				return fail("invalid_argument", "A clip already matches itself.");
			}
			const subject = findClip(timeline, clipId);
			const reference = findClip(timeline, referenceClipId);
			if (!subject) return fail("unknown_clip", `No clip '${clipId}'.`);
			if (!reference) return fail("unknown_clip", `No clip '${referenceClipId}'.`);
			for (const clip of [subject, reference]) {
				if (clip.mediaType === "text" || clip.mediaType === "audio") {
					return fail("wrong_media_type", `'${clip.name}' has no picture to measure.`);
				}
			}

			/*
			 * A frame from the middle of each clip, rendered on its own.
			 *
			 * Isolated the way inspect_color does it, so a caption or another
			 * track above cannot end up in the measurement — matching a clip to
			 * a subtitle's white text would be nonsense.
			 */
			const measure = async (clip: ClipModel) => {
				const isolated: TimelineModel = {
					...timeline,
					tracks: timeline.tracks.map((track) => ({
						...track,
						clips: track.clips.filter((entry) => entry.id === clip.id),
					})),
				};
				const frame = Math.round((clip.startFrame + clip.endFrame) / 2);
				const rendered = await renderFrameToCanvas(isolated, state.assets, frame, 480);
				if (!rendered) return null;
				const context = rendered.canvas.getContext("2d", { willReadFrequently: true });
				if (!context) return null;
				return measureScopes(
					context.getImageData(0, 0, rendered.width, rendered.height).data,
				);
			};

			const subjectScopes = await measure(subject);
			const referenceScopes = await measure(reference);
			if (!subjectScopes || !referenceScopes) {
				return fail(
					"render_failed",
					"Couldn't render a frame from one of those clips. Its media may need relinking.",
				);
			}

			/*
			 * A frame with nothing in it cannot be matched to anything.
			 *
			 * Offline media renders black, and comparing black to black reports a
			 * perfect match — which is how this tool came to say two visibly
			 * different grades already matched. Measuring nothing and calling it
			 * a match is worse than refusing.
			 */
			for (const [name, scopes] of [
				[subject.name, subjectScopes],
				[reference.name, referenceScopes],
			] as const) {
				if (scopes.whitePoint < 0.02) {
					return fail(
						"nothing_to_measure",
						`'${name}' rendered as an empty frame, so there is nothing to measure. Its media is probably offline — check get_media and relink it.`,
					);
				}
			}

			const gap = compareScopes(subjectScopes, referenceScopes);
			if (!worthCorrecting(gap)) {
				return ok({
					changed: false,
					gap: gap.hints,
					note: "Those already match to within what anyone can see, so the grade was left alone.",
				});
			}

			const corrected = correctionFor(gap, {
				exposure: subject.color.exposure,
				contrast: subject.color.contrast,
				saturation: subject.color.saturation,
				temperature: subject.color.temperature,
				tint: subject.color.tint,
			});

			if (args.measureOnly === true) {
				return ok({
					measureOnly: true,
					gap: gap.hints,
					wouldApply: corrected,
					note: "Nothing was changed.",
				});
			}

			return mutate(
				"Match colour",
				(t) => setClipColor(t, [clipId], corrected),
				() => ({
					matched: clipId,
					to: referenceClipId,
					applied: corrected,
					gap: gap.hints,
					note: "Applied on top of the clip's existing grade, so a look it already carried was kept.",
				}),
			);
		},

		async normalize_audio(args) {
			const targetDb = asNumber(args.targetDb) ?? -18;
			const ceilingDb = asNumber(args.ceilingDb) ?? -1;
			const asked = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);

			const carriesAudio = (clip: ClipModel) => {
				if (clip.mediaType === "text" || clip.mediaType === "image") return false;
				const asset = state.assets.find((entry) => entry.id === clip.assetId);
				return Boolean(asset && !asset.offline && asset.url && asset.hasAudio !== false);
			};
			const targets = timeline.tracks
				.flatMap((track) => track.clips)
				.filter(carriesAudio)
				.filter((clip) => (asked.length === 0 ? true : asked.includes(clip.id)));

			if (targets.length === 0) {
				return fail(
					"nothing_to_normalize",
					"No clip on the timeline carries decodable audio.",
				);
			}

			const measured: Array<{
				clipId: string;
				programDb: number;
				peakDb: number;
				gainDb: number;
				limitedBy: "peak" | null;
				shortfallDb: number;
			}> = [];
			for (const clip of targets) {
				const asset = state.assets.find((entry) => entry.id === clip.assetId);
				if (!asset) continue;
				const buffer = await decodeAudio(asset);
				if (!buffer) continue;
				const profile = measureLoudness(monoSamples(buffer), buffer.sampleRate);
				if (profile.activeRatio === 0) continue;
				const gain = normalizationGainDb(profile, targetDb, ceilingDb);
				measured.push({
					clipId: clip.id,
					programDb: profile.programDb,
					peakDb: profile.peakDb,
					// The level it will end up at, relative to the clip's own.
					gainDb: gain.gainDb,
					limitedBy: gain.limitedBy,
					shortfallDb: gain.shortfallDb,
				});
			}

			if (measured.length === 0) {
				return fail(
					"decode_failed",
					"Couldn't decode any of those clips, or they are silent throughout.",
				);
			}

			const held = measured.filter((entry) => entry.limitedBy === "peak");
			if (args.measureOnly === true) {
				return ok({
					measureOnly: true,
					clips: measured,
					targetDb,
					note: "Nothing was changed. programDb is unweighted program RMS over the audible passages, not LUFS.",
				});
			}

			return mutate(
				"Normalize audio",
				(t) =>
					measured.reduce((acc, entry) => {
						const clip = findClip(acc, entry.clipId);
						if (!clip) return acc;
						return setClipNumber(
							acc,
							[entry.clipId],
							"volumeDb",
							clip.volumeDb + entry.gainDb,
						);
					}, t),
				() => ({
					normalized: measured.length,
					targetDb,
					clips: measured,
					...(held.length
						? {
								warning: `${held.length} ${held.length === 1 ? "clip" : "clips"} couldn't reach the target without clipping, so ${held.length === 1 ? "it was" : "they were"} left as loud as the ceiling allows. Lower targetDb, or accept the shortfall.`,
							}
						: {}),
					note: "Levels measured over the audible passages only, so silence at the head didn't inflate the gain.",
				}),
			);
		},

		reframe_timeline(args) {
			const name = asString(args.aspect);
			const aspect = name ? ASPECTS[name] : undefined;
			if (!aspect) {
				return fail(
					"invalid_argument",
					`No aspect '${name}'. Use one of: ${Object.keys(ASPECTS).join(", ")}.`,
				);
			}
			const visual = timeline.tracks
				.filter((track) => track.kind === "video")
				.flatMap((track) => track.clips)
				.filter((clip) => clip.mediaType !== "text");
			if (visual.length === 0) {
				return fail(
					"nothing_to_reframe",
					"There is no footage on the timeline to reframe.",
				);
			}

			// Following is the point of a vertical crop of a screen recording, so
			// it is on whenever there is telemetry to follow.
			const follow = args.followCursor !== false && state.cursorTelemetry.length > 0;

			return mutate(
				"Reframe",
				(t) => {
					const reframed = reframeClips(t, aspect);
					if (!follow) return reframed;
					return reframed.tracks
						.filter((track) => track.kind === "video")
						.flatMap((track) => track.clips)
						.filter((clip) => clip.mediaType !== "text")
						.reduce((acc, clip) => {
							const keys = followKeyframes(state.cursorTelemetry, {
								clipStartFrame: clip.startFrame,
								clipEndFrame: clip.endFrame,
								trimStartFrame: clip.trimStartFrame,
								fps: t.fps,
								width: clip.transform.width,
							});
							return keys.length === 0
								? acc
								: setClipKeyframes(acc, clip.id, "position", keys);
						}, reframed);
				},
				(next) => ({
					aspect: name,
					followingCursor: follow,
					clips: next.tracks
						.filter((track) => track.kind === "video")
						.flatMap((track) => track.clips)
						.filter((clip) => clip.mediaType !== "text")
						.map((clip) => ({
							id: clip.id,
							width: Number(clip.transform.width.toFixed(3)),
							height: clip.transform.height,
						})),
					note: follow
						? "The frame keeps its pixel size and the crop pans to keep the pointer in shot, smoothed so it follows the subject rather than mirroring the mouse. Text and captions were left alone — they are composed for the frame, not cropped from a source."
						: "The frame keeps its pixel size; the footage is centred and cover-fitted, so nothing is letterboxed. Text and captions were left alone.",
				}),
			);
		},

		duck_audio(args) {
			const amountDb = asNumber(args.amountDb) ?? -12;
			const rampFrames = asNumber(args.rampFrames) ?? 8;
			if (amountDb >= 0) {
				return fail(
					"invalid_argument",
					"amountDb must be negative — ducking lowers a level. -12 keeps a bed audible under speech.",
				);
			}

			// The narration track is what everything else ducks under.
			const narration = timeline.tracks.find((track) => track.name === "Narration");
			const spans = (narration?.clips ?? []).map((clip) => ({
				startFrame: clip.startFrame,
				endFrame: clip.endFrame,
			}));
			if (spans.length === 0) {
				return fail(
					"nothing_to_duck_under",
					"There is no narration to duck under. Run narrate_timeline first, or set levels directly with set_clip_properties.",
				);
			}

			const asked = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			const candidates = timeline.tracks
				.filter((track) => track.name !== "Narration")
				.flatMap((track) => track.clips)
				.filter((clip) => clip.mediaType !== "text")
				.filter((clip) => (asked.length === 0 ? true : asked.includes(clip.id)));

			const plans = candidates
				.map((clip) => buildDuckPlan(clip, spans, { amountDb, rampFrames }))
				.filter((plan): plan is NonNullable<typeof plan> => plan !== null);

			if (plans.length === 0) {
				return fail(
					"nothing_to_duck",
					"Nothing overlaps the narration for long enough to duck. A line has to be longer than two ramps to hold a level.",
				);
			}

			return mutate(
				"Duck audio",
				(t) =>
					plans.reduce(
						// Replaces the volume track rather than adding to it, so
						// running this again after re-narrating doesn't layer.
						(acc, plan) =>
							setClipKeyframes(
								acc,
								plan.clipId,
								"volumeDb",
								// Linear, so the ramps are straight lines rather than
								// eased — a duck that eases in sounds like the bed
								// is being faded by hand, which is not what it is.
								plan.rows.map(([frame, db]) => ({
									frame,
									values: [db],
									interp: "linear" as const,
								})),
							),
						t,
					),
				() => ({
					ducked: plans.map((plan) => ({
						clipId: plan.clipId,
						points: plan.rows.length,
					})),
					amountDb,
					rampFrames,
					underNarrationLines: spans.length,
					note: "Written as volume keyframes, so it is audible while scrubbing and present in the export with no bake step.",
				}),
			);
		},

		add_transition(args) {
			const removeClipId = asString(args.removeClipId);
			if (removeClipId) {
				if (!findClip(timeline, removeClipId)) {
					return fail("unknown_clip", `No clip '${removeClipId}'.`);
				}
				return mutate(
					"Remove transition",
					(t) => removeTransition(t, removeClipId),
					() => ({
						restored: removeClipId,
						note: "Fades cleared, so the cut is hard again. The clip's timing is unchanged.",
					}),
				);
			}

			const atFrame = asNumber(args.atFrame);
			const frames = asNumber(args.frames);
			if (atFrame === null || frames === null) {
				return fail(
					"invalid_argument",
					"Pass atFrame and frames, or removeClipId to restore a hard cut.",
				);
			}

			// Attempted on the timeline in hand so the refusal can be reported
			// with its reason rather than as a silent no-change.
			const attempt = addTransition(timeline, atFrame, frames);
			if (attempt.error) return fail("transition_refused", attempt.error);

			return mutate(
				"Add transition",
				(t) => addTransition(t, atFrame, frames).timeline,
				() => ({
					between: attempt.between,
					frames: attempt.frames,
					note: "The incoming clip was pulled earlier so the two overlap, and both carry matching fades across it — the same fades you can set by hand.",
				}),
			);
		},

		duplicate_clips(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			// The new ids are computed from the timeline in hand, not read back
			// after the commit — a receipt has to describe what happened.
			const { newIds } = duplicateClips(timeline, clipIds);
			return mutate(
				"Duplicate clips",
				(t) => duplicateClips(t, clipIds).timeline,
				() => ({
					duplicated: clipIds.length,
					newClipIds: newIds,
					note: "Each copy sits immediately after its original on the same track; nothing was pushed aside.",
				}),
			);
		},

		nudge_clips(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const delta = asNumber(args.deltaFrames);
			if (delta === null || delta === 0) {
				return fail("invalid_argument", "deltaFrames must be a non-zero number.");
			}
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			return mutate(
				"Nudge clips",
				(t) => nudgeClips(t, clipIds, Math.round(delta)),
				(next) => ({
					nudged: clipIds.map((id) => {
						const clip = findClip(next, id);
						return clip ? { id, frames: [clip.startFrame, clip.endFrame] } : { id };
					}),
					note: "The set moved together, so relative timing inside it is unchanged. Nothing was pushed past frame 0.",
				}),
			);
		},

		trim_clips(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			const edge = asString(args.edge) === "start" ? "start" : "end";
			const atPlayhead = args.atPlayhead === true;
			const toFrame = asNumber(args.toFrame);
			if (!atPlayhead && toFrame === null) {
				return fail(
					"invalid_argument",
					"Pass toFrame, or atPlayhead:true to trim to the playhead.",
				);
			}

			return mutate(
				"Trim clips",
				(t) =>
					atPlayhead
						? trimSelectionToPlayhead(t, clipIds, Math.round(state.playhead), edge)
						: clipIds.reduce(
								(acc, id) =>
									edge === "start"
										? trimClipStart(acc, id, Math.round(toFrame ?? 0))
										: trimClipEnd(acc, id, Math.round(toFrame ?? 0)),
								t,
							),
				(next) => ({
					edge,
					clips: clipIds.map((id) => {
						const clip = findClip(next, id);
						return clip
							? {
									id,
									frames: [clip.startFrame, clip.endFrame],
									trimStart: clip.trimStartFrame,
								}
							: { id, missing: true };
					}),
					note: "The other edge stayed put, so the timeline around the clip is undisturbed. The source offset moved with the head, so the picture didn't slide.",
				}),
			);
		},

		async run_workflow(args) {
			const workflowId = asString(args.workflowId);
			if (!workflowId) return fail("invalid_argument", "workflowId is required.");
			const workflow = state.workflows.find((entry) => entry.id === workflowId);
			if (!workflow) return fail("unknown_workflow", `No workflow '${workflowId}'.`);

			const blocking = workflowIssues(workflow);
			if (blocking.length > 0) {
				return fail(
					"workflow_invalid",
					`This workflow can't run yet: ${blocking.map((issue) => issue.message).join(" ")}`,
				);
			}

			const dryRun = args.dryRun === true;
			const report = await runWorkflow(workflow, {
				timeline,
				assets: state.assets,
				comments: state.comments,
				telemetry: state.cursorTelemetry,
				hooks: {
					// A dry run performs no speech and writes no file, so the
					// hooks report success without doing the work.
					narrate: dryRun
						? async () => ({ spoken: state.comments.length, lines: [] })
						: async () => {
								const result = await api.runNarration({});
								return { spoken: result.spoken, lines: result.lines };
							},
					export: dryRun
						? async () => ({ path: "(dry run — no file written)" })
						: async () => {
								const jobId = await api.agentExport({});
								return { path: `export job ${jobId}` };
							},
				},
			});

			if (!report.ok) {
				return fail("workflow_failed", `${report.error} Nothing was committed.`);
			}

			const steps = report.steps.map((step) => ({ step: step.label, did: step.detail }));
			if (dryRun) {
				return ok({
					dryRun: true,
					steps,
					note: "Nothing was committed and no file was written. Run again without dryRun to apply it.",
				});
			}

			// Committed once, at the end: a failure part way through must leave
			// the timeline exactly as it was.
			return mutate(
				`Run ${workflow.name}`,
				() => report.timeline ?? timeline,
				() => ({
					ran: workflow.name,
					steps,
					...(report.outputPath ? { output: report.outputPath } : {}),
					note: "Every step succeeded, so the timeline was committed as one undoable change.",
				}),
			);
		},

		manage_workflows(args) {
			const action = asString(args.action) ?? "list";
			const describe = (workflow: WorkflowModel) => ({
				workflowId: workflow.id,
				name: workflow.name,
				nodes: workflow.nodes.length,
				edges: workflow.edges.length,
				runnable: canRun(workflow),
			});

			if (action === "list") {
				return ok({
					workflows: state.workflows.map(describe),
					nodeKinds: NODE_SPECS.map((spec) => ({
						kind: spec.kind,
						label: spec.label,
						summary: spec.summary,
						takesInput: spec.inputs === 1,
						producesOutput: spec.hasOutput,
					})),
					note: "A workflow describes an edit instead of performing one. create_clips_preset gives the short-form pipeline, ready to run.",
				});
			}

			if (action === "create" || action === "create_clips_preset") {
				const name = asString(args.name);
				const workflow =
					action === "create_clips_preset"
						? clipsWorkflow(name ?? undefined)
						: createWorkflow(name ?? "Untitled workflow");
				api.addWorkflow(workflow);
				return ok({
					created: describe(workflow),
					runOrder: (runOrder(workflow) ?? []).map((node) => nodeLabel(node)),
					issues: workflowIssues(workflow).map((issue) => issue.message),
				});
			}

			const workflowId = asString(args.workflowId);
			if (!workflowId)
				return fail("invalid_argument", `workflowId is required to ${action}.`);
			const workflow = state.workflows.find((entry) => entry.id === workflowId);
			if (!workflow) return fail("unknown_workflow", `No workflow '${workflowId}'.`);

			if (action === "delete") {
				api.removeWorkflow(workflowId);
				return ok({ deleted: workflowId });
			}
			if (action === "rename") {
				const name = asString(args.name);
				if (!name) return fail("invalid_argument", "name is required to rename.");
				api.updateWorkflow(workflowId, (current) => ({ ...current, name }));
				return ok({ renamed: { workflowId, name } });
			}
			if (action === "describe") {
				return ok({
					...describe(workflow),
					run: describeRun(workflow, timeline),
					nodes: workflow.nodes.map((node) => ({
						nodeId: node.id,
						kind: node.kind,
						label: nodeLabel(node),
						params: node.params,
						...(node.disabled ? { disabled: true } : {}),
					})),
					edges: workflow.edges.map((edge) => ({
						edgeId: edge.id,
						from: edge.from,
						to: edge.to,
					})),
					issues: workflowIssues(workflow).map((issue) => issue.message),
				});
			}

			return fail(
				"invalid_argument",
				`No action '${action}'. Use list, create, create_clips_preset, rename, delete, or describe.`,
			);
		},

		edit_workflow(args) {
			const workflowId = asString(args.workflowId);
			if (!workflowId) return fail("invalid_argument", "workflowId is required.");
			const workflow = state.workflows.find((entry) => entry.id === workflowId);
			if (!workflow) return fail("unknown_workflow", `No workflow '${workflowId}'.`);
			const action = asString(args.action);

			const receipt = (next: WorkflowModel, extra: Record<string, unknown>) => {
				api.updateWorkflow(workflowId, () => next);
				return ok({
					...extra,
					nodes: next.nodes.length,
					edges: next.edges.length,
					runnable: canRun(next),
					issues: workflowIssues(next).map((issue) => issue.message),
				});
			};

			if (action === "add_node") {
				const kind = asString(args.kind);
				if (!kind || !nodeSpec(kind as NodeKind)) {
					return fail(
						"invalid_argument",
						`No node kind '${kind}'. This build offers: ${NODE_SPECS.map((s) => s.kind).join(", ")}.`,
					);
				}
				const node = createNode(
					kind as NodeKind,
					asNumber(args.x) ?? 40 + workflow.nodes.length * 190,
					asNumber(args.y) ?? 120,
				);
				return receipt(
					{ ...workflow, nodes: [...workflow.nodes, node] },
					{ added: { nodeId: node.id, kind: node.kind, label: nodeLabel(node) } },
				);
			}

			if (action === "remove_node") {
				const nodeId = asString(args.nodeId);
				if (!nodeId) return fail("invalid_argument", "nodeId is required.");
				if (!workflow.nodes.some((node) => node.id === nodeId)) {
					return fail("unknown_node", `No node '${nodeId}' in this workflow.`);
				}
				return receipt(removeNode(workflow, nodeId), { removed: nodeId });
			}

			if (action === "connect") {
				const from = asString(args.from);
				const to = asString(args.to);
				if (!from || !to) return fail("invalid_argument", "connect needs from and to.");
				// Refused with the reason, not silently dropped: a wire that looks
				// connected and does nothing is the worst outcome here.
				const problem = connectionError(workflow, from, to);
				if (problem) return fail("invalid_connection", problem);
				return receipt(connect(workflow, from, to), { connected: { from, to } });
			}

			if (action === "disconnect") {
				const edgeId = asString(args.edgeId);
				if (!edgeId) return fail("invalid_argument", "edgeId is required.");
				if (!workflow.edges.some((edge) => edge.id === edgeId)) {
					return fail("unknown_edge", `No wire '${edgeId}'.`);
				}
				return receipt(disconnect(workflow, edgeId), { disconnected: edgeId });
			}

			if (action === "move_node") {
				const nodeId = asString(args.nodeId);
				const x = asNumber(args.x);
				const y = asNumber(args.y);
				if (!nodeId || x === null || y === null) {
					return fail("invalid_argument", "move_node needs nodeId, x and y.");
				}
				return receipt(moveNode(workflow, nodeId, x, y), { moved: nodeId });
			}

			if (action === "set_params") {
				const nodeId = asString(args.nodeId);
				if (!nodeId) return fail("invalid_argument", "nodeId is required.");
				const params = args.params;
				if (!params || typeof params !== "object") {
					return fail("invalid_argument", "params must be an object.");
				}
				return receipt(setNodeParams(workflow, nodeId, params as Record<string, unknown>), {
					updated: nodeId,
				});
			}

			return fail(
				"invalid_argument",
				`No action '${action}'. Use add_node, remove_node, connect, disconnect, move_node, or set_params.`,
			);
		},

		get_recording_status() {
			const { phase, elapsed, sourceName } = state.recording;
			// The overlays are reported either way: whether the next take will
			// have a drawn cursor or a camera is a property of the settings, not
			// of whether capture happens to be running right now.
			const overlays = {
				cursor: { show: (state.cursor ?? DEFAULT_CURSOR).show },
				webcam: { show: (state.webcam ?? DEFAULT_WEBCAM).show },
			};
			return phase === "idle"
				? ok({ active: false, ...overlays })
				: ok({
						...overlays,
						active: phase === "recording",
						state: phase,
						elapsedSeconds: elapsed,
						source: sourceName,
					});
		},

		async list_capture_sources(args) {
			const kind = asString(args.kind) ?? "all";
			if (!["all", "screen", "window", "camera"].includes(kind)) {
				return fail("invalid_argument", "kind must be screen, window, camera, or all.");
			}

			// Enumerated here and now. Reading a cache the Record panel happens to
			// fill would report "nothing capturable" on a machine that can capture
			// perfectly well — the panel simply hadn't been opened.
			let sources: CaptureSource[];
			try {
				sources = await listSources();
			} catch (error) {
				return fail(
					"capture_unavailable",
					`Couldn't enumerate capture sources: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			const matching = sources.filter((source) => kind === "all" || source.kind === kind);
			if (matching.length === 0) {
				return ok({
					sources: [],
					permissionRequired:
						typeof navigator?.userAgent === "string" && /Mac/.test(navigator.userAgent)
							? "Screen Recording, in System Settings → Privacy & Security"
							: "screen capture",
					note: "Nothing capturable was returned. On macOS and Windows the usual cause is the screen-recording permission not being granted to Rendr — ask the user to enable it and retry.",
				});
			}

			return ok({
				sources: matching.map((source) => ({
					sourceId: source.id,
					name: source.name,
					kind: source.kind,
				})),
				note: "Pass a sourceId back to start_recording exactly as given.",
			});
		},

		async start_recording(args) {
			if (state.recording.phase !== "idle") {
				return fail(
					"already_recording",
					`Capture is already ${state.recording.phase}. Call stop_recording first.`,
				);
			}
			const countdown = asNumber(args.countdownSeconds);
			try {
				const started = await api.agentStartRecording(
					asString(args.sourceId) ?? undefined,
					{
						countdownSeconds:
							countdown === null ? 0 : Math.max(0, Math.round(countdown)),
						microphoneDeviceId: asString(args.microphoneDeviceId) ?? undefined,
						systemAudio:
							typeof args.systemAudio === "boolean" ? args.systemAudio : undefined,
						captureCursor:
							typeof args.captureCursor === "boolean"
								? args.captureCursor
								: undefined,
						name: asString(args.name) ?? undefined,
					},
				);
				return ok({
					status: "recording",
					recordingId: started.recordingId,
					source: started.sourceName,
					note: "Capture is running. Call stop_recording to end it; the take lands in the library.",
				});
			} catch (error) {
				return fail(
					"capture_failed",
					error instanceof Error ? error.message : "Capture couldn't be started.",
				);
			}
		},

		async stop_recording(args) {
			if (state.recording.phase === "idle") {
				return fail("not_recording", "Nothing is being captured.");
			}
			// One capture at a time, so a recordingId can only name this one —
			// and naming a different one is a mistake worth reporting.
			const recordingId = asString(args.recordingId);
			if (recordingId && recordingId !== state.activeRecordingId) {
				return fail(
					"unknown_recording",
					`This window is capturing '${state.activeRecordingId ?? "an untracked take"}', not '${recordingId}'.`,
				);
			}
			const discard = args.discard === true;
			try {
				const asset = await api.agentStopRecording({ discard });
				if (discard) {
					return ok({
						status: "discarded",
						note: "Capture stopped and the take was thrown away — nothing entered the library.",
					});
				}
				return ok({
					status: "stopped",
					mediaRef: asset.assetId,
					name: asset.name,
					durationSeconds: asset.durationSeconds,
					note: "The take is in the library. Place it with add_clips, then suggest_zooms reads its cursor telemetry.",
				});
			} catch (error) {
				return fail(
					"capture_failed",
					error instanceof Error ? error.message : "The recording couldn't be finished.",
				);
			}
		},

		add_captions(args) {
			if (args.censorProfanity === true) {
				return fail(
					"not_supported",
					"Rendr has no profanity list — which words count is a judgement call it shouldn't make silently. Caption first, then use remove_words with the exact tokens.",
				);
			}

			const subtitles = asString(args.subtitles);
			const host =
				asString(args.clipId) ??
				timeline.tracks
					.flatMap((t) => t.clips)
					.find((c) => c.mediaType === "audio" || c.mediaType === "video")?.id ??
				null;

			// Style, animation and placement apply to the clips this call makes.
			const style = { ...((args.style ?? {}) as Record<string, unknown>) };
			const animation = asString(args.animation);
			if (animation) style.animation = animation;
			const highlightColor = asString(args.highlightColor);
			if (highlightColor) style.highlightColor = highlightColor;
			const placement = {
				style: Object.keys(style).length ? style : undefined,
				transform: (args.transform ?? null) as Record<string, unknown> | null,
				maxWords: asNumber(args.maxWords),
			};

			if (subtitles) {
				// An agent that already has cues can hand them straight over.
				try {
					const groupId = api.applyCaptions(parseSubtitles(subtitles), host, placement);
					return ok({
						status: "added",
						source: "subtitles",
						captionGroupId: groupId,
						...(asString(args.language)
							? {
									note: "`language` is ignored for supplied subtitles — the cues are used exactly as given.",
								}
							: {}),
					});
				} catch (error) {
					return fail(
						"invalid_subtitles",
						error instanceof Error ? error.message : "Couldn't read those subtitles.",
					);
				}
			}

			if (!host) return fail("no_target", "There is no clip with audio to transcribe.");
			// Transcription is async and runs a local model; the tool reports that
			// it started rather than blocking the call for minutes.
			void api.transcribe(host, placement);
			return ok({
				status: "started",
				note: "Transcription runs locally and can take a while. Poll get_transcript, or pass `subtitles` to skip it.",
			});
		},

		get_transcript(args) {
			const groups = captionGroups(timeline);
			if (groups.length === 0) {
				return ok({
					words: [],
					captionGroups: [],
					note: "Nothing is captioned yet. Run add_captions first.",
				});
			}

			// A clipId narrows to that caption's own group, so "what does this
			// caption say" doesn't require knowing the group id.
			const clipId = asString(args.clipId);
			const fromClip = clipId ? findClip(timeline, clipId) : null;
			if (clipId && !fromClip) return fail("unknown_clip", `No clip '${clipId}'.`);
			const groupId = asString(args.captionGroupId) ?? fromClip?.captionGroupId ?? undefined;
			if (groupId && !groups.includes(groupId)) {
				return fail(
					"unknown_group",
					`No caption group '${groupId}'. Known groups: ${groups.join(", ")}.`,
				);
			}

			const from = asNumber(args.startFrame);
			const to = asNumber(args.endFrame);
			const all = transcriptWords(timeline, groupId);
			// Indices stay the ones the whole transcript uses, so a windowed read
			// still hands remove_words numbers it will understand.
			const words = all.filter(
				(word) =>
					(from === null || word.endFrame > from) &&
					(to === null || word.startFrame < to),
			);

			const granularity = asString(args.granularity) ?? "word";
			if (granularity !== "word" && granularity !== "caption") {
				return fail("invalid_argument", "granularity must be 'word' or 'caption'.");
			}

			if (granularity === "caption") {
				const clips = (groupId ? captionClips(timeline, groupId) : [])
					.concat(groupId ? [] : groups.flatMap((entry) => captionClips(timeline, entry)))
					.filter(
						(clip) =>
							(from === null || clip.endFrame > from) &&
							(to === null || clip.startFrame < to),
					)
					.sort((a, b) => a.startFrame - b.startFrame);
				return ok({
					captionGroups: groups,
					granularity,
					text: transcriptText(timeline, groupId),
					captions: clips.map((clip) => ({
						clipId: clip.id,
						frames: [clip.startFrame, clip.endFrame],
						text: clip.content ?? "",
					})),
				});
			}

			return ok({
				captionGroups: groups,
				granularity,
				text: transcriptText(timeline, groupId),
				...(asString(args.language)
					? {
							languageNote:
								"`language` doesn't apply here — this reads captions that already exist. Set the language when they're created, on add_captions.",
						}
					: {}),
				words: words.map((word) => [word.index, word.text, word.startFrame]),
				...(from !== null || to !== null
					? { window: [from ?? 0, to ?? computeTotalFrames(timeline)] }
					: {}),
				note: "Word rows are [index, text, startFrame], in project frames. Pass indices to remove_words.",
			});
		},

		remove_words(args) {
			// How much of the pause around a word goes with it. "tight" keeps the
			// breath either side, "loose" takes it — the difference between a cut
			// that sounds deliberate and one that sounds clipped.
			const aggressiveness = asString(args.cutAggressiveness) ?? "balanced";
			if (!["tight", "balanced", "loose"].includes(aggressiveness)) {
				return fail(
					"invalid_argument",
					"cutAggressiveness must be tight, balanced, or loose.",
				);
			}
			const padFrames =
				aggressiveness === "loose" ? 2 : aggressiveness === "balanced" ? 1 : 0;

			const words = transcriptWords(timeline);
			if (words.length === 0) {
				return fail("no_transcript", "Nothing is captioned yet. Run add_captions first.");
			}

			const matches = asArray(args.matches).filter(
				(value): value is string => typeof value === "string",
			);
			const explicit = asArray(args.words);

			// Resolve either addressing mode down to one set of indices.
			const indices = new Set<number>();
			if (matches.length > 0) {
				const wanted = new Set(matches.map((m) => m.toLowerCase()));
				for (const word of words) {
					if (wanted.has(word.text.toLowerCase().replace(/[^a-z']/gi, ""))) {
						indices.add(word.index);
					}
				}
			} else if (explicit.length > 0) {
				for (const entry of explicit) {
					if (typeof entry === "number") indices.add(entry);
					else if (Array.isArray(entry) && entry.length === 2) {
						const [from, to] = entry as [number, number];
						for (let index = from; index <= to; index++) indices.add(index);
					}
				}
			} else {
				// Neither addressing mode given: the overwhelmingly common ask is
				// "drop the filler", so do that rather than refusing.
				for (const word of words) {
					if (isFiller(word.text)) indices.add(word.index);
				}
				if (indices.size === 0) {
					return ok({
						removed: 0,
						note: "No filler words found. Pass words (indices) or matches (tokens) to target something else.",
					});
				}
			}

			if (indices.size === 0) {
				return ok({ removed: 0, note: "Nothing matched; the timeline is unchanged." });
			}

			/**
			 * A word is removed from the cut, not only from the caption.
			 *
			 * Editing the caption text alone would leave every "um" audible with
			 * a subtitle that no longer admits it — the opposite of what filler
			 * removal is for. So the word's span is cut out of every track, and
			 * the captions are then rebuilt from the words that survived.
			 */
			const removed = words.filter((word) => indices.has(word.index));
			const survivors = words.filter((word) => !indices.has(word.index));
			const spans = mergeRanges(
				removed.map((word): [number, number] => [
					Math.max(0, word.startFrame - padFrames),
					word.endFrame + padFrames,
				]),
			);

			// How far a surviving word slides left: the total cut before it.
			const shiftAt = (frame: number) =>
				spans.reduce((sum, [from, to]) => (to <= frame ? sum + (to - from) : sum), 0);

			const groups = captionGroups(timeline);
			let removedFrames = 0;

			return mutate(
				"Remove words",
				(t) => {
					const cut = rippleDelete(t, spans);
					removedFrames = cut.removedFrames;
					let next = cut.timeline;

					// The ripple sliced the caption clips wherever it cut, leaving
					// halves whose text no longer matches. Rebuild them instead.
					for (const groupId of groups) next = removeCaptionGroup(next, groupId);

					const kept = survivors
						.map((word) => ({
							text: word.text,
							startMs:
								((word.startFrame - shiftAt(word.startFrame)) / next.fps) * 1000,
							endMs: ((word.endFrame - shiftAt(word.endFrame)) / next.fps) * 1000,
						}))
						.filter((word) => word.endMs > word.startMs)
						.sort((a, b) => a.startMs - b.startMs);

					if (kept.length === 0) return next;
					return placeCaptions(next, groupWordsIntoCues(kept), {
						groupId: groups[0] ?? `g${indices.size}`,
						toFrame: (sourceMs) => (sourceMs / 1000) * next.fps,
					}).timeline;
				},
				(next) => ({
					removed: indices.size,
					removedFrames,
					removedSeconds: Number((removedFrames / timeline.fps).toFixed(2)),
					cutAggressiveness: aggressiveness,
					paddingFrames: padFrames,
					wordsRemaining: survivors.length,
					totalFrames: computeTotalFrames(next),
					...(asString(args.language)
						? {
								languageNote:
									"`language` doesn't apply — matching is done against the transcript's own tokens, whatever language it is in.",
							}
						: {}),
					note: "The words were cut out of every track, not just the captions. Re-read get_transcript — indices have changed.",
				}),
			);
		},

		async remove_silence(args) {
			// Analysed against a clip's own audio, so the answer describes the
			// take being cut rather than the whole library.
			const clipId =
				asString(args.clipId) ??
				timeline.tracks
					.flatMap((track) => track.clips)
					.find((clip) => clip.mediaType === "audio" || clip.mediaType === "video")?.id;
			if (!clipId) return fail("no_target", "There is no clip with audio to analyse.");
			const clip = findClip(timeline, clipId);
			if (!clip) return fail("unknown_clip", `No clip '${clipId}'.`);

			const asset = state.assets.find((entry) => entry.id === clip.assetId);
			if (!asset) return fail("unknown_media", `'${clip.name}' has no source to analyse.`);
			const buffer = await decodeAudio(asset);
			if (!buffer) {
				return fail("no_audio", `'${asset.name}' carries no decodable audio track.`);
			}

			const spans = detectSilence(monoSamples(buffer), buffer.sampleRate, {
				thresholdDb: asNumber(args.thresholdDb) ?? undefined,
				minDurationSeconds: asNumber(args.minDurationSeconds) ?? undefined,
				paddingSeconds: asNumber(args.paddingSeconds) ?? undefined,
			});
			if (spans.length === 0) {
				return ok({ removed: 0, note: "No silence long enough to be worth cutting." });
			}

			// Source seconds → timeline frames, clamped to the clip's visible span.
			const toFrame = (seconds: number) =>
				clipSourceMsToFrame(clip, seconds * 1000, timeline.fps);
			const ranges = spans
				.map(([from, to]): [number, number] => [
					Math.round(Math.max(clip.startFrame, toFrame(from))),
					Math.round(Math.min(clip.endFrame, toFrame(to))),
				])
				.filter(([from, to]) => to > from);
			if (ranges.length === 0) {
				return ok({
					removed: 0,
					note: "Every silent span falls outside this clip's trimmed range.",
				});
			}

			if (args.preview === true) {
				return ok({
					preview: true,
					ranges,
					note: "Nothing was cut. Call again without preview, or pass these to ripple_delete_ranges.",
				});
			}

			let removedFrames = 0;
			return mutate(
				"Remove silence",
				(t) => {
					const outcome = rippleDelete(t, ranges);
					removedFrames = outcome.removedFrames;
					return outcome.timeline;
				},
				(next) => ({
					removed: ranges.length,
					removedFrames,
					removedSeconds: Number((removedFrames / timeline.fps).toFixed(2)),
					totalFrames: computeTotalFrames(next),
				}),
			);
		},

		async detect_beats(args) {
			const mediaRef = asString(args.mediaRef);
			if (!mediaRef) return fail("invalid_argument", "mediaRef is required.");
			const asset = state.assets.find((entry) => entry.id === mediaRef);
			if (!asset) return fail("unknown_media", `No asset '${mediaRef}'.`);
			if (asset.offline)
				return fail("media_offline", `'${asset.name}' has no source yet — import it.`);

			const buffer = await decodeAudio(asset);
			if (!buffer) {
				return fail("no_audio", `'${asset.name}' carries no decodable audio track.`);
			}

			const analysis = detectBeats(monoSamples(buffer), buffer.sampleRate);
			const from = asNumber(args.startSeconds) ?? -Infinity;
			const to = asNumber(args.endSeconds) ?? Infinity;
			const within = (seconds: number) => seconds >= from && seconds <= to;

			if (analysis.confidence < BEAT_CONFIDENCE_FLOOR) {
				return ok({
					bpm: 0,
					beats: [],
					downbeats: [],
					confidence: analysis.confidence,
					note: "No steady pulse found. This reads as speech or ambience rather than music.",
				});
			}

			return ok({
				bpm: analysis.bpm,
				confidence: analysis.confidence,
				beats: analysis.beats.filter(within),
				downbeats: analysis.downbeats.filter(within),
				note: "Source seconds. Timeline frame = startFrame + (beat × fps − trimStartFrame) / speed.",
			});
		},

		async denoise_audio(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			// A clip carries audio only if its asset does; text and stills never do.
			const carriesAudio = (id: string) => {
				const clip = findClip(timeline, id);
				if (!clip || clip.mediaType === "text" || clip.mediaType === "image") return false;
				const asset = state.assets.find((entry) => entry.id === clip.assetId);
				return Boolean(asset?.hasAudio);
			};
			const silent = clipIds.filter((id) => !carriesAudio(id));
			if (silent.length === clipIds.length) {
				return fail(
					"wrong_media_type",
					`Nothing there carries audio to denoise: ${silent.join(", ")}.`,
				);
			}
			const targets = clipIds.filter(carriesAudio);

			const enabled = args.enabled !== false;
			let strength = asNumber(args.strength);

			// "auto" measures the clip's own quiet passages rather than guessing.
			// One measurement covers the selection: a strength per clip would make
			// a single take's cuts sound different from each other.
			const measured: Array<{ clipId: string; floorDb: number }> = [];
			if (args.auto === true && enabled) {
				for (const id of targets) {
					const clip = findClip(timeline, id);
					const asset = state.assets.find((entry) => entry.id === clip?.assetId);
					if (!asset) continue;
					const buffer = await decodeAudio(asset);
					if (!buffer) continue;
					const profile = measureNoiseFloor(monoSamples(buffer), buffer.sampleRate);
					measured.push({ clipId: id, floorDb: profile.floorDb });
					strength = Math.max(strength ?? 0, suggestedDenoiseStrength(profile));
				}
				if (measured.length === 0) {
					return fail(
						"decode_failed",
						"Couldn't decode any of those clips to measure their noise floor. Pass an explicit strength instead.",
					);
				}
			}

			return mutate(
				"Denoise",
				(t) => {
					let next = setClipFlag(t, targets, "denoiseEnabled", enabled);
					if (strength !== null) {
						next = setClipNumber(next, targets, "denoiseStrength", strength);
					}
					return next;
				},
				(next) => ({
					...(silent.length ? { skipped: silent, reason: "no audio" } : {}),
					...(measured.length ? { measured } : {}),
					clips: targets.map((id) => {
						const clip = findClip(next, id);
						return clip
							? {
									id,
									denoise: clip.denoiseEnabled
										? { strength: clip.denoiseStrength }
										: false,
								}
							: { id, missing: true };
					}),
					note: enabled
						? "Rendr's denoise is spectral subtraction measured from the clip's own quiet passages — real processing, not a speech-enhancement model. It applies on playback and on export. measured reports the noise floor in dB below peak."
						: "Denoise removed.",
				}),
			);
		},

		async sync_clips(args) {
			const referenceClipId = asString(args.referenceClipId);
			if (!referenceClipId) return fail("invalid_argument", "referenceClipId is required.");
			const reference = findClip(timeline, referenceClipId);
			if (!reference) return fail("unknown_clip", `No clip '${referenceClipId}'.`);

			const targets = [
				...asArray(args.targetClipIds).filter(
					(value): value is string => typeof value === "string",
				),
				...(asString(args.targetClipId) ? [asString(args.targetClipId) as string] : []),
			];
			if (targets.length === 0)
				return fail("invalid_argument", "Pass targetClipId or targetClipIds.");
			const unknown = targets.filter((id) => !findClip(timeline, id));
			if (unknown.length) return fail("unknown_clip", `No clip: ${unknown.join(", ")}.`);

			const mode = asString(args.mode) ?? "auto";
			if (mode === "timecode") {
				return fail(
					"not_implemented",
					"Rendr doesn't read embedded source timecode — that needs a container parser it doesn't have. Use mode 'audio' or 'auto'.",
				);
			}

			const samplesFor = async (clip: ClipModel) => {
				const asset = state.assets.find((entry) => entry.id === clip.assetId);
				if (!asset) return null;
				const buffer = await decodeAudio(asset);
				return buffer ? { samples: monoSamples(buffer), rate: buffer.sampleRate } : null;
			};

			const anchor = await samplesFor(reference);
			if (!anchor) {
				return fail(
					"no_audio",
					`'${reference.name}' has no decodable audio, so there is nothing to align to.`,
				);
			}

			const minConfidence = asNumber(args.minConfidence) ?? 0.5;
			const searchWindow = asNumber(args.searchWindowSeconds) ?? undefined;
			const results: Array<{ clipId: string; offsetFrames: number; confidence: number }> = [];
			const refused: Array<{ clipId: string; reason: string }> = [];

			for (const clipId of targets) {
				const clip = findClip(timeline, clipId) as ClipModel;
				const target = await samplesFor(clip);
				if (!target) {
					refused.push({ clipId, reason: "No decodable audio to correlate." });
					continue;
				}
				if (target.rate !== anchor.rate) {
					// Envelopes are built at a fixed rate, so differing sample rates
					// are fine — but say so rather than leaving it implicit.
					refused.push({
						clipId,
						reason: `Sample rates differ (${anchor.rate} vs ${target.rate}); correlation is on the loudness envelope, so this is still valid.`,
					});
				}
				const sync = findSyncOffset(
					anchor.samples,
					target.samples,
					anchor.rate,
					searchWindow,
				);
				if (sync.confidence < minConfidence) {
					refused.push({
						clipId,
						reason: `Correlation confidence ${sync.confidence} is below ${minConfidence}. The two takes may not overlap.`,
					});
					continue;
				}
				// A positive offset means the target's content happens later in the
				// reference, so the clip has to move earlier by that much.
				results.push({
					clipId,
					offsetFrames: Math.round(sync.offsetSeconds * timeline.fps),
					confidence: sync.confidence,
				});
			}

			if (results.length === 0) {
				return fail(
					"weak_match",
					`Nothing aligned confidently enough.\n${refused.map((entry) => `${entry.clipId}: ${entry.reason}`).join("\n")}`,
				);
			}

			// Keep the group together if any target would land before frame 0.
			const landings = results.map(
				(entry) =>
					(findClip(timeline, entry.clipId) as ClipModel).startFrame + entry.offsetFrames,
			);
			const shiftedFrames = Math.max(0, -Math.min(...landings, 0));

			return mutate(
				"Sync clips",
				(t) => {
					let next = t;
					for (const entry of results) {
						const clip = findClip(next, entry.clipId);
						if (!clip) continue;
						next = moveClip(
							next,
							entry.clipId,
							clip.startFrame + entry.offsetFrames + shiftedFrames,
						);
					}
					if (shiftedFrames > 0) {
						const anchorClip = findClip(next, referenceClipId);
						if (anchorClip) {
							next = moveClip(
								next,
								referenceClipId,
								anchorClip.startFrame + shiftedFrames,
							);
						}
					}
					return next;
				},
				() => ({
					method: "audio",
					shiftedFrames,
					aligned: results,
					...(refused.length ? { refused } : {}),
				}),
			);
		},

		// ── Zoom suggestions ──────────────────────────────────────────

		suggest_zooms(args) {
			const clipId =
				asString(args.clipId) ??
				timeline.tracks
					.flatMap((track) => track.clips)
					.find((clip) => clip.mediaType === "video")?.id;
			if (!clipId) return fail("no_target", "There is no video clip to punch in on.");
			const clip = findClip(timeline, clipId);
			if (!clip) return fail("unknown_clip", `No clip '${clipId}'.`);

			if (state.cursorTelemetry.length === 0) {
				return ok({
					status: "no-telemetry",
					proposals: [],
					note: "This recording carries no cursor data — it was captured with cursor tracking off, or imported from elsewhere. Place zooms with add_zoom_regions instead.",
				});
			}

			const totalMs = ((clip.endFrame - clip.startFrame) * clip.speed * 1000) / timeline.fps;

			const startMs = asNumber(args.startMs) ?? 0;
			const endMs = asNumber(args.endMs) ?? totalMs;
			const maxRegions = Math.max(
				1,
				Math.min(32, Math.round(asNumber(args.maxRegions) ?? 12)),
			);

			const cut = autoZoomRegions(state.cursorTelemetry, {
				totalMs,
				// Never propose over a region that already exists.
				reserved: (clip.zoomRegions ?? []).map((region) => ({
					start: region.startMs,
					end: region.endMs,
				})),
				max: maxRegions,
			});

			const proposals = cut.filter(
				(region) => region.endMs > startMs && region.startMs < endMs,
			);

			return ok({
				status: proposals.length > 0 ? "ok" : "no-interactions",
				clipId,
				proposals,
				note:
					proposals.length === 0
						? "Nothing proposed — the pointer never settled anywhere or clicked during this take."
						: "Not applied. Pass the ones you want to add_zoom_regions. `reason` is 'click' or 'dwell' — a dwell is the pointer resting somewhere, which is most of what is worth zooming on.",
			});
		},

		async inspect_media(args) {
			if (args.wordTimestamps === true || asString(args.language)) {
				return fail(
					"not_supported",
					"inspect_media doesn't transcribe. Run add_captions on a clip of this asset, then get_transcript — that path gives word timings.",
				);
			}

			// A clipId inspects whatever asset that clip draws from, so an agent
			// holding a timeline id doesn't have to go back through get_timeline.
			const clipId = asString(args.clipId);
			const fromClip = clipId ? findClip(timeline, clipId) : null;
			if (clipId && !fromClip) return fail("unknown_clip", `No clip '${clipId}'.`);
			const mediaRef = asString(args.mediaRef) ?? fromClip?.assetId ?? null;
			const asset = state.assets.find((entry) => entry.id === mediaRef);
			if (!asset) return fail("unknown_media", `No asset '${mediaRef}'.`);

			const metadata = {
				id: asset.id,
				name: asset.name,
				type: asset.type,
				duration: formatDuration(asset.durationSeconds),
				durationSeconds: asset.durationSeconds,
				dimensions: asset.width > 0 ? [asset.width, asset.height] : undefined,
				hasAudio: asset.hasAudio,
				folder: asset.folder ?? null,
				hasCursorTelemetry: asset.hasCursorTelemetry ?? false,
				webcamAssetId: asset.webcamAssetId ?? null,
				isWebcam: asset.isWebcam ?? false,
				offline: asset.offline ?? false,
				...(fromClip ? { fromClip: fromClip.id } : {}),
			};

			// Sampling is opt-in: metadata is cheap, decoding frames is not.
			const wantsFrames =
				args.overview === true ||
				asNumber(args.maxFrames) !== null ||
				asNumber(args.startSeconds) !== null ||
				asNumber(args.endSeconds) !== null;
			if (!wantsFrames) {
				return ok({
					...metadata,
					note: "Metadata only. Pass overview:true or maxFrames to sample frames; for what is said, add_captions then get_transcript.",
				});
			}
			if (asset.type === "audio") {
				return fail("wrong_media_type", `'${asset.name}' is audio — there are no frames.`);
			}
			if (asset.offline) {
				return fail("media_offline", `'${asset.name}' has no source yet — import it.`);
			}

			const from = Math.max(0, asNumber(args.startSeconds) ?? 0);
			const to = Math.min(
				asset.durationSeconds || from,
				asNumber(args.endSeconds) ?? asset.durationSeconds,
			);
			const count = Math.max(1, Math.min(12, Math.round(asNumber(args.maxFrames) ?? 6)));

			const content: ToolResult["content"] = [];
			const sampled: number[] = [];
			for (let index = 0; index < count; index++) {
				// Sample at the middle of each slice rather than its edge, so the
				// first frame isn't the black one many files start on.
				const seconds = to > from ? from + ((index + 0.5) * (to - from)) / count : from;
				const frame = await renderAssetFrame(asset, seconds, 640);
				if (!frame) break;
				content.push({
					type: "image",
					data: canvasToBase64Png(frame.canvas),
					mimeType: "image/png",
				});
				sampled.push(Number(seconds.toFixed(2)));
			}
			if (content.length === 0) {
				return fail("render_failed", `No frame of '${asset.name}' could be decoded.`);
			}

			content.push({
				type: "text",
				text: JSON.stringify(
					{
						...metadata,
						sampledSeconds: sampled,
						note: "Raw source frames — no grade, transform or crop. For the composited cut, use inspect_timeline.",
					},
					null,
					2,
				),
			});
			return { content };
		},

		// ── Library ───────────────────────────────────────────────────

		search_media(args) {
			const query = asString(args.query);
			if (!query) return fail("invalid_argument", "query is required.");
			const scope = asString(args.scope) ?? "both";
			if (!["visual", "spoken", "both"].includes(scope)) {
				return fail("invalid_argument", "scope must be visual, spoken, or both.");
			}
			const limit = Math.max(1, Math.min(50, Math.round(asNumber(args.limit) ?? 10)));
			const only = asString(args.mediaRef);

			const terms = query
				.toLowerCase()
				.split(/[^a-z0-9']+/i)
				.filter((term) => term.length > 2);

			// Spoken hits come from the captions already on the timeline: that is
			// the only transcript this build has, and it is a real one.
			const spoken: Array<Record<string, unknown>> = [];
			if (scope !== "visual" && terms.length > 0) {
				const words = transcriptWords(timeline);
				for (const word of words) {
					const token = word.text.toLowerCase().replace(/[^a-z0-9']/gi, "");
					if (!terms.includes(token)) continue;
					const clip = findClip(timeline, word.clipId);
					if (!clip) continue;
					if (only && clip.assetId !== only) continue;
					const seconds = word.startFrame / timeline.fps;
					spoken.push({
						mediaRef: clip.assetId,
						clipId: clip.id,
						text: word.text,
						source: [Number(seconds.toFixed(2)), Number((seconds + 0.6).toFixed(2))],
					});
					if (spoken.length >= limit) break;
				}
			}

			// Names and folders are the only thing this build can match on for
			// picture; say so rather than implying the frames were looked at.
			const visual: Array<Record<string, unknown>> = [];
			if (scope !== "spoken") {
				for (const asset of state.assets) {
					if (only && asset.id !== only) continue;
					const haystack = `${asset.name} ${asset.folder ?? ""}`.toLowerCase();
					const score = terms.filter((term) => haystack.includes(term)).length;
					if (score === 0) continue;
					visual.push({
						mediaRef: asset.id,
						name: asset.name,
						type: asset.type,
						score,
						...(asset.durationSeconds > 0
							? { source: [0, Number(asset.durationSeconds.toFixed(2))] }
							: {}),
					});
					if (visual.length >= limit) break;
				}
				visual.sort((a, b) => (b.score as number) - (a.score as number));
			}

			return ok({
				visual,
				spoken,
				index: {
					status: "disabled",
					message:
						"This build has no on-device visual index, so 'visual' matches file and folder names only — not what is on screen. 'spoken' searches the captions already on the timeline; run add_captions first to widen it.",
				},
			});
		},

		async import_media(args) {
			const source = (args.source ?? {}) as Record<string, unknown>;
			const url = asString(source.url);
			const path = asString(source.path);
			const bytes = asString(source.bytes);
			const matte = source.matte as { hex?: string; aspectRatio?: string } | undefined;

			const modes = [url, path, bytes, matte].filter(Boolean);
			if (modes.length !== 1) {
				return fail(
					"invalid_argument",
					"source must set exactly one of url, path, bytes, or matte.",
				);
			}

			const folder = asString(args.folder) ?? undefined;
			let file: File | null = null;

			try {
				if (matte) {
					const hex = matte.hex ?? "#000000";
					if (!/^#[0-9a-f]{6}$/i.test(hex)) {
						return fail("invalid_argument", "matte.hex must look like '#000000'.");
					}
					const RATIOS: Record<string, number> = {
						Project: timeline.width / timeline.height,
						"16:9": 16 / 9,
						"9:16": 9 / 16,
						"1:1": 1,
						"4:3": 4 / 3,
						"9:14": 9 / 14,
						"2.4:1": 2.4,
					};
					const ratio = RATIOS[matte.aspectRatio ?? "Project"];
					if (!ratio)
						return fail(
							"invalid_argument",
							"matte.aspectRatio isn't one of the presets.",
						);
					const shortEdge =
						matte.aspectRatio && matte.aspectRatio !== "Project"
							? Math.min(timeline.width, timeline.height)
							: 0;
					const width =
						shortEdge === 0
							? timeline.width
							: Math.round(ratio >= 1 ? shortEdge * ratio : shortEdge);
					const height =
						shortEdge === 0
							? timeline.height
							: Math.round(ratio >= 1 ? shortEdge : shortEdge / ratio);

					const canvas = document.createElement("canvas");
					canvas.width = width;
					canvas.height = height;
					const context = canvas.getContext("2d");
					if (!context) return fail("render_failed", "Couldn't create the matte canvas.");
					context.fillStyle = hex;
					context.fillRect(0, 0, width, height);
					const blob = await canvasToPngBlob(canvas);
					if (!blob) return fail("render_failed", "Couldn't encode the matte.");
					file = new File([blob], `${asString(args.name) ?? `Matte ${hex}`}.png`, {
						type: "image/png",
					});
				} else if (url) {
					if (!url.startsWith("https://")) {
						return fail("invalid_argument", "url must be HTTPS.");
					}
					const response = await fetch(url);
					if (!response.ok) {
						return fail("download_failed", `${url} returned ${response.status}.`);
					}
					const blob = await response.blob();
					const inferred =
						asString(source.mimeType) ?? blob.type ?? "application/octet-stream";
					const filename =
						asString(args.name) ??
						decodeURIComponent(url.split("/").pop() ?? "download");
					file = new File([blob], filename, { type: inferred });
				} else if (path) {
					const bridge = window.electronAPI;
					if (!bridge?.readLocalFile) {
						return fail(
							"unsupported",
							"Local-path imports need Rendr's desktop bridge, which isn't available in this window.",
						);
					}
					const read = await bridge.readLocalFile(path);
					if (!read?.success || !read.data) {
						return fail("read_failed", read?.error ?? `Couldn't read '${path}'.`);
					}
					// A directory read fails above, so this is always one file.
					const name =
						asString(args.name) ?? path.split(/[\\/]/).pop() ?? "Imported file";
					file = new File([new Uint8Array(read.data)], name);
				} else if (bytes) {
					const mimeType = asString(source.mimeType);
					if (!mimeType)
						return fail("invalid_argument", "source.mimeType is required with bytes.");
					const binary = atob(bytes.replace(/^data:[^,]+,/, ""));
					const buffer = new Uint8Array(binary.length);
					for (let index = 0; index < binary.length; index++) {
						buffer[index] = binary.charCodeAt(index);
					}
					file = new File([buffer], asString(args.name) ?? "Imported asset", {
						type: mimeType,
					});
				}
			} catch (error) {
				return fail(
					"import_failed",
					error instanceof Error ? error.message : "The import failed.",
				);
			}

			if (!file) return fail("import_failed", "Nothing was produced to import.");

			const added = await api.importMedia([file]);
			if (added.length === 0) {
				return fail(
					"unsupported_type",
					`Rendr couldn't read '${file.name}'. Supported: ${SUPPORTED_SUMMARY}.`,
				);
			}
			if (folder)
				api.moveAssets(
					added.map((asset) => asset.id),
					folder,
				);

			const asset = added[0];
			return ok({
				mediaRef: asset.id,
				name: asset.name,
				type: asset.type,
				status: "ready",
				durationSeconds: asset.durationSeconds,
				dimensions: asset.width > 0 ? [asset.width, asset.height] : undefined,
				...(folder ? { folder } : {}),
				note: "Imports finish inline in Rendr — the asset is ready for add_clips now.",
			});
		},

		organize_media(args) {
			const createFolders = asArray(args.createFolders).filter(
				(value): value is string => typeof value === "string",
			);
			const moves = asArray(args.moves) as Array<Record<string, unknown>>;
			const renames = asArray(args.renames) as Array<Record<string, unknown>>;
			const deletes = asArray(args.deletes).filter(
				(value): value is string => typeof value === "string",
			);

			if (!createFolders.length && !moves.length && !renames.length && !deletes.length) {
				return fail("invalid_argument", "Pass createFolders, moves, renames, or deletes.");
			}

			// Resolved against the library as it was before the call, exactly as
			// the contract promises — so a move and a rename can't fight.
			const assetIds = new Set(state.assets.map((asset) => asset.id));
			const timelineIds = new Set(state.timelines.map((entry) => entry.id));
			const folders = new Set(state.assets.flatMap((asset) => folderChain(asset.folder)));

			const receipt = {
				createdFolders: [] as string[],
				moved: [] as string[],
				renamed: [] as string[],
				deleted: [] as string[],
				clipsRemoved: 0,
				warnings: [] as string[],
			};

			for (const path of createFolders) {
				if (!folders.has(path)) {
					folders.add(path);
					receipt.createdFolders.push(path);
				}
			}

			for (const move of moves) {
				const items = asArray(move.items).filter(
					(value): value is string => typeof value === "string",
				);
				const into = asString(move.into) ?? "";
				const assets = items.filter((item) => assetIds.has(item));
				const folderItems = items.filter((item) => folders.has(item));
				const unknown = items.filter(
					(item) => !assetIds.has(item) && !folders.has(item) && !timelineIds.has(item),
				);
				for (const item of unknown) {
					receipt.warnings.push(
						`'${item}' is neither an asset, a timeline, nor a folder.`,
					);
				}
				if (items.some((item) => timelineIds.has(item))) {
					receipt.warnings.push(
						"Rendr keeps timelines at the library root — timeline moves were ignored.",
					);
				}
				if (assets.length) {
					api.moveAssets(assets, into);
					receipt.moved.push(...assets);
				}
				for (const source of folderItems) {
					const leaf = source.split("/").pop() as string;
					const destination = into ? `${into}/${leaf}` : leaf;
					api.moveFolder(source, destination);
					receipt.moved.push(source);
				}
			}

			for (const rename of renames) {
				const item = asString(rename.item);
				const name = asString(rename.name);
				if (!item || !name) {
					receipt.warnings.push("A rename entry was missing item or name.");
					continue;
				}
				if (name.includes("/")) {
					receipt.warnings.push(`'${name}' is a path — renaming never moves.`);
					continue;
				}
				if (assetIds.has(item)) {
					api.renameAsset(item, name);
					receipt.renamed.push(item);
				} else if (timelineIds.has(item)) {
					api.renameTimeline(item, name);
					receipt.renamed.push(item);
				} else if (folders.has(item)) {
					const parent = item.split("/").slice(0, -1).join("/");
					api.moveFolder(item, parent ? `${parent}/${name}` : name);
					receipt.renamed.push(item);
				} else {
					receipt.warnings.push(`'${item}' doesn't exist, so it wasn't renamed.`);
				}
			}

			for (const item of deletes) {
				if (assetIds.has(item)) {
					receipt.clipsRemoved += timeline.tracks.reduce(
						(sum, track) =>
							sum + track.clips.filter((clip) => clip.assetId === item).length,
						0,
					);
					api.removeAsset(item);
					receipt.deleted.push(item);
				} else if (timelineIds.has(item)) {
					if (state.timelines.length <= 1) {
						receipt.warnings.push("The last remaining timeline can't be deleted.");
						continue;
					}
					api.removeTimeline(item);
					receipt.deleted.push(item);
				} else if (folders.has(item)) {
					const inside = state.assets.filter((asset) =>
						folderChain(asset.folder).includes(item),
					);
					for (const asset of inside) {
						receipt.clipsRemoved += timeline.tracks.reduce(
							(sum, track) =>
								sum +
								track.clips.filter((clip) => clip.assetId === asset.id).length,
							0,
						);
						api.removeAsset(asset.id);
					}
					receipt.deleted.push(item);
				} else {
					receipt.warnings.push(`'${item}' doesn't exist, so it wasn't deleted.`);
				}
			}

			return ok(receipt);
		},

		// ── Exports and projects ──────────────────────────────────────

		manage_exports(args) {
			const action = asString(args.action);
			if (action === "list") {
				const jobs = state.exports.map((job) => ({
					jobId: job.id,
					filename: job.filename,
					status: job.status,
					progress: Math.round(job.progress * 100),
					...(job.path ? { path: job.path } : {}),
					...(job.warning ? { warning: job.warning } : {}),
				}));
				return ok({
					jobs,
					note:
						jobs.length === 0
							? "No exports this session. Rendr renders in the editor window, so a job only exists while the app is open."
							: undefined,
				});
			}
			if (action === "cancel") {
				const jobId = asString(args.jobId);
				if (!jobId) return fail("invalid_argument", "cancel needs a jobId.");
				const job = state.exports.find((entry) => entry.id === jobId);
				if (!job) return fail("unknown_job", `No export job '${jobId}'.`);
				if (job.status !== "running" && job.status !== "queued") {
					return fail("not_cancellable", `'${jobId}' is already ${job.status}.`);
				}
				api.cancelExport(jobId);
				return ok({ jobId, status: "cancelling" });
			}
			return fail("invalid_argument", "action must be 'list' or 'cancel'.");
		},

		manage_project(args) {
			const action = asString(args.action);
			switch (action) {
				case "list":
					return ok({
						projects: [
							{
								name: state.projectName,
								active: true,
								visible: true,
								dirty: state.dirty,
								timelines: state.timelines.length,
								assets: state.assets.length,
							},
						],
						note: "Rendr edits one project per window and keeps no project registry on disk, so this lists the open one. To work on another, ask the user to open it from the File menu.",
					});
				case "create": {
					api.newProject();
					const name = asString(args.name);
					if (name) api.renameProject(name);
					const fps = asNumber(args.fps);
					const resolved = resolveResolution(timeline, {
						width: null,
						height: null,
						aspectRatio: asString(args.aspectRatio),
						quality: asString(args.quality),
					});
					if (!resolved.ok) return fail("invalid_argument", resolved.reason);
					if (fps !== null || resolved.width) {
						api.setProjectSettings({
							fps: fps ?? undefined,
							width: resolved.width,
							height: resolved.height,
						});
					}
					return ok({
						name: name ?? "Untitled Project",
						active: true,
						note: "A new, empty project replaced what was open. Nothing was written to disk yet.",
					});
				}
				case "close": {
					// One project per window, so a name/id/path can only mean the
					// open one — saying so beats silently saving something else.
					const targeted =
						asString(args.name) ?? asString(args.id) ?? asString(args.path);
					const mine =
						!targeted ||
						targeted === state.projectName ||
						targeted.endsWith(`${state.projectName}.rendr`);
					if (!mine) {
						return fail(
							"unknown_project",
							`This window has '${state.projectName}' open, and Rendr edits one project per window — it can't reach '${targeted}'.`,
						);
					}
					api.saveProject();
					return ok({
						saved: true,
						project: state.projectName,
						note: "The project was saved. Rendr can't close a window from a tool call — ask the user to close it.",
					});
				}
				case "open":
					return fail(
						"needs_user",
						`Opening a project reads a file from disk, which Rendr only does through the user's own File → Open${asString(args.path) ? ` — including '${asString(args.path)}'` : ""}. Ask them to open it, then retry.`,
					);
				default:
					return fail("invalid_argument", "action must be list, open, create, or close.");
			}
		},

		// ── Effects ───────────────────────────────────────────────────

		apply_effect(args) {
			const clipIds = asArray(args.clipIds).filter(
				(value): value is string => typeof value === "string",
			);
			const incoming = asArray(args.effects);
			const remove = asArray(args.remove).filter(
				(value): value is string => typeof value === "string",
			);

			// Reading the catalog is the documented no-argument call.
			if (incoming.length === 0 && remove.length === 0) {
				return ok({
					catalog: EFFECTS.map((definition) => ({
						type: definition.id,
						name: definition.displayName,
						params: definition.params,
					})),
					note: "Pass clipIds plus effects to apply any of these.",
				});
			}
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			const normalized: AppliedEffect[] = [];
			for (let index = 0; index < incoming.length; index++) {
				const raw = incoming[index] as Record<string, unknown>;
				const type = asString(raw.type);
				if (!type) return fail("invalid_argument", `effects[${index}] needs a type.`);
				const effect = normalizeEffect({
					type,
					params: (raw.params ?? {}) as Record<string, number>,
					enabled: raw.enabled !== false,
				});
				if (!effect) {
					return fail(
						"unknown_effect",
						`No effect '${type}'. This build offers:\n${effectCatalog()}`,
					);
				}
				normalized.push(effect);
			}

			const audioOnly = clipIds.every((id) => findClip(timeline, id)?.mediaType === "audio");
			if (audioOnly) {
				return fail(
					"wrong_media_type",
					"Effects are picture-only. For audio use denoise_audio, or set_clip_properties for level and fades.",
				);
			}

			return mutate(
				"Apply effect",
				(t) => setClipEffects(t, clipIds, normalized, remove),
				(next) => ({
					clips: clipIds.map((id) => {
						const clip = findClip(next, id);
						return clip ? { id, effects: clip.effects ?? [] } : { id, missing: true };
					}),
				}),
			);
		},

		// ── Layout ────────────────────────────────────────────────────

		apply_layout(args) {
			const layout = asString(args.layout) as LayoutName | null;
			if (!layout) return fail("invalid_argument", "layout is required.");
			let slots: Slot[];
			try {
				slots = slotsFor(layout);
			} catch {
				return fail("unknown_layout", `No layout '${layout}'.`);
			}
			if (!slots?.length) return fail("unknown_layout", `No layout '${layout}'.`);

			const entries = asArray(args.slots) as Array<Record<string, unknown>>;
			if (entries.length === 0)
				return fail("invalid_argument", "slots must be a non-empty array.");

			const bySlot = new Map<string, Record<string, unknown>>();
			for (const entry of entries) {
				const name = asString(entry.slot);
				if (!name) return fail("invalid_argument", "Every slot entry needs a slot name.");
				if (!slots.some((slot) => slot.name === name)) {
					return fail(
						"unknown_slot",
						`'${name}' isn't a slot of ${layout}. Slots: ${slotNames(layout).join(", ")}.`,
					);
				}
				bySlot.set(name, entry);
			}
			const unfilled = slots.filter((slot) => !bySlot.has(slot.name));
			if (unfilled.length) {
				return fail(
					"incomplete_layout",
					`${layout} needs every slot filled; missing ${unfilled.map((slot) => slot.name).join(", ")}.`,
				);
			}

			const placing = entries.some((entry) => asString(entry.mediaRef));
			const relayout = entries.some((entry) => asArray(entry.clipIds).length > 0);
			if (placing && relayout) {
				return fail(
					"invalid_argument",
					"Don't mix mediaRef and clipIds across slots — place new clips, or re-lay-out existing ones.",
				);
			}
			if (!placing && !relayout) {
				return fail("invalid_argument", "Each slot needs a mediaRef or clipIds.");
			}

			const fit = (asString(args.fit) ?? "fill") as LayoutFit;
			if (fit !== "fill" && fit !== "fit")
				return fail("invalid_argument", "fit must be 'fill' or 'fit'.");
			const canvasAspect = timeline.width / timeline.height;

			const framing = (entry: Record<string, unknown>) => {
				const anchor = asString(entry.anchor);
				const base = (anchor && ANCHORS[anchor]) || ANCHORS.center;
				return {
					anchorX: asNumber(entry.anchorX) ?? base.x,
					anchorY: asNumber(entry.anchorY) ?? base.y,
				};
			};

			if (relayout) {
				const placements = new Map<string, ReturnType<typeof placeInSlot>>();
				for (const slot of slots) {
					const entry = bySlot.get(slot.name) as Record<string, unknown>;
					const ids = asArray(entry.clipIds).filter(
						(value): value is string => typeof value === "string",
					);
					if (ids.length === 0) {
						return fail(
							"invalid_argument",
							`Slot '${slot.name}' has no clipIds; every slot must be filled the same way.`,
						);
					}
					for (const id of ids) {
						const clip = findClip(timeline, id);
						if (!clip) return fail("unknown_clip", `No clip '${id}'.`);
						placements.set(
							id,
							placeInSlot(slot, aspectOf(clip, canvasAspect), canvasAspect, {
								fit,
								...framing(entry),
							}),
						);
					}
				}
				return mutate(
					`Apply ${layout}`,
					(t) => layoutClips(t, placements),
					(next) => ({
						layout,
						fit,
						clips: [...placements.keys()].map((id) => {
							const clip = findClip(next, id);
							return clip ? describeClip(clip, next.fps) : { id, missing: true };
						}),
					}),
				);
			}

			// Placement mode: one stacked video track per slot, top slot last so
			// a PIP inset lands above the clip it sits on.
			const startFrame = Math.max(0, Math.round(asNumber(args.startFrame) ?? 0));
			const endFrame = asNumber(args.endFrame);
			if (endFrame === null || endFrame <= startFrame) {
				return fail(
					"invalid_argument",
					"Placing new clips needs an endFrame greater than startFrame.",
				);
			}

			for (const slot of slots) {
				const mediaRef = asString(
					(bySlot.get(slot.name) as Record<string, unknown>).mediaRef,
				);
				if (!mediaRef)
					return fail("invalid_argument", `Slot '${slot.name}' needs a mediaRef.`);
				const asset = state.assets.find((item) => item.id === mediaRef);
				if (!asset) return fail("unknown_media", `No asset '${mediaRef}'.`);
				if (asset.offline)
					return fail("media_offline", `'${asset.name}' has no source yet — import it.`);
			}

			const stamp = Date.now().toString(36);
			// The inset slot paints on top, which means it must sit on the track
			// that renders first — the editor draws index 0 topmost.
			const ordered = [...slots].sort(
				(a, b) => Number(b.onTop ?? false) - Number(a.onTop ?? false),
			);
			const created: string[] = [];

			return mutate(
				`Apply ${layout}`,
				(t) => {
					let next = t;
					ordered.forEach((slot, index) => {
						const entry = bySlot.get(slot.name) as Record<string, unknown>;
						const mediaRef = asString(entry.mediaRef) as string;
						const asset = state.assets.find((item) => item.id === mediaRef);
						const clipId = `clip-${layout}-${stamp}-${index}`;
						created.push(clipId);

						const placement = placeInSlot(
							slot,
							asset && asset.width > 0 && asset.height > 0
								? asset.width / asset.height
								: canvasAspect,
							canvasAspect,
							{ fit, ...framing(entry) },
						);

						const track = {
							id: `trk-${layout}-${stamp}-${index}`,
							name: slot.name,
							kind: "video" as const,
							muted: false,
							hidden: false,
							clips: [
								{
									...withDefaults({
										id: clipId,
										name: asset?.name ?? slot.name,
										mediaType: (asset?.type === "image"
											? "image"
											: "video") as ClipModel["mediaType"],
										startFrame,
										endFrame: Math.round(endFrame),
										assetId: mediaRef,
									}),
									transform: placement.transform,
									crop: placement.crop,
								},
							],
						};
						next = { ...next, tracks: [track, ...next.tracks] };
					});
					return next;
				},
				(next) => ({
					layout,
					fit,
					clips: created.map((id) => {
						const clip = findClip(next, id);
						return clip ? describeClip(clip, next.fps) : { id, missing: true };
					}),
				}),
			);
		},

		// ── Keyframes ─────────────────────────────────────────────────

		set_keyframes(args) {
			const clipId = asString(args.clipId);
			if (!clipId) return fail("invalid_argument", "clipId is required.");
			const clip = findClip(timeline, clipId);
			if (!clip) return fail("unknown_clip", `No clip '${clipId}'.`);

			const property = asString(args.property);
			if (!property || !isKeyframeProperty(property)) {
				return fail(
					"invalid_argument",
					`property must be one of ${Object.keys(KEYFRAME_ARITY).join(", ")}.`,
				);
			}
			if (!Array.isArray(args.keyframes)) {
				return fail(
					"invalid_argument",
					"keyframes must be an array (empty clears the track).",
				);
			}
			if (property === "volumeDb" && clip.mediaType === "text") {
				return fail("wrong_media_type", "Text clips carry no audio to animate.");
			}

			const parsed = parseKeyframeRows(property, args.keyframes);
			if (!parsed.ok) return fail("invalid_argument", parsed.reason);

			const duration = clip.endFrame - clip.startFrame;
			const outside = parsed.keyframes.filter(
				(keyframe) => keyframe.frame < 0 || keyframe.frame > duration,
			);

			return mutate(
				"Set keyframes",
				(t) => setClipKeyframes(t, clipId, property, parsed.keyframes),
				(next) => {
					const updated = findClip(next, clipId);
					return {
						clipId,
						property,
						keyframes: keyframeRows(updated?.keyframes?.[property] ?? []),
						animated: updated ? animatedProperties(updated) : [],
						...(outside.length
							? {
									warning: `${outside.length} keyframe(s) fall outside the clip's ${duration} frames and will hold at the nearest edge.`,
								}
							: {}),
					};
				},
			);
		},

		// ── Ripple edits ──────────────────────────────────────────────

		insert_clips(args) {
			const trackIndex = asNumber(args.trackIndex);
			if (trackIndex === null)
				return fail("invalid_argument", "trackIndex is required — ripple needs a track.");
			const track = timeline.tracks[Math.round(trackIndex)];
			if (!track) return fail("unknown_track", `No track at index ${trackIndex}.`);

			const atFrame = asNumber(args.atFrame);
			if (atFrame === null || atFrame < 0)
				return fail("invalid_argument", "atFrame must be a non-negative frame.");

			const entries = asArray(args.entries) as Array<Record<string, unknown>>;
			if (entries.length === 0)
				return fail("invalid_argument", "entries must be a non-empty array.");

			// Validate everything before anything moves.
			const planned: Array<{ assetId: string; name: string; frames: number; type: string }> =
				[];
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index];
				const mediaRef = asString(entry.mediaRef);
				if (!mediaRef)
					return fail("invalid_argument", `entries[${index}] needs a mediaRef.`);
				const asset = state.assets.find((item) => item.id === mediaRef);
				if (!asset) return fail("unknown_media", `No asset '${mediaRef}'.`);
				if (asset.offline)
					return fail("media_offline", `'${asset.name}' has no source yet — import it.`);

				const source = asArray(entry.source).map(asNumber);
				const explicit = asNumber(entry.durationFrames);
				if (source.length > 0 && explicit !== null) {
					return fail(
						"invalid_argument",
						`entries[${index}] sets both source and durationFrames; they're mutually exclusive.`,
					);
				}

				let frames: number;
				if (explicit !== null) frames = Math.round(explicit);
				else if (source.length === 2 && source[0] !== null && source[1] !== null) {
					frames = Math.round(
						((source[1] as number) - (source[0] as number)) * timeline.fps,
					);
				} else {
					frames = Math.round((asset.durationSeconds || 5) * timeline.fps);
				}
				if (frames < 2)
					return fail(
						"invalid_argument",
						`entries[${index}] resolves to ${frames} frames.`,
					);
				planned.push({ assetId: mediaRef, name: asset.name, frames, type: asset.type });
			}

			const total = planned.reduce((sum, entry) => sum + entry.frames, 0);
			const start = Math.round(atFrame);
			const stamp = Date.now().toString(36);
			const created: string[] = [];

			return mutate(
				"Insert clips",
				(t) => {
					// Split whatever spans the insertion point first: a clip the
					// gap opens inside has to become a head that stays and a tail
					// that moves, or the inserted footage lands on top of it.
					// Then open the gap across every track, so audio on another
					// track keeps its offset to the picture.
					let next = rippleShift(splitAt(t, start), start, total);
					let cursor = start;
					const clips = planned.map((entry, index) => {
						const id = `clip-ins-${stamp}-${index}`;
						created.push(id);
						const clip = withDefaults({
							id,
							name: entry.name,
							mediaType: (entry.type === "image"
								? "image"
								: entry.type === "audio"
									? "audio"
									: "video") as ClipModel["mediaType"],
							startFrame: cursor,
							endFrame: cursor + entry.frames,
							assetId: entry.assetId,
						});
						cursor += entry.frames;
						return clip;
					});
					next = {
						...next,
						tracks: next.tracks.map((entry) =>
							entry.id === track.id
								? {
										...entry,
										clips: [...entry.clips, ...clips].sort(
											(a, b) => a.startFrame - b.startFrame,
										),
									}
								: entry,
						),
					};
					return next;
				},
				(next) => ({
					inserted: created.length,
					rippledFrames: total,
					clips: created.map((id) => {
						const clip = findClip(next, id);
						return clip ? describeClip(clip, next.fps) : { id, missing: true };
					}),
				}),
			);
		},

		ripple_delete_ranges(args) {
			const rawRanges = asArray(args.ranges);
			if (rawRanges.length === 0)
				return fail("invalid_argument", "ranges must be a non-empty array.");

			const trackIndex = asNumber(args.trackIndex);
			const clipId = asString(args.clipId);
			if (trackIndex !== null && clipId) {
				return fail("invalid_argument", "Pass trackIndex or clipId, not both.");
			}

			const units = asString(args.units) ?? "frames";
			if (units !== "frames" && units !== "seconds")
				return fail("invalid_argument", "units must be 'frames' or 'seconds'.");
			if (units === "seconds" && !clipId) {
				return fail(
					"invalid_argument",
					"'seconds' addresses source time, so it needs a clipId.",
				);
			}

			const clip = clipId ? findClip(timeline, clipId) : null;
			if (clipId && !clip) return fail("unknown_clip", `No clip '${clipId}'.`);
			const track = trackIndex !== null ? timeline.tracks[Math.round(trackIndex)] : null;
			if (trackIndex !== null && !track)
				return fail("unknown_track", `No track at index ${trackIndex}.`);

			const ranges: Array<[number, number]> = [];
			for (let index = 0; index < rawRanges.length; index++) {
				const pair = asArray(rawRanges[index]).map(asNumber);
				if (pair.length !== 2 || pair[0] === null || pair[1] === null) {
					return fail(
						"invalid_argument",
						`ranges[${index}] must be [start, end] numbers.`,
					);
				}
				let [from, to] = pair as [number, number];
				if (units === "seconds" && clip) {
					// Source seconds → timeline frames, honouring trim and speed.
					const toFrame = (seconds: number) =>
						clip.startFrame +
						(seconds * timeline.fps - clip.trimStartFrame) / clip.speed;
					from = toFrame(from);
					to = toFrame(to);
				}
				if (clip) {
					from = Math.max(clip.startFrame, Math.min(clip.endFrame, from));
					to = Math.max(clip.startFrame, Math.min(clip.endFrame, to));
				}
				if (to > from) ranges.push([Math.round(from), Math.round(to)]);
			}
			if (ranges.length === 0) {
				return ok({ changed: false, note: "Every range was empty after clamping." });
			}

			const exemptIndices = asArray(args.ignoreSyncLockedTracks)
				.map(asNumber)
				.filter((value): value is number => value !== null);
			const exemptTrackIds = exemptIndices
				.map((index) => timeline.tracks[Math.round(index)]?.id)
				.filter((value): value is string => Boolean(value));

			const anchor =
				track ?? timeline.tracks.find((entry) => entry.clips.some((c) => c.id === clipId));
			let removedFrames = 0;

			const result = mutate(
				"Ripple delete",
				(t) => {
					const outcome = rippleDelete(t, ranges, {
						trackId: clip ? anchor?.id : undefined,
						exemptTrackIds,
					});
					removedFrames = outcome.removedFrames;
					return outcome.timeline;
				},
				(next) => {
					const resulting = next.tracks.find((entry) => entry.id === anchor?.id);
					return {
						ranges: ranges.length,
						removedFrames,
						totalFrames: computeTotalFrames(next),
						track: resulting
							? {
									name: resulting.name,
									clips: resulting.clips.map((entry) => ({
										id: entry.id,
										frames: [entry.startFrame, entry.endFrame],
									})),
								}
							: undefined,
					};
				},
			);

			/*
			 * Move the notes with the cut.
			 *
			 * A ripple that shifted the clips but left the notes behind leaves
			 * every note after the cut pointing at the wrong moment — and a
			 * review note that points at the wrong frame is worse than no note,
			 * because it looks authoritative. Shifted from the earliest range, by
			 * everything the cut removed.
			 */
			if (removedFrames > 0 && state.comments.length > 0) {
				const from = Math.min(...ranges.map(([startFrame]) => startFrame));
				for (const moved of shiftComments(state.comments, from, -removedFrames)) {
					const before = state.comments.find((entry) => entry.id === moved.id);
					if (before && before.frame !== moved.frame) {
						api.updateComment(moved.id, { frame: moved.frame });
					}
				}
			}

			return result;
		},

		// ── Timelines and project settings ────────────────────────────

		create_timeline(args) {
			const from = asString(args.from);
			if (from && !state.timelines.some((entry) => entry.id === from)) {
				return fail(
					"unknown_timeline",
					`No timeline '${from}'. Call get_media to list them.`,
				);
			}
			const created = api.createTimeline({
				name: asString(args.name) ?? undefined,
				from: from ?? undefined,
			});
			if (!created) return fail("failed", "The timeline couldn't be created.");
			return ok({
				timelineId: created.id,
				name: created.name,
				fps: created.fps,
				resolution: [created.width, created.height],
				active: true,
				note: from
					? "Every clip and track id in the copy is new — re-read get_timeline before editing."
					: "This timeline is now active and empty.",
			});
		},

		set_active_timeline(args) {
			const timelineId = asString(args.timelineId);
			if (!timelineId) return fail("invalid_argument", "timelineId is required.");
			if (!api.setActiveTimeline(timelineId)) {
				return fail(
					"unknown_timeline",
					`No timeline '${timelineId}'. get_media lists them under 'timelines'.`,
				);
			}
			return ok({
				timelineId,
				note: "Re-read get_timeline; ids from the previous timeline are no longer valid.",
			});
		},

		set_project_settings(args) {
			const fps = asNumber(args.fps);
			const width = asNumber(args.width);
			const height = asNumber(args.height);
			const aspectRatio = asString(args.aspectRatio);
			const quality = asString(args.quality);

			if (aspectRatio && (width !== null || height !== null)) {
				return fail(
					"invalid_argument",
					"aspectRatio and explicit width/height are mutually exclusive.",
				);
			}
			if ((width === null) !== (height === null)) {
				return fail("invalid_argument", "Pass width and height together.");
			}
			if (fps === null && width === null && !aspectRatio && !quality) {
				return fail("invalid_argument", "Pass fps, width+height, aspectRatio, or quality.");
			}
			if (fps !== null && (fps < 1 || fps > 120)) {
				return fail("invalid_argument", "fps must be between 1 and 120.");
			}

			const resolved = resolveResolution(timeline, { width, height, aspectRatio, quality });
			if (!resolved.ok) return fail("invalid_argument", resolved.reason);

			const before = { fps: timeline.fps, width: timeline.width, height: timeline.height };
			api.setProjectSettings({
				fps: fps ?? undefined,
				width: resolved.width,
				height: resolved.height,
			});
			return ok({
				fps: fps ?? before.fps,
				resolution: [resolved.width ?? before.width, resolved.height ?? before.height],
				previous: [before.fps, before.width, before.height],
				note:
					fps !== null && fps !== before.fps
						? "Frame rate changed — every clip's frames, trims, and fades were rescaled to hold their timing."
						: "Transforms are normalised, so clips keep their framing at the new size.",
			});
		},

		// ── Looking at the picture ────────────────────────────────────

		async inspect_timeline(args) {
			const total = computeTotalFrames(timeline);
			const startFrame = Math.max(0, Math.round(asNumber(args.startFrame) ?? 0));
			const endFrame = asNumber(args.endFrame);
			const maxFrames = Math.max(1, Math.min(12, Math.round(asNumber(args.maxFrames) ?? 6)));

			const frames: number[] = [];
			if (endFrame !== null && endFrame > startFrame) {
				const span = Math.round(endFrame) - startFrame;
				const count = Math.min(maxFrames, span);
				for (let index = 0; index < count; index++) {
					frames.push(startFrame + Math.floor((span * index) / count));
				}
			} else {
				frames.push(startFrame);
			}

			const content: ToolResult["content"] = [];
			const rendered: Array<Record<string, unknown>> = [];
			for (const frame of frames) {
				// 720 on the long edge is plenty to judge framing and reads well
				// as an image part without inflating the response.
				const result = await renderFrameToCanvas(
					timeline,
					state.assets,
					frame,
					720,
					overlays(),
				);
				if (!result) {
					return fail(
						"render_failed",
						"This build can't provide a canvas to render into.",
					);
				}
				stampFrameNumber(result.canvas, frame);
				content.push({
					type: "image",
					data: canvasToBase64Png(result.canvas),
					mimeType: "image/png",
				});
				rendered.push({
					frame,
					pastContent: frame >= total,
					visibleClips: timeline.tracks
						.filter((track) => track.kind === "video" && !track.hidden)
						.flatMap((track) =>
							track.clips
								.filter((clip) => frame >= clip.startFrame && frame < clip.endFrame)
								.map((clip) => clip.captionGroupId ?? clip.id),
						),
				});
			}

			content.push({
				type: "text",
				text: JSON.stringify(
					{
						fps: timeline.fps,
						resolution: [timeline.width, timeline.height],
						totalFrames: total,
						frames: rendered,
						note: "visibleClips are listed top-down, as they stack in the preview.",
					},
					null,
					2,
				),
			});
			return { content };
		},

		async capture_frame(args) {
			const timelineFrame = asNumber(args.timelineFrame);
			const mediaRef = asString(args.mediaRef);
			if ((timelineFrame === null) === (mediaRef === null)) {
				return fail(
					"invalid_argument",
					"Pass exactly one of timelineFrame (composited) or mediaRef (raw source).",
				);
			}

			let canvas: HTMLCanvasElement | null = null;
			let label: string;
			if (timelineFrame !== null) {
				const result = await renderFrameToCanvas(
					timeline,
					state.assets,
					Math.round(timelineFrame),
					undefined,
					overlays(),
				);
				canvas = result?.canvas ?? null;
				label = asString(args.name) ?? `Frame ${Math.round(timelineFrame)}`;
			} else {
				const asset = state.assets.find((entry) => entry.id === mediaRef);
				if (!asset) return fail("unknown_media", `No asset '${mediaRef}'.`);
				if (asset.type === "audio")
					return fail(
						"wrong_media_type",
						`'${asset.name}' is audio — there is no frame.`,
					);
				const seconds = asNumber(args.sourceSeconds) ?? 0;
				const result = await renderAssetFrame(asset, seconds, Number.MAX_SAFE_INTEGER);
				canvas = result?.canvas ?? null;
				label = asString(args.name) ?? `${asset.name} @ ${seconds.toFixed(2)}s`;
			}
			if (!canvas) return fail("render_failed", "That frame couldn't be decoded.");

			const blob = await canvasToPngBlob(canvas);
			if (!blob) return fail("render_failed", "The frame rendered but couldn't be encoded.");

			const file = new File([blob], `${label.replace(/[^\w. -]/g, "")}.png`, {
				type: "image/png",
			});
			const added = await api.importMedia([file]);
			const asset = added[0];
			if (!asset)
				return fail("failed", "The frame was rendered but couldn't enter the library.");

			return ok({
				mediaRef: asset.id,
				name: asset.name,
				dimensions: [asset.width, asset.height],
				note: "Ready for add_clips or inspect_media.",
			});
		},

		async inspect_color(args) {
			const clipId = asString(args.clipId);
			const mediaRef = asString(args.mediaRef);
			if ((clipId === null) === (mediaRef === null)) {
				return fail("invalid_argument", "Pass exactly one of clipId or mediaRef.");
			}

			const measure = async (target: {
				clipId?: string;
				mediaRef?: string;
				atFrame?: number;
			}): Promise<
				| { ok: true; scopes: ReturnType<typeof measureScopes>; canvas: HTMLCanvasElement }
				| { ok: false; reason: string }
			> => {
				if (target.clipId) {
					const clip = findClip(timeline, target.clipId);
					if (!clip) return { ok: false, reason: `No clip '${target.clipId}'.` };
					const frame =
						target.atFrame ?? Math.floor((clip.startFrame + clip.endFrame) / 2);
					// Measuring one clip means measuring it alone: the stack above
					// it would otherwise be what the numbers describe.
					const isolated: TimelineModel = {
						...timeline,
						tracks: timeline.tracks.map((track) => ({
							...track,
							hidden: false,
							clips: track.clips.filter((entry) => entry.id === clip.id),
						})),
					};
					// Deliberately without the overlays: this measures the
					// picture's colour, and a white pointer or a camera bubble
					// would pull the scopes toward a grade nobody made.
					const result = await renderFrameToCanvas(isolated, state.assets, frame, 640);
					if (!result) return { ok: false, reason: "Couldn't render that frame." };
					const context = result.canvas.getContext("2d", { willReadFrequently: true });
					if (!context) return { ok: false, reason: "Couldn't read the rendered frame." };
					const pixels = context.getImageData(0, 0, result.width, result.height).data;
					return { ok: true, scopes: measureScopes(pixels), canvas: result.canvas };
				}

				const asset = state.assets.find((entry) => entry.id === target.mediaRef);
				if (!asset) return { ok: false, reason: `No asset '${target.mediaRef}'.` };
				if (asset.type === "audio")
					return { ok: false, reason: `'${asset.name}' is audio — it has no colour.` };
				const result = await renderAssetFrame(asset, asset.durationSeconds / 2, 640);
				if (!result)
					return { ok: false, reason: `Couldn't decode a frame of '${asset.name}'.` };
				const context = result.canvas.getContext("2d", { willReadFrequently: true });
				if (!context) return { ok: false, reason: "Couldn't read the decoded frame." };
				const pixels = context.getImageData(0, 0, result.width, result.height).data;
				return { ok: true, scopes: measureScopes(pixels), canvas: result.canvas };
			};

			const atFrame = asNumber(args.atFrame);
			const subject = await measure({
				clipId: clipId ?? undefined,
				mediaRef: mediaRef ?? undefined,
				atFrame: atFrame !== null ? Math.round(atFrame) : undefined,
			});
			if (!subject.ok) return fail("measure_failed", subject.reason);

			const payload: Record<string, unknown> = {
				subject: clipId ? { clipId } : { mediaRef },
				scopes: subject.scopes,
				hueBins: HUE_BIN_NAMES,
			};

			const referenceId = asString(args.reference);
			if (referenceId) {
				const reference = await measure({ mediaRef: referenceId });
				if (!reference.ok) return fail("measure_failed", reference.reason);
				payload.reference = { mediaRef: referenceId, scopes: reference.scopes };
				payload.gap = compareScopes(subject.scopes, reference.scopes);
			}

			return {
				content: [
					{
						type: "image",
						data: canvasToBase64Png(subject.canvas),
						mimeType: "image/png",
					},
					{ type: "text", text: JSON.stringify(payload, null, 2) },
				],
			};
		},

		// ── Arranging clips in time ───────────────────────────────────────
		//
		// All five movers go through `placeAt`, so a clip's duration is
		// structurally incapable of changing here. Only where it sits does.

		find_gaps(args) {
			const only = asString(args.trackId);
			const min = Math.max(1, Math.round(asNumber(args.minFrames) ?? 1));
			if (only && !timeline.tracks.some((track) => track.id === only))
				return fail("unknown_track", `No track '${only}'.`);

			const gaps: Array<Record<string, unknown>> = [];
			for (const track of timeline.tracks) {
				if (only && track.id !== only) continue;
				const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
				let cursor = 0;
				for (const clip of sorted) {
					if (clip.startFrame - cursor >= min) {
						gaps.push({
							trackId: track.id,
							trackName: track.name,
							startFrame: cursor,
							endFrame: clip.startFrame,
							frames: clip.startFrame - cursor,
							seconds: Number(((clip.startFrame - cursor) / timeline.fps).toFixed(3)),
							// A gap at the head is worth calling out separately: it
							// renders as background from frame 0, which reads as a
							// broken export rather than an edit.
							...(cursor === 0 ? { leading: true } : {}),
							before: clip.name,
						});
					}
					cursor = Math.max(cursor, clip.endFrame);
				}
			}
			return ok({
				gaps,
				totalGapFrames: gaps.reduce((sum, gap) => sum + (gap.frames as number), 0),
				note: gaps.length
					? "close_gaps removes these. Gaps render as the project background."
					: "No gaps — every track runs continuously from frame 0.",
			});
		},

		close_gaps(args) {
			const only = asString(args.trackId);
			const keepLeading = args.keepLeadingGap === true;
			const min = Math.max(1, Math.round(asNumber(args.minFrames) ?? 1));
			if (only && !timeline.tracks.some((track) => track.id === only))
				return fail("unknown_track", `No track '${only}'.`);

			const moves = new Map<string, number>();
			const reclaimed: Array<Record<string, unknown>> = [];
			for (const track of timeline.tracks) {
				if (only && track.id !== only) continue;
				const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
				let cursor = 0;
				let saved = 0;
				for (const [index, clip] of sorted.entries()) {
					if (index === 0 && keepLeading) {
						cursor = clip.endFrame;
						continue;
					}
					const gap = clip.startFrame - cursor;
					if (gap >= min) {
						saved += gap;
						moves.set(clip.id, clip.startFrame - saved);
					} else if (saved > 0) {
						moves.set(clip.id, clip.startFrame - saved);
					}
					cursor = Math.max(cursor, clip.endFrame - saved);
				}
				if (saved > 0)
					reclaimed.push({
						trackId: track.id,
						trackName: track.name,
						framesRemoved: saved,
						seconds: Number((saved / timeline.fps).toFixed(3)),
					});
			}
			if (moves.size === 0)
				return ok({ changed: false, note: "No gaps long enough to close." });

			return mutate(
				"Close gaps",
				(t) => placeAt(t, moves),
				() => ({
					clipsMoved: moves.size,
					tracks: reclaimed,
					note: "Each track was closed independently, so picture and sound only stay in sync if both tracks were included.",
				}),
			);
		},

		align_clips(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length < 2)
				return fail("invalid_argument", "clipIds needs at least two clips.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			const edge = asString(args.edge) ?? "start";
			if (edge !== "start" && edge !== "end")
				return fail("invalid_argument", "edge must be 'start' or 'end'.");

			const frame = asNumber(args.frame);
			const referenceId = asString(args.referenceClipId);
			if ((frame === null) === (referenceId === null))
				return fail("invalid_argument", "Pass exactly one of frame or referenceClipId.");

			let target: number;
			if (referenceId !== null) {
				const reference = findClip(timeline, referenceId);
				if (!reference) return fail("unknown_clip", `No clip '${referenceId}'.`);
				target = edge === "start" ? reference.startFrame : reference.endFrame;
			} else {
				target = Math.round(frame ?? 0);
			}
			if (target < 0) return fail("invalid_argument", "A clip cannot start before frame 0.");

			const moves = new Map<string, number>();
			for (const id of clipIds) {
				if (id === referenceId) continue;
				const clip = findClip(timeline, id);
				if (!clip) continue;
				const start =
					edge === "start" ? target : target - (clip.endFrame - clip.startFrame);
				if (start < 0)
					return fail(
						"invalid_argument",
						`Aligning '${clip.name}' by its end would start it at frame ${start}, before the timeline begins. Align by 'start', or pick a later target.`,
					);
				moves.set(id, start);
			}
			if (moves.size === 0)
				return ok({ changed: false, note: "Only the reference clip was listed." });

			return mutate(
				"Align clips",
				(t) => placeAt(t, moves),
				(next) => ({
					aligned: moves.size,
					edge,
					atFrame: target,
					...overlapNote(next, [...moves.keys()]),
				}),
			);
		},

		distribute_clips(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length < 2)
				return fail("invalid_argument", "clipIds needs at least two clips.");
			const clips = clipIds.map((id) => findClip(timeline, id));
			const missing = clipIds.filter((_, index) => !clips[index]);
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			// Ordered by where they are now, so the result preserves the sequence
			// the caller can see rather than the order they happened to type.
			const ordered = (clips as ClipModel[])
				.slice()
				.sort((a, b) => a.startFrame - b.startFrame);
			const spacing = asNumber(args.spacingFrames);
			const moves = new Map<string, number>();

			if (spacing !== null) {
				const gap = Math.round(spacing);
				let cursor = ordered[0].startFrame;
				for (const clip of ordered) {
					moves.set(clip.id, cursor);
					cursor += clip.endFrame - clip.startFrame + gap;
				}
			} else {
				if (ordered.length < 3)
					return fail(
						"invalid_argument",
						"Even distribution needs three clips — the first and last are anchors. For two clips, pass spacingFrames.",
					);
				const first = ordered[0];
				const last = ordered[ordered.length - 1];
				const span = last.endFrame - first.startFrame;
				const used = ordered.reduce(
					(sum, clip) => sum + (clip.endFrame - clip.startFrame),
					0,
				);
				const slack = span - used;
				if (slack < 0)
					return fail(
						"invalid_argument",
						`These clips total ${used} frames but only span ${span}, so they already overlap and there is nothing to distribute. Move the last clip later first.`,
					);
				const gap = slack / (ordered.length - 1);
				let cursor = first.startFrame;
				for (const clip of ordered) {
					moves.set(clip.id, Math.round(cursor));
					cursor += clip.endFrame - clip.startFrame + gap;
				}
			}

			return mutate(
				"Distribute clips",
				(t) => placeAt(t, moves),
				(next) => ({
					distributed: moves.size,
					mode: spacing !== null ? `fixed ${Math.round(spacing)}-frame gaps` : "even",
					...overlapNote(next, [...moves.keys()]),
				}),
			);
		},

		stagger_clips(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length < 2)
				return fail("invalid_argument", "clipIds needs at least two clips.");
			const clips = clipIds.map((id) => findClip(timeline, id));
			if (clips.some((clip) => !clip))
				return fail(
					"unknown_clip",
					`No clip: ${clipIds.filter((_, i) => !clips[i]).join(", ")}.`,
				);
			const offset = asNumber(args.offsetFrames);
			if (offset === null) return fail("invalid_argument", "offsetFrames is required.");

			const ordered = (clips as ClipModel[])
				.slice()
				.sort((a, b) => a.startFrame - b.startFrame);
			const moves = new Map<string, number>();
			for (const [index, clip] of ordered.entries()) {
				const start = clip.startFrame + Math.round(offset) * index;
				if (start < 0)
					return fail(
						"invalid_argument",
						`A stagger of ${Math.round(offset)} would put '${clip.name}' at frame ${start}, before the timeline begins.`,
					);
				if (index > 0) moves.set(clip.id, start);
			}
			if (moves.size === 0)
				return ok({ changed: false, note: "An offset of 0 moves nothing." });

			return mutate(
				"Stagger clips",
				(t) => placeAt(t, moves),
				(next) => ({
					staggered: moves.size,
					offsetFrames: Math.round(offset),
					...overlapNote(next, [...moves.keys()]),
				}),
			);
		},

		copy_clip_style(args) {
			const sourceId = asString(args.sourceClipId);
			if (!sourceId) return fail("invalid_argument", "sourceClipId is required.");
			const source = findClip(timeline, sourceId);
			if (!source) return fail("unknown_clip", `No clip '${sourceId}'.`);

			const targets = stringList(args.targetClipIds).filter((id) => id !== sourceId);
			if (targets.length === 0)
				return fail("invalid_argument", "targetClipIds must name at least one other clip.");
			const missing = targets.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			// transform and crop carry layout, which is nearly always per-clip —
			// copying them by default would silently undo apply_layout.
			const requested = stringList(args.include);
			const parts = new Set(
				requested.length
					? requested
					: ["color", "effects", "opacity", "blendMode", "edges", "textStyle"],
			);
			const unknown = [...parts].filter(
				(part) =>
					![
						"color",
						"effects",
						"opacity",
						"blendMode",
						"edges",
						"transform",
						"crop",
						"textStyle",
					].includes(part),
			);
			if (unknown.length)
				return fail("invalid_argument", `Unknown include: ${unknown.join(", ")}.`);

			const skippedText: string[] = [];
			const apply = (t: TimelineModel): TimelineModel =>
				mapClips(t, targets, (clip) => {
					const next = { ...clip };
					if (parts.has("color")) next.color = { ...source.color };
					if (parts.has("effects"))
						next.effects = source.effects ? source.effects.map((e) => ({ ...e })) : [];
					if (parts.has("opacity")) next.opacity = source.opacity;
					if (parts.has("blendMode")) next.blendMode = source.blendMode;
					if (parts.has("edges")) {
						next.edgeRounding = source.edgeRounding;
						next.edgeSoftness = source.edgeSoftness;
					}
					if (parts.has("transform")) next.transform = { ...source.transform };
					if (parts.has("crop")) next.crop = { ...source.crop };
					if (parts.has("textStyle")) {
						// Typography on a video clip does nothing, and silently
						// attaching it would leave a clip claiming a style it
						// cannot render.
						if (source.textStyle && clip.mediaType === "text")
							next.textStyle = { ...source.textStyle };
						else if (source.textStyle) skippedText.push(clip.name);
					}
					return next;
				});

			return mutate("Copy clip style", apply, () => ({
				from: source.name,
				styled: targets.length,
				copied: [...parts],
				...(skippedText.length
					? {
							warnings: [
								`Text style was not copied to ${skippedText.length} non-text clip(s): ${skippedText.join(", ")}.`,
							],
						}
					: {}),
			}));
		},

		// ── Looks, stills, and measurement ────────────────────────────────

		save_look(args) {
			const name = asString(args.name)?.trim();
			if (!name) return fail("invalid_argument", "name is required.");
			const clipId = asString(args.clipId);
			if (!clipId) return fail("invalid_argument", "clipId is required.");
			const clip = findClip(timeline, clipId);
			if (!clip) return fail("unknown_clip", `No clip '${clipId}'.`);

			const replacing = findLook(state.looks, name);
			const look = api.saveLook({
				id: freshLookId(),
				name,
				grade: structuredClone(clip.color),
				createdAt: new Date().toISOString(),
				sourceClip: clip.name,
			});
			return ok({
				lookId: look.id,
				name: look.name,
				from: clip.name,
				graded: isGraded(clip.color),
				...(replacing ? { replaced: replacing.id } : {}),
				note: isGraded(clip.color)
					? "Saved with the project. apply_look puts it on other clips."
					: "Saved, but this clip has no grade on it — the look is neutral and applying it will clear a target's grade.",
			});
		},

		apply_look(args) {
			const wanted = asString(args.look);
			if (!wanted) return fail("invalid_argument", "look is required.");
			const look = findLook(state.looks, wanted);
			if (!look)
				return fail(
					"unknown_look",
					state.looks.length
						? `No look '${wanted}'. Saved: ${state.looks.map((entry) => entry.name).join(", ")}.`
						: `No look '${wanted}' — nothing is saved yet. Use save_look first.`,
				);
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			// Replaces rather than merges: a look half-applied over a leftover
			// grade is not the look, and is not reproducible from its name.
			return mutate(
				`Apply look ${look.name}`,
				(t) =>
					mapClips(t, clipIds, (clip) => ({
						...clip,
						color: structuredClone(look.grade),
					})),
				() => ({
					look: look.name,
					graded: clipIds.length,
					note: "The whole grade was replaced. apply_color adjusts from here.",
				}),
			);
		},

		manage_looks(args) {
			const action = asString(args.action) ?? "list";
			const describe = (look: LookModel) => ({
				id: look.id,
				name: look.name,
				...(look.createdAt ? { savedAt: look.createdAt } : {}),
				...(look.sourceClip ? { from: look.sourceClip } : {}),
			});

			if (action === "list") {
				return ok({
					looks: sortLooks(state.looks).map(describe),
					note: state.looks.length
						? "apply_look takes a name or an id."
						: "Nothing saved yet — save_look stores a clip's grade under a name.",
				});
			}

			const wanted = asString(args.look);
			if (!wanted) return fail("invalid_argument", `look is required for '${action}'.`);
			const look = findLook(state.looks, wanted);
			if (!look) return fail("unknown_look", `No look '${wanted}'.`);

			if (action === "delete") {
				api.removeLook(look.id);
				return ok({
					deleted: look.name,
					remaining: state.looks.length - 1,
					note: "Clips graded with it keep their grade — applying a look copies values onto the clip.",
				});
			}
			if (action === "rename") {
				const name = asString(args.name)?.trim();
				if (!name) return fail("invalid_argument", "name is required for a rename.");
				const clash = findLook(state.looks, name);
				if (clash && clash.id !== look.id)
					return fail(
						"name_taken",
						`'${name}' is already a look. Delete it first, or pick another name.`,
					);
				api.renameLook(look.id, name);
				return ok({ renamed: look.name, to: name });
			}
			return fail("invalid_argument", `Unknown action '${action}'.`);
		},

		async add_freeze_frame(args) {
			const frame = asNumber(args.frame);
			if (frame === null) return fail("invalid_argument", "frame is required.");
			const at = Math.max(0, Math.round(frame));
			const hold = Math.max(1, Math.round(asNumber(args.durationFrames) ?? 30));

			const requested = asString(args.trackId);
			// Topmost video track by default: a still inserted under the take
			// would be saved, inserted, and invisible.
			const track = requested
				? timeline.tracks.find((entry) => entry.id === requested)
				: [...timeline.tracks].reverse().find((entry) => entry.kind === "video");
			if (!track)
				return fail(
					requested ? "unknown_track" : "no_video_track",
					requested ? `No track '${requested}'.` : "This timeline has no video track.",
				);
			if (track.kind !== "video")
				return fail("wrong_track_type", `'${track.name}' is not a video track.`);

			const rendered = await renderFrameToCanvas(
				timeline,
				state.assets,
				at,
				undefined,
				overlays(),
			);
			if (!rendered?.canvas)
				return fail("render_failed", `Frame ${at} couldn't be rendered.`);
			const blob = await canvasToPngBlob(rendered.canvas);
			if (!blob) return fail("render_failed", "The frame rendered but couldn't be encoded.");

			const added = await api.importMedia([
				new File([blob], `Freeze ${at}.png`, { type: "image/png" }),
			]);
			const asset = added[0];
			if (!asset)
				return fail("failed", "The frame was rendered but couldn't enter the library.");

			// Ripple first so the still lands in space that is actually empty;
			// inserting then rippling would push the still along with everything
			// else and leave it somewhere other than the frame asked for.
			return mutate(
				"Add freeze frame",
				(t) => {
					// A clip spanning the freeze point has to be cut, or the
					// still is laid over footage that keeps playing underneath
					// and the picture never actually holds. Splitting first is
					// what makes the ripple land in real empty space.
					const split = splitAt(t, at);
					// Everything pauses, not just this track: the still is a
					// composite of every track, so leaving the others running
					// would desync picture from sound for the length of the hold.
					const shifted = rippleShift(split, at, hold);
					return {
						...shifted,
						tracks: shifted.tracks.map((entry) =>
							entry.id !== track.id
								? entry
								: {
										...entry,
										clips: [
											...entry.clips,
											withDefaults({
												id: `freeze-${asset.id}-${at}`,
												name: `Freeze ${at}`,
												mediaType: "image",
												assetId: asset.id,
												startFrame: at,
												endFrame: at + hold,
											}),
										].sort((a, b) => a.startFrame - b.startFrame),
									},
						),
					};
				},
				() => ({
					mediaRef: asset.id,
					frame: at,
					durationFrames: hold,
					trackId: track.id,
					note: `Any clip crossing frame ${at} was split, and everything from there moved ${hold} frames later on every track, so picture and sound stay together. The still has the zoom, colour, text, and captions of that frame baked in.`,
				}),
			);
		},

		async find_scene_changes(args) {
			const end = computeTotalFrames(timeline);
			const from = Math.max(0, Math.round(asNumber(args.startFrame) ?? 0));
			const to = Math.min(end, Math.round(asNumber(args.endFrame) ?? end));
			const step = Math.max(1, Math.round(asNumber(args.stepFrames) ?? 5));
			const threshold = Math.min(1, Math.max(0, asNumber(args.threshold) ?? 0.18));
			const includeZooms = args.includeZoomRegions === true;
			if (to <= from) return fail("invalid_argument", "endFrame must be after startFrame.");

			const samples = Math.floor((to - from) / step);
			if (samples > 400)
				return fail(
					"too_many_frames",
					`That range needs ${samples} full composites at step ${step}. Raise stepFrames or narrow the range — 400 is the ceiling.`,
				);

			// A punch-in produces the same delta as a cut, so zoomed spans are
			// excluded unless asked for; otherwise every zoom reads as an edit.
			const zoomed: Array<[number, number]> = [];
			if (!includeZooms) {
				for (const track of timeline.tracks) {
					for (const clip of track.clips) {
						for (const region of clip.zoomRegions ?? []) {
							const base = clip.startFrame;
							zoomed.push([
								base + Math.floor((region.startMs / 1000) * timeline.fps) - step,
								base + Math.ceil((region.endMs / 1000) * timeline.fps) + step,
							]);
						}
					}
				}
			}
			const inZoom = (frame: number) =>
				zoomed.some(([start, stop]) => frame >= start && frame <= stop);

			const changes: Array<Record<string, unknown>> = [];
			let previous: ReturnType<typeof measureScopes> | null = null;
			let previousFrame = from;
			let skipped = 0;
			for (let frame = from; frame < to; frame += step) {
				const rendered = await renderFrameToCanvas(
					timeline,
					state.assets,
					frame,
					undefined,
					overlays(),
				);
				if (!rendered?.canvas) continue;
				const context = rendered.canvas.getContext("2d");
				if (!context) continue;
				const scopes = measureScopes(
					context.getImageData(0, 0, rendered.canvas.width, rendered.canvas.height).data,
				);
				if (previous) {
					const delta = sceneDistance(compareScopes(previous, scopes));
					if (delta >= threshold) {
						if (inZoom(frame)) skipped += 1;
						else
							changes.push({
								frame,
								seconds: Number((frame / timeline.fps).toFixed(3)),
								difference: Number(delta.toFixed(3)),
								afterFrame: previousFrame,
							});
					}
				}
				previous = scopes;
				previousFrame = frame;
			}

			return ok({
				changes,
				sampled: samples,
				stepFrames: step,
				threshold,
				...(skipped
					? {
							note: `${skipped} change(s) inside zoom regions were excluded — a punch-in looks exactly like a cut. Pass includeZoomRegions to see them.`,
						}
					: {}),
				hint: changes.length
					? "Pass these frames to split_clips to cut on them."
					: "Nothing crossed the threshold. Lower it, or reduce stepFrames.",
			});
		},

		async measure_audio(args) {
			const target = asNumber(args.targetDb) ?? -16;
			const asked = stringList(args.clipIds);
			const audible = timeline.tracks
				.flatMap((track) => track.clips.map((clip) => ({ track, clip })))
				.filter(
					({ track, clip }) =>
						(clip.mediaType === "audio" || clip.mediaType === "video") &&
						!track.muted &&
						(asked.length === 0 || asked.includes(clip.id)),
				);
			if (asked.length) {
				const missing = asked.filter((id) => !findClip(timeline, id));
				if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);
			}
			if (audible.length === 0)
				return ok({
					clips: [],
					note: "Nothing to measure — no unmuted audio or video clips matched.",
				});

			const rows: Array<Record<string, unknown>> = [];
			for (const { track, clip } of audible) {
				const asset = state.assets.find((entry) => entry.id === clip.assetId);
				if (!asset || asset.offline) {
					rows.push({
						clipId: clip.id,
						name: clip.name,
						measured: false,
						reason: asset
							? "Media is offline — relink the file to measure it."
							: "This clip has no asset.",
					});
					continue;
				}
				const decoded = await decodeAudio(asset);
				if (!decoded) {
					rows.push({
						clipId: clip.id,
						name: clip.name,
						measured: false,
						reason: "No decodable audio stream.",
					});
					continue;
				}
				const samples = monoSamples(decoded);
				const loudness = measureLoudness(samples, decoded.sampleRate);
				const suggestion = normalizationGainDb(loudness, target);
				rows.push({
					clipId: clip.id,
					name: clip.name,
					trackName: track.name,
					programDb: Number(loudness.programDb.toFixed(1)),
					peakDbfs: Number(loudness.peakDb.toFixed(1)),
					activeRatio: Number(loudness.activeRatio.toFixed(2)),
					currentGainDb: clip.volumeDb,
					suggestedGainDb: Number(suggestion.gainDb.toFixed(1)),
					...(suggestion.limitedBy === "peak"
						? {
								limitedBy: "peak",
								shortfallDb: Number(suggestion.shortfallDb.toFixed(1)),
							}
						: {}),
					measured: true,
				});
			}

			const measured = rows.filter((row) => row.measured);
			const spread = measured.length
				? Math.max(...measured.map((row) => row.programDb as number)) -
					Math.min(...measured.map((row) => row.programDb as number))
				: 0;
			return ok({
				clips: rows,
				targetDb: target,
				...(measured.length > 1 ? { loudnessSpreadDb: Number(spread.toFixed(1)) } : {}),
				note:
					spread > 6
						? `These clips vary by ${spread.toFixed(1)} dB, which is audible as a jump between them. normalize_audio evens it out.`
						: "Nothing was changed. normalize_audio applies the suggested gains.",
			});
		},

		// ── Motion and colour ─────────────────────────────────────────────

		add_ken_burns(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			const direction = asString(args.direction) ?? "in";
			if (!["in", "out", "left", "right", "up", "down"].includes(direction))
				return fail("invalid_argument", `Unknown direction '${direction}'.`);
			const amount = Math.min(1, Math.max(0, asNumber(args.amount) ?? 0.12));
			if (amount === 0) return ok({ changed: false, note: "An amount of 0 is not a move." });
			const focusX = Math.min(1, Math.max(0, asNumber(args.focusX) ?? 0.5));
			const focusY = Math.min(1, Math.max(0, asNumber(args.focusY) ?? 0.5));

			const zooming = direction === "in" || direction === "out";
			// A pan needs the picture oversized, or it slides its own edge into
			// frame and shows background — the move would read as a glitch.
			const headroom = zooming ? 1 + amount : 1 + Math.max(amount, 0.08);
			const startScale = direction === "out" ? headroom : 1;
			const endScale = direction === "out" ? 1 : headroom;
			const pan = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[direction] ?? [
				0, 0,
			];
			// Normalized canvas units: 0.5 is the centre, so a full-frame travel
			// is 1.0 and `amount` reads as a fraction of the frame.
			const startX = zooming ? 0.5 : 0.5 - (pan[0] * amount) / 2;
			const startY = zooming ? 0.5 : 0.5 - (pan[1] * amount) / 2;
			const endX = zooming ? 0.5 + (focusX - 0.5) * amount : 0.5 + (pan[0] * amount) / 2;
			const endY = zooming ? 0.5 + (focusY - 0.5) * amount : 0.5 + (pan[1] * amount) / 2;

			return mutate(
				"Ken Burns",
				(t) =>
					mapClips(t, clipIds, (clip) => {
						const last = Math.max(1, clip.endFrame - clip.startFrame - 1);
						return {
							...clip,
							// Scale is oversized for the whole move, so the clip
							// never shows its own edge mid-travel.
							transform: { ...clip.transform },
							keyframes: {
								...clip.keyframes,
								// Replaced, not merged: two competing moves on one
								// clip is not a move anybody asked for.
								scale: [
									{
										frame: 0,
										values: [startScale, startScale],
										interp: "smooth",
									},
									{ frame: last, values: [endScale, endScale], interp: "smooth" },
								],
								position: [
									{ frame: 0, values: [startX, startY], interp: "smooth" },
									{ frame: last, values: [endX, endY], interp: "smooth" },
								],
							},
						};
					}),
				() => ({
					animated: clipIds.length,
					direction,
					amount,
					note: `Scale runs ${startScale.toFixed(2)}→${endScale.toFixed(2)} with a smooth ease. Any position or scale keyframes these clips had were replaced.`,
				}),
			);
		},

		crop_clips(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			if (args.reset === true) {
				return mutate(
					"Reset crop",
					(t) => setClipCrop(t, clipIds, { top: 0, right: 0, bottom: 0, left: 0 }),
					() => ({ reset: clipIds.length }),
				);
			}

			const patch: Record<string, number> = {};
			for (const side of ["top", "right", "bottom", "left"] as const) {
				const value = asNumber(args[side]);
				if (value === null) continue;
				if (value < 0 || value >= 1)
					return fail("invalid_argument", `${side} must be 0 or more and less than 1.`);
				patch[side] = value;
			}
			if (Object.keys(patch).length === 0)
				return fail("invalid_argument", "Pass at least one of top, right, bottom, left.");

			// Merged against each clip's existing crop, so a call setting only
			// `top` cannot be validated against zero for the other three.
			for (const id of clipIds) {
				const clip = findClip(timeline, id);
				if (!clip) continue;
				const merged = { ...clip.crop, ...patch };
				if (merged.left + merged.right >= 1)
					return fail(
						"invalid_argument",
						`On '${clip.name}' left + right would be ${(merged.left + merged.right).toFixed(2)}, leaving no picture.`,
					);
				if (merged.top + merged.bottom >= 1)
					return fail(
						"invalid_argument",
						`On '${clip.name}' top + bottom would be ${(merged.top + merged.bottom).toFixed(2)}, leaving no picture.`,
					);
			}

			return mutate(
				"Crop clips",
				(t) => setClipCrop(t, clipIds, patch),
				() => ({
					cropped: clipIds.length,
					applied: patch,
					note: "The remaining picture keeps its size and position — use apply_layout or a transform to fill the frame.",
				}),
			);
		},

		add_motion_preset(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);
			const preset = asString(args.preset);
			if (!preset || !["slide", "pop", "fade", "drift"].includes(preset))
				return fail("invalid_argument", "preset must be slide, pop, fade, or drift.");
			const at = asString(args.at) ?? "in";
			if (at !== "in" && at !== "out")
				return fail("invalid_argument", "at must be 'in' or 'out'.");
			const edge = asString(args.from) ?? "bottom";
			if (!["left", "right", "top", "bottom"].includes(edge))
				return fail("invalid_argument", `Unknown edge '${edge}'.`);
			const wanted = Math.max(1, Math.round(asNumber(args.durationFrames) ?? 12));

			const offset = { left: [-0.5, 0], right: [0.5, 0], top: [0, -0.5], bottom: [0, 0.5] }[
				edge
			] ?? [0, 0.5];

			return mutate(
				`Motion ${preset} ${at}`,
				(t) =>
					mapClips(t, clipIds, (clip) => {
						const span = clip.endFrame - clip.startFrame;
						// Half the clip at most, so an entrance and an exit added
						// separately can never run into each other.
						const move = Math.max(1, Math.min(wanted, Math.floor(span / 2)));
						const startAt = at === "in" ? 0 : Math.max(0, span - 1 - move);
						const endAt = at === "in" ? move : Math.max(1, span - 1);
						const restX = clip.transform.centerX;
						const restY = clip.transform.centerY;
						const offX = restX + offset[0];
						const offY = restY + offset[1];
						const next = { ...clip, keyframes: { ...clip.keyframes } };

						if (preset === "slide" || preset === "drift") {
							const travel = preset === "drift" ? 0.12 : 1;
							const awayX = restX + offset[0] * travel;
							const awayY = restY + offset[1] * travel;
							next.keyframes.position =
								at === "in"
									? [
											{
												frame: startAt,
												values: [awayX, awayY],
												interp: "smooth",
											},
											{
												frame: endAt,
												values: [restX, restY],
												interp: "smooth",
											},
										]
									: [
											{
												frame: startAt,
												values: [restX, restY],
												interp: "smooth",
											},
											{
												frame: endAt,
												values: [awayX, awayY],
												interp: "smooth",
											},
										];
							if (preset === "slide") {
								next.keyframes.opacity =
									at === "in"
										? [
												{ frame: startAt, values: [0], interp: "linear" },
												{
													frame: endAt,
													values: [clip.opacity],
													interp: "linear",
												},
											]
										: [
												{
													frame: startAt,
													values: [clip.opacity],
													interp: "linear",
												},
												{ frame: endAt, values: [0], interp: "linear" },
											];
							}
						} else if (preset === "pop") {
							next.keyframes.scale =
								at === "in"
									? [
											{
												frame: startAt,
												values: [0.6, 0.6],
												interp: "smooth",
											},
											{ frame: endAt, values: [1, 1], interp: "smooth" },
										]
									: [
											{ frame: startAt, values: [1, 1], interp: "smooth" },
											{ frame: endAt, values: [0.6, 0.6], interp: "smooth" },
										];
							next.keyframes.opacity =
								at === "in"
									? [
											{ frame: startAt, values: [0], interp: "linear" },
											{
												frame: endAt,
												values: [clip.opacity],
												interp: "linear",
											},
										]
									: [
											{
												frame: startAt,
												values: [clip.opacity],
												interp: "linear",
											},
											{ frame: endAt, values: [0], interp: "linear" },
										];
						} else {
							next.keyframes.opacity =
								at === "in"
									? [
											{ frame: startAt, values: [0], interp: "linear" },
											{
												frame: endAt,
												values: [clip.opacity],
												interp: "linear",
											},
										]
									: [
											{
												frame: startAt,
												values: [clip.opacity],
												interp: "linear",
											},
											{ frame: endAt, values: [0], interp: "linear" },
										];
						}
						// unused when the offsets are zero, but kept honest
						void offX;
						void offY;
						return next;
					}),
				() => ({
					animated: clipIds.length,
					preset,
					at,
					...(preset === "slide" || preset === "drift" ? { from: edge } : {}),
					note: "The move is clamped to half the clip, so an entrance and an exit never overlap.",
				}),
			);
		},

		async auto_color(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);
			const strength = Math.min(1, Math.max(0, asNumber(args.strength) ?? 1));

			const referenceId = asString(args.referenceClipId);
			let reference: ReturnType<typeof measureScopes> | null = null;
			if (referenceId) {
				if (!findClip(timeline, referenceId))
					return fail("unknown_clip", `No clip '${referenceId}'.`);
				const measured = await scopesForClip(referenceId);
				if (!measured.ok) return fail("render_failed", measured.reason);
				reference = measured.scopes;
			}

			const applied: Array<Record<string, unknown>> = [];
			const patches = new Map<string, Partial<ClipModel["color"]>>();
			for (const id of clipIds) {
				if (id === referenceId) continue;
				const clip = findClip(timeline, id);
				if (!clip) continue;
				const measured = await scopesForClip(id);
				if (!measured.ok) {
					applied.push({
						clipId: id,
						name: clip.name,
						corrected: false,
						reason: measured.reason,
					});
					continue;
				}
				const target = reference ?? NEUTRAL_SCOPES;
				const gap = compareScopes(measured.scopes, target);
				if (!worthCorrecting(gap)) {
					applied.push({
						clipId: id,
						name: clip.name,
						corrected: false,
						reason: referenceId
							? "Already matches the reference closely enough that a grade would not be visible."
							: "Already close enough to neutral that a grade would not be visible.",
					});
					continue;
				}
				const wanted = correctionFor(gap, {
					exposure: clip.color.exposure,
					contrast: clip.color.contrast,
					saturation: clip.color.saturation,
					temperature: clip.color.temperature,
					tint: clip.color.tint,
				});
				// Strength interpolates from where the clip is now, so 0.5 really
				// is half the correction rather than half the absolute value.
				const mix = (from: number, to: number) =>
					Number((from + (to - from) * strength).toFixed(3));
				const patch = {
					exposure: mix(clip.color.exposure, wanted.exposure),
					contrast: mix(clip.color.contrast, wanted.contrast),
					saturation: mix(clip.color.saturation, wanted.saturation),
					temperature: Math.round(mix(clip.color.temperature, wanted.temperature)),
					tint: mix(clip.color.tint, wanted.tint),
				};
				patches.set(id, patch);
				applied.push({ clipId: id, name: clip.name, corrected: true, ...patch });
			}

			if (patches.size === 0)
				return ok({
					changed: false,
					clips: applied,
					note: "Nothing needed correcting. worthCorrecting refuses a grade too small to see rather than reporting a change nobody can perceive.",
				});

			return mutate(
				"Auto colour",
				(t) => {
					let next = t;
					for (const [id, patch] of patches) next = setClipColor(next, [id], patch);
					return next;
				},
				() => ({
					corrected: patches.size,
					toward: referenceId ? findClip(timeline, referenceId)?.name : "neutral",
					strength,
					clips: applied,
					note: "apply_color adjusts from here.",
				}),
			);
		},

		async apply_lut(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			if (args.remove === true) {
				return mutate(
					"Remove LUT",
					(t) =>
						mapClips(t, clipIds, (clip) => {
							const { lut, lutAmount, ...rest } = clip.color;
							void lut;
							void lutAmount;
							return { ...clip, color: rest as ClipModel["color"] };
						}),
					() => ({
						removed: clipIds.length,
						note: "The rest of the grade is untouched.",
					}),
				);
			}

			const path = asString(args.path);
			const inline = asString(args.lutText);
			if ((path === null) === (inline === null))
				return fail("invalid_argument", "Pass exactly one of path or lutText.");

			let text = inline ?? "";
			if (path) {
				const bridge =
					typeof window === "undefined" ? undefined : window.electronAPI?.readLut;
				if (!bridge)
					return fail(
						"unavailable",
						"This build can't read files from disk. Pass the LUT's contents as lutText instead.",
					);
				const read = await bridge(path);
				if (!read.ok) return fail("read_failed", read.reason);
				text = read.text;
			}

			let lut: ReturnType<typeof parseCubeLut>;
			try {
				lut = parseCubeLut(text);
			} catch (error) {
				// A malformed cube renders as garbage rather than failing, so the
				// parse error is the only chance to say what is wrong.
				return fail(
					"invalid_lut",
					error instanceof LutParseError
						? error.message
						: `That file isn't a readable .cube LUT: ${String(error)}`,
				);
			}
			const amount = Math.min(1, Math.max(0, asNumber(args.amount) ?? 1));

			return mutate(
				"Apply LUT",
				(t) => setClipColor(t, clipIds, { lut, lutAmount: amount }),
				() => ({
					graded: clipIds.length,
					size: lut.size,
					amount,
					...(path ? { from: path } : {}),
					note: "The LUT runs after exposure and contrast, so the other knobs still apply.",
				}),
			);
		},

		reset_grade(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);
			const alsoEffects = args.includeEffects === true;

			return mutate(
				"Reset grade",
				(t) =>
					mapClips(t, clipIds, (clip) => ({
						...clip,
						// Rebuilt from defaults rather than patched, so curves,
						// balance, hue curves and the LUT go too — patching the
						// numeric knobs would leave those silently applied.
						color: { ...withDefaults({ ...clip, color: undefined as never }).color },
						...(alsoEffects ? { effects: [] } : {}),
					})),
				() => ({
					reset: clipIds.length,
					includedEffects: alsoEffects,
					note: "Curves, colour balance, hue curves and any LUT were cleared too.",
				}),
			);
		},

		async check_color_consistency(args) {
			const asked = stringList(args.clipIds);
			const tolerance = Math.max(0, asNumber(args.tolerance) ?? 0.08);
			const candidates = timeline.tracks
				.flatMap((track) => track.clips)
				.filter(
					(clip) =>
						(clip.mediaType === "video" || clip.mediaType === "image") &&
						(asked.length === 0 || asked.includes(clip.id)),
				);
			if (asked.length) {
				const missing = asked.filter((id) => !findClip(timeline, id));
				if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);
			}
			if (candidates.length < 2)
				return fail(
					"not_enough_clips",
					"Consistency needs at least two picture clips to compare.",
				);

			const measured: Array<{ clip: ClipModel; scopes: ReturnType<typeof measureScopes> }> =
				[];
			const unreadable: Array<Record<string, unknown>> = [];
			for (const clip of candidates) {
				const result = await scopesForClip(clip.id);
				if (result.ok) measured.push({ clip, scopes: result.scopes });
				else unreadable.push({ clipId: clip.id, name: clip.name, reason: result.reason });
			}
			if (measured.length < 2)
				return fail(
					"not_enough_clips",
					`Only ${measured.length} clip(s) could be measured. ${unreadable.map((row) => row.reason).join(" ")}`,
				);

			// The median rather than the mean: one badly wrong clip would drag a
			// mean toward itself and make the good clips look like the outliers.
			const median = (values: number[]) => {
				const sorted = [...values].sort((a, b) => a - b);
				return sorted[Math.floor(sorted.length / 2)];
			};
			const pick = (read: (scopes: Scopes) => number) =>
				median(measured.map((entry) => read(entry.scopes)));
			const middle: Scopes = {
				...measured[0].scopes,
				meanLuma: pick((s) => s.meanLuma),
				blackPoint: pick((s) => s.blackPoint),
				whitePoint: pick((s) => s.whitePoint),
				saturation: pick((s) => s.saturation),
				warmCool: pick((s) => s.warmCool),
				greenMagenta: pick((s) => s.greenMagenta),
				mean: {
					r: pick((s) => s.mean.r),
					g: pick((s) => s.mean.g),
					b: pick((s) => s.mean.b),
				},
			};

			const rows = measured
				.map(({ clip, scopes }) => {
					const gap = compareScopes(scopes, middle);
					return {
						clipId: clip.id,
						name: clip.name,
						distance: Number(sceneDistance(gap).toFixed(3)),
						exposureGap: Number(gap.exposure.toFixed(3)),
						contrastGap: Number(gap.contrast.toFixed(3)),
						saturationGap: Number(gap.saturation.toFixed(3)),
						warmCoolGap: Number(gap.warmCool.toFixed(3)),
						outlier: sceneDistance(gap) > tolerance,
					};
				})
				.sort((a, b) => b.distance - a.distance);

			const outliers = rows.filter((row) => row.outlier);
			return ok({
				clips: rows,
				outliers: outliers.length,
				tolerance,
				...(unreadable.length ? { notMeasured: unreadable } : {}),
				note: outliers.length
					? `${outliers.map((row) => row.name).join(", ")} sit furthest from the middle. auto_color with referenceClipId set to one of the matching clips will bring them in.`
					: "Every clip sits within tolerance of the middle.",
			});
		},

		// ── Audio ─────────────────────────────────────────────────────────

		fade_audio(args) {
			const clipIds = stringList(args.clipIds);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must be a non-empty array.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			const fadeIn = asNumber(args.fadeInFrames);
			const fadeOut = asNumber(args.fadeOutFrames);
			const shape = asString(args.shape);
			if (fadeIn === null && fadeOut === null && shape === null)
				return fail(
					"invalid_argument",
					"Pass at least one of fadeInFrames, fadeOutFrames, or shape.",
				);
			if (shape !== null && !["linear", "equalPower", "smooth"].includes(shape))
				return fail("invalid_argument", `Unknown shape '${shape}'.`);
			if ((fadeIn ?? 0) < 0 || (fadeOut ?? 0) < 0)
				return fail("invalid_argument", "Fade lengths cannot be negative.");

			// A fade pair longer than the clip would ramp down before it finished
			// ramping up, which is a dip rather than a fade.
			const tooLong: string[] = [];
			for (const id of clipIds) {
				const clip = findClip(timeline, id);
				if (!clip) continue;
				const span = clip.endFrame - clip.startFrame;
				const wantIn = fadeIn ?? clip.fadeInFrames;
				const wantOut = fadeOut ?? clip.fadeOutFrames;
				if (wantIn + wantOut > span) tooLong.push(`${clip.name} (${span} frames)`);
			}
			if (tooLong.length)
				return fail(
					"invalid_argument",
					`The fades would be longer than the clip on: ${tooLong.join(", ")}. Shorten them or trim less.`,
				);

			return mutate(
				"Fade audio",
				(t) => {
					let next = t;
					if (fadeIn !== null)
						next = setClipTiming(next, clipIds, "fadeInFrames", Math.round(fadeIn));
					if (fadeOut !== null)
						next = setClipTiming(next, clipIds, "fadeOutFrames", Math.round(fadeOut));
					if (shape !== null) {
						next = setClipFadeShape(
							next,
							clipIds,
							"fadeInInterpolation",
							shape as FadeInterpolation,
						);
						next = setClipFadeShape(
							next,
							clipIds,
							"fadeOutInterpolation",
							shape as FadeInterpolation,
						);
					}
					return next;
				},
				() => ({
					faded: clipIds.length,
					...(fadeIn !== null ? { fadeInFrames: Math.round(fadeIn) } : {}),
					...(fadeOut !== null ? { fadeOutFrames: Math.round(fadeOut) } : {}),
					...(shape ? { shape } : {}),
					note: "On picture a fade ramps opacity; on sound it ramps gain. Fades multiply existing keyframes rather than replacing them.",
				}),
			);
		},

		async find_silence(args) {
			const clipId = asString(args.clipId);
			if (!clipId) return fail("invalid_argument", "clipId is required.");
			const clip = findClip(timeline, clipId);
			if (!clip) return fail("unknown_clip", `No clip '${clipId}'.`);
			const asset = state.assets.find((entry) => entry.id === clip.assetId);
			if (!asset) return fail("no_asset", `'${clip.name}' has no media behind it.`);
			if (asset.offline)
				return fail("media_offline", `'${asset.name}' is offline — relink it first.`);

			const decoded = await decodeAudio(asset);
			if (!decoded) return fail("no_audio", `'${asset.name}' has no decodable audio stream.`);

			const gaps = detectSilence(monoSamples(decoded), decoded.sampleRate, {
				thresholdDb: asNumber(args.thresholdDb) ?? -45,
				minDurationSeconds: asNumber(args.minSeconds) ?? 0.35,
			});

			// Source seconds are what the detector speaks; frames are what the
			// editing tools take. Reporting both is what makes this actionable
			// without the caller redoing the speed and trim arithmetic.
			const toFrame = (seconds: number) =>
				clip.startFrame +
				Math.round(
					(seconds * timeline.fps) / Math.max(0.01, clip.speed) - clip.trimStartFrame,
				);
			const rows = gaps
				.map(([from, to]) => ({
					sourceSeconds: [Number(from.toFixed(3)), Number(to.toFixed(3))],
					frames: [toFrame(from), toFrame(to)],
					seconds: Number((to - from).toFixed(3)),
				}))
				.filter((row) => row.frames[1] > clip.startFrame && row.frames[0] < clip.endFrame);

			return ok({
				clipId,
				name: clip.name,
				silences: rows,
				totalSeconds: Number(rows.reduce((sum, row) => sum + row.seconds, 0).toFixed(2)),
				note: rows.length
					? "Nothing was cut. The frames go straight to ripple_delete_ranges or split_clips; remove_silence does it in one step."
					: "No silence long enough at this threshold. Raise thresholdDb toward −30 for a noisy recording.",
			});
		},

		set_track_volume(args) {
			const trackId = asString(args.trackId);
			if (!trackId) return fail("invalid_argument", "trackId is required.");
			const track = timeline.tracks.find((entry) => entry.id === trackId);
			if (!track) return fail("unknown_track", `No track '${trackId}'.`);
			if (track.clips.length === 0)
				return ok({ changed: false, note: `'${track.name}' has no clips on it.` });

			const absolute = asNumber(args.volumeDb);
			const relative = asNumber(args.adjustDb);
			if ((absolute === null) === (relative === null))
				return fail("invalid_argument", "Pass exactly one of volumeDb or adjustDb.");
			if (absolute !== null && (absolute < -60 || absolute > 15))
				return fail("invalid_argument", "volumeDb must be between −60 and 15.");

			const clipIds = track.clips.map((clip) => clip.id);
			const clamped: string[] = [];
			return mutate(
				"Set track volume",
				(t) =>
					mapClips(t, clipIds, (clip) => {
						const wanted = absolute ?? clip.volumeDb + (relative ?? 0);
						const value = Math.min(15, Math.max(-60, wanted));
						if (value !== wanted) clamped.push(clip.name);
						return { ...clip, volumeDb: Number(value.toFixed(2)) };
					}),
				() => ({
					trackName: track.name,
					clips: clipIds.length,
					...(absolute !== null ? { volumeDb: absolute } : { adjustDb: relative }),
					...(clamped.length
						? {
								warnings: [
									`Clamped to the −60…+15 range on: ${[...new Set(clamped)].join(", ")}.`,
								],
							}
						: {}),
					...(track.muted
						? { note: `'${track.name}' is still muted — manage_tracks unmutes it.` }
						: {}),
				}),
			);
		},

		async align_to_beats(args) {
			const musicId = asString(args.musicClipId);
			if (!musicId) return fail("invalid_argument", "musicClipId is required.");
			const music = findClip(timeline, musicId);
			if (!music) return fail("unknown_clip", `No clip '${musicId}'.`);
			const clipIds = stringList(args.clipIds).filter((id) => id !== musicId);
			if (clipIds.length === 0)
				return fail("invalid_argument", "clipIds must name at least one clip to move.");
			const missing = clipIds.filter((id) => !findClip(timeline, id));
			if (missing.length) return fail("unknown_clip", `No clip: ${missing.join(", ")}.`);

			const asset = state.assets.find((entry) => entry.id === music.assetId);
			if (!asset) return fail("no_asset", `'${music.name}' has no media behind it.`);
			if (asset.offline)
				return fail("media_offline", `'${asset.name}' is offline — relink it first.`);
			const decoded = await decodeAudio(asset);
			if (!decoded) return fail("no_audio", `'${asset.name}' has no decodable audio.`);

			const analysis = detectBeats(monoSamples(decoded), decoded.sampleRate);
			// Speech and ambience have no reliable beat; aligning to one anyway
			// produces arbitrary moves that look deliberate.
			if (analysis.confidence < 0.35)
				return fail(
					"no_beat",
					`'${music.name}' has no clear tempo — confidence ${analysis.confidence.toFixed(2)} at ${Math.round(analysis.bpm)} BPM. Aligning to this would move clips to arbitrary frames.`,
				);

			const useDownbeats = asString(args.to) === "downbeat";
			const grid = useDownbeats ? analysis.downbeats : analysis.beats;
			if (grid.length === 0)
				return fail("no_beat", `No ${useDownbeats ? "bar starts" : "beats"} were found.`);
			const maxShift = Math.max(0, Math.round(asNumber(args.maxShiftFrames) ?? 15));

			// Beat times are source seconds of the music; the music's own start
			// on the timeline is what puts them on the project's clock.
			const gridFrames = grid.map(
				(seconds) => music.startFrame + Math.round(seconds * timeline.fps),
			);
			const moves = new Map<string, number>();
			const skipped: Array<Record<string, unknown>> = [];
			for (const id of clipIds) {
				const clip = findClip(timeline, id);
				if (!clip) continue;
				let best = gridFrames[0];
				for (const frame of gridFrames)
					if (Math.abs(frame - clip.startFrame) < Math.abs(best - clip.startFrame))
						best = frame;
				const shift = Math.abs(best - clip.startFrame);
				if (shift > maxShift) {
					skipped.push({ clipId: id, name: clip.name, wouldMoveFrames: shift });
					continue;
				}
				if (best !== clip.startFrame && best >= 0) moves.set(id, best);
			}

			if (moves.size === 0)
				return ok({
					changed: false,
					bpm: Math.round(analysis.bpm),
					confidence: Number(analysis.confidence.toFixed(2)),
					...(skipped.length ? { skipped } : {}),
					note: skipped.length
						? `Every clip was further than ${maxShift} frames from a ${useDownbeats ? "bar start" : "beat"}. Raise maxShiftFrames to move them anyway.`
						: "Every clip already sits on a beat.",
				});

			return mutate(
				"Align to beats",
				(t) => placeAt(t, moves),
				(next) => ({
					aligned: moves.size,
					bpm: Math.round(analysis.bpm),
					confidence: Number(analysis.confidence.toFixed(2)),
					to: useDownbeats ? "downbeat" : "beat",
					...(skipped.length ? { skipped } : {}),
					...overlapNote(next, [...moves.keys()]),
				}),
			);
		},

		async mix_to_asset(args) {
			const rendered = await renderTimelineAudio(
				timeline,
				state.assets,
				computeTotalFrames(timeline),
			);
			if (!rendered)
				return fail(
					"no_audio",
					"This timeline has nothing audible — every audio clip is muted, silent, or offline.",
				);
			const channels: Float32Array[] = [];
			for (let index = 0; index < rendered.numberOfChannels; index++)
				channels.push(rendered.getChannelData(index));
			const bytes = encodeWavBytes(channels, rendered.sampleRate);
			const name = asString(args.name) ?? "Mixdown";
			const added = await api.importMedia([
				new File([bytes as unknown as BlobPart], `${name.replace(/[^\w. -]/g, "")}.wav`, {
					type: "audio/wav",
				}),
			]);
			const asset = added[0];
			if (!asset) return fail("failed", "The mix rendered but couldn't enter the library.");
			return ok({
				mediaRef: asset.id,
				name: asset.name,
				durationSeconds: Number(rendered.duration.toFixed(2)),
				channels: rendered.numberOfChannels,
				sampleRate: rendered.sampleRate,
				note: "Rendered through the same mixdown the exporter uses, so this is what an export would contain.",
			});
		},

		async check_audio_sync(args) {
			const referenceId = asString(args.referenceClipId);
			const clipId = asString(args.clipId);
			if (!referenceId || !clipId)
				return fail("invalid_argument", "referenceClipId and clipId are both required.");
			if (referenceId === clipId)
				return fail("invalid_argument", "A clip cannot be measured against itself.");

			const load = async (id: string) => {
				const clip = findClip(timeline, id);
				if (!clip) return { ok: false as const, reason: `No clip '${id}'.` };
				const asset = state.assets.find((entry) => entry.id === clip.assetId);
				if (!asset) return { ok: false as const, reason: `'${clip.name}' has no media.` };
				if (asset.offline)
					return { ok: false as const, reason: `'${asset.name}' is offline.` };
				const decoded = await decodeAudio(asset);
				if (!decoded)
					return {
						ok: false as const,
						reason: `'${asset.name}' has no decodable audio.`,
					};
				return {
					ok: true as const,
					clip,
					samples: monoSamples(decoded),
					rate: decoded.sampleRate,
				};
			};

			const reference = await load(referenceId);
			if (!reference.ok) return fail("no_audio", reference.reason);
			const subject = await load(clipId);
			if (!subject.ok) return fail("no_audio", subject.reason);
			if (reference.rate !== subject.rate)
				return fail(
					"rate_mismatch",
					`These were recorded at ${reference.rate} Hz and ${subject.rate} Hz. Correlating them would report an offset scaled by the ratio.`,
				);

			const found = findSyncOffset(reference.samples, subject.samples, reference.rate);
			const frames = Math.round(found.offsetSeconds * timeline.fps);
			return ok({
				referenceClip: reference.clip.name,
				clip: subject.clip.name,
				offsetSeconds: Number(found.offsetSeconds.toFixed(4)),
				offsetMs: Math.round(found.offsetSeconds * 1000),
				offsetFrames: frames,
				confidence: Number(found.confidence.toFixed(3)),
				note:
					found.confidence < 0.3
						? `Confidence ${found.confidence.toFixed(2)} is too low to act on — these two recordings do not share enough sound to be aligned this way. Do not nudge on this number.`
						: frames === 0
							? "Already in sync to within a frame."
							: `nudge_clips by ${-frames} frames on '${subject.clip.name}' closes it. Nothing was moved.`,
			});
		},
	};

	return handlers;
}

/** Resolves the aspect/quality shorthand into concrete pixels. */
function resolveResolution(
	timeline: TimelineModel,
	input: {
		width: number | null;
		height: number | null;
		aspectRatio: string | null;
		quality: string | null;
	},
): { ok: true; width?: number; height?: number } | { ok: false; reason: string } {
	if (input.width !== null && input.height !== null) {
		return { ok: true, width: Math.round(input.width), height: Math.round(input.height) };
	}
	if (!input.aspectRatio && !input.quality) return { ok: true };

	const RATIOS: Record<string, number> = {
		"16:9": 16 / 9,
		"9:16": 9 / 16,
		"1:1": 1,
		"4:3": 4 / 3,
		"2.4:1": 2.4,
		"9:14": 9 / 14,
	};
	const ratio = input.aspectRatio ? RATIOS[input.aspectRatio] : timeline.width / timeline.height;
	if (!ratio) {
		return {
			ok: false,
			reason: `aspectRatio must be one of ${Object.keys(RATIOS).join(", ")}.`,
		};
	}

	const SHORT_EDGE: Record<string, number> = {
		"720p": 720,
		"1080p": 1080,
		"2K": 1440,
		"4K": 2160,
	};
	const shortEdge = input.quality
		? SHORT_EDGE[input.quality]
		: Math.min(timeline.width, timeline.height);
	if (!shortEdge) {
		return {
			ok: false,
			reason: `quality must be one of ${Object.keys(SHORT_EDGE).join(", ")}.`,
		};
	}

	// Encoders reject odd dimensions, so both axes land on even numbers.
	const even = (value: number) => Math.max(16, Math.round(value / 2) * 2);
	return ratio >= 1
		? { ok: true, width: even(shortEdge * ratio), height: even(shortEdge) }
		: { ok: true, width: even(shortEdge), height: even(shortEdge / ratio) };
}
