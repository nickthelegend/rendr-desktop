// Editor state, shaped after Palmier Pro's EditorViewModel.
//
// Every timeline mutation goes through `commit`, which pushes the previous
// timeline onto an undo stack — Palmier's rule that one coherent user intent is
// one undoable action, and that UI and agent edits share one history.
//
// A new project is genuinely empty. Nothing here seeds placeholder media or a
// pretend conversation; the panels' empty states are the first-run experience.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { forgetWaveform } from "./audio";
import { type BackgroundSettings, DEFAULT_BACKGROUND } from "./background";
import {
	type Cue,
	groupWordsIntoCues,
	narrationCues,
	parseSubtitles,
	placeCaptions,
	removeCaptionGroup,
	SubtitleParseError,
	toSrt,
} from "./captions";
import { type CommentModel, type CommentSeed, createComment, sortComments } from "./comments";
import { type LookModel, parseLooks, sameName } from "./looks";
import { DEFAULT_VOICE, planNarration, speakToAsset } from "./voice";
import type { WorkflowModel } from "./workflow";

/** One track holds every narration line, reused across runs. */
const NARRATION_TRACK = "Narration";

export interface NarrationOptions {
	voice?: string;
	speed?: number;
	regenerate?: boolean;
	commentIds?: readonly string[];
	/** Karaoke subtitles on the CC track, cut from the script. Default on. */
	subtitles?: boolean;
}

export interface NarrationResult {
	spoken: number;
	skipped: number;
	voice: string;
	lines: Array<{ commentId: string; startFrame: number; seconds: number; text: string }>;
}

import { type CursorSettings, DEFAULT_CURSOR } from "./cursor";
import { forgetDecodedSources } from "./frames";
import { type AssetModel, importFiles, normalizeFolder, releaseAsset } from "./media";
import { forgetDenoised } from "./mixdown";
import { type ClipModel, withDefaults } from "./model";
import {
	clearAutosave,
	downloadProject,
	offlineAsset,
	ProjectParseError,
	parseProject,
	readAutosave,
	relinkAssets,
	serializeProject,
	writeAutosave,
} from "./project";
import {
	addTextClip,
	addTrack,
	totalFrames as computeTotalFrames,
	duplicateClips,
	nudgeClips,
	pasteClips,
	removeClips,
	setClipTransform,
	type TimelineModel,
	type TrackModel,
} from "./reducers";
import type { FocusedPanel, LayoutPreset, ToolMode } from "./theme";
import { DEFAULT_WEBCAM, type WebcamSettings } from "./webcam";
import { DEFAULT_ZOOM_TIMING, type ZoomTiming } from "./zoom";

export type { AssetModel } from "./media";
export type { ClipModel } from "./model";
export type { TimelineModel, TrackModel } from "./reducers";

export type AgentEntry =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; text: string }
	| {
			kind: "tool";
			id: string;
			tool: string;
			status: "ok" | "error" | "pending";
			detail: string;
	  };

export interface Toast {
	id: string;
	message: string;
	tone: "info" | "error";
}

/** One line of text asked for in a sheet. See `askFor`. */
export interface PromptRequest {
	title: string;
	label: string;
	initialValue: string;
	confirmLabel?: string;
	onConfirm: (value: string) => void;
}

export type RecordingPhase = "idle" | "countdown" | "recording" | "paused" | "finalizing";

export interface RecordingState {
	phase: RecordingPhase;
	/** Seconds of capture so far. */
	elapsed: number;
	countdown: number;
	sourceName: string | null;
	captureCursor: boolean;
	microphone: boolean;
	systemAudio: boolean;
}

/** What `add_captions` may say about the captions it is about to create. */
export interface CaptionPlacementOptions {
	style?: Record<string, unknown>;
	transform?: Record<string, unknown> | null;
	/** Words per caption. Absent means the default line-length grouping. */
	maxWords?: number | null;
}

/** Starts a render and hands back the job id `manage_exports` tracks. */
export type ExporterHook = (settings: Record<string, unknown>) => Promise<string>;

/** What EditorShell hands the agent tools so they can drive real capture. */
export interface RecorderHooks {
	start: (
		sourceId: string | undefined,
		options: {
			countdownSeconds?: number;
			microphoneDeviceId?: string;
			systemAudio?: boolean;
			captureCursor?: boolean;
			name?: string;
		},
	) => Promise<{ sourceName: string; recordingId: string }>;
	stop: (options: {
		discard?: boolean;
	}) => Promise<{ assetId: string | null; name: string; durationSeconds: number }>;
}

export interface CaptureSource {
	id: string;
	name: string;
	kind: "screen" | "window" | "camera";
	/** A live frame of the source, as a data URL. Recordly's picker shows these. */
	thumbnail?: string | null;
	/** The owning application's icon, for windows. */
	appIcon?: string | null;
	/** Which app owns this window, shown as the row's subtitle. */
	appName?: string;
	/** True for the display the menu bar is on. */
	primary?: boolean;
}

/** One render, tracked so `manage_exports` reports something real. */
export interface ExportJob {
	id: string;
	filename: string;
	status: "queued" | "running" | "done" | "cancelled" | "failed";
	/** 0–1. */
	progress: number;
	warning?: string;
	/** Where the file actually landed, once the download finishes. */
	path?: string;
}

export interface EditorState {
	projectName: string;
	layoutPreset: LayoutPreset;
	focusedPanel: FocusedPanel | null;
	maximizedPanel: FocusedPanel | null;
	agentPanelVisible: boolean;
	mediaPanelVisible: boolean;
	inspectorPanelVisible: boolean;
	toolMode: ToolMode;
	zoomScale: number;
	playing: boolean;
	/**
	 * Playback speed as a plain multiplier.
	 *
	 * Continuous rather than a set of 1×/2× buttons: reviewing a screen
	 * recording is mostly done somewhere between 1 and 2, and the useful rate
	 * for a given passage is whatever keeps it readable — a value you find by
	 * dragging, not one you pick from a list. This is a *review* control and
	 * never touches the timeline, so nothing it does can reach the export.
	 */
	playbackRate: number;
	playhead: number;
	selectedClipIds: string[];
	selectedZoomRegionId: string | null;
	selectedAssetId: string | null;
	activeTimelineId: string;
	timelines: TimelineModel[];
	assets: AssetModel[];
	agentLog: AgentEntry[];
	agentConnected: boolean;
	cursorTelemetry: CursorTelemetryPoint[];
	/**
	 * Notes pinned to the timeline — review marks, and the script narration is
	 * generated from. Kept beside the timelines rather than inside them because
	 * a note is not a clip and must never affect what renders.
	 */
	comments: CommentModel[];
	/** Workflow graphs — an edit described rather than performed by hand. */
	workflows: WorkflowModel[];
	/**
	 * Named grades, kept beside the timelines rather than inside them: a look
	 * exists to outlive the clip it was pulled from.
	 */
	looks: LookModel[];
	activeWorkflowId: string | null;
	recording: RecordingState;
	captureSources: CaptureSource[];
	toasts: Toast[];
	/**
	 * The open text prompt, if any.
	 *
	 * Electron's Chromium has `window.prompt` removed, so a rename that used it
	 * would silently do nothing. Rendr asks through its own sheet instead.
	 */
	prompt: PromptRequest | null;
	undoStack: TimelineModel[];
	redoStack: TimelineModel[];
	lastAction: string | null;
	dirty: boolean;
	/** Clips lifted by copy or cut, waiting to be pasted. */
	clipboard: ClipModel[];
	shortcutsOpen: boolean;
	/** True while a transcription is running. */
	transcribing: boolean;
	/** Renders started this session, newest last. */
	exports: ExportJob[];
	/** The id handed out by start_recording, while a take is running. */
	activeRecordingId: string | null;
	/** How the drawn pointer looks. Rendr draws its own, as Recordly does. */
	cursor: CursorSettings;
	/** The camera inset composited over the capture. */
	webcam: WebcamSettings;
	/** The backdrop a screen recording sits on. */
	background: BackgroundSettings;
	/** How a zoom punches in and releases — Recordly's timing. */
	zoomTiming: ZoomTiming;
}

const FPS = 30;
const UNDO_LIMIT = 100;
const IMAGE_DEFAULT_SECONDS = 5;

/** An empty project: one video track and one audio track, no clips. */
function emptyTimeline(): TimelineModel {
	const tracks: TrackModel[] = [
		{ id: "trk-v1", name: "V1", kind: "video", muted: false, hidden: false, clips: [] },
		{ id: "trk-a1", name: "A1", kind: "audio", muted: false, hidden: false, clips: [] },
	];
	return { id: "tl-main", name: "Main", fps: FPS, width: 1920, height: 1080, tracks };
}

function initialState(): EditorState {
	return {
		projectName: "Untitled Project",
		layoutPreset: "default",
		focusedPanel: null,
		maximizedPanel: null,
		agentPanelVisible: true,
		mediaPanelVisible: true,
		inspectorPanelVisible: true,
		toolMode: "pointer",
		zoomScale: 1,
		playing: false,
		playbackRate: 1,
		playhead: 0,
		selectedClipIds: [],
		selectedZoomRegionId: null,
		selectedAssetId: null,
		activeTimelineId: "tl-main",
		timelines: [emptyTimeline()],
		assets: [],
		agentLog: [],
		agentConnected: false,
		cursorTelemetry: [],
		comments: [],
		workflows: [],
		looks: [],
		activeWorkflowId: null,
		recording: {
			phase: "idle",
			elapsed: 0,
			countdown: 0,
			sourceName: null,
			captureCursor: true,
			microphone: false,
			systemAudio: false,
		},
		captureSources: [],
		toasts: [],
		prompt: null,
		undoStack: [],
		redoStack: [],
		lastAction: null,
		dirty: false,
		clipboard: [],
		shortcutsOpen: false,
		transcribing: false,
		exports: [],
		activeRecordingId: null,
		cursor: { ...DEFAULT_CURSOR },
		webcam: { ...DEFAULT_WEBCAM },
		background: { ...DEFAULT_BACKGROUND },
		zoomTiming: { ...DEFAULT_ZOOM_TIMING },
	};
}

/**
 * Cancel handles live outside React state because they are functions, not data
 * — putting them in state would make every render carry a live encoder.
 */
const exportCancels = new Map<string, () => void>();

/**
 * The speed range the bar offers.
 *
 * A quarter speed is slow enough to read a fast interaction frame by frame;
 * four is fast enough to skim a long take without the picture becoming
 * meaningless. Beyond that the audio is unintelligible and the video is a blur,
 * so the bar stops rather than pretending those rates are useful.
 */
export const PLAYBACK_RATE = { min: 0.25, max: 4, step: 0.05, default: 1 } as const;

let toastCounter = 0;

export function useEditorState() {
	const [state, setState] = useState<EditorState>(initialState);
	const timers = useRef<{ countdown?: number; elapsed?: number }>({});
	/** Assets asked to be freed, and the last url each was known by. */
	const releasedAssets = useRef<Set<string>>(new Set());
	const releasedUrls = useRef<Map<string, AssetModel>>(new Map());

	const patch = useCallback((next: Partial<EditorState>) => {
		setState((current) => ({ ...current, ...next }));
	}, []);

	const timeline = useMemo(
		() =>
			state.timelines.find((item) => item.id === state.activeTimelineId) ??
			state.timelines[0],
		[state.activeTimelineId, state.timelines],
	);

	const totalFrames = useMemo(() => computeTotalFrames(timeline), [timeline]);

	const toast = useCallback((message: string, tone: Toast["tone"] = "info") => {
		toastCounter += 1;
		const id = `toast-${toastCounter}`;
		setState((current) => ({ ...current, toasts: [...current.toasts, { id, message, tone }] }));
		window.setTimeout(() => {
			setState((current) => ({
				...current,
				toasts: current.toasts.filter((entry) => entry.id !== id),
			}));
		}, 5000);
	}, []);

	/** Opens the rename sheet. The callback runs with the trimmed value. */
	const askFor = useCallback((request: PromptRequest) => {
		setState((current) => ({ ...current, prompt: request }));
	}, []);

	const closePrompt = useCallback(() => {
		setState((current) => (current.prompt ? { ...current, prompt: null } : current));
	}, []);

	/** Playback speed. Clamped to the range the transport bar offers. */
	const setPlaybackRate = useCallback((rate: number) => {
		setState((current) => ({
			...current,
			playbackRate: Math.min(PLAYBACK_RATE.max, Math.max(PLAYBACK_RATE.min, rate)),
		}));
	}, []);

	/** Pins a note to a frame, and optionally to a track. */
	const addComment = useCallback((seed: CommentSeed) => {
		const comment = createComment(seed);
		setState((current) => ({
			...current,
			comments: sortComments([...current.comments, comment]),
			dirty: true,
		}));
		return comment;
	}, []);

	const updateComment = useCallback((id: string, patchValue: Partial<CommentModel>) => {
		setState((current) => ({
			...current,
			comments: sortComments(
				current.comments.map((comment) =>
					comment.id === id ? { ...comment, ...patchValue, id: comment.id } : comment,
				),
			),
			dirty: true,
		}));
	}, []);

	const removeComment = useCallback((id: string) => {
		setState((current) => ({
			...current,
			comments: current.comments.filter((comment) => comment.id !== id),
			dirty: true,
		}));
	}, []);

	/** Replaces one workflow, keeping the rest. */
	const updateWorkflow = useCallback(
		(workflowId: string, change: (workflow: WorkflowModel) => WorkflowModel) => {
			setState((current) => ({
				...current,
				workflows: current.workflows.map((workflow) =>
					workflow.id === workflowId ? change(workflow) : workflow,
				),
				dirty: true,
			}));
		},
		[],
	);

	const addWorkflow = useCallback((workflow: WorkflowModel) => {
		setState((current) => ({
			...current,
			// Replace on id collision rather than appending a shadow: two
			// workflows sharing an id means every lookup returns whichever came
			// first, so the new one is invisible while appearing to exist.
			workflows: [...current.workflows.filter((entry) => entry.id !== workflow.id), workflow],
			activeWorkflowId: workflow.id,
			dirty: true,
		}));
		return workflow;
	}, []);

	/**
	 * Saves a look, replacing any existing one with the same name.
	 *
	 * Replace rather than append: two looks called "Warm" means every apply by
	 * name resolves to whichever was stored first, so the new one would appear
	 * to save and then do nothing.
	 */
	const saveLook = useCallback((look: LookModel) => {
		setState((current) => ({
			...current,
			looks: [
				...current.looks.filter(
					(entry) => entry.id !== look.id && !sameName(entry.name, look.name),
				),
				look,
			],
			dirty: true,
		}));
		return look;
	}, []);

	const removeLook = useCallback((lookId: string) => {
		setState((current) => ({
			...current,
			looks: current.looks.filter((look) => look.id !== lookId),
			dirty: true,
		}));
	}, []);

	const renameLook = useCallback((lookId: string, name: string) => {
		setState((current) => ({
			...current,
			looks: current.looks.map((look) => (look.id === lookId ? { ...look, name } : look)),
			dirty: true,
		}));
	}, []);

	const removeWorkflow = useCallback((workflowId: string) => {
		setState((current) => ({
			...current,
			workflows: current.workflows.filter((workflow) => workflow.id !== workflowId),
			activeWorkflowId:
				current.activeWorkflowId === workflowId ? null : current.activeWorkflowId,
			dirty: true,
		}));
	}, []);

	const dismissToast = useCallback((id: string) => {
		setState((current) => ({ ...current, toasts: current.toasts.filter((t) => t.id !== id) }));
	}, []);

	/**
	 * Applies a timeline reducer and records one undo step. A reducer that
	 * returns the same reference is a no-op and must not create an undo entry —
	 * Palmier's rule that unchanged operations leave no empty steps.
	 */
	const commit = useCallback(
		(action: string, reduce: (current: TimelineModel) => TimelineModel) => {
			setState((current) => {
				const active =
					current.timelines.find((item) => item.id === current.activeTimelineId) ??
					current.timelines[0];
				const next = reduce(active);
				if (next === active) return current;

				return {
					...current,
					timelines: current.timelines.map((item) =>
						item.id === active.id ? next : item,
					),
					undoStack: [...current.undoStack.slice(-(UNDO_LIMIT - 1)), active],
					redoStack: [],
					lastAction: action,
					dirty: true,
				};
			});
		},
		[],
	);

	const undo = useCallback(() => {
		setState((current) => {
			const previous = current.undoStack[current.undoStack.length - 1];
			if (!previous) return current;
			const active =
				current.timelines.find((item) => item.id === current.activeTimelineId) ??
				current.timelines[0];
			return {
				...current,
				timelines: current.timelines.map((item) =>
					item.id === previous.id ? previous : item,
				),
				undoStack: current.undoStack.slice(0, -1),
				redoStack: [...current.redoStack, active],
				lastAction: "Undo",
				dirty: true,
			};
		});
	}, []);

	const redo = useCallback(() => {
		setState((current) => {
			const next = current.redoStack[current.redoStack.length - 1];
			if (!next) return current;
			const active =
				current.timelines.find((item) => item.id === current.activeTimelineId) ??
				current.timelines[0];
			return {
				...current,
				timelines: current.timelines.map((item) => (item.id === next.id ? next : item)),
				undoStack: [...current.undoStack, active],
				redoStack: current.redoStack.slice(0, -1),
				lastAction: "Redo",
				dirty: true,
			};
		});
	}, []);

	const selection = useMemo(() => {
		const ids = new Set(state.selectedClipIds);
		const clips: Array<{ clip: ClipModel; track: TrackModel }> = [];
		for (const track of timeline.tracks) {
			for (const clip of track.clips) {
				if (ids.has(clip.id)) clips.push({ clip, track });
			}
		}
		return clips;
	}, [state.selectedClipIds, timeline]);

	const selectClip = useCallback((clipId: string, additive: boolean) => {
		setState((current) => {
			if (!additive) {
				return { ...current, selectedClipIds: [clipId], selectedZoomRegionId: null };
			}
			const has = current.selectedClipIds.includes(clipId);
			return {
				...current,
				selectedClipIds: has
					? current.selectedClipIds.filter((id) => id !== clipId)
					: [...current.selectedClipIds, clipId],
			};
		});
	}, []);

	const toggleMaximize = useCallback((panel: FocusedPanel) => {
		setState((current) => ({
			...current,
			maximizedPanel: current.maximizedPanel === panel ? null : panel,
		}));
	}, []);

	const logAgent = useCallback((entry: AgentEntry) => {
		setState((current) => ({ ...current, agentLog: [...current.agentLog, entry] }));
	}, []);

	/**
	 * Appends streamed assistant text to one message. The CLI emits fragments;
	 * logging each separately would fill the panel with slivers of a sentence.
	 */
	const appendAssistantText = useCallback((id: string, text: string) => {
		setState((current) => {
			const existing = current.agentLog.find((entry) => entry.id === id);
			if (!existing) {
				return {
					...current,
					agentLog: [...current.agentLog, { kind: "assistant", id, text }],
				};
			}
			return {
				...current,
				agentLog: current.agentLog.map((entry) =>
					entry.id === id && entry.kind === "assistant"
						? { ...entry, text: entry.text + text }
						: entry,
				),
			};
		});
	}, []);

	// ── Media ─────────────────────────────────────────────────────────

	const addAssets = useCallback((assets: AssetModel[]) => {
		setState((current) => ({
			...current,
			assets: [...current.assets, ...assets],
			selectedAssetId: assets[assets.length - 1]?.id ?? current.selectedAssetId,
			dirty: true,
		}));
	}, []);

	/** Import dropped or picked files, reporting anything that could not be read. */
	const importMedia = useCallback(
		async (files: readonly File[]): Promise<AssetModel[]> => {
			if (files.length === 0) return [];
			const { assets, rejected } = await importFiles(files);
			for (const reason of rejected) toast(reason, "error");
			if (assets.length === 0) return [];

			/**
			 * What actually lands in the library. An open project's missing media
			 * is matched by filename first, so relinking a folder restores the
			 * whole edit in one drop — and a relinked asset keeps its original id,
			 * so the caller can't assume these are the freshly-read `assets`.
			 */
			const plan = (existing: readonly AssetModel[]) => {
				const offline = existing.filter((asset) => asset.offline);
				if (offline.length === 0) {
					return { next: [...existing, ...assets], landed: assets, restored: 0 };
				}
				const { relinked, unmatched } = relinkAssets(offline, assets);
				const relinkedById = new Map(relinked.map((asset) => [asset.id, asset]));
				return {
					next: [
						...existing.map((asset) => relinkedById.get(asset.id) ?? asset),
						...unmatched,
					],
					landed: [...relinked.filter((asset) => !asset.offline), ...unmatched],
					restored: relinked.filter((asset) => !asset.offline).length,
				};
			};

			// Planned against the snapshot in hand so the return value is true to
			// what happened: a value read back after setState would still be
			// empty, because React runs an updater when it schedules, not when
			// it is called.
			const planned = plan(state.assets);
			setState((current) => {
				const applied = current.assets === state.assets ? planned : plan(current.assets);
				return {
					...current,
					assets: applied.next,
					selectedAssetId:
						applied.landed[applied.landed.length - 1]?.id ?? current.selectedAssetId,
					dirty: true,
				};
			});

			if (planned.restored > 0) {
				toast(`Relinked ${planned.restored} ${planned.restored === 1 ? "file" : "files"}`);
			}
			toast(`Imported ${assets.length} ${assets.length === 1 ? "item" : "items"}`);
			return planned.landed;
		},
		[state.assets, toast],
	);

	/** Files assets into a library folder. An empty path means the root. */
	const moveAssets = useCallback((assetIds: readonly string[], folder: string) => {
		const target = normalizeFolder(folder);
		const ids = new Set(assetIds);
		if (ids.size === 0) return;
		setState((current) => ({
			...current,
			assets: current.assets.map((asset) =>
				ids.has(asset.id) ? { ...asset, folder: target } : asset,
			),
			dirty: true,
		}));
	}, []);

	/**
	 * Renames or re-parents a folder by rewriting the paths its assets carry —
	 * folders have no existence apart from those paths, so this is the move.
	 */
	const moveFolder = useCallback((from: string, to: string) => {
		const source = normalizeFolder(from);
		const destination = normalizeFolder(to);
		if (!source || source === destination) return;
		setState((current) => ({
			...current,
			assets: current.assets.map((asset) => {
				const path = asset.folder;
				if (!path || (path !== source && !path.startsWith(`${source}/`))) return asset;
				const tail = path.slice(source.length);
				const next = normalizeFolder(`${destination ?? ""}${tail}`);
				return { ...asset, folder: next };
			}),
			dirty: true,
		}));
	}, []);

	/**
	 * Pairs an existing video as a screen take's camera.
	 *
	 * Recording both at once is the normal path, but a camera shot separately —
	 * on a phone, or by another tool — is just as valid a source for the inset,
	 * and without this there is no way to use one. Passing null unpairs.
	 */
	const pairCamera = useCallback((screenAssetId: string, cameraAssetId: string | null) => {
		setState((current) => ({
			...current,
			assets: current.assets.map((asset) => {
				if (asset.id === screenAssetId) {
					return cameraAssetId
						? { ...asset, webcamAssetId: cameraAssetId }
						: { ...asset, webcamAssetId: undefined };
				}
				// The camera asset is marked so the library badges it and nobody
				// wonders why placing it duplicates the inset.
				if (cameraAssetId && asset.id === cameraAssetId) {
					return { ...asset, isWebcam: true };
				}
				return asset;
			}),
			dirty: true,
		}));
	}, []);

	const renameAsset = useCallback((assetId: string, name: string) => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setState((current) => ({
			...current,
			assets: current.assets.map((asset) =>
				asset.id === assetId ? { ...asset, name: trimmed } : asset,
			),
			dirty: true,
		}));
	}, []);

	const removeAsset = useCallback((assetId: string) => {
		// The object URL, the denoised copy and the decoded element are all
		// released outside the updater: React may run an updater twice, and
		// revoking a URL twice would free one a retry still needs.
		releasedAssets.current.add(assetId);
		setState((current) => {
			return {
				...current,
				assets: current.assets
					.filter((entry) => entry.id !== assetId)
					// A take whose camera file has just been deleted no longer has
					// one to composite. Left pointing at nothing it would look, to
					// every readback, like a take with a camera.
					.map((entry) =>
						entry.webcamAssetId === assetId
							? { ...entry, webcamAssetId: undefined }
							: entry,
					),
				selectedAssetId:
					current.selectedAssetId === assetId ? null : current.selectedAssetId,
				// Clips referencing a deleted asset would render nothing.
				timelines: current.timelines.map((item) => ({
					...item,
					tracks: item.tracks.map((track) => ({
						...track,
						clips: track.clips.filter((clip) => clip.assetId !== assetId),
					})),
				})),
				dirty: true,
			};
		});
	}, []);

	/**
	 * Frees what a removed asset was holding.
	 *
	 * Run as an effect rather than in the updater so it happens exactly once per
	 * commit, and after the render that stopped referencing the asset — releasing
	 * a URL a still-mounted <video> is playing would blank it.
	 */
	useEffect(() => {
		if (releasedAssets.current.size === 0) return;
		const gone = [...releasedAssets.current].filter(
			(id) => !state.assets.some((asset) => asset.id === id),
		);
		if (gone.length === 0) return;
		for (const id of gone) {
			releasedAssets.current.delete(id);
			const asset = releasedUrls.current.get(id);
			if (asset) {
				releaseAsset(asset);
				releasedUrls.current.delete(id);
			}
			forgetDenoised(id);
			forgetWaveform(id);
		}
		// The decode cache is keyed on the whole asset list, so one removal
		// invalidates it wholesale.
		forgetDecodedSources();
	}, [state.assets]);

	// Every asset that has been seen, so the effect above can still reach the
	// url of one the state has already dropped.
	useEffect(() => {
		for (const asset of state.assets) releasedUrls.current.set(asset.id, asset);
	}, [state.assets]);

	/**
	 * Place an asset on the timeline at `atFrame`, on the first track of the
	 * matching kind, clearing whatever it lands on as add_clips does.
	 */
	const placeAsset = useCallback(
		(assetId: string, atFrame: number) => {
			const asset = state.assets.find((entry) => entry.id === assetId);
			if (!asset) return;

			const seconds =
				asset.durationSeconds > 0 ? asset.durationSeconds : IMAGE_DEFAULT_SECONDS;
			const durationFrames = Math.max(1, Math.round(seconds * timeline.fps));
			const start = Math.max(0, Math.round(atFrame));
			const clipId = `clip-${assetId}-${start}`;

			commit(`Add ${asset.name}`, (current) => {
				const wantsVideo = asset.type !== "audio";
				const trackIndex = current.tracks.findIndex((track) =>
					wantsVideo ? track.kind === "video" : track.kind === "audio",
				);
				if (trackIndex < 0) return current;

				const clip = withDefaults({
					id: clipId,
					name: asset.name,
					mediaType: asset.type === "image" ? "image" : asset.type,
					assetId,
					startFrame: start,
					endFrame: start + durationFrames,
				});

				const tracks = current.tracks.map((track, index) =>
					index === trackIndex
						? {
								...track,
								clips: [
									...track.clips.filter(
										(existing) =>
											existing.endFrame <= clip.startFrame ||
											existing.startFrame >= clip.endFrame,
									),
									clip,
								].sort((a, b) => a.startFrame - b.startFrame),
							}
						: track,
				);

				return { ...current, tracks };
			});
			setState((current) => ({ ...current, selectedClipIds: [clipId] }));
		},
		[commit, state.assets, timeline.fps],
	);

	// ── Project ───────────────────────────────────────────────────────

	/**
	 * Speaks the timeline's notes and lays them on the narration track.
	 *
	 * Owned here rather than in the agent tool so the button in the inspector
	 * and `narrate_timeline` run the same code — a voiceover an agent generates
	 * has to be the same one a person gets, and two implementations would drift.
	 *
	 * Every line is generated before anything is committed, so a failure part
	 * way through leaves the timeline untouched rather than half-narrated.
	 */
	const runNarration = useCallback(
		async (options: NarrationOptions = {}): Promise<NarrationResult> => {
			const wanted = options.commentIds?.length
				? state.comments.filter((comment) => options.commentIds?.includes(comment.id))
				: state.comments;
			const todo = planNarration(wanted, { regenerate: options.regenerate }).filter(
				(entry) => !entry.skipped,
			);
			const voice = options.voice ?? DEFAULT_VOICE;
			const speed = options.speed ?? 1;
			if (todo.length === 0) return { spoken: 0, skipped: wanted.length, lines: [], voice };

			const rendered: Array<{
				comment: CommentModel;
				asset: AssetModel;
				seconds: number;
			}> = [];
			for (const entry of todo) {
				const line = await speakToAsset(entry.comment.text, { voice, speed });
				rendered.push({ comment: entry.comment, asset: line.asset, seconds: line.seconds });
			}

			addAssets(rendered.map((line) => line.asset));

			const fps = timeline.fps;
			commit("Narrate timeline", (current) => {
				let next = current;

				// Subtitles, cut from the same script. The narration lines are
				// the one transcript this app is certain of, so the karaoke
				// captions come straight from them. Replaced wholesale each run,
				// so re-narrating never stacks stale cues under new audio.
				if (options.subtitles !== false) {
					next = removeCaptionGroup(next, "narration");
					next = placeCaptions(
						next,
						narrationCues(
							rendered.map((line) => ({
								commentId: line.comment.id,
								startFrame: line.comment.frame,
								seconds: line.seconds,
								text: line.comment.text,
							})),
							fps,
						),
						{
							groupId: "narration",
							toFrame: (sourceMs) => Math.round((sourceMs / 1000) * fps),
							// A subtitle is read at a glance, so the whole cue is
							// on screen for its whole duration. Karaoke highlights
							// one word at a time, which is right for a lyric and
							// wrong for a line somebody is trying to read while
							// also watching the demo. (Word timing is still stored
							// on the clip, so switching the preset back is a style
							// change and not a regeneration.)
							style: { animation: "fade" },
						},
					).timeline;
				}
				let track = next.tracks.find((entry) => entry.name === NARRATION_TRACK);
				if (!track) {
					next = addTrack(next, "audio");
					const created = next.tracks[next.tracks.length - 1];
					next = {
						...next,
						tracks: next.tracks.map((entry) =>
							entry.id === created.id ? { ...entry, name: NARRATION_TRACK } : entry,
						),
					};
					track = next.tracks.find((entry) => entry.name === NARRATION_TRACK);
				}
				if (!track) return current;

				const trackId = track.id;
				for (const line of rendered) {
					const startFrame = line.comment.frame;
					const durationFrames = Math.max(1, Math.round(line.seconds * next.fps));
					// A re-spoken note replaces its old take rather than stacking
					// a second one over it.
					const previous = line.comment.voice?.assetId;
					next = {
						...next,
						tracks: next.tracks.map((entry) =>
							entry.id !== trackId
								? entry
								: {
										...entry,
										clips: [
											...entry.clips.filter(
												(clip) => clip.assetId !== previous,
											),
											withDefaults({
												id: `narr-${line.comment.id}`,
												name: line.asset.name,
												mediaType: "audio",
												assetId: line.asset.id,
												startFrame,
												endFrame: startFrame + durationFrames,
											}),
										],
									},
						),
					};
				}
				return next;
			});

			// The notes remember what was said, so editing the wording later
			// shows as stale rather than silently disagreeing with the audio.
			setState((current) => ({
				...current,
				comments: current.comments.map((comment) => {
					const line = rendered.find((entry) => entry.comment.id === comment.id);
					return line
						? {
								...comment,
								voice: {
									assetId: line.asset.id,
									fromText: comment.text,
									voiceId: voice,
								},
							}
						: comment;
				}),
			}));

			return {
				spoken: rendered.length,
				skipped: wanted.length - rendered.length,
				voice,
				lines: rendered.map((line) => ({
					commentId: line.comment.id,
					startFrame: line.comment.frame,
					seconds: Number(line.seconds.toFixed(2)),
					text: line.comment.text,
				})),
			};
		},
		[addAssets, commit, state.comments, timeline.fps],
	);

	const snapshot = useCallback(
		() =>
			serializeProject({
				projectName: state.projectName,
				timelines: state.timelines,
				activeTimelineId: state.activeTimelineId,
				assets: state.assets,
				savedAt: new Date().toISOString(),
				cursor: state.cursor,
				webcam: state.webcam,
				background: state.background,
				zoomTiming: state.zoomTiming,
				comments: state.comments,
				workflows: state.workflows,
				looks: state.looks,
				// Without the telemetry a reopened project has no pointer to draw
				// and no clicks for suggest_zooms to read.
				cursorTelemetry: state.cursorTelemetry,
			}),
		[
			state.activeTimelineId,
			state.assets,
			state.cursor,
			state.cursorTelemetry,
			state.projectName,
			state.timelines,
			state.webcam,
			state.background,
			state.zoomTiming,
			state.comments,
			state.workflows,
			state.looks,
		],
	);

	// ── Exports ───────────────────────────────────────────────────────

	/** Registers a render so it shows up in the UI and in manage_exports. */
	const beginExport = useCallback((filename: string, cancel: () => void) => {
		const id = `job-${Date.now().toString(36)}-${exportCancels.size + 1}`;
		exportCancels.set(id, cancel);
		setState((current) => ({
			...current,
			exports: [...current.exports, { id, filename, status: "running", progress: 0 }],
		}));
		return id;
	}, []);

	const updateExport = useCallback((jobId: string, patchJob: Partial<ExportJob>) => {
		if (patchJob.status && patchJob.status !== "running" && patchJob.status !== "queued") {
			exportCancels.delete(jobId);
		}
		setState((current) => ({
			...current,
			exports: current.exports.map((job) =>
				job.id === jobId ? { ...job, ...patchJob } : job,
			),
		}));
	}, []);

	// A download's real path is only known once Electron has written it, so the
	// job is completed here rather than guessed at when the blob was handed over.
	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.onDownloadDone) return;
		return bridge.onDownloadDone((info) => {
			setState((current) => {
				// The newest job still missing a path is the one that just landed.
				let index = -1;
				for (let at = current.exports.length - 1; at >= 0; at--) {
					const job = current.exports[at];
					if (job.filename === info.filename || !job.path) {
						index = at;
						break;
					}
				}
				if (index < 0) return current;
				const exports = [...current.exports];
				exports[index] = {
					...exports[index],
					path: info.path,
					...(info.state === "completed"
						? {}
						: { warning: `The download ended as '${info.state}'.` }),
				};
				return { ...current, exports };
			});
		});
	}, []);

	const cancelExport = useCallback((jobId: string) => {
		exportCancels.get(jobId)?.();
		exportCancels.delete(jobId);
		setState((current) => ({
			...current,
			exports: current.exports.map((job) =>
				job.id === jobId && (job.status === "running" || job.status === "queued")
					? { ...job, status: "cancelled" }
					: job,
			),
		}));
	}, []);

	/** Writes text to the user's downloads — how interchange files leave Rendr. */
	const downloadText = useCallback(
		(text: string, filename: string, mimeType = "text/plain") => {
			const blob = new Blob([text], { type: mimeType });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			anchor.click();
			// Revoking immediately can cancel the download in some browsers.
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			toast(`Wrote ${filename}`);
		},
		[toast],
	);

	/**
	 * The shell owns the capture devices, so an agent-started recording has to
	 * go through the same code the Record button does rather than opening a
	 * second, parallel path that could drift from it.
	 */
	const recorderHooks = useRef<RecorderHooks | null>(null);
	const exporterHook = useRef<ExporterHook | null>(null);
	const registerExporter = useCallback((hook: ExporterHook | null) => {
		exporterHook.current = hook;
	}, []);
	const agentExport = useCallback(
		(settings: Record<string, unknown>) =>
			exporterHook.current
				? exporterHook.current(settings)
				: Promise.reject(new Error("The editor window isn't ready to export yet.")),
		[],
	);
	const registerRecorder = useCallback((hooks: RecorderHooks | null) => {
		recorderHooks.current = hooks;
	}, []);
	const agentStartRecording = useCallback(
		(sourceId: string | undefined, options: Parameters<RecorderHooks["start"]>[1]) =>
			recorderHooks.current
				? recorderHooks.current.start(sourceId, options)
				: Promise.reject(new Error("The editor window isn't ready to record yet.")),
		[],
	);
	const agentStopRecording = useCallback(
		(options: Parameters<RecorderHooks["stop"]>[0] = {}) =>
			recorderHooks.current
				? recorderHooks.current.stop(options)
				: Promise.reject(new Error("Nothing is recording.")),
		[],
	);

	const saveProject = useCallback(() => {
		downloadProject(snapshot());
		setState((current) => ({ ...current, dirty: false }));
		toast("Project saved");
	}, [snapshot, toast]);

	/**
	 * Loads a project file. Media is referenced rather than embedded, so the
	 * assets come back offline and the user is told what to relink.
	 */
	const loadProject = useCallback(
		(text: string) => {
			try {
				const file = parseProject(text);
				forgetDenoised();
				forgetWaveform();
				forgetDecodedSources();
				setState((current) => {
					for (const asset of current.assets) releaseAsset(asset);
					return {
						...current,
						projectName: file.projectName,
						timelines: file.timelines,
						activeTimelineId: file.activeTimelineId,
						assets: file.assets.map(offlineAsset),
						cursor: file.cursor ?? { ...DEFAULT_CURSOR },
						webcam: file.webcam ?? { ...DEFAULT_WEBCAM },
						background: file.background ?? { ...DEFAULT_BACKGROUND },
						zoomTiming: file.zoomTiming ?? { ...DEFAULT_ZOOM_TIMING },
						comments: file.comments ?? [],
						workflows: file.workflows ?? [],
						looks: parseLooks(file.looks),
						cursorTelemetry: file.cursorTelemetry ?? [],
						selectedClipIds: [],
						selectedZoomRegionId: null,
						selectedAssetId: null,
						playhead: 0,
						playing: false,
						undoStack: [],
						redoStack: [],
						clipboard: [],
						dirty: false,
						lastAction: "Opened project",
					};
				});
				if (file.assets.length > 0) {
					toast(
						`Opened "${file.projectName}". ${file.assets.length} media ${file.assets.length === 1 ? "file needs" : "files need"} relinking — import them to restore the picture.`,
					);
				} else {
					toast(`Opened "${file.projectName}"`);
				}
			} catch (error) {
				toast(
					error instanceof ProjectParseError
						? error.message
						: "Couldn't open that project.",
					"error",
				);
			}
		},
		[toast],
	);

	const newProject = useCallback(() => {
		forgetDenoised();
		forgetWaveform();
		forgetDecodedSources();
		setState((current) => {
			for (const asset of current.assets) releaseAsset(asset);
			return { ...initialState(), captureSources: current.captureSources };
		});
		clearAutosave();
		toast("New project");
	}, [toast]);

	const renameProject = useCallback((name: string) => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setState((current) => ({ ...current, projectName: trimmed, dirty: true }));
	}, []);

	/**
	 * Adds a timeline and switches to it. Duplicating gives every clip and track
	 * a fresh id, so editing the copy can never reach into the original.
	 *
	 * The new timeline is built here rather than inside the state updater: React
	 * runs an updater when it schedules, not when it is called, so a value read
	 * back afterwards is still null and the caller would report a real creation
	 * as a failure.
	 */
	/**
	 * Replaces a timeline that is not necessarily the active one.
	 *
	 * `commit` only ever touches the active cut, which is right for editing but
	 * leaves no way to build a derived timeline — a vertical variant, say —
	 * without switching to it first and switching back. Deliberately outside the
	 * undo stack: this creates cuts rather than editing one, and pushing each
	 * onto the stack would make undo walk backwards through a batch.
	 */
	const replaceTimeline = useCallback((next: TimelineModel) => {
		setState((current) => ({
			...current,
			timelines: current.timelines.map((item) => (item.id === next.id ? next : item)),
			dirty: true,
		}));
	}, []);

	const createTimeline = useCallback(
		(options: { name?: string; from?: string } = {}) => {
			const source = options.from
				? state.timelines.find((item) => item.id === options.from)
				: undefined;
			if (options.from && !source) return null;

			const active =
				state.timelines.find((item) => item.id === state.activeTimelineId) ??
				state.timelines[0];
			// Both halves of the obvious id are stale inside one synchronous
			// caller: `state` is the render's snapshot, so the count does not
			// move between two calls, and two calls land in the same
			// millisecond. Two timelines then share an id, every lookup returns
			// the first, and replaceTimeline overwrites both — which is exactly
			// what batch_export hit when its second variant silently replaced
			// its first. The random suffix is what makes that unrepresentable.
			const id = `tl-${Date.now().toString(36)}-${state.timelines.length + 1}-${Math.random()
				.toString(36)
				.slice(2, 8)}`;
			const stamp = id.slice(3);

			const created: TimelineModel = source
				? {
						...source,
						id,
						name: options.name ?? `${source.name} copy`,
						tracks: source.tracks.map((track, trackIndex) => ({
							...track,
							id: `${id}-t${trackIndex}`,
							clips: track.clips.map((clip) => ({
								...clip,
								id: `${clip.id}-${stamp}`,
							})),
						})),
					}
				: {
						id,
						name: options.name ?? `Timeline ${state.timelines.length + 1}`,
						fps: active.fps,
						width: active.width,
						height: active.height,
						tracks: [
							{
								id: `${id}-t0`,
								name: "V1",
								kind: "video",
								muted: false,
								hidden: false,
								clips: [],
							},
							{
								id: `${id}-t1`,
								name: "A1",
								kind: "audio",
								muted: false,
								hidden: false,
								clips: [],
							},
						],
					};

			setState((current) => ({
				...current,
				timelines: [...current.timelines, created],
				activeTimelineId: id,
				selectedClipIds: [],
				selectedZoomRegionId: null,
				playhead: 0,
				playing: false,
				lastAction: source ? "Duplicate timeline" : "New timeline",
				dirty: true,
			}));
			return created;
		},
		[state.activeTimelineId, state.timelines],
	);

	const setActiveTimeline = useCallback(
		(timelineId: string) => {
			// Same reason as createTimeline: the answer has to come from the
			// snapshot in hand, not from inside the updater.
			if (!state.timelines.some((item) => item.id === timelineId)) return false;
			setState((current) =>
				current.activeTimelineId === timelineId
					? current
					: {
							...current,
							activeTimelineId: timelineId,
							// Ids from the previous timeline aren't valid targets any more.
							selectedClipIds: [],
							selectedZoomRegionId: null,
							playhead: 0,
							playing: false,
						},
			);
			return true;
		},
		[state.timelines],
	);

	const removeTimeline = useCallback((timelineId: string) => {
		setState((current) => {
			if (current.timelines.length <= 1) return current;
			const timelines = current.timelines.filter((item) => item.id !== timelineId);
			if (timelines.length === current.timelines.length) return current;
			return {
				...current,
				timelines,
				activeTimelineId:
					current.activeTimelineId === timelineId
						? timelines[0].id
						: current.activeTimelineId,
				selectedClipIds: [],
				lastAction: "Delete timeline",
				dirty: true,
			};
		});
	}, []);

	const renameTimeline = useCallback((timelineId: string, name: string) => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setState((current) => ({
			...current,
			timelines: current.timelines.map((item) =>
				item.id === timelineId ? { ...item, name: trimmed } : item,
			),
			dirty: true,
		}));
	}, []);

	/**
	 * Changes frame rate and canvas size.
	 *
	 * Transforms and crops are normalised, so a resolution change needs no
	 * refitting — but frames are absolute, so a frame-rate change rescales every
	 * clip's position, trim, and fades to keep the cut at the same wall-clock
	 * time. That rescale is what makes this undoable rather than a settings write.
	 */
	const setProjectSettings = useCallback(
		(settings: { fps?: number; width?: number; height?: number }) => {
			commit("Project settings", (current) => {
				const fps = settings.fps
					? Math.max(1, Math.min(120, Math.round(settings.fps)))
					: current.fps;
				const width = settings.width
					? Math.max(16, Math.round(settings.width))
					: current.width;
				const height = settings.height
					? Math.max(16, Math.round(settings.height))
					: current.height;
				if (fps === current.fps && width === current.width && height === current.height) {
					return current;
				}

				const ratio = fps / current.fps;
				const scale = (value: number) => Math.round(value * ratio);
				const tracks =
					ratio === 1
						? current.tracks
						: current.tracks.map((track) => ({
								...track,
								clips: track.clips.map((clip) => {
									const startFrame = scale(clip.startFrame);
									return {
										...clip,
										startFrame,
										endFrame: Math.max(startFrame + 2, scale(clip.endFrame)),
										trimStartFrame: scale(clip.trimStartFrame),
										trimEndFrame: scale(clip.trimEndFrame),
										fadeInFrames: scale(clip.fadeInFrames),
										fadeOutFrames: scale(clip.fadeOutFrames),
										captionWords: clip.captionWords?.map((word) => ({
											...word,
											startFrame: scale(word.startFrame),
											endFrame: scale(word.endFrame),
										})),
									};
								}),
							}));

				return { ...current, fps, width, height, tracks };
			});
		},
		[commit],
	);

	/** Autosave so a reload doesn't lose the edit. */
	useEffect(() => {
		if (!state.dirty) return;
		const handle = window.setTimeout(() => writeAutosave(snapshot()), 1200);
		return () => window.clearTimeout(handle);
	}, [snapshot, state.dirty]);

	/** Recover an autosave once, on first mount. */
	const recovered = useRef(false);
	useEffect(() => {
		if (recovered.current) return;
		recovered.current = true;
		const saved = readAutosave();
		if (
			!saved ||
			saved.timelines.every((t) => t.tracks.every((track) => track.clips.length === 0))
		) {
			return;
		}
		setState((current) => ({
			...current,
			projectName: saved.projectName,
			timelines: saved.timelines,
			activeTimelineId: saved.activeTimelineId,
			assets: saved.assets.map(offlineAsset),
			// Recovered with the take, not just the cuts: without the pointer
			// path the recovered project has no cursor to draw and nothing for
			// suggest_zooms to read.
			cursor: saved.cursor ?? current.cursor,
			webcam: saved.webcam ?? current.webcam,
			background: saved.background ?? current.background,
			zoomTiming: saved.zoomTiming ?? current.zoomTiming,
			comments: saved.comments ?? current.comments,
			workflows: saved.workflows ?? current.workflows,
			looks: parseLooks(saved.looks).length ? parseLooks(saved.looks) : current.looks,
			cursorTelemetry: saved.cursorTelemetry ?? current.cursorTelemetry,
			lastAction: "Recovered autosave",
		}));
		toast(`Recovered "${saved.projectName}" from autosave — media needs relinking.`);
	}, [toast]);

	/** Don't let a reload discard unsaved work silently. */
	useEffect(() => {
		if (!state.dirty) return;
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [state.dirty]);

	// ── Clipboard ─────────────────────────────────────────────────────

	const copySelection = useCallback(() => {
		const clips = selection.map((entry) => entry.clip);
		if (clips.length === 0) return;
		setState((current) => ({ ...current, clipboard: clips }));
		toast(`Copied ${clips.length} clip${clips.length === 1 ? "" : "s"}`);
	}, [selection, toast]);

	// ── Captions ──────────────────────────────────────────────────────

	/**
	 * Turns cues into caption clips against a clip on the timeline. Cue times
	 * are source milliseconds of that clip, so they map through its trim and
	 * speed the way zoom regions do.
	 */
	/**
	 * Places cues as caption clips and hands back the group id.
	 *
	 * `placement` is what `add_captions` was declared to accept: a text style,
	 * a box to put the captions in, and how many words a caption may hold.
	 */
	const applyCaptions = useCallback(
		(
			cues: readonly Cue[],
			hostClipId: string | null,
			placement: CaptionPlacementOptions = {},
		): string | null => {
			if (cues.length === 0) {
				toast("No speech found to caption.", "error");
				return null;
			}
			const host = hostClipId
				? timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === hostClipId)
				: null;
			const groupId = `g${Date.now().toString(36)}`;
			let count = 0;

			commit("Add captions", (current) => {
				const result = placeCaptions(current, cues, {
					groupId,
					toFrame: (sourceMs) =>
						host
							? clipSourceMsToFrame(host, sourceMs, current.fps)
							: (sourceMs / 1000) * current.fps,
					style: placement.style as never,
					// A transform's centreY is where the caption sits; the rest of
					// the box is applied after placement, once the clips exist.
					centerY:
						typeof placement.transform?.centerY === "number"
							? placement.transform.centerY
							: undefined,
				});
				count = result.clipCount;
				if (!placement.transform) return result.timeline;
				const placed = result.timeline.tracks
					.flatMap((track) => track.clips)
					.filter((clip) => clip.captionGroupId === groupId)
					.map((clip) => clip.id);
				return setClipTransform(result.timeline, placed, placement.transform as never);
			});
			toast(`Added ${count} caption${count === 1 ? "" : "s"}`);
			return groupId;
		},
		[commit, timeline, toast],
	);

	/**
	 * Transcribes a clip's audio into captions.
	 *
	 * The speech model is whisper.cpp, which Recordly already bundles and runs
	 * in the main process. A browser tab has no such model — there is no
	 * file-based speech API — so it says so rather than silently doing nothing.
	 */
	const transcribe = useCallback(
		async (clipId: string, placement: CaptionPlacementOptions = {}) => {
			const clip = timeline.tracks
				.flatMap((track) => track.clips)
				.find((c) => c.id === clipId);
			const asset = clip ? state.assets.find((entry) => entry.id === clip.assetId) : null;
			if (!clip || !asset) {
				toast("Select a clip with audio to transcribe.", "error");
				return;
			}
			if (asset.offline) {
				toast(`"${asset.name}" needs relinking before it can be transcribed.`, "error");
				return;
			}

			const bridge = window.electronAPI;
			if (!bridge?.transcribeAudio) {
				toast(
					"Transcription runs a speech model in the desktop app; a browser tab can't. Import an .srt or .vtt instead.",
					"error",
				);
				return;
			}

			setState((current) => ({ ...current, transcribing: true }));
			try {
				const result = await bridge.transcribeAudio(asset.url, asset.name);
				if (!result.ok) {
					toast(result.reason ?? "Transcription failed.", "error");
					return;
				}
				// Word-level timing groups into readable cues and drives karaoke
				// off the real speech; cue-level timing has to be inferred.
				const cues = result.words
					? groupWordsIntoCues(result.words, {
							maxWords: placement.maxWords ?? undefined,
						})
					: ((result.cues ?? []) as Cue[]);
				applyCaptions(cues, clipId, placement);
			} catch (error) {
				toast(error instanceof Error ? error.message : "Transcription failed.", "error");
			} finally {
				setState((current) => ({ ...current, transcribing: false }));
			}
		},
		[applyCaptions, state.assets, timeline, toast],
	);

	/** Imports an .srt or .vtt and places it as captions. */
	const importSubtitles = useCallback(
		(text: string, hostClipId: string | null) => {
			try {
				applyCaptions(parseSubtitles(text), hostClipId);
			} catch (error) {
				toast(
					error instanceof SubtitleParseError
						? error.message
						: "Couldn't read that subtitle file.",
					"error",
				);
			}
		},
		[applyCaptions, toast],
	);

	const dropCaptions = useCallback(
		(groupId: string) => {
			commit("Remove captions", (current) => removeCaptionGroup(current, groupId));
		},
		[commit],
	);

	/** Writes the caption group back out as an .srt. */
	const exportSubtitles = useCallback(
		(groupId: string) => {
			const clips = timeline.tracks
				.flatMap((track) => track.clips)
				.filter((clip) => clip.captionGroupId === groupId)
				.sort((a, b) => a.startFrame - b.startFrame);
			if (clips.length === 0) {
				toast("That caption group is empty.", "error");
				return;
			}
			const cues: Cue[] = clips.map((clip, index) => ({
				id: String(index + 1),
				startMs: (clip.startFrame / timeline.fps) * 1000,
				endMs: (clip.endFrame / timeline.fps) * 1000,
				text: clip.content ?? "",
			}));
			const blob = new Blob([toSrt(cues)], { type: "text/plain" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${state.projectName}.srt`;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			toast("Subtitles exported");
		},
		[state.projectName, timeline, toast],
	);

	// ── Recording ─────────────────────────────────────────────────────

	const stopTimers = useCallback(() => {
		if (timers.current.countdown) window.clearInterval(timers.current.countdown);
		if (timers.current.elapsed) window.clearInterval(timers.current.elapsed);
		timers.current = {};
	}, []);

	const setRecording = useCallback((next: Partial<RecordingState>) => {
		setState((current) => ({ ...current, recording: { ...current.recording, ...next } }));
	}, []);

	/**
	 * Runs the countdown, then hands control back through `onArmed`.
	 *
	 * Capture must not begin until the count reaches zero — starting the
	 * encoder alongside the countdown puts "3… 2… 1…" at the head of every
	 * take, which is what it used to do.
	 */
	const beginRecording = useCallback(
		(source: CaptureSource, countdownSeconds: number, onArmed?: () => void) => {
			stopTimers();
			setRecording({
				phase: countdownSeconds > 0 ? "countdown" : "recording",
				countdown: countdownSeconds,
				elapsed: 0,
				sourceName: source.name,
			});

			const startElapsed = () => {
				// Guarded: whatever calls this, capture begins exactly once.
				if (timers.current.elapsed !== undefined) return;
				onArmed?.();
				setRecording({ phase: "recording", countdown: 0 });

				// Counted from a timestamp rather than by incrementing, so a
				// dropped or doubled tick can't drift the reported length.
				const startedAt = Date.now();
				timers.current.elapsed = window.setInterval(() => {
					const seconds = Math.floor((Date.now() - startedAt) / 1000);
					setState((current) =>
						current.recording.phase === "recording" &&
						current.recording.elapsed !== seconds
							? { ...current, recording: { ...current.recording, elapsed: seconds } }
							: current,
					);
				}, 250);
			};

			if (countdownSeconds <= 0) {
				startElapsed();
				return;
			}

			// The count is driven from the interval callback against a wall-clock
			// deadline, not from inside a state updater. React may run an updater
			// more than once for the same tick, and this one used to schedule
			// `startElapsed` from in there — so the elapsed timer could be started
			// twice and the take's duration counted double.
			const deadline = Date.now() + countdownSeconds * 1000;
			timers.current.countdown = window.setInterval(() => {
				const left = Math.ceil((deadline - Date.now()) / 1000);
				if (left > 0) {
					setState((current) =>
						current.recording.countdown === left
							? current
							: { ...current, recording: { ...current.recording, countdown: left } },
					);
					return;
				}
				window.clearInterval(timers.current.countdown);
				timers.current.countdown = undefined;
				startElapsed();
			}, 200);
		},
		[setRecording, stopTimers],
	);

	const pauseRecording = useCallback(() => setRecording({ phase: "paused" }), [setRecording]);

	const resumeRecording = useCallback(() => setRecording({ phase: "recording" }), [setRecording]);

	const cancelRecording = useCallback(() => {
		stopTimers();
		setRecording({ phase: "idle", elapsed: 0, countdown: 0, sourceName: null });
		toast("Recording discarded");
	}, [setRecording, stopTimers, toast]);

	/** Ends capture and returns the elapsed seconds for the caller to import. */
	const finishRecording = useCallback((): number => {
		stopTimers();
		const seconds = state.recording.elapsed;
		setRecording({ phase: "idle", elapsed: 0, countdown: 0, sourceName: null });
		return seconds;
	}, [setRecording, state.recording.elapsed, stopTimers]);

	const cutSelection = useCallback(() => {
		const clips = selection.map((entry) => entry.clip);
		if (clips.length === 0) return;
		setState((current) => ({ ...current, clipboard: clips }));
		commit("Cut clips", (t) =>
			removeClips(
				t,
				clips.map((clip) => clip.id),
			),
		);
		setState((current) => ({ ...current, selectedClipIds: [] }));
	}, [commit, selection]);

	const pasteClipboard = useCallback(() => {
		if (state.clipboard.length === 0) return;
		const stamp = String(Date.now()).slice(-6);
		let pastedIds: string[] = [];
		commit("Paste clips", (t) => {
			const result = pasteClips(t, state.clipboard, state.playhead, stamp);
			pastedIds = result.newIds;
			return result.timeline;
		});
		if (pastedIds.length > 0) {
			setState((current) => ({ ...current, selectedClipIds: pastedIds }));
		}
	}, [commit, state.clipboard, state.playhead]);

	const deleteSelection = useCallback(() => {
		if (state.selectedClipIds.length === 0) return;
		commit("Delete clips", (t) => removeClips(t, state.selectedClipIds));
		setState((current) => ({ ...current, selectedClipIds: [], selectedZoomRegionId: null }));
	}, [commit, state.selectedClipIds]);

	const duplicateSelection = useCallback(() => {
		if (state.selectedClipIds.length === 0) return;
		let ids: string[] = [];
		commit("Duplicate clips", (t) => {
			const result = duplicateClips(t, state.selectedClipIds);
			ids = result.newIds;
			return result.timeline;
		});
		if (ids.length > 0) setState((current) => ({ ...current, selectedClipIds: ids }));
	}, [commit, state.selectedClipIds]);

	const nudgeSelection = useCallback(
		(delta: number) => {
			if (state.selectedClipIds.length === 0) return;
			commit("Nudge clips", (t) => nudgeClips(t, state.selectedClipIds, delta));
		},
		[commit, state.selectedClipIds],
	);

	const addTextAtPlayhead = useCallback(() => {
		const id = `text-${Date.now()}`;
		const duration = Math.round(timeline.fps * 3);
		commit("Add text", (t) => addTextClip(t, state.playhead, duration, id).timeline);
		setState((current) => ({ ...current, selectedClipIds: [id] }));
	}, [commit, state.playhead, timeline.fps]);

	return {
		state,
		patch,
		timeline,
		totalFrames,
		selection,
		selectClip,
		commit,
		undo,
		redo,
		canUndo: state.undoStack.length > 0,
		canRedo: state.redoStack.length > 0,
		toggleMaximize,
		// Exposed so the file a save would write can be inspected without
		// writing one — it is the project, not a view of it.
		snapshot,
		logAgent,
		appendAssistantText,
		toast,
		dismissToast,
		setPlaybackRate,
		addComment,
		updateComment,
		removeComment,
		addWorkflow,
		updateWorkflow,
		removeWorkflow,
		saveLook,
		removeLook,
		renameLook,
		replaceTimeline,
		runNarration,
		askFor,
		closePrompt,
		importMedia,
		addAssets,
		removeAsset,
		pairCamera,
		renameAsset,
		placeAsset,
		moveAssets,
		moveFolder,
		beginExport,
		updateExport,
		cancelExport,
		beginRecording,
		pauseRecording,
		resumeRecording,
		cancelRecording,
		finishRecording,
		setRecording,
		registerRecorder,
		registerExporter,
		agentExport,
		agentStartRecording,
		agentStopRecording,
		saveProject,
		downloadText,
		loadProject,
		newProject,
		renameProject,
		createTimeline,
		setActiveTimeline,
		removeTimeline,
		renameTimeline,
		setProjectSettings,
		copySelection,
		cutSelection,
		pasteClipboard,
		deleteSelection,
		duplicateSelection,
		nudgeSelection,
		addTextAtPlayhead,
		applyCaptions,
		transcribe,
		importSubtitles,
		dropCaptions,
		exportSubtitles,
	};
}

export type EditorApi = ReturnType<typeof useEditorState>;

export function formatTimecode(frame: number, fps: number): string {
	// A negative or non-finite frame produced "-1:-1:-1:-5" rather than a
	// timecode — nothing upstream should send one, but a readout is the wrong
	// place to find out that something did.
	const safe = Number.isFinite(frame) ? Math.max(0, frame) : 0;
	const totalSeconds = Math.floor(safe / fps);
	const frames = Math.floor(safe % fps);
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

export function formatClock(seconds: number): string {
	const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	const minutes = Math.floor(safe / 60);
	const rest = Math.floor(safe % 60);
	return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Timeline frame → source milliseconds for a clip, honouring trim and speed. */
export function frameToClipSourceMs(clip: ClipModel, frame: number, fps: number): number {
	return ((clip.trimStartFrame + (frame - clip.startFrame) * clip.speed) / fps) * 1000;
}

/** Inverse of frameToClipSourceMs. */
export function clipSourceMsToFrame(clip: ClipModel, sourceMs: number, fps: number): number {
	const sourceFrames = (sourceMs / 1000) * fps;
	return clip.startFrame + (sourceFrames - clip.trimStartFrame) / clip.speed;
}
