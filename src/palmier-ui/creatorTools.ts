// Handlers for the creator tools (electron/mcp/creatorToolDefinitions.ts):
// camera-footage work — analysis, background removal, and what builds on them.
//
// Merged with createAgentTools by useAgentBridge, so they answer over the same
// MCP bridge and land in the same undo history as every other edit.

import type { ToolHandler, ToolResult } from "./agentTools";
import { type ClipBackground, parseBackground } from "./matte";
import { type AssetModel, importFiles } from "./media";
import type { ClipModel } from "./model";
import type { TimelineModel } from "./reducers";
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
async function ensureAnalysis(
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

export function createCreatorTools(api: EditorApi): Record<string, ToolHandler> {
	const { state, timeline, commit } = api;

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
