// Project files.
//
// A `.rendr` file is JSON: the timeline, plus a manifest of the media it
// references. It deliberately does NOT embed the media — a screen recording is
// hundreds of megabytes and belongs beside the project, not inside it.
//
// That means opening a project brings the edit back but not the footage: assets
// arrive `offline` until relinked. Every editor does this, and saying so is
// better than silently restoring a timeline that renders black.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type BackgroundSettings, DEFAULT_BACKGROUND } from "./background";
import { type CommentModel, parseComments } from "./comments";
import { type CursorSettings, DEFAULT_CURSOR } from "./cursor";
import { type LookModel, parseLooks } from "./looks";
import type { AssetModel } from "./media";
import type { TimelineModel } from "./reducers";
import { DEFAULT_WEBCAM, type WebcamSettings } from "./webcam";
import { parseWorkflows, type WorkflowModel } from "./workflow";
import { DEFAULT_ZOOM_TIMING, type ZoomTiming } from "./zoom";

export const PROJECT_VERSION = 2;
const PROJECT_EXTENSION = ".rendr";
const AUTOSAVE_KEY = "rendr.autosave.v2";

/** What a saved asset remembers. The blob URL is deliberately absent. */
export interface AssetManifestEntry {
	id: string;
	name: string;
	type: AssetModel["type"];
	durationSeconds: number;
	width: number;
	height: number;
	hasAudio: boolean;
	folder?: string;
	fromRecording?: boolean;
	hasCursorTelemetry?: boolean;
	/** The camera take recorded with this one, if any. */
	webcamAssetId?: string;
	isWebcam?: boolean;
}

export interface ProjectFile {
	version: number;
	projectName: string;
	savedAt: string;
	timelines: TimelineModel[];
	activeTimelineId: string;
	assets: AssetManifestEntry[];
	/**
	 * How the drawn pointer and the camera inset are set up.
	 *
	 * These belong to the project, not the session: a take tuned for a 2.5×
	 * pointer in the bottom-right looks wrong reopened at the defaults.
	 */
	cursor?: CursorSettings;
	webcam?: WebcamSettings;
	background?: BackgroundSettings;
	zoomTiming?: ZoomTiming;
	/** Notes pinned to the timeline, and the narration script. */
	comments?: CommentModel[];
	/** Workflow graphs saved with the project. */
	workflows?: WorkflowModel[];
	/** Named grades. Absent in files written before looks existed. */
	looks?: LookModel[];
	/**
	 * The captured pointer path. Without it a reopened project has no cursor to
	 * draw and no clicks for suggest_zooms to read — the recording's zoom
	 * feature simply stops existing after a save.
	 */
	cursorTelemetry?: CursorTelemetryPoint[];
}

export function toManifest(asset: AssetModel): AssetManifestEntry {
	return {
		id: asset.id,
		name: asset.name,
		type: asset.type,
		durationSeconds: asset.durationSeconds,
		width: asset.width,
		height: asset.height,
		hasAudio: asset.hasAudio,
		folder: asset.folder,
		fromRecording: asset.fromRecording,
		hasCursorTelemetry: asset.hasCursorTelemetry,
		// Without these the pairing is lost on save, and a reopened project
		// composites no camera even after both files are relinked.
		webcamAssetId: asset.webcamAssetId,
		isWebcam: asset.isWebcam,
	};
}

/** A manifest entry rehydrated as an asset with no source behind it yet. */
export function offlineAsset(entry: AssetManifestEntry): AssetModel {
	return { ...entry, url: "", offline: true };
}

export function serializeProject(input: {
	projectName: string;
	timelines: TimelineModel[];
	activeTimelineId: string;
	assets: readonly AssetModel[];
	savedAt: string;
	cursor?: CursorSettings;
	webcam?: WebcamSettings;
	background?: BackgroundSettings;
	zoomTiming?: ZoomTiming;
	cursorTelemetry?: readonly CursorTelemetryPoint[];
	comments?: readonly CommentModel[];
	workflows?: readonly WorkflowModel[];
	/** Named grades. Absent in files written before looks existed. */
	looks?: readonly LookModel[];
}): ProjectFile {
	return {
		version: PROJECT_VERSION,
		projectName: input.projectName,
		savedAt: input.savedAt,
		timelines: input.timelines,
		activeTimelineId: input.activeTimelineId,
		assets: input.assets.map(toManifest),
		...(input.cursor ? { cursor: input.cursor } : {}),
		...(input.webcam ? { webcam: input.webcam } : {}),
		...(input.background ? { background: input.background } : {}),
		...(input.zoomTiming ? { zoomTiming: input.zoomTiming } : {}),
		...(input.comments?.length ? { comments: [...input.comments] } : {}),
		...(input.workflows?.length ? { workflows: [...input.workflows] } : {}),
		...(input.looks?.length ? { looks: [...input.looks] } : {}),
		...(input.cursorTelemetry?.length ? { cursorTelemetry: [...input.cursorTelemetry] } : {}),
	};
}

export class ProjectParseError extends Error {}

/** Parses a `.rendr` file, refusing anything that isn't one. */
export function parseProject(text: string): ProjectFile {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new ProjectParseError("That file isn't valid JSON.");
	}

	if (typeof raw !== "object" || raw === null) {
		throw new ProjectParseError("That file isn't a Rendr project.");
	}
	const candidate = raw as Partial<ProjectFile>;

	if (typeof candidate.version !== "number") {
		throw new ProjectParseError("That file isn't a Rendr project.");
	}
	if (candidate.version > PROJECT_VERSION) {
		throw new ProjectParseError(
			`This project was saved by a newer version of Rendr (v${candidate.version}).`,
		);
	}
	if (!Array.isArray(candidate.timelines) || candidate.timelines.length === 0) {
		throw new ProjectParseError("That project has no timelines.");
	}

	return {
		version: candidate.version,
		projectName: candidate.projectName ?? "Untitled Project",
		savedAt: candidate.savedAt ?? "",
		timelines: candidate.timelines,
		activeTimelineId: candidate.activeTimelineId ?? candidate.timelines[0].id,
		assets: Array.isArray(candidate.assets) ? candidate.assets : [],
		// Merged over the defaults rather than replacing them, so a project
		// written before a setting existed still opens with that setting sane.
		...(candidate.cursor ? { cursor: { ...DEFAULT_CURSOR, ...candidate.cursor } } : {}),
		...(candidate.webcam ? { webcam: { ...DEFAULT_WEBCAM, ...candidate.webcam } } : {}),
		...(candidate.background
			? { background: { ...DEFAULT_BACKGROUND, ...candidate.background } }
			: {}),
		...(candidate.zoomTiming
			? { zoomTiming: { ...DEFAULT_ZOOM_TIMING, ...candidate.zoomTiming } }
			: {}),
		// Parsed rather than trusted: a malformed note is dropped, not thrown on,
		// so one bad entry can't cost the user the whole project.
		...(candidate.comments ? { comments: parseComments(candidate.comments) } : {}),
		...(candidate.workflows ? { workflows: parseWorkflows(candidate.workflows) } : {}),
		...(candidate.looks ? { looks: parseLooks(candidate.looks) } : {}),
		...(Array.isArray(candidate.cursorTelemetry)
			? { cursorTelemetry: candidate.cursorTelemetry }
			: {}),
	};
}

/** Triggers a download of the project as a file. */
export function downloadProject(project: ProjectFile): void {
	const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = `${project.projectName.replace(/[/\\?%*:|"<>]/g, "-")}${PROJECT_EXTENSION}`;
	anchor.click();
	// Revoking immediately can cancel the download in some browsers.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Autosave ──────────────────────────────────────────────────────────

/**
 * Autosave keeps the edit across an accidental reload. It stores the same
 * shape as a project file, so recovery is just an open from memory.
 */
export function writeAutosave(project: ProjectFile): void {
	try {
		localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project));
	} catch {
		// A full or disabled localStorage must never break editing.
	}
}

export function readAutosave(): ProjectFile | null {
	try {
		const text = localStorage.getItem(AUTOSAVE_KEY);
		if (!text) return null;
		return parseProject(text);
	} catch {
		return null;
	}
}

export function clearAutosave(): void {
	try {
		localStorage.removeItem(AUTOSAVE_KEY);
	} catch {
		// Nothing to do; the next write overwrites it anyway.
	}
}

/** True when a saved project references media the session can't see. */
export function countOfflineAssets(assets: readonly AssetModel[]): number {
	return assets.filter((asset) => asset.offline).length;
}

/**
 * Matches freshly imported files to offline assets by name, so relinking a
 * folder of footage restores a whole project in one drop.
 */
export function relinkAssets(
	offline: readonly AssetModel[],
	incoming: readonly AssetModel[],
): { relinked: AssetModel[]; unmatched: AssetModel[] } {
	const byName = new Map(incoming.map((asset) => [asset.name, asset]));
	const relinked: AssetModel[] = [];
	const used = new Set<string>();

	for (const asset of offline) {
		const match = byName.get(asset.name);
		if (match && !used.has(match.id)) {
			used.add(match.id);
			// Keep the project's id so existing clips stay attached.
			relinked.push({ ...match, id: asset.id, offline: false });
		} else {
			relinked.push(asset);
		}
	}

	return {
		relinked,
		unmatched: incoming.filter((asset) => !used.has(asset.id)),
	};
}
