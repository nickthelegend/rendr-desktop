// Handlers for the creator tools (electron/mcp/creatorToolDefinitions.ts):
// camera-footage work — analysis, background removal, and what builds on them.
//
// Merged with createAgentTools by useAgentBridge, so they answer over the same
// MCP bridge and land in the same undo history as every other edit.

import type { ToolHandler, ToolResult } from "./agentTools";
import {
	footageUnder,
	type GraphicLayer,
	keepOutFromFaces,
	placeGraphic,
} from "./graphicPlacement";
import {
	buildTemplate,
	DEFAULT_GRAPHIC_STYLE,
	type GraphicElement,
	type GraphicSpec,
	type GraphicStyle,
	graphicRegions,
	type KeepOut,
	settleSeconds,
} from "./graphics";
import { type ClipBackground, parseBackground } from "./matte";
import { type AssetModel, importFiles } from "./media";
import type { ClipModel } from "./model";
import { footageTrackIndex } from "./placement";
import {
	boxOf,
	clipFace,
	faceInFrame,
	type PunchPattern,
	punchBox,
	punchedIndexes,
	pushKeyframes,
} from "./punchIns";
import type { TimelineModel } from "./reducers";
import { findClip } from "./reducers";
import type { EditorApi } from "./state";
import { compactFaceTrack, type FootageAnalysis, faceCoverage, typicalFace } from "./vision";

function ok(payload: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: code, message }, null, 2) }],
		isError: true,
	};
}

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

// ── Footage analysis jobs ────────────────────────────────────────────────
//
// A long take analyses for minutes, longer than one MCP call may wait. So a
// job outlives the call that started it: the call waits a while, reports
// progress if it's still going, and the next call joins the same job.

interface AnalysisJob {
	promise: Promise<AnalysisOutcome>;
	progress: number;
	outcome?: AnalysisOutcome;
}

type AnalysisOutcome =
	| { ok: true; matteAssetId: string; summary: Record<string, unknown> }
	| { ok: false; reason: string };

const jobs = new Map<string, AnalysisJob>();
let progressListening = false;

function listenForProgress(): void {
	if (progressListening) return;
	const bridge = typeof window === "undefined" ? undefined : window.electronAPI;
	if (!bridge?.onFootageProgress) return;
	progressListening = true;
	bridge.onFootageProgress(({ name, progress }) => {
		for (const [key, job] of jobs) {
			if (key.endsWith(`::${name}`)) job.progress = progress;
		}
	});
}

const wait = (ms: number) =>
	new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

function summarize(asset: AssetModel, analysis: FootageAnalysis): Record<string, unknown> {
	const faces = analysis.faces;
	const typical = faces ? typicalFace(faces) : null;
	const round = (value: number) => Math.round(value * 1000) / 1000;
	return {
		assetId: asset.id,
		name: asset.name,
		personCoverage: round(analysis.personCoverage ?? 0),
		faceCoverage: faces ? round(faceCoverage(faces)) : 0,
		typicalFace: typical
			? { cx: round(typical.cx), cy: round(typical.cy), size: round(typical.size) }
			: null,
		talkingHead:
			(analysis.personCoverage ?? 0) > 0.6 && (faces ? faceCoverage(faces) : 0) > 0.5,
		cached: analysis.cached === true,
	};
}

async function runAnalysis(
	api: EditorApi,
	asset: AssetModel,
	quality?: string,
): Promise<AnalysisOutcome> {
	const bridge = window.electronAPI;
	if (!bridge?.analyzeFootage || !bridge.readLocalFile) {
		return { ok: false, reason: "Footage analysis needs Rendr's desktop app." };
	}
	const analysis = await bridge.analyzeFootage(asset.url, {
		name: asset.name,
		quality: quality === "fast" || quality === "accurate" ? quality : undefined,
	});
	if (!analysis.ok || !analysis.mattePath) {
		return { ok: false, reason: analysis.reason ?? "The analysis produced no matte." };
	}
	const read = await bridge.readLocalFile(analysis.mattePath);
	if (!read?.success || !read.data) {
		return { ok: false, reason: read?.error ?? "Couldn't read the matte back." };
	}
	const file = new File([new Uint8Array(read.data)], `${asset.name} (matte).mp4`, {
		type: "video/mp4",
	});
	const { assets, rejected } = await importFiles([file]);
	const matte = assets[0];
	if (!matte) return { ok: false, reason: rejected[0] ?? "The matte couldn't be loaded." };
	api.attachAnalysis(asset.id, matte, {
		faceTrack: analysis.faces ? compactFaceTrack(analysis.faces) : undefined,
		personCoverage: analysis.personCoverage,
	});
	// attachAnalysis keeps an earlier matte's id, so clips already pointing at
	// it pick the new file up; report the id that actually landed.
	return {
		ok: true,
		matteAssetId: asset.matteAssetId ?? matte.id,
		summary: summarize(asset, analysis),
	};
}

/**
 * Starts (or joins) the analysis of one asset and waits up to `waitMs`.
 * Re-analyses when the matte is missing or offline — the result is cached by
 * file in the main process, so that costs a file read, not minutes.
 */
export async function ensureAnalysis(
	api: EditorApi,
	asset: AssetModel,
	options: { quality?: string; waitMs: number },
): Promise<{ status: "done"; outcome: AnalysisOutcome } | { status: "running"; progress: number }> {
	listenForProgress();
	const key = `${asset.id}::${asset.name}`;
	let job = jobs.get(key);
	if (!job || (job.outcome && !job.outcome.ok)) {
		const created: AnalysisJob = {
			progress: 0,
			promise: Promise.resolve({ ok: false, reason: "" }),
		};
		created.promise = runAnalysis(api, asset, options.quality)
			.catch(
				(error: unknown): AnalysisOutcome => ({
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				}),
			)
			.then((outcome) => {
				created.outcome = outcome;
				created.progress = 1;
				return outcome;
			});
		jobs.set(key, created);
		job = created;
	}
	const settled = await Promise.race([job.promise, wait(options.waitMs)]);
	if (settled === "timeout")
		return { status: "running", progress: Math.round(job.progress * 100) / 100 };
	return { status: "done", outcome: settled };
}

function hasUsableMatte(asset: AssetModel, assets: readonly AssetModel[]): boolean {
	const matte = asset.matteAssetId
		? assets.find((entry) => entry.id === asset.matteAssetId)
		: undefined;
	return Boolean(matte && !matte.offline && matte.url);
}

function waitMsFrom(args: Record<string, unknown>): number {
	const seconds = typeof args.waitSeconds === "number" ? args.waitSeconds : 90;
	return Math.max(0, Math.min(100, seconds)) * 1000;
}

export function replaceGraphic(
	timeline: TimelineModel,
	clipId: string,
	graphic: GraphicSpec,
	startFrame: number,
	endFrame: number,
): TimelineModel {
	return {
		...timeline,
		tracks: timeline.tracks.map((track) =>
			track.clips.some((clip) => clip.id === clipId)
				? {
						...track,
						clips: track.clips.map((clip) =>
							clip.id === clipId ? { ...clip, graphic, startFrame, endFrame } : clip,
						),
					}
				: track,
		),
	};
}

/** Sets (or clears) the background on the named clips. Pure; returns the same timeline when nothing changes. */
export function setClipBackgrounds(
	timeline: TimelineModel,
	clipIds: ReadonlySet<string>,
	background: ClipBackground | undefined,
): TimelineModel {
	let changed = false;
	const tracks = timeline.tracks.map((track) => {
		let trackChanged = false;
		const clips = track.clips.map((clip): ClipModel => {
			if (!clipIds.has(clip.id)) return clip;
			if (JSON.stringify(clip.background) === JSON.stringify(background)) return clip;
			trackChanged = true;
			const next = { ...clip };
			if (background) next.background = background;
			else delete next.background;
			return next;
		});
		if (!trackChanged) return track;
		changed = true;
		return { ...track, clips };
	});
	return changed ? { ...timeline, tracks } : timeline;
}

const STYLE_KEYS: Array<keyof GraphicStyle> = [
	"accent",
	"boxFill",
	"boxText",
	"textColor",
	"fontFamily",
	"fontWeight",
	"radius",
	"lineWidth",
	"shadow",
	"uppercase",
];

/** Copies only the style keys a graphic understands, with their types checked. */
export function parseGraphicStyle(input: unknown): Partial<GraphicStyle> {
	if (!input || typeof input !== "object") return {};
	const raw = input as Record<string, unknown>;
	const out: Partial<GraphicStyle> = {};
	for (const key of STYLE_KEYS) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value === typeof DEFAULT_GRAPHIC_STYLE[key])
			(out as Record<string, unknown>)[key] = value;
	}
	return out;
}

/** Light validation of caller-supplied elements: known types, finite coordinates. */
export function parseElements(input: unknown): { elements: GraphicElement[] } | { error: string } {
	if (!Array.isArray(input) || input.length === 0)
		return { error: "elements must be a non-empty array." };
	const types = new Set(["box", "line", "text", "rect", "qr"]);
	for (const [index, element] of input.entries()) {
		if (!element || typeof element !== "object")
			return { error: `elements[${index}] isn't an object.` };
		const record = element as Record<string, unknown>;
		if (!types.has(String(record.type))) {
			return { error: `elements[${index}].type must be one of box, line, text, rect, qr.` };
		}
		if (record.type !== "line") {
			for (const axis of ["x", "y"]) {
				const value = record[axis];
				if (
					typeof value !== "number" ||
					!Number.isFinite(value) ||
					value < -0.5 ||
					value > 1.5
				) {
					return {
						error: `elements[${index}].${axis} must be a number in frame coordinates (0–1).`,
					};
				}
			}
		}
		if (record.type === "box" && typeof record.label !== "string")
			return { error: `elements[${index}] needs a label.` };
		if (record.type === "text" && typeof record.text !== "string")
			return { error: `elements[${index}] needs text.` };
		if (record.type === "qr" && typeof record.data !== "string")
			return { error: `elements[${index}] needs data.` };
	}
	return { elements: input as GraphicElement[] };
}

export function createCreatorTools(api: EditorApi): Record<string, ToolHandler> {
	const { state, timeline, commit } = api;

	/** Same contract as agentTools' mutate: compute, commit against the latest timeline, report. */
	const mutate = (
		label: string,
		reduce: (t: TimelineModel) => TimelineModel,
		receipt: () => unknown,
	): ToolResult => {
		const next = reduce(timeline);
		if (next === timeline)
			return ok({ changed: false, note: "That request left the timeline unchanged." });
		const result = receipt();
		commit(label, (current) => (current === timeline ? next : reduce(current)));
		return ok(result);
	};

	/** Where a run of back-to-back clips (cut segments of one take) ends on a track. */
	const runEnd = (trackIndex: number, from: ClipModel): number => {
		const clips = [...(timeline.tracks[trackIndex]?.clips ?? [])].sort(
			(a, b) => a.startFrame - b.startFrame,
		);
		let end = from.endFrame;
		for (const clip of clips) {
			if (clip.startFrame < from.startFrame) continue;
			if (clip.startFrame > end + 1) break;
			end = Math.max(end, clip.endFrame);
		}
		return end;
	};

	/** What other graphics already occupy while this one is on screen. */
	const otherGraphicRegions = (start: number, end: number, exceptId?: string): KeepOut[] =>
		timeline.tracks.flatMap((track) =>
			track.clips
				.filter(
					(clip) =>
						clip.mediaType === "graphic" &&
						clip.graphic &&
						clip.id !== exceptId &&
						clip.startFrame < end + timeline.fps * 30 &&
						clip.endFrame > start,
				)
				.flatMap((clip) =>
					graphicRegions(clip.graphic as GraphicSpec, timeline.width / timeline.height),
				),
		);

	const videoClips = (): ClipModel[] =>
		timeline.tracks.flatMap((track) =>
			track.clips.filter((clip) => clip.mediaType === "video"),
		);

	return {
		async analyze_footage(args: Record<string, unknown>): Promise<ToolResult> {
			const assetId = asString(args.assetId);
			const asset = state.assets.find((entry) => entry.id === assetId);
			if (!asset) return fail("not_found", `No asset '${assetId}'. get_media lists them.`);
			if (asset.type !== "video")
				return fail("invalid_argument", `'${asset.name}' isn't a video.`);
			if (asset.offline || !asset.url) {
				return fail(
					"offline",
					`'${asset.name}' needs relinking before it can be analysed.`,
				);
			}
			const result = await ensureAnalysis(api, asset, {
				quality: asString(args.quality) ?? undefined,
				waitMs: waitMsFrom(args),
			});
			if (result.status === "running") {
				return ok({
					status: "running",
					progress: result.progress,
					note: "Still analysing. Call analyze_footage again with the same assetId to wait for it — the job keeps going either way.",
				});
			}
			if (!result.outcome.ok) return fail("analysis_failed", result.outcome.reason);
			return ok({ status: "done", ...result.outcome.summary });
		},

		add_graphic(args: Record<string, unknown>): ToolResult {
			const template = asString(args.template) ?? (args.elements ? "custom" : null);
			if (!template)
				return fail(
					"invalid_argument",
					"Pass a template, or elements for a custom graphic.",
				);

			const fps = timeline.fps;
			const existingId = asString(args.clipId);
			const existing = existingId ? findClip(timeline, existingId) : null;
			if (existingId && (!existing || existing.mediaType !== "graphic")) {
				return fail("not_found", `No graphic clip '${existingId}' on the active timeline.`);
			}

			const start = Math.max(
				0,
				Math.round(
					typeof args.startFrame === "number"
						? args.startFrame
						: (existing?.startFrame ?? 0),
				),
			);
			// Face avoidance reads the footage the graphic will sit beside.
			const footage = footageUnder(timeline, start, start + 1);
			const footageAsset = footage
				? state.assets.find((entry) => entry.id === footage.clip.assetId)
				: undefined;

			let elements: GraphicElement[];
			if (template === "custom") {
				const parsed = parseElements(args.elements);
				if ("error" in parsed) return fail("invalid_argument", parsed.error);
				elements = parsed.elements;
			} else {
				const built = buildTemplate({
					template,
					nodes: Array.isArray(args.nodes)
						? args.nodes.map((node) =>
								typeof node === "string"
									? { label: node }
									: (node as { label: string; x?: number; y?: number }),
							)
						: undefined,
					links: Array.isArray(args.links)
						? (args.links as Array<[number | string, number | string]>)
						: undefined,
					items: Array.isArray(args.items) ? args.items.map(String) : undefined,
					title: asString(args.title) ?? undefined,
					subtitle: asString(args.subtitle) ?? undefined,
					data: asString(args.data) ?? undefined,
					label: asString(args.label) ?? undefined,
					corner: (asString(args.corner) ?? undefined) as "top_left" | undefined,
					x: typeof args.x === "number" ? args.x : undefined,
					y: typeof args.y === "number" ? args.y : undefined,
					pointTo: Array.isArray(args.pointTo)
						? (args.pointTo as [number, number])
						: undefined,
					stagger: typeof args.stagger === "number" ? args.stagger : undefined,
					keepOut: [
						...(keepOutFromFaces(footageAsset?.faceTrack)
							? [keepOutFromFaces(footageAsset?.faceTrack) as KeepOut]
							: []),
						...otherGraphicRegions(start, start + 1, existing?.id),
					],
				});
				if ("error" in built) return fail("invalid_argument", built.error);
				elements = built.elements;
			}

			const spec: GraphicSpec = {
				template,
				elements,
				style: {
					...DEFAULT_GRAPHIC_STYLE,
					...(existing?.graphic?.style ?? {}),
					...parseGraphicStyle(args.style),
				},
				background: asString(args.background) ?? existing?.graphic?.background,
			};

			const layer: GraphicLayer =
				asString(args.layer) === "behind" || asString(args.layer) === "front"
					? (asString(args.layer) as GraphicLayer)
					: template === "mind_map" && footageAsset?.matteAssetId
						? "behind"
						: "front";

			// How long each kind lingers once it has landed, unless told otherwise:
			// long enough to scan a QR code, short enough that a name plate doesn't
			// overstay. A graphic behind the speaker is part of the scene, so it
			// lasts as long as the run of footage it sits behind.
			const linger: Record<string, number> = {
				qr: 8,
				lower_third: 5,
				callout: 4,
				key_points: 5,
				mind_map: 6,
			};
			const settled = Math.ceil((settleSeconds(elements) + (linger[template] ?? 4)) * fps);
			const behindUntil =
				layer === "behind" && footage ? runEnd(footage.trackIndex, footage.clip) : null;
			const durationFrames = Math.max(
				Math.round(fps * 0.5),
				Math.round(
					typeof args.durationFrames === "number"
						? args.durationFrames
						: existing
							? existing.endFrame - existing.startFrame
							: behindUntil !== null
								? Math.max(settled, behindUntil - start)
								: settled,
				),
			);
			const end = start + durationFrames;

			if (existing) {
				return mutate(
					`Update graphic ${existing.name}`,
					(t) => replaceGraphic(t, existing.id, spec, start, end),
					() => ({
						clipId: existing.id,
						template,
						elements: elements.length,
						startFrame: start,
						endFrame: end,
					}),
				);
			}

			const id = `graphic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			const name = asString(args.name) ?? `${template.replace(/_/g, " ")}`;
			let placement: ReturnType<typeof placeGraphic> | null = null;
			return mutate(
				`Add ${name}`,
				(t) => {
					placement = placeGraphic(t, {
						id,
						name,
						spec,
						startFrame: start,
						endFrame: end,
						layer,
					});
					return placement.timeline;
				},
				() => ({
					clipId: id,
					template,
					layer,
					elements: elements.length,
					startFrame: start,
					endFrame: end,
					settlesAtFrame: start + Math.ceil(settleSeconds(elements) * fps),
					movedBackgroundFrom: (placement as ReturnType<typeof placeGraphic> | null)
						?.movedBackgroundFrom,
					note:
						layer === "behind" && !footageAsset?.matteAssetId
							? "Placed behind the footage, but that footage still has its own background, so the graphic is hidden. Run remove_background on it (mode 'remove' or 'color')."
							: undefined,
				}),
			);
		},

		add_punch_ins(args: Record<string, unknown>): ToolResult {
			const off = args.mode === "off" || args.amount === 1;
			const amount = typeof args.amount === "number" ? args.amount : 1.15;
			if (!off && (amount < 1.02 || amount > 1.8)) {
				return fail(
					"invalid_argument",
					"amount is the push-in scale, 1.02–1.8 (1.15 is the classic jump-cut punch).",
				);
			}
			const pattern: PunchPattern = args.pattern === "every" ? "every" : "alternate";
			const style = args.style === "push" ? "push" : "cut";
			const startWith = args.startWith === "tight" ? "tight" : "wide";

			const requested = Array.isArray(args.clipIds) ? args.clipIds.map(String) : null;
			const footageTrack = timeline.tracks[footageTrackIndex(timeline)];
			const candidates = requested
				? videoClips().filter((clip) => requested.includes(clip.id))
				: (footageTrack?.clips ?? []).filter((clip) => clip.mediaType === "video");
			const segments = [...candidates].sort((a, b) => a.startFrame - b.startFrame);
			if (segments.length === 0) return fail("not_found", "No footage clips to punch in on.");

			const canvasAspect = timeline.width / timeline.height;
			const punched = new Set(
				off
					? []
					: punchedIndexes(segments.length, pattern, startWith).map(
							(index) => segments[index].id,
						),
			);
			const skipped: string[] = [];
			let withoutFace = 0;
			const plans = new Map<string, Partial<ClipModel>>();

			for (const clip of segments) {
				const base = clip.punch?.base ?? boxOf(clip.transform);
				const animated = clip.keyframes?.position?.length || clip.keyframes?.scale?.length;
				// Motion someone else authored is theirs; a push of ours we can redo.
				if (animated && !clip.punch) {
					skipped.push(clip.id);
					continue;
				}
				const restKeyframes = clip.keyframes ? { ...clip.keyframes } : undefined;
				if (clip.punch && restKeyframes) {
					delete restKeyframes.position;
					delete restKeyframes.scale;
				}
				const restored: Partial<ClipModel> = {
					transform: { ...clip.transform, ...base },
					keyframes:
						restKeyframes && Object.keys(restKeyframes).length > 0
							? restKeyframes
							: undefined,
					punch: undefined,
				};
				if (!punched.has(clip.id)) {
					if (clip.punch) plans.set(clip.id, restored);
					continue;
				}
				const asset = state.assets.find((entry) => entry.id === clip.assetId);
				const pictureAspect =
					asset && asset.width > 0 && asset.height > 0
						? asset.width / asset.height
						: canvasAspect;
				const face = clipFace(clip, asset, timeline.fps);
				if (!face) withoutFace += 1;
				// No face track: aim at the upper middle, where a presenter's face usually is.
				const focus = faceInFrame(
					base,
					face ?? { x: 0.5, y: 0.38 },
					pictureAspect,
					canvasAspect,
				);
				const target = punchBox(base, focus, amount);
				if (style === "push") {
					const { scale, position } = pushKeyframes(
						base,
						target,
						clip.endFrame - clip.startFrame,
					);
					plans.set(clip.id, {
						...restored,
						keyframes: { ...(restored.keyframes ?? {}), scale, position },
						punch: { base, factor: amount },
					});
				} else {
					plans.set(clip.id, {
						...restored,
						transform: { ...clip.transform, ...target },
						punch: { base, factor: amount },
					});
				}
			}

			if (plans.size === 0) {
				return ok({
					changed: false,
					skipped,
					note: "Nothing to change — no punched clips to restore, or every clip already has its own motion.",
				});
			}
			const apply = (t: TimelineModel): TimelineModel => ({
				...t,
				tracks: t.tracks.map((track) => ({
					...track,
					clips: track.clips.map((clip) => {
						const plan = plans.get(clip.id);
						if (!plan) return clip;
						const next = { ...clip, ...plan };
						if (!plan.punch) delete next.punch;
						if (!plan.keyframes) delete next.keyframes;
						return next;
					}),
				})),
			});
			return mutate(off ? "Remove punch-ins" : `Punch-ins (${style})`, apply, () => ({
				changed: true,
				segments: segments.length,
				punched: off ? 0 : punched.size,
				amount: off ? 1 : amount,
				style,
				skipped: skipped.length > 0 ? skipped : undefined,
				note:
					withoutFace > 0
						? `${withoutFace} segment(s) had no face track, so the push aims at the upper middle. Run analyze_footage for face-centred punch-ins.`
						: undefined,
			}));
		},

		async remove_background(args: Record<string, unknown>): Promise<ToolResult> {
			const mode = asString(args.mode);
			let background: ClipBackground | undefined;
			if (mode !== "off") {
				const parsed = parseBackground(args);
				if ("error" in parsed) return fail("invalid_argument", parsed.error);
				background = parsed.background;
				if (
					background.imageAssetId &&
					!state.assets.some((entry) => entry.id === background?.imageAssetId)
				) {
					return fail("not_found", `No image asset '${background.imageAssetId}'.`);
				}
			}

			const requested = Array.isArray(args.clipIds) ? args.clipIds.map(String) : null;
			const targets = requested
				? videoClips().filter((clip) => requested.includes(clip.id))
				: videoClips().filter((clip) => {
						const asset = state.assets.find((entry) => entry.id === clip.assetId);
						// Without a clip list, only footage that has (or may have) a person.
						return asset && !asset.isMatte && (asset.personCoverage ?? 1) > 0.2;
					});
			if (requested) {
				const missing = requested.filter((id) => !targets.some((clip) => clip.id === id));
				if (missing.length > 0) {
					return fail(
						"not_found",
						`Not video clips on the active timeline: ${missing.join(", ")}.`,
					);
				}
			}
			if (targets.length === 0) return fail("not_found", "No video clips to change.");

			// Every clip's footage needs a matte before the background can go.
			const analysed: Record<string, unknown>[] = [];
			if (background) {
				const assetIds = [
					...new Set(targets.map((clip) => clip.assetId).filter(Boolean)),
				] as string[];
				for (const assetId of assetIds) {
					const asset = state.assets.find((entry) => entry.id === assetId);
					if (!asset) continue;
					if (hasUsableMatte(asset, state.assets)) continue;
					if (asset.offline || !asset.url) {
						return fail(
							"offline",
							`'${asset.name}' is offline — import the file again to relink it, then retry. Its matte comes back on its own.`,
						);
					}
					const result = await ensureAnalysis(api, asset, {
						quality: asString(args.quality) ?? undefined,
						waitMs: waitMsFrom(args),
					});
					if (result.status === "running") {
						return ok({
							status: "running",
							progress: result.progress,
							assetId,
							note: "Analysing the footage first. Call remove_background again with the same arguments — the analysis keeps going in the meantime.",
						});
					}
					if (!result.outcome.ok)
						return fail("analysis_failed", `${asset.name}: ${result.outcome.reason}`);
					analysed.push(result.outcome.summary);
				}
			}

			const ids = new Set(targets.map((clip) => clip.id));
			const next = setClipBackgrounds(timeline, ids, background);
			if (next === timeline)
				return ok({ changed: false, note: "Those clips already look like that." });
			commit(
				background ? `Background: ${background.mode}` : "Restore background",
				(current) => setClipBackgrounds(current, ids, background),
			);
			return ok({
				changed: true,
				clipIds: [...ids],
				background: background ?? "original",
				analysed,
				tip:
					background?.mode === "remove"
						? "Transparent now: put a colour, image or add_graphic on a track BELOW these clips to fill the space."
						: undefined,
			});
		},
	};
}
