// The recording surface, following Recordly's shape: pick a source, watch a
// countdown, then a floating control bar hovers over the work while capture
// runs. The bar floats rather than docking because it has to sit above whatever
// is being recorded without becoming part of it.

import { useCallback, useEffect, useState } from "react";

import {
	CameraIcon,
	CloseIcon,
	CursorTrackIcon,
	HudPauseIcon,
	MicIcon,
	MonitorIcon,
	PlayIcon,
	SpeakerIcon,
	StopIcon,
	WindowIcon,
} from "./icons";
import { type AssetModel, assetFromRecording } from "./media";
import { type CaptureSource, type EditorApi, formatClock } from "./state";

/** Capture sources this runtime can actually offer. */
export async function listSources(): Promise<CaptureSource[]> {
	const electron = (window as { electronAPI?: { getSources?: unknown } }).electronAPI;
	const getSources = electron?.getSources;

	// In Electron the main process enumerates real screens and windows, and can
	// hand back a live frame of each — which is what makes the picker a picker
	// rather than a list of names you have to guess between.
	if (typeof getSources === "function") {
		try {
			const raw = (await (
				getSources as (opts: {
					types: string[];
					thumbnailSize?: { width: number; height: number };
					fetchWindowIcons?: boolean;
				}) => Promise<
					Array<{
						id: string;
						name: string;
						thumbnail?: string | null;
						appIcon?: string | null;
						appName?: string;
						windowTitle?: string;
						display_id?: string;
						sourceType?: "screen" | "window";
					}>
				>
			)({
				types: ["screen", "window"],
				thumbnailSize: { width: 320, height: 200 },
				fetchWindowIcons: true,
			})) as Array<{
				id: string;
				name: string;
				thumbnail?: string | null;
				appIcon?: string | null;
				appName?: string;
				windowTitle?: string;
			}>;

			const cameras = await listCameras();
			return [
				...raw.map((entry) => ({
					id: entry.id,
					name: entry.name,
					kind: (entry.id.startsWith("screen:") ? "screen" : "window") as
						| "screen"
						| "window",
					thumbnail: entry.thumbnail ?? null,
					appIcon: entry.appIcon ?? null,
					appName: entry.appName,
					primary: /primary/i.test(entry.name),
				})),
				...cameras,
			];
		} catch {
			// Fall through to the browser path rather than showing an empty list.
		}
	}

	// In a browser the picker belongs to the OS, so there is exactly one entry
	// and choosing it opens the native chooser.
	const sources: CaptureSource[] = [];
	if (typeof navigator.mediaDevices?.getDisplayMedia === "function") {
		sources.push({ id: "display", name: "Choose a screen or window…", kind: "screen" });
	}
	return [...sources, ...(await listCameras())];
}

async function listCameras(): Promise<CaptureSource[]> {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices
			.filter((device) => device.kind === "videoinput")
			.map((device) => ({
				id: `camera:${device.deviceId}`,
				name: device.label || "Camera",
				kind: "camera" as const,
			}));
	} catch {
		// Camera enumeration needs permission; screens are the primary surface.
		return [];
	}
}

/**
 * Opens a stream for one specific source.
 *
 * In Electron a `sourceId` from desktopCapturer can be captured directly
 * through the chromeMediaSource constraints — which is what lets the picker
 * (and an agent) record the screen you actually chose. `getDisplayMedia` would
 * throw the OS chooser up again and ignore the choice already made.
 */
export async function captureStream(
	source: CaptureSource,
	options: {
		microphone?: boolean;
		microphoneDeviceId?: string;
		systemAudio?: boolean;
		captureCursor?: boolean;
	} = {},
): Promise<MediaStream> {
	const microphone = options.microphoneDeviceId
		? { deviceId: { exact: options.microphoneDeviceId } }
		: true;

	/*
	 * Whether the capture should keep the real pointer.
	 *
	 * `captureCursor` means "record telemetry so Rendr can draw its own
	 * pointer" — and if Rendr is drawing one, the hardware pointer should be
	 * left out of the video, or the take has two cursors in it.
	 *
	 * KNOWN LIMITATION on macOS: this constraint is accepted and ignored. Both
	 * capture paths were tried (`getUserMedia` with chromeMediaSourceId, and
	 * `getDisplayMedia` through Electron's display-media handler), and disabling
	 * Chromium's ScreenCaptureKit features was tried as well. In every case a
	 * take recorded with the pointer parked on plain background still contained
	 * an arrow at exactly the parked coordinates, checked against the raw asset
	 * frames with no drawn overlay. So the real pointer is still burnt in and
	 * the drawn one sits on top of it.
	 *
	 * The constraint is left in place because it is correct and is honoured on
	 * other platforms. Fixing macOS likely means masking the captured pointer at
	 * composite time — the telemetry says where it was on every frame — rather
	 * than asking the capture pipeline to omit it.
	 */
	const drawsOwnCursor = options.captureCursor !== false;
	const streamCursor: "never" | "always" = drawsOwnCursor ? "never" : "always";

	if (source.kind === "camera") {
		return navigator.mediaDevices.getUserMedia({
			video: { deviceId: source.id.replace("camera:", "") },
			audio: options.microphone ? microphone : false,
		});
	}

	// The real screen or window, captured without a second prompt.
	if (source.id !== "display" && typeof window.electronAPI?.getSources === "function") {
		/*
		 * Through `getDisplayMedia`, not `getUserMedia`.
		 *
		 * The chromeMediaSourceId route bypasses Electron's display-media
		 * handler entirely, and that handler is the only thing that propagates
		 * `cursor: "never"` into the native capture pipeline. Taking the
		 * shortcut meant the constraint was accepted and silently ignored, so
		 * every take contained the real pointer *and* the one Rendr draws over
		 * it. Telling the main process which source to use first is what keeps
		 * this from raising a second OS picker.
		 */
		await window.electronAPI?.selectSource?.({
			id: source.id,
			name: source.name,
		} as never);

		const video = await navigator.mediaDevices.getDisplayMedia({
			audio: false,
			video: { cursor: streamCursor },
		} as DisplayMediaStreamOptions);

		// Screen capture carries no microphone, so the mic is a second stream
		// whose track is added to the same recording.
		if (options.microphone) {
			try {
				const mic = await navigator.mediaDevices.getUserMedia({ audio: microphone });
				for (const track of mic.getAudioTracks()) video.addTrack(track);
			} catch {
				// A refused microphone shouldn't cost the user their screen capture.
			}
		}
		return video;
	}

	return navigator.mediaDevices.getDisplayMedia({
		video: { cursor: streamCursor },
		audio: Boolean(options.systemAudio),
	} as DisplayMediaStreamOptions);
}

/**
 * Opens the camera as its own stream.
 *
 * Kept separate from the screen capture rather than mixed into it: the inset is
 * composited at edit time, so its size, position and crop stay changeable after
 * the take instead of being burned into the pixels.
 */
export async function openWebcamStream(
	deviceId?: string,
): Promise<{ stream: MediaStream; reason?: undefined } | { stream: null; reason: string }> {
	try {
		return {
			stream: await navigator.mediaDevices.getUserMedia({
				video: deviceId ? { deviceId: { exact: deviceId } } : true,
				audio: false,
			}),
		};
	} catch (error) {
		// A refused or busy camera must not cost the user their screen capture,
		// but "it didn't work" is not a useful thing to be told — the browser
		// distinguishes no camera from a refused one from one already in use,
		// and each has a different fix.
		const name = error instanceof Error ? error.name : "";
		const reason =
			name === "NotFoundError" || name === "OverconstrainedError"
				? deviceId
					? "That camera isn't connected any more. Pick another in the Webcam panel."
					: "No camera found on this machine."
				: name === "NotAllowedError"
					? "Camera access was refused. Grant it in System Settings → Privacy & Security → Camera."
					: name === "NotReadableError"
						? "The camera is in use by another app."
						: `Couldn't open the camera${name ? ` (${name})` : ""}.`;
		return { stream: null, reason };
	}
}

const KIND_ICON = {
	screen: <MonitorIcon />,
	window: <WindowIcon />,
	camera: <CameraIcon />,
};

/** Recordly groups the picker by what you are capturing; so does this. */
const GROUPS = [
	{ kind: "screen" as const, label: "Screens" },
	{ kind: "window" as const, label: "Windows" },
	{ kind: "camera" as const, label: "Cameras" },
];

export function SourcePicker({
	api,
	onClose,
	onStart,
}: {
	api: EditorApi;
	onClose: () => void;
	onStart: (source: CaptureSource, stream: MediaStream) => void;
}) {
	const { state, setRecording, toast } = api;
	const [sources, setSources] = useState<CaptureSource[] | null>(null);
	const [busy, setBusy] = useState(false);

	// A modal closes on Escape; the picker is one now.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		let cancelled = false;
		const load = () =>
			listSources().then((list) => {
				if (!cancelled) setSources(list);
			});
		void load();
		// Windows open and close and their contents change, so the previews are
		// refreshed while the picker is up rather than frozen at open time.
		const timer = window.setInterval(load, 3000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, []);

	const start = useCallback(
		async (source: CaptureSource) => {
			setBusy(true);
			try {
				const stream = await captureStream(source, {
					microphone: state.recording.microphone,
					systemAudio: state.recording.systemAudio,
				});
				onStart(source, stream);
			} catch (error) {
				// A cancelled picker is a normal outcome, not a failure to report loudly.
				const message = error instanceof Error ? error.message : String(error);
				if (!/denied|dismissed|abort/i.test(message)) {
					toast(`Couldn't start capture — ${message}`, "error");
				}
			} finally {
				setBusy(false);
			}
		},
		[onStart, state.recording.microphone, state.recording.systemAudio, toast],
	);

	return (
		// A dedicated surface, as Recordly gives it: the thumbnails are the whole
		// point of the picker and a 200px column can't show them.
		<div
			className="pmr-sheet__scrim"
			role="dialog"
			aria-modal="true"
			aria-label="Choose what to record"
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="pmr-sheet pmr-sheet--wide">
				<div className="pmr-sheet__head">
					<span className="pmr-sheet__title">Record</span>
					<button type="button" className="pmr-btn" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</div>

				<div className="pmr-record__options">
					<button
						type="button"
						className="pmr-action"
						data-active={state.recording.microphone}
						aria-pressed={state.recording.microphone}
						onClick={() => setRecording({ microphone: !state.recording.microphone })}
						style={
							state.recording.microphone
								? { borderColor: "var(--pmr-accent)", color: "var(--pmr-text)" }
								: undefined
						}
					>
						<MicIcon size={12} />
						Microphone
					</button>
					<button
						type="button"
						className="pmr-action"
						aria-pressed={state.recording.systemAudio}
						onClick={() => setRecording({ systemAudio: !state.recording.systemAudio })}
						style={
							state.recording.systemAudio
								? { borderColor: "var(--pmr-accent)", color: "var(--pmr-text)" }
								: undefined
						}
					>
						<SpeakerIcon size={12} />
						System audio
					</button>
					<button
						type="button"
						className="pmr-action"
						aria-pressed={state.recording.captureCursor}
						onClick={() =>
							setRecording({ captureCursor: !state.recording.captureCursor })
						}
						style={
							state.recording.captureCursor
								? { borderColor: "var(--pmr-accent)", color: "var(--pmr-text)" }
								: undefined
						}
						title="Cursor telemetry is what automatic zoom suggestions read"
					>
						<CursorTrackIcon size={12} />
						Track cursor
					</button>
				</div>

				<div className="pmr-sheet__body pmr-record__list">
					{sources === null ? (
						<div className="pmr-blank">
							<span className="pmr-blank__body">Looking for capture sources…</span>
						</div>
					) : sources.length === 0 ? (
						<div className="pmr-blank">
							<span className="pmr-blank__title">No capture sources</span>
							<span className="pmr-blank__body">
								Screen recording needs permission from the operating system. Grant
								it to Rendr in system settings, then reopen this panel.
							</span>
						</div>
					) : (
						<>
							{GROUPS.map(({ kind, label }) => {
								const inGroup = sources.filter((source) => source.kind === kind);
								if (inGroup.length === 0) return null;
								return (
									<section key={kind} className="pmr-sourcegroup">
										<h3 className="pmr-sourcegroup__label">
											{KIND_ICON[kind]}
											{label}
											<span className="pmr-sourcegroup__count">
												{inGroup.length}
											</span>
										</h3>
										<div className="pmr-sources">
											{inGroup.map((source) => (
												<button
													key={source.id}
													type="button"
													className="pmr-source"
													disabled={busy}
													onClick={() => start(source)}
													title={source.name}
												>
													<span className="pmr-source__preview">
														{source.thumbnail ? (
															// The real frame, so you pick by
															// looking rather than by guessing
															// which "Untitled" is which.
															<img
																src={source.thumbnail}
																alt=""
																className="pmr-source__shot"
															/>
														) : (
															<span className="pmr-source__glyph">
																{KIND_ICON[source.kind]}
															</span>
														)}
														{source.primary ? (
															<span className="pmr-source__badge">
																Primary
															</span>
														) : null}
													</span>
													<span className="pmr-source__meta">
														{source.appIcon ? (
															<img
																src={source.appIcon}
																alt=""
																className="pmr-source__icon"
															/>
														) : null}
														<span className="pmr-source__text">
															<span className="pmr-source__name">
																{source.name}
															</span>
															{source.appName &&
															source.appName !== source.name ? (
																<span className="pmr-source__app">
																	{source.appName}
																</span>
															) : null}
														</span>
													</span>
												</button>
											))}
										</div>
									</section>
								);
							})}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

export function Countdown({ value }: { value: number }) {
	return (
		<div className="pmr-countdown">
			<span className="pmr-countdown__n" key={value}>
				{value}
			</span>
		</div>
	);
}

export function RecordingHud({ api, onStop }: { api: EditorApi; onStop: () => void }) {
	const { state, pauseRecording, resumeRecording, cancelRecording } = api;
	const { phase, elapsed, sourceName } = state.recording;
	if (phase === "idle" || phase === "countdown") return null;

	return (
		<div className="pmr-hud" data-state={phase} role="status" aria-live="polite">
			<span className="pmr-hud__dot" />
			<span className="pmr-hud__time">{formatClock(elapsed)}</span>
			{sourceName ? <span className="pmr-hud__source">{sourceName}</span> : null}

			<span className="pmr-hud__sep" />

			{phase === "paused" ? (
				<button
					type="button"
					className="pmr-hud__btn"
					onClick={resumeRecording}
					title="Resume recording"
				>
					<PlayIcon size={13} />
				</button>
			) : (
				<button
					type="button"
					className="pmr-hud__btn"
					onClick={pauseRecording}
					title="Pause recording"
				>
					<HudPauseIcon />
				</button>
			)}

			<button
				type="button"
				className="pmr-hud__btn"
				onClick={cancelRecording}
				title="Discard this take"
			>
				<CloseIcon size={13} />
			</button>

			<button
				type="button"
				className="pmr-hud__btn pmr-hud__btn--stop"
				onClick={onStop}
				title="Stop and add to library"
			>
				<StopIcon />
			</button>
		</div>
	);
}

/**
 * Drives MediaRecorder for the life of one capture. Kept out of the components
 * so the HUD stays a view and the recorder has one owner.
 */
export function createRecorder(stream: MediaStream, webcamStream?: MediaStream | null) {
	const chunks: Blob[] = [];
	const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) =>
		MediaRecorder.isTypeSupported(type),
	);
	const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	// Deliberately not started here. The stream is open so the first frame is
	// ready the instant the countdown ends, but capturing during "3… 2… 1…"
	// would put the countdown itself at the head of every recording.

	const track = stream.getVideoTracks()[0];
	const settings = track?.getSettings() ?? {};
	// The stream knows whether anything is being recorded on the audio side, so
	// the asset doesn't have to guess later.
	const hasAudio = stream.getAudioTracks().length > 0;

	// The camera is captured to its own file rather than burnt into the screen
	// take, so its size, corner and shape stay editable after the fact — the
	// inset is composited at export time from these frames.
	const camera = webcamStream ? createCameraTake(webcamStream) : null;

	return {
		recorder,
		/** Begins capturing. Called when the countdown reaches zero. */
		begin() {
			if (recorder.state === "inactive") recorder.start(1000);
			camera?.begin();
		},
		/** Stops capture and resolves the finished asset. */
		async finish(
			name: string,
			seconds: number,
			hasCursorTelemetry: boolean,
		): Promise<{ asset: AssetModel; webcam: AssetModel | null }> {
			// The camera take is finished first so its id can be linked into the
			// screen take, which is the asset everything else refers to.
			const webcam = camera ? await camera.finish(`${name} — camera`, seconds) : null;
			const asset = await new Promise<AssetModel>((resolve) => {
				if (recorder.state === "inactive") {
					// Stopped during the countdown: there is no take, but the
					// devices still have to be released.
					for (const t of stream.getTracks()) t.stop();
					resolve(
						assetFromRecording(
							new Blob(chunks, { type: "video/webm" }),
							name,
							seconds,
							settings.width ?? 1920,
							settings.height ?? 1080,
							hasCursorTelemetry,
							hasAudio,
							webcam ? { webcamAssetId: webcam.id } : undefined,
						),
					);
					return;
				}
				recorder.onstop = () => {
					for (const t of stream.getTracks()) t.stop();
					resolve(
						assetFromRecording(
							new Blob(chunks, { type: recorder.mimeType || "video/webm" }),
							name,
							seconds,
							settings.width ?? 1920,
							settings.height ?? 1080,
							hasCursorTelemetry,
							hasAudio,
							webcam ? { webcamAssetId: webcam.id } : undefined,
						),
					);
				};
				recorder.stop();
			});
			return { asset, webcam };
		},
		abort() {
			camera?.abort();
			recorder.onstop = null;
			try {
				recorder.stop();
			} catch {
				// Already stopped; nothing to unwind.
			}
			for (const t of stream.getTracks()) t.stop();
		},
		/** The user ending capture from the OS chrome must end it here too. */
		onExternalStop(handler: () => void) {
			if (track) track.addEventListener("ended", handler, { once: true });
		},
	};
}

/**
 * The camera half of a take.
 *
 * A second recorder on the webcam stream, started and stopped with the screen
 * one so the two files share a clock: frame N of the screen take is frame N of
 * the camera take, which is what lets the encoder line them up without any
 * drift correction.
 */
function createCameraTake(stream: MediaStream) {
	const chunks: Blob[] = [];
	const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) =>
		MediaRecorder.isTypeSupported(type),
	);
	const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};

	// The stream is the preview's — stopping its tracks here would kill the
	// preview too, so the camera take releases nothing it did not open.
	return {
		begin() {
			if (recorder.state === "inactive") recorder.start(1000);
		},
		finish(name: string, seconds: number): Promise<AssetModel | null> {
			return new Promise((resolve) => {
				if (recorder.state === "inactive" || chunks.length === 0) {
					resolve(null);
					return;
				}
				recorder.onstop = () =>
					resolve(
						assetFromRecording(
							new Blob(chunks, { type: recorder.mimeType || "video/webm" }),
							name,
							seconds,
							settings.width ?? 1280,
							settings.height ?? 720,
							false,
							false,
							{ isWebcam: true },
						),
					);
				recorder.stop();
			});
		},
		abort() {
			recorder.onstop = null;
			try {
				recorder.stop();
			} catch {
				// Already stopped; nothing to unwind.
			}
		},
	};
}
