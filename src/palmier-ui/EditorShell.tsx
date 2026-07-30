// Editor shell — the React equivalent of Palmier Pro's EditorSplitViewController.
//
// Root is a horizontal split: [Agent column] | [preset layout]. The preset
// determines how media / preview / inspector / timeline are arranged:
//
//   default   [Media | Preview | Inspector] / [Timeline]
//   media     [Media] | ([Preview | Inspector] / [Timeline])
//   vertical  (([Media | Inspector]) / [Timeline]) | [Preview]
//
// Maximizing a panel collapses every sibling up the ancestor chain, exactly as
// applyMaximize() does. The shell also owns the things that float above the
// layout: the menu bar, the recording HUD, the countdown, and toasts.

import { useCallback, useEffect, useRef, useState } from "react";

import "./palmier.css";

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { autoZoomRegions } from "./autoZoom";
import { DEFAULT_BACKGROUND } from "./background";
import { DEFAULT_CURSOR } from "./cursor";
import { startCursorCapture } from "./cursorCapture";
import {
	DEFAULT_EXPORT_SETTINGS,
	downloadBlob,
	type ExportHandle,
	type ExportProgress,
	type ExportSettings,
	exportDimensions,
	exportStill,
	exportTimeline,
} from "./export";
import { CloseIcon, RecordIcon, SparkleIcon } from "./icons";
import { MenuBar } from "./MenuBar";
import type { AssetModel } from "./media";
import { withDefaults, type ZoomRegionModel } from "./model";
import { exportTimelineOffline, offlineExportSupport } from "./offlineExport";
import { Panel } from "./Panel";
import { AgentPanel } from "./panels/AgentPanel";
import { InspectorPanel } from "./panels/InspectorPanel";
import { MediaPanel } from "./panels/MediaPanel";
import { PreviewPanel } from "./panels/PreviewPanel";
import { TimelinePanel } from "./panels/TimelinePanel";
import { WorkflowPanel } from "./panels/WorkflowPanel";
import {
	Countdown,
	captureStream,
	createRecorder,
	listSources,
	openWebcamStream,
	RecordingHud,
	SourcePicker,
} from "./Recording";
import type { TimelineModel } from "./reducers";
import { splitAt, trimSelectionToPlayhead, updateZoomRegion } from "./reducers";
import { ExportSheet, ProjectSettingsSheet, PromptSheet, ShortcutsSheet } from "./Sheets";
import { Split, type SplitPane } from "./Split";
import { type CaptureSource, type EditorApi, formatTimecode, useEditorState } from "./state";
import { type FocusedPanel, Layout } from "./theme";
import { useAgentBridge } from "./useAgentBridge";
import { DEFAULT_WEBCAM } from "./webcam";
import { DEFAULT_ZOOM_TIMING } from "./zoom";

const COUNTDOWN_SECONDS = 3;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Rendr's mark, inline so the titlebar needs no asset load. */
function RendrMark() {
	return (
		<svg width="15" height="15" viewBox="0 0 64 64" aria-hidden="true">
			<rect
				x="6"
				y="12"
				width="52"
				height="40"
				rx="10"
				fill="none"
				stroke="rgb(245,239,228)"
				strokeWidth="4"
			/>
			<circle cx="32" cy="32" r="6" fill="rgb(242,153,51)" />
		</svg>
	);
}

function Titlebar({
	api,
	onImportClick,
	onRecordClick,
	onExportClick,
	onOpenClick,
	onExportFrame,
	onProjectSettings,
}: {
	api: EditorApi;
	onImportClick: () => void;
	onRecordClick: () => void;
	onExportClick: () => void;
	onOpenClick: () => void;
	onExportFrame: () => void;
	onProjectSettings: () => void;
}) {
	const { state, timeline, totalFrames } = api;
	const recording = state.recording.phase !== "idle";

	return (
		// On macOS the window keeps its traffic lights (hiddenInset), and they sit
		// at x=12 — exactly where the mark and the File menu used to start, so
		// they overlapped. The bar is inset past them there and nowhere else.
		<div className="pmr-titlebar" data-platform={IS_MAC ? "mac" : "other"}>
			<RendrMark />
			<MenuBar
				api={api}
				onImportClick={onImportClick}
				onRecordClick={onRecordClick}
				onExportClick={onExportClick}
				onOpenClick={onOpenClick}
				onExportFrame={onExportFrame}
				onProjectSettings={onProjectSettings}
			/>

			<span style={{ flex: 1 }} />

			<span className="pmr-titlebar__name">
				{state.projectName}
				{state.dirty ? (
					<span className="pmr-titlebar__dot" title="Unsaved changes" />
				) : null}
			</span>
			<span className="pmr-titlebar__meta">
				{timeline.width}×{timeline.height} · {timeline.fps}fps ·{" "}
				{formatTimecode(totalFrames, timeline.fps)}
			</span>

			{/* The agent chat is opened and closed constantly, so the toggle lives
			    here rather than only in the View menu. */}
			<button
				type="button"
				className="pmr-btn"
				data-active={state.agentPanelVisible || undefined}
				title={
					state.agentPanelVisible ? "Hide the agent chat (A)" : "Show the agent chat (A)"
				}
				aria-label="Toggle the agent chat"
				aria-pressed={state.agentPanelVisible}
				onClick={() => api.patch({ agentPanelVisible: !state.agentPanelVisible })}
				style={{ marginLeft: 4 }}
			>
				<SparkleIcon size={12} />
			</button>

			<button
				type="button"
				className="pmr-action pmr-action--record"
				onClick={onRecordClick}
				disabled={recording}
				style={{ marginLeft: 4 }}
			>
				<RecordIcon size={10} />
				Record
			</button>
		</div>
	);
}

/**
 * Decodes a custom backdrop image once, for the whole export.
 *
 * Returns null for every other backdrop kind — a colour or a gradient is
 * painted, not drawn, and has nothing to decode.
 */
async function decodeBackdrop(
	settings: { kind: string; imageUrl?: string } | undefined,
): Promise<HTMLImageElement | null> {
	if (settings?.kind !== "image" || !settings.imageUrl) return null;
	const image = new Image();
	image.src = settings.imageUrl;
	try {
		await image.decode();
		return image;
	} catch {
		// A backdrop that won't decode costs the backdrop, not the export.
		return null;
	}
}

/** The keyboard handler before the first render assigns the real one. */
function ignoreKey(): void {
	// Nothing is mounted yet, so there is nothing a shortcut could act on.
}

export function EditorShell() {
	const api = useEditorState();
	const {
		state,
		patch,
		toggleMaximize,
		toast,
		importMedia,
		addAssets,
		beginRecording,
		finishRecording,
	} = api;

	// Agents drive this editor through the same reducers the panels use.
	useAgentBridge(api);

	const [picking, setPicking] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
	// Read at the moment capture opens, so `startRecording` doesn't have to be
	// rebuilt — and invalidate every recorder callback — each time the camera
	// device changes.
	const webcamStreamRef = useRef<MediaStream | null>(null);
	webcamStreamRef.current = webcamStream;
	const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
	const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
	const exportRef = useRef<ExportHandle | null>(null);
	const recorderRef = useRef<ReturnType<typeof createRecorder> | null>(null);
	const cursorRef = useRef<ReturnType<typeof startCursorCapture> | null>(null);
	/** A name supplied by whoever asked for this take. */
	const pendingTakeName = useRef<string | null>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const projectInput = useRef<HTMLInputElement>(null);

	const focus = useCallback((panel: FocusedPanel) => patch({ focusedPanel: panel }), [patch]);

	const openImport = useCallback(() => importInput.current?.click(), []);
	const openProjectFile = useCallback(() => projectInput.current?.click(), []);

	const runExport = useCallback(
		async (settingsOverride?: Partial<ExportSettings>) => {
			const settings = { ...exportSettings, ...settingsOverride };
			setExportProgress({ frame: 0, totalFrames: api.totalFrames, ratio: 0 });
			// Offline when WebCodecs will take it — the encode then runs as fast
			// as frames can be composited rather than at playback speed. The
			// real-time path stays as the fallback. The route is decided before
			// the job is registered because the two write different containers,
			// and the job is named after the file that will actually appear.
			const { width, height } = exportDimensions(api.timeline, settings);
			const offline = await offlineExportSupport(width, height, api.timeline.fps);
			const filename = `${state.projectName}.${offline.supported ? "mp4" : "webm"}`;

			// The job is what `manage_exports` lists and cancels. It is registered
			// first so a cancel arriving during setup still reaches the encoder.
			const jobId = api.beginExport(filename, () => exportRef.current?.cancel());
			const onExportProgress = (progress: ExportProgress) => {
				setExportProgress(progress);
				api.updateExport(jobId, { progress: progress.ratio });
			};
			const overlays = [
				{ telemetry: state.cursorTelemetry, settings: state.cursor ?? DEFAULT_CURSOR },
				{ settings: state.webcam ?? DEFAULT_WEBCAM, assets: state.assets },
				{
					settings: state.background ?? DEFAULT_BACKGROUND,
					// Decoded once for the whole export rather than per frame.
					image: await decodeBackdrop(state.background),
				},
				state.zoomTiming ?? DEFAULT_ZOOM_TIMING,
			] as const;
			const handle = offline.supported
				? exportTimelineOffline(
						api.timeline,
						state.assets,
						api.totalFrames,
						settings,
						onExportProgress,
						...overlays,
					)
				: exportTimeline(
						api.timeline,
						state.assets,
						api.totalFrames,
						settings,
						onExportProgress,
						...overlays,
					);
			exportRef.current = handle;
			try {
				const blob = await handle.done;
				if (blob) {
					downloadBlob(blob, filename);
					const warning = handle.warning();
					api.updateExport(jobId, {
						status: "done",
						progress: 1,
						...(warning ? { warning } : {}),
					});
					// A file that came out usable but not as asked says so — a silent
					// export that reports "finished" is the worst outcome here.
					toast(warning ?? "Export finished", warning ? "error" : "info");
				} else {
					api.updateExport(jobId, { status: "cancelled" });
					toast("Export cancelled");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "Export failed";
				api.updateExport(jobId, { status: "failed", warning: message });
				toast(message, "error");
			} finally {
				exportRef.current = null;
				setExportProgress(null);
				setExporting(false);
			}
			return jobId;
		},
		[
			api,
			exportSettings,
			state.assets,
			state.background,
			state.cursor,
			state.cursorTelemetry,
			state.projectName,
			state.webcam,
			state.zoomTiming,
			toast,
		],
	);

	const exportFrame = useCallback(async () => {
		const blob = await exportStill(
			api.timeline,
			state.assets,
			Math.round(state.playhead),
			{ telemetry: state.cursorTelemetry, settings: state.cursor ?? DEFAULT_CURSOR },
			{ settings: state.webcam ?? DEFAULT_WEBCAM, assets: state.assets },
			{
				settings: state.background ?? DEFAULT_BACKGROUND,
				image: await decodeBackdrop(state.background),
			},
		);
		if (!blob) {
			toast("Couldn't render that frame", "error");
			return;
		}
		downloadBlob(blob, `${state.projectName} ${Math.round(state.playhead)}.png`);
		toast("Frame exported");
	}, [
		api.timeline,
		state.assets,
		state.background,
		state.cursor,
		state.cursorTelemetry,
		state.playhead,
		state.projectName,
		state.webcam,
		toast,
	]);

	const openRecord = useCallback(() => {
		patch({ mediaPanelVisible: true });
		setPicking(true);
	}, [patch]);

	/**
	 * Puts a finished take on the timeline and cuts its zooms.
	 *
	 * One commit, so it is one undo: a take that arrives placed and zoomed
	 * should also leave in a single step if the user didn't want it.
	 */
	const placeTakeWithZooms = useCallback(
		(asset: AssetModel, telemetry: readonly CursorTelemetryPoint[]) => {
			const fps = api.timeline.fps;
			const durationFrames = Math.max(1, Math.round(asset.durationSeconds * fps));
			const startFrame = api.totalFrames;

			// Both clicks *and* dwells. Recordly's exported
			// `buildInteractionZoomSuggestions` filters to explicit clicks and
			// discards every dwell, which is why a take of reading and scrolling
			// used to arrive with one zoom in it or none. Most of what is worth
			// punching in on is somebody stopping to look at something.
			const cut =
				telemetry.length > 0
					? autoZoomRegions(telemetry, { totalMs: asset.durationSeconds * 1000 })
					: [];

			const regions: ZoomRegionModel[] = cut.map((entry, index) => ({
				id: `zoom-${asset.id}-${index}`,
				startMs: entry.startMs,
				endMs: entry.endMs,
				depth: entry.depth,
				focus: entry.focus,
				// Auto: the camera follows the pointer through the region rather
				// than sitting on the moment it was cut from.
				mode: "auto" as const,
			}));

			api.commit("Add recording", (current: TimelineModel) => {
				const track = current.tracks.find((entry) => entry.kind === "video");
				if (!track) return current;
				const clip = withDefaults({
					id: `clip-${asset.id}-0`,
					name: asset.name,
					mediaType: "video",
					assetId: asset.id,
					startFrame,
					endFrame: startFrame + durationFrames,
					...(regions.length > 0 ? { zoomRegions: regions } : {}),
				});
				return {
					...current,
					tracks: current.tracks.map((entry) =>
						entry.id === track.id ? { ...entry, clips: [...entry.clips, clip] } : entry,
					),
				};
			});

			const clicks = telemetry.filter(
				(point) =>
					point.interactionType === "click" || point.interactionType === "right-click",
			).length;
			return { zooms: regions.length, clicks };
		},
		[api.timeline.fps, api.totalFrames, api.commit],
	);

	/**
	 * Moves or resizes the selected zoom region by a number of source ms.
	 *
	 * `resizeEnd` drags the out point instead of the whole region, which is the
	 * keyboard equivalent of grabbing its right edge.
	 */
	const nudgeZoomRegion = useCallback(
		(deltaMs: number, resizeEnd: boolean) => {
			const regionId = state.selectedZoomRegionId;
			if (!regionId) return;
			const host = api.timeline.tracks
				.flatMap((track) => track.clips)
				.find((clip) => (clip.zoomRegions ?? []).some((region) => region.id === regionId));
			const region = host?.zoomRegions?.find((entry) => entry.id === regionId);
			if (!host || !region) return;

			// The region lives in source ms, so its limit is the clip's own span.
			const limitMs =
				((host.endFrame - host.startFrame) * host.speed * 1000) / api.timeline.fps +
				(host.trimStartFrame / api.timeline.fps) * 1000;

			api.commit(resizeEnd ? "Resize zoom" : "Move zoom", (current: TimelineModel) => {
				const result = updateZoomRegion(
					current,
					host.id,
					regionId,
					resizeEnd
						? { endMs: Math.max(region.startMs + 200, region.endMs + deltaMs) }
						: {
								startMs: Math.max(0, region.startMs + deltaMs),
								endMs: Math.max(0, region.endMs + deltaMs),
							},
					limitMs,
				);
				return result.ok ? result.timeline : current;
			});
		},
		[api, state.selectedZoomRegionId],
	);

	const stopRecording = useCallback(
		async (discard = false, autoPlace = true) => {
			const recorder = recorderRef.current;
			if (!recorder) return null;
			recorderRef.current = null;
			const seconds = finishRecording();
			const telemetry = (await cursorRef.current?.stop()) ?? [];
			cursorRef.current = null;

			// Discarding releases the devices without the take ever reaching the
			// library — a rejected take should leave nothing behind to clean up.
			if (discard) {
				recorder.abort();
				pendingTakeName.current = null;
				toast("Take discarded");
				return null;
			}

			const { asset, webcam } = await recorder.finish(
				pendingTakeName.current ??
					`Screen recording ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
				seconds,
				telemetry.length > 0,
			);
			pendingTakeName.current = null;
			// The camera take goes into the library too — it is a real file, and
			// the screen take carries its id so the encoder can find it.
			addAssets(webcam ? [asset, webcam] : [asset]);
			if (telemetry.length > 0) patch({ cursorTelemetry: telemetry });

			// A finished take lands on the timeline with its zooms already cut,
			// the way Recordly does it. Waiting for the user to place the clip
			// and then ask for zooms means a recording of clicking through an app
			// arrives looking like it has no zooms in it at all.
			if (!autoPlace) {
				toast(`Recorded ${seconds}s — added to the library`);
				return asset;
			}

			const placed = placeTakeWithZooms(asset, telemetry);
			toast(
				placed.zooms > 0
					? `Recorded ${seconds}s — ${placed.zooms} ${placed.zooms === 1 ? "zoom" : "zooms"} cut from the cursor`
					: telemetry.length > 0
						? `Recorded ${seconds}s — the pointer never settled anywhere, so no zooms. Add them by clicking the Zoom track.`
						: `Recorded ${seconds}s — no cursor telemetry, so no zooms. Turn on "Capture cursor" before recording.`,
			);
			return asset;
		},
		[addAssets, finishRecording, patch, placeTakeWithZooms, toast],
	);

	const startRecording = useCallback(
		(
			source: CaptureSource,
			stream: MediaStream,
			countdownSeconds = COUNTDOWN_SECONDS,
			captureCursor = state.recording.captureCursor,
		) => {
			setPicking(false);
			// The camera stream is the preview's own, so what the presenter sees in
			// the corner is what lands in the file.
			const recorder = createRecorder(
				stream,
				state.webcam?.show ? webcamStreamRef.current : null,
			);
			recorderRef.current = recorder;
			if (captureCursor) cursorRef.current = startCursorCapture();
			// Ending capture from the OS chrome must end it here too.
			recorder.onExternalStop(() => {
				if (recorderRef.current === recorder) void stopRecording();
			});
			// The encoder starts when the count hits zero, not now.
			beginRecording(source, countdownSeconds, () => recorder.begin());
		},
		[beginRecording, state.recording.captureCursor, state.webcam?.show, stopRecording],
	);

	/**
	 * The same capture the Record button performs, reachable by an agent.
	 *
	 * It goes through `startRecording`/`stopRecording` rather than opening its
	 * own path, so an agent-made recording is the same file a human would get.
	 */
	useEffect(() => {
		api.registerRecorder({
			async start(sourceId, options) {
				if (recorderRef.current) throw new Error("A recording is already running.");
				// The options are the recording's settings, so they are applied
				// before capture opens rather than read from stale state.
				if (options.captureCursor !== undefined || options.systemAudio !== undefined) {
					api.setRecording({
						...(options.captureCursor !== undefined
							? { captureCursor: options.captureCursor }
							: {}),
						...(options.systemAudio !== undefined
							? { systemAudio: options.systemAudio }
							: {}),
					});
				}
				const sources = await listSources();
				if (sources.length === 0) {
					throw new Error(
						"No capture sources. On macOS this usually means Rendr hasn't been granted Screen Recording in System Settings → Privacy & Security.",
					);
				}
				const source =
					(sourceId ? sources.find((entry) => entry.id === sourceId) : undefined) ??
					sources.find((entry) => entry.kind === "screen") ??
					sources[0];
				if (sourceId && source.id !== sourceId) {
					throw new Error(
						`No capture source '${sourceId}'. Call list_capture_sources again — windows open and close.`,
					);
				}
				const stream = await captureStream(source, {
					microphone: state.recording.microphone || Boolean(options.microphoneDeviceId),
					microphoneDeviceId: options.microphoneDeviceId,
					systemAudio: options.systemAudio ?? state.recording.systemAudio,
					captureCursor: options.captureCursor ?? state.recording.captureCursor,
				});
				pendingTakeName.current = options.name ?? null;
				startRecording(
					source,
					stream,
					options.countdownSeconds ?? 0,
					options.captureCursor ?? state.recording.captureCursor,
				);
				const recordingId = `take-${Date.now().toString(36)}`;
				patch({ activeRecordingId: recordingId });
				return { sourceName: source.name, recordingId };
			},
			async stop(options) {
				if (!recorderRef.current) throw new Error("Nothing is recording.");
				// The take is not auto-placed for an agent: it asked for a
				// recording, and where it goes on the timeline is its next
				// decision, not something that should happen behind it.
				const asset = await stopRecording(options.discard === true, false);
				patch({ activeRecordingId: null });
				if (options.discard === true) {
					return { assetId: null, name: "", durationSeconds: 0 };
				}
				if (!asset) throw new Error("The recording produced no file.");
				return {
					assetId: asset.id,
					name: asset.name,
					durationSeconds: asset.durationSeconds,
				};
			},
		});
		// The encoder renders into its own offscreen canvas, so an agent-started
		// export is the same render the dialog performs — the dialog only ever
		// supplied the progress bar.
		api.registerExporter((settingsOverride) => {
			if (exportRef.current) throw new Error("An export is already running.");
			if (api.totalFrames === 0)
				throw new Error("There's nothing on the timeline to export.");
			setExporting(true);
			return runExport(settingsOverride);
		});
		return () => {
			api.registerRecorder(null);
			api.registerExporter(null);
		};
	}, [
		api,
		patch,
		runExport,
		startRecording,
		stopRecording,
		state.recording.captureCursor,
		state.recording.microphone,
		state.recording.systemAudio,
	]);

	/**
	 * The floating record bar, in its own content-protected window.
	 *
	 * It is opened for the whole take — countdown included — and torn down after,
	 * and the editor keeps pushing it the recording state so it stays in step
	 * without holding any of its own.
	 */
	const recordingPhase = state.recording.phase;
	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.setRecordBarVisible) return;
		const active = recordingPhase !== "idle";
		bridge.setRecordBarVisible(active);
		if (!active) return;
		return () => bridge.setRecordBarVisible?.(false);
	}, [recordingPhase]);

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.pushRecordBarState || state.recording.phase === "idle") return;
		bridge.pushRecordBarState({
			phase: state.recording.phase,
			elapsed: state.recording.elapsed,
			countdown: state.recording.countdown,
			sourceName: state.recording.sourceName,
		});
	}, [
		state.recording.phase,
		state.recording.elapsed,
		state.recording.countdown,
		state.recording.sourceName,
	]);

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.onRecordBarCommand) return;
		return bridge.onRecordBarCommand((command) => {
			if (command === "stop") void stopRecording();
			else if (command === "cancel") void stopRecording(true);
			else if (command === "pause") api.pauseRecording();
			else if (command === "resume") api.resumeRecording();
		});
	}, [api, stopRecording]);

	/**
	 * The live camera, open only while the inset is switched on.
	 *
	 * Held here rather than in the preview so the stream survives a preview
	 * re-render, and so turning the inset off actually releases the device
	 * instead of leaving the camera light on.
	 */
	// Keyed on `show` and `deviceId` alone, deliberately: depending on the whole
	// settings object would tear down and reopen the camera every time the
	// bubble was moved or resized, flashing the preview mid-adjustment.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const settings = state.webcam ?? DEFAULT_WEBCAM;
		if (!settings.show) {
			setWebcamStream((current) => {
				for (const track of current?.getTracks() ?? []) track.stop();
				return null;
			});
			return;
		}

		let cancelled = false;
		let opened: MediaStream | null = null;
		void openWebcamStream(settings.deviceId).then(({ stream, reason }) => {
			if (cancelled) {
				for (const track of stream?.getTracks() ?? []) track.stop();
				return;
			}
			opened = stream;
			if (!stream) {
				/*
				 * No live device. That only matters if the inset had nothing else
				 * to draw — a take with a camera file already paired to it
				 * composites from that file and needs no device at all, so
				 * switching off here would silently hide a camera the project
				 * genuinely has. (This is exactly what happened: pairing a camera
				 * file on a machine with no webcam turned the inset straight back
				 * off and the bubble never rendered.)
				 */
				const hasPairedCamera = state.assets.some((asset) => asset.webcamAssetId);
				toast(
					hasPairedCamera
						? `${reason} The paired camera file will still be composited.`
						: reason,
					hasPairedCamera ? "info" : "error",
				);
				if (!hasPairedCamera) {
					patch({ webcam: { ...settings, show: false } });
				}
			}
			setWebcamStream(stream);
		});

		return () => {
			cancelled = true;
			for (const track of opened?.getTracks() ?? []) track.stop();
		};
	}, [state.assets, state.webcam?.show, state.webcam?.deviceId, patch, toast]);

	// A discarded take must also tear down the recorder and release the devices.
	useEffect(() => {
		if (state.recording.phase === "idle" && recorderRef.current) {
			recorderRef.current.abort();
			recorderRef.current = null;
			cursorRef.current?.stop();
			cursorRef.current = null;
		}
	}, [state.recording.phase]);

	useEffect(() => () => recorderRef.current?.abort(), []);

	// Keyboard map from ToolbarView's help strings, plus the menu's accelerators.
	/**
	 * The keyboard shortcuts.
	 *
	 * The handler closes over most of the editor's state, so binding it as an
	 * effect dependency would re-subscribe a window listener on every render —
	 * thirty times a second during playback. Instead the latest handler is kept
	 * in a ref and the listener is bound once: the shortcut always runs against
	 * current state, and the subscription never churns.
	 */
	const onKeyRef = useRef<(event: KeyboardEvent) => void>(ignoreKey);
	onKeyRef.current = (event: KeyboardEvent) => {
		{
			const target = event.target as HTMLElement | null;
			const typing =
				target &&
				(target.tagName === "TEXTAREA" ||
					target.tagName === "INPUT" ||
					target.isContentEditable);

			const mod = event.metaKey || event.ctrlKey;
			if (mod) {
				const key = event.key.toLowerCase();
				// Text fields keep their own copy/paste; only editor-wide verbs
				// are intercepted while typing.
				if (typing && !["s", "o", "e"].includes(key)) return;

				const accelerators: Record<string, () => void> = {
					z: () => (event.shiftKey ? api.redo() : api.undo()),
					i: openImport,
					s: api.saveProject,
					o: openProjectFile,
					e: () => setExporting(true),
					x: api.cutSelection,
					c: api.copySelection,
					v: api.pasteClipboard,
					d: api.duplicateSelection,
					k: () => api.commit("Split at playhead", (t) => splitAt(t, state.playhead)),
					a: () =>
						event.shiftKey
							? patch({ selectedClipIds: [], selectedZoomRegionId: null })
							: patch({
									selectedClipIds: api.timeline.tracks.flatMap((track) =>
										track.clips.map((clip) => clip.id),
									),
								}),
				};
				if (key === "r" && event.shiftKey) {
					event.preventDefault();
					openRecord();
					return;
				}
				const accelerator = accelerators[key];
				if (accelerator) {
					event.preventDefault();
					accelerator();
				}
				return;
			}

			if (typing) return;

			if (event.key === "Delete" || event.key === "Backspace") {
				event.preventDefault();
				api.deleteSelection();
				return;
			}
			if (event.key === "Home") {
				event.preventDefault();
				patch({ playhead: 0 });
				return;
			}
			if (event.key === "End") {
				event.preventDefault();
				patch({ playhead: api.totalFrames });
				return;
			}
			if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				const step = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 10 : 1);
				// A selected zoom region takes the arrows before the clip does:
				// it was reachable only by dragging its block, which meant no
				// keyboard path to move or resize one at all. Alt resizes the end,
				// so the three drag gestures on a region each have a key.
				if (state.selectedZoomRegionId) {
					nudgeZoomRegion(step * (1000 / api.timeline.fps), event.altKey);
					return;
				}
				if (state.selectedClipIds.length > 0) {
					api.nudgeSelection(step);
				} else {
					patch({
						playhead: Math.max(0, Math.min(api.totalFrames, state.playhead + step)),
					});
				}
				return;
			}
			// The agent chat is the one panel you open and close constantly, so it
			// gets a key of its own rather than a trip through the View menu.
			if (event.key.toLowerCase() === "a" && !event.shiftKey) {
				event.preventDefault();
				patch({ agentPanelVisible: !state.agentPanelVisible });
				return;
			}
			if (event.key === "?") {
				event.preventDefault();
				patch({ shortcutsOpen: true });
				return;
			}

			if (event.key === " ") {
				event.preventDefault();
				patch({ playing: !state.playing });
				return;
			}
			if (event.altKey) return;

			// Q and W trim the selection's in and out points to the playhead —
			// the keyboard half of the [ and ] toolbar buttons, whose titles
			// have advertised these keys all along without them being bound.
			if (
				(event.key.toLowerCase() === "q" || event.key.toLowerCase() === "w") &&
				state.selectedClipIds.length > 0
			) {
				event.preventDefault();
				const edge = event.key.toLowerCase() === "q" ? "start" : "end";
				api.commit(`Trim ${edge} to playhead`, (current: TimelineModel) =>
					trimSelectionToPlayhead(
						current,
						state.selectedClipIds,
						Math.round(state.playhead),
						edge,
					),
				);
				return;
			}

			const tools: Record<string, () => void> = {
				v: () => patch({ toolMode: "pointer" }),
				c: () => patch({ toolMode: "razor" }),
				t: () => patch({ toolMode: "trim" }),
			};
			const action = tools[event.key.toLowerCase()];
			if (action) {
				event.preventDefault();
				action();
			}
			if (event.key === "`" && state.focusedPanel) {
				event.preventDefault();
				toggleMaximize(state.focusedPanel);
			}
		}
	};

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => onKeyRef.current(event);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const maximized = state.maximizedPanel;
	const wrap = (panel: FocusedPanel, content: React.ReactNode) => (
		<Panel panel={panel} focused={state.focusedPanel} onFocus={focus}>
			{content}
		</Panel>
	);

	const mediaPane: SplitPane = {
		key: "media",
		// The picker is a modal over the whole editor, so it mounts at the shell's
		// top level rather than inside this pane — a scrim nested in a 240px
		// column can only ever dim that column.
		content: wrap("media", <MediaPanel api={api} onRecordClick={openRecord} />),
		size: 0.26,
		minPx: 240,
		collapsed: !state.mediaPanelVisible || (maximized !== null && maximized !== "media"),
	};
	const previewPane: SplitPane = {
		key: "preview",
		content: wrap(
			"preview",
			<PreviewPanel api={api} onRecordClick={openRecord} webcamStream={webcamStream} />,
		),
		size: 0.48,
		minPx: Layout.previewMinWidth,
		collapsed: maximized !== null && maximized !== "preview",
	};
	const inspectorPane: SplitPane = {
		key: "inspector",
		content: wrap("inspector", <InspectorPanel api={api} />),
		size: 0.26,
		minPx: Layout.inspectorMin,
		collapsed:
			!state.inspectorPanelVisible || (maximized !== null && maximized !== "inspector"),
	};
	const timelinePane: SplitPane = {
		key: "timeline",
		// A workflow replaces the timeline rather than sitting beside it: the two
		// answer different questions, and a workflow is what produces a timeline.
		content: wrap(
			"timeline",
			state.activeWorkflowId ? (
				<WorkflowPanel api={api} />
			) : (
				<TimelinePanel api={api} onImportClick={openImport} />
			),
		),
		size: 0.34,
		minPx: Layout.timelineMinHeight,
		collapsed: maximized !== null && maximized !== "timeline",
	};

	let presetLayout: React.ReactNode;
	if (state.layoutPreset === "default") {
		presetLayout = (
			<Split
				direction="vertical"
				panes={[
					{
						key: "upper",
						content: (
							<Split
								direction="horizontal"
								panes={[mediaPane, previewPane, inspectorPane]}
							/>
						),
						size: 0.66,
						minPx: Layout.previewMinHeight,
						collapsed: maximized === "timeline",
					},
					timelinePane,
				]}
			/>
		);
	} else if (state.layoutPreset === "media") {
		presetLayout = (
			<Split
				direction="horizontal"
				panes={[
					{ ...mediaPane, size: 0.3 },
					{
						key: "right",
						content: (
							<Split
								direction="vertical"
								panes={[
									{
										key: "top",
										content: (
											<Split
												direction="horizontal"
												panes={[previewPane, inspectorPane]}
											/>
										),
										size: 0.55,
										minPx: Layout.previewMinHeight,
										collapsed: maximized === "timeline",
									},
									timelinePane,
								]}
							/>
						),
						size: 0.7,
						minPx: 400,
						collapsed: maximized === "media",
					},
				]}
			/>
		);
	} else {
		presetLayout = (
			<Split
				direction="horizontal"
				panes={[
					{
						key: "left",
						content: (
							<Split
								direction="vertical"
								panes={[
									{
										key: "top",
										content: (
											<Split
												direction="horizontal"
												panes={[mediaPane, inspectorPane]}
											/>
										),
										size: 0.55,
										minPx: 200,
										collapsed: maximized === "timeline",
									},
									timelinePane,
								]}
							/>
						),
						size: 0.5,
						minPx: 360,
						collapsed: maximized === "preview",
					},
					{ ...previewPane, size: 0.5 },
				]}
			/>
		);
	}

	return (
		<div
			className="pmr"
			// The timeline's header width lives in one place; CSS reads it from here.
			style={{ "--pmr-track-header": `${Layout.trackHeaderWidth}px` } as React.CSSProperties}
		>
			<input
				ref={projectInput}
				type="file"
				accept=".rendr,application/json"
				style={{ display: "none" }}
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) void file.text().then(api.loadProject);
					event.target.value = "";
				}}
			/>
			<input
				ref={importInput}
				type="file"
				multiple
				accept="video/*,audio/*,image/*"
				style={{ display: "none" }}
				onChange={(event) => {
					const files = Array.from(event.target.files ?? []);
					if (files.length > 0) void importMedia(files);
					event.target.value = "";
				}}
			/>

			<Titlebar
				api={api}
				onImportClick={openImport}
				onRecordClick={openRecord}
				onExportClick={() => setExporting(true)}
				onOpenClick={openProjectFile}
				onExportFrame={() => void exportFrame()}
				onProjectSettings={() => setSettingsOpen(true)}
			/>

			<Split
				direction="horizontal"
				panes={[
					{
						key: "agent",
						content: wrap("agent", <AgentPanel api={api} />),
						size: 0.22,
						minPx: Layout.agentPanelMin,
						maxPx: Layout.agentPanelMax,
						collapsed:
							!state.agentPanelVisible ||
							(maximized !== null && maximized !== "agent"),
					},
					{
						key: "preset",
						content: presetLayout,
						size: 0.78,
						minPx: 400,
						collapsed: maximized === "agent",
					},
				]}
			/>

			{state.recording.phase === "countdown" ? (
				<Countdown value={state.recording.countdown} />
			) : null}

			{/* In the desktop app the bar floats in its own protected window, so
			    the in-editor HUD would be a second copy — and the one that shows
			    up in the recording. It stays for the browser build, which has no
			    second window to put it in. */}
			{window.electronAPI?.setRecordBarVisible ? null : (
				<RecordingHud api={api} onStop={() => void stopRecording()} />
			)}

			{exporting ? (
				<ExportSheet
					settings={exportSettings}
					onChange={setExportSettings}
					progress={exportProgress}
					timeline={api.timeline}
					totalFrames={api.totalFrames}
					onStart={() => void runExport()}
					onCancel={() => {
						exportRef.current?.cancel();
						if (!exportProgress) setExporting(false);
					}}
				/>
			) : null}

			{picking ? (
				<SourcePicker
					api={api}
					onClose={() => setPicking(false)}
					onStart={startRecording}
				/>
			) : null}

			{settingsOpen ? (
				<ProjectSettingsSheet
					timeline={api.timeline}
					onApply={api.setProjectSettings}
					onClose={() => setSettingsOpen(false)}
				/>
			) : null}

			{state.shortcutsOpen ? (
				<ShortcutsSheet onClose={() => patch({ shortcutsOpen: false })} />
			) : null}

			{state.prompt ? <PromptSheet request={state.prompt} onClose={api.closePrompt} /> : null}

			<div className="pmr-toasts">
				{state.toasts.map((entry) => (
					<div className="pmr-toast" key={entry.id} data-tone={entry.tone} role="status">
						<span className="pmr-toast__dot" />
						<span style={{ flex: 1 }}>{entry.message}</span>
						<button
							type="button"
							className="pmr-btn"
							style={{ width: 18, height: 18 }}
							onClick={() => api.dismissToast(entry.id)}
							aria-label="Dismiss"
						>
							<CloseIcon size={10} />
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
