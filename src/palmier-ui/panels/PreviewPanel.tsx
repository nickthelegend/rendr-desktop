// PreviewContainerView — the composited canvas plus its transport bar.
//
// Everything the inspector edits is visible here: the zoom camera (driven by
// Recordly's own modules), transform, crop, opacity, blend mode, edge rounding
// and softness, the colour grade, and text overlays. If a control changes state
// but nothing moves on this canvas, the wiring is wrong.
//
// Video clips draw their real decoded frame, seeked to the playhead.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	backgroundCss,
	DEFAULT_BACKGROUND,
	footageBox,
	hasBackground,
	shadowFor,
} from "../background";
import { Slider } from "../controls";
import {
	type CursorFrame,
	createCursorSpringState,
	cursorFill,
	cursorPath,
	DEFAULT_CURSOR,
	resetCursorSpring,
	resolveCursor,
	ringAt,
} from "../cursor";
import { buildChannelLuts, type ChannelLuts, lutToTableValues } from "../curves";
import { clipFilter, curveFilterId } from "../effects";
import {
	CollapseIcon,
	ExpandIcon,
	FilmIcon,
	PauseIcon,
	PlayIcon,
	RecordIcon,
	SkipEndIcon,
	SkipStartIcon,
} from "../icons";
import { clipAtFrame, clipOpacityAt } from "../keyframes";
import type { ClipModel } from "../model";
import { PanelHeader } from "../Panel";
import { applyPixelGrade, needsPixelGrade, type PixelGrade } from "../pixelGrade";
import { updateZoomRegion } from "../reducers";
import { type EditorApi, formatTimecode, frameToClipSourceMs, PLAYBACK_RATE } from "../state";
import { isPerWord, resolveTextAnimation, wordColor } from "../textAnimation";
import { DEFAULT_WEBCAM, type WebcamBox, webcamBox } from "../webcam";
import {
	type CameraState,
	createCameraSpringState,
	createCursorFollowCameraState,
	DEFAULT_ZOOM_TIMING,
	resetCameraSpring,
	resolveCamera,
	springCamera,
} from "../zoom";

const BLEND_CSS: Record<ClipModel["blendMode"], string> = {
	normal: "normal",
	multiply: "multiply",
	screen: "screen",
	overlay: "overlay",
	softLight: "soft-light",
	difference: "difference",
};

/** A video clip's decoded frame, kept in step with the playhead. */
function ClipVideo({ url, sourceSeconds }: { url: string; sourceSeconds: number }) {
	const ref = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const video = ref.current;
		if (!video) return;
		// Seeking within a frame of the current position would only stall
		// decoding, so only move when it actually matters.
		if (Math.abs(video.currentTime - sourceSeconds) > 0.03) {
			try {
				video.currentTime = Math.max(0, sourceSeconds);
			} catch {
				// Metadata may not have arrived yet; the next tick lands it.
			}
		}
	}, [sourceSeconds]);

	return (
		<video
			ref={ref}
			src={url}
			muted
			playsInline
			preload="auto"
			style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
		/>
	);
}

/**
 * A frame that needs whole-pixel grading, drawn through a canvas.
 *
 * Hue curves and 3D LUTs can't be expressed as a CSS filter or an SVG transfer
 * function, so for a clip carrying either, the preview stops showing the raw
 * <video> and paints each frame into a canvas that pixelGrade.ts then works
 * over — the same function the encoder calls, so the two agree.
 *
 * The canvas is sized to what is on screen, not to the source: a 1080p frame is
 * two million pixels and a preview pane is a fraction of that, which is what
 * keeps the per-pixel pass fast enough to scrub through.
 */
function ClipGradedCanvas({
	url,
	sourceSeconds,
	grade,
	isImage,
}: {
	url: string;
	sourceSeconds: number;
	grade: PixelGrade;
	isImage: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const sourceRef = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
	const [ready, setReady] = useState(false);

	// The decoded source is held outside React: it is a mutable device, not
	// state, and re-creating it per render would restart the decode each frame.
	useEffect(() => {
		setReady(false);
		if (isImage) {
			const image = new Image();
			image.onload = () => {
				sourceRef.current = image;
				setReady(true);
			};
			image.src = url;
			return () => {
				sourceRef.current = null;
			};
		}
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.onloadeddata = () => {
			sourceRef.current = video;
			setReady(true);
		};
		video.src = url;
		return () => {
			video.removeAttribute("src");
			sourceRef.current = null;
		};
	}, [url, isImage]);

	// The grade is read through a ref inside the effect. It is a fresh object on
	// every render, so depending on it directly would repaint — a full readback
	// and per-pixel pass — on every render rather than when it actually changed.
	const gradeRef = useRef(grade);
	gradeRef.current = grade;

	// A stable identity for the grade, so the paint effect isn't re-run by a
	// fresh object carrying the same numbers.
	const gradeKey = useMemo(
		() =>
			JSON.stringify({
				hue: grade.hueCurves ?? null,
				lut: grade.lut ? `${grade.lut.name}:${grade.lut.size}` : null,
				amount: grade.lutAmount ?? 1,
			}),
		[grade],
	);

	// gradeKey is listed but never read in the body: it exists purely to make the
	// effect re-run when the grade's *values* change, since the grade itself is
	// reached through a ref. Removing it would freeze the picture on the first
	// grade a clip was given.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const canvas = canvasRef.current;
		const source = sourceRef.current;
		if (!canvas || !source || !ready) return;

		let cancelled = false;
		const paint = () => {
			if (cancelled) return;
			const box = canvas.getBoundingClientRect();
			const width = Math.max(2, Math.round(box.width));
			const height = Math.max(2, Math.round(box.height));
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (!context) return;

			// Cover-fit, matching the object-fit: cover the ungraded path uses.
			const naturalW =
				source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
			const naturalH =
				source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
			if (naturalW === 0 || naturalH === 0) return;
			const scale = Math.max(width / naturalW, height / naturalH);
			const drawW = naturalW * scale;
			const drawH = naturalH * scale;
			context.clearRect(0, 0, width, height);
			context.drawImage(source, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);

			const image = context.getImageData(0, 0, width, height);
			applyPixelGrade(image.data, gradeRef.current);
			context.putImageData(image, 0, 0);
		};

		if (source instanceof HTMLVideoElement) {
			if (Math.abs(source.currentTime - sourceSeconds) > 0.03) {
				const onSeeked = () => {
					source.removeEventListener("seeked", onSeeked);
					paint();
				};
				source.addEventListener("seeked", onSeeked);
				try {
					source.currentTime = Math.max(0, sourceSeconds);
				} catch {
					source.removeEventListener("seeked", onSeeked);
					paint();
				}
				return () => {
					cancelled = true;
					source.removeEventListener("seeked", onSeeked);
				};
			}
		}
		paint();
		return () => {
			cancelled = true;
		};
	}, [sourceSeconds, ready, gradeKey]);

	return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}

/**
 * Tone curves and colour balance as SVG filters the CSS chain can reference.
 *
 * `feComponentTransfer` is a per-channel lookup, which is exactly what
 * `buildChannelLuts` produces — so the preview and the canvas encoder apply the
 * same table rather than two approximations of it.
 */
function CurveFilters({ clips }: { clips: readonly ClipModel[] }) {
	const graded = clips
		.map((clip) => ({ clip, luts: buildChannelLuts(clip.color.curves, clip.color.balance) }))
		.filter((entry): entry is { clip: ClipModel; luts: ChannelLuts } => entry.luts !== null);
	if (graded.length === 0) return null;

	return (
		<svg aria-hidden="true" style={{ position: "absolute", width: 0, height: 0 }}>
			<title>Colour curves</title>
			<defs>
				{graded.map(({ clip, luts }) => (
					<filter
						key={clip.id}
						id={curveFilterId(clip.id)}
						colorInterpolationFilters="sRGB"
					>
						<feComponentTransfer>
							<feFuncR type="table" tableValues={lutToTableValues(luts.r)} />
							<feFuncG type="table" tableValues={lutToTableValues(luts.g)} />
							<feFuncB type="table" tableValues={lutToTableValues(luts.b)} />
						</feComponentTransfer>
					</filter>
				))}
			</defs>
		</svg>
	);
}

/**
 * The camera, drawn into its bubble.
 *
 * Two sources, and which one is right depends on where the playhead is. A take
 * that was recorded with a camera has that camera on file, and the preview has
 * to scrub it in step with the screen — otherwise the preview shows a live
 * face over footage the export will show the recorded one over, and the two
 * disagree. With no recorded camera under the playhead it falls back to the
 * live stream, which is what makes the bubble useful before you hit record.
 */
function WebcamInset({
	stream,
	recorded,
	box,
	mirror,
	crop,
}: {
	stream: MediaStream | null;
	recorded: { url: string; sourceSeconds: number } | null;
	box: WebcamBox;
	mirror: boolean;
	crop: { top: number; right: number; bottom: number; left: number };
}) {
	const ref = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const video = ref.current;
		if (!video) return;
		if (recorded) {
			// The recorded take wins: srcObject and src can't both be set.
			if (video.srcObject) video.srcObject = null;
			if (video.src !== recorded.url) video.src = recorded.url;
			if (Math.abs(video.currentTime - recorded.sourceSeconds) > 0.03) {
				try {
					video.currentTime = Math.max(0, recorded.sourceSeconds);
				} catch {
					// Metadata may not have arrived yet; the next tick lands it.
				}
			}
			return;
		}
		if (!stream || video.srcObject === stream) return;
		video.removeAttribute("src");
		video.srcObject = stream;
		void video.play().catch(() => undefined);
	}, [stream, recorded]);

	return (
		<div
			className="pmr-webcam"
			style={{
				left: `${box.x * 100}%`,
				top: `${box.y * 100}%`,
				width: `${box.width * 100}%`,
				height: `${box.height * 100}%`,
				borderRadius: `${box.radius * 100}%`,
			}}
		>
			<video
				ref={ref}
				muted
				playsInline
				style={{
					width: `${100 / Math.max(0.02, 1 - crop.left - crop.right)}%`,
					height: `${100 / Math.max(0.02, 1 - crop.top - crop.bottom)}%`,
					marginLeft: `${(-crop.left * 100) / Math.max(0.02, 1 - crop.left - crop.right)}%`,
					marginTop: `${(-crop.top * 100) / Math.max(0.02, 1 - crop.top - crop.bottom)}%`,
					objectFit: "cover",
					transform: mirror ? "scaleX(-1)" : undefined,
					display: "block",
				}}
			/>
		</div>
	);
}

export function PreviewPanel({
	api,
	onRecordClick,
	webcamStream,
}: {
	api: EditorApi;
	onRecordClick: () => void;
	/** The live camera, when one is open. */
	webcamStream?: MediaStream | null;
}) {
	const { state, patch, timeline, totalFrames, commit } = api;
	const fps = timeline.fps;
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [fullscreen, setFullscreen] = useState(false);
	const [stage, setStage] = useState({ width: 0, height: 0 });
	const playheadRef = useRef(state.playhead);
	playheadRef.current = state.playhead;

	/**
	 * Measures the canvas, through a callback ref rather than an effect.
	 *
	 * An effect with an empty dependency list runs once, and on first mount the
	 * preview is usually showing its empty state — a restored project arrives a
	 * tick later — so there was no canvas to observe and the observer was never
	 * attached again when one appeared. `stage` stayed 0×0, and because
	 * `resolveCamera` treats a zero-sized stage as "nothing to do", every zoom
	 * silently rendered un-zoomed. A callback ref binds whenever the node
	 * appears, however late that is.
	 */
	const observerRef = useRef<ResizeObserver | null>(null);
	const measureCanvas = useCallback((node: HTMLDivElement | null) => {
		canvasRef.current = node;
		observerRef.current?.disconnect();
		if (!node) {
			observerRef.current = null;
			setStage({ width: 0, height: 0 });
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			setStage({ width: entry.contentRect.width, height: entry.contentRect.height });
		});
		observer.observe(node);
		observerRef.current = observer;
		// The first measurement comes from the box itself: a ResizeObserver only
		// fires on the next frame, and the first paint would zoom wrong until then.
		const rect = node.getBoundingClientRect();
		setStage({ width: rect.width, height: rect.height });
	}, []);

	useEffect(() => () => observerRef.current?.disconnect(), []);

	const rateRef = useRef(state.playbackRate ?? 1);
	rateRef.current = state.playbackRate ?? 1;

	// Playback advances the playhead in real time and stops at the end. The
	// current frame is read through a ref so the loop isn't torn down each tick.
	useEffect(() => {
		if (!state.playing) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			// The rate is read from a ref, so dragging the speed bar changes the
			// playhead's pace mid-play without tearing the loop down and
			// restarting it from a stale `last`.
			const advanced = ((now - last) / 1000) * fps * rateRef.current;
			last = now;
			const next = playheadRef.current + advanced;
			if (next >= totalFrames) {
				patch({ playhead: totalFrames, playing: false });
				return;
			}
			patch({ playhead: next });
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [state.playing, fps, totalFrames, patch]);

	const visible = timeline.tracks
		.filter((track) => track.kind === "video" && !track.hidden)
		.flatMap((track) =>
			track.clips.filter(
				(clip) => state.playhead >= clip.startFrame && state.playhead < clip.endFrame,
			),
		);

	const zoomHost = visible.find((clip) => (clip.zoomRegions?.length ?? 0) > 0);
	const sourceMs = zoomHost ? frameToClipSourceMs(zoomHost, state.playhead, fps) : 0;

	/*
	 * The camera and the drawn pointer both carry motion state between frames —
	 * the follow camera's held position, and the springs that ease toward it.
	 *
	 * Stepping that state during render would be wrong twice over: React may
	 * render a component more than once for a single commit (StrictMode does it
	 * on every render), which advances the springs twice per frame with a
	 * nonsense delta the second time; and a render can happen for reasons that
	 * have nothing to do with time passing. So while time is running the motion
	 * is stepped exactly once per animation frame, in the tick below, and the
	 * result is what renders.
	 *
	 * While paused or scrubbing it is computed fresh and snapped: a spring would
	 * leave the picture trailing the playhead, so the frame on screen would not
	 * be the frame that was asked for.
	 */
	const followState = useRef(createCursorFollowCameraState());
	const cameraSpring = useRef(createCameraSpringState());
	const cursorSpring = useRef(createCursorSpringState());
	const [sprung, setSprung] = useState<{
		camera: CameraState;
		cursor: CursorFrame | null;
	} | null>(null);

	const cursorSettings = state.cursor ?? DEFAULT_CURSOR;
	const cursorHost = visible.find((clip) => clip.mediaType === "video");
	const timing = state.zoomTiming ?? DEFAULT_ZOOM_TIMING;

	// Everything the tick needs, refreshed each render so the loop itself never
	// has to be torn down and rebuilt mid-playback.
	const motionInputs = useRef({
		regions: zoomHost?.zoomRegions ?? [],
		sourceMs,
		width: stage.width,
		height: stage.height,
		telemetry: state.cursorTelemetry,
		timing,
		cursorSettings,
		cursorSourceMs: cursorHost ? frameToClipSourceMs(cursorHost, state.playhead, fps) : null,
	});
	motionInputs.current = {
		regions: zoomHost?.zoomRegions ?? [],
		sourceMs,
		width: stage.width,
		height: stage.height,
		telemetry: state.cursorTelemetry,
		timing,
		cursorSettings,
		cursorSourceMs: cursorHost ? frameToClipSourceMs(cursorHost, state.playhead, fps) : null,
	};

	useEffect(() => {
		if (!state.playing) {
			// Forget the momentum, so resuming doesn't lurch from a stale velocity.
			resetCameraSpring(cameraSpring.current);
			resetCursorSpring(cursorSpring.current);
			setSprung(null);
			return;
		}
		let raf = 0;
		let last = performance.now();
		const step = (now: number) => {
			const deltaMs = Math.max(1, now - last);
			last = now;
			const input = motionInputs.current;
			const raw = resolveCamera(
				input.regions,
				input.sourceMs,
				input.width,
				input.height,
				input.telemetry,
				followState.current,
				input.timing,
			);
			setSprung({
				camera: springCamera(raw, cameraSpring.current, deltaMs, input.timing.smoothness),
				cursor:
					input.cursorSourceMs === null
						? null
						: resolveCursor(
								input.telemetry,
								input.cursorSourceMs,
								input.cursorSettings,
								cursorSpring.current,
								deltaMs,
							),
			});
			raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [state.playing]);

	// Paused: computed fresh from a throwaway follow state, so nothing is
	// mutated by rendering and scrubbing lands exactly on the frame asked for.
	const camera =
		sprung?.camera ??
		resolveCamera(
			zoomHost?.zoomRegions ?? [],
			sourceMs,
			stage.width,
			stage.height,
			state.cursorTelemetry,
			createCursorFollowCameraState(),
			timing,
		);

	const dragFocus = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const region = camera.region;
			// Only the selected zoom can be aimed, matching where the handle is
			// drawn. Otherwise a click anywhere on the preview silently moves the
			// focus of whatever zoom happens to be under the playhead, with no
			// handle on screen to explain what just moved.
			if (!region || !zoomHost || region.id !== state.selectedZoomRegionId) return;
			const node = canvasRef.current;
			if (!node) return;
			event.preventDefault();

			const apply = (clientX: number, clientY: number) => {
				const rect = node.getBoundingClientRect();
				commit("Aim zoom", (current) => {
					const result = updateZoomRegion(
						current,
						zoomHost.id,
						region.id,
						{
							focus: {
								cx: (clientX - rect.left) / rect.width,
								cy: (clientY - rect.top) / rect.height,
							},
						},
						Number.MAX_SAFE_INTEGER,
					);
					return result.ok ? result.timeline : current;
				});
			};

			apply(event.clientX, event.clientY);
			const onMove = (moveEvent: PointerEvent) => apply(moveEvent.clientX, moveEvent.clientY);
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[camera.region, commit, state.selectedZoomRegionId, zoomHost],
	);

	// The browser owns fullscreen state — Escape and the OS chrome can both
	// leave it — so the flag follows the document rather than a local toggle.
	useEffect(() => {
		const sync = () => setFullscreen(document.fullscreenElement === rootRef.current);
		document.addEventListener("fullscreenchange", sync);
		return () => document.removeEventListener("fullscreenchange", sync);
	}, []);

	const toggleFullscreen = useCallback(() => {
		const node = rootRef.current;
		if (!node) return;
		if (document.fullscreenElement) void document.exitFullscreen();
		else void node.requestFullscreen?.().catch(() => undefined);
	}, []);

	// While playing this came from the tick, sprung. Paused, it is resolved
	// fresh and unsprung so the pointer sits exactly where this frame says.
	const cursorFrame =
		sprung?.cursor !== undefined
			? sprung.cursor
			: cursorHost
				? resolveCursor(
						state.cursorTelemetry,
						frameToClipSourceMs(cursorHost, state.playhead, fps),
						cursorSettings,
					)
				: null;

	// The backdrop, and where the footage sits inside it. Measured against the
	// project's own size and then scaled to the preview, so the rounding and the
	// shadow are proportionally what the export will write.
	const backdrop = state.background ?? DEFAULT_BACKGROUND;
	const backdropOn = hasBackground(backdrop);
	const footage = footageBox(backdrop, timeline.width, timeline.height);
	const backdropShadow = shadowFor(backdrop, timeline.height);
	const previewScale = stage.height > 0 ? stage.height / timeline.height : 1;

	const webcamSettings = state.webcam ?? DEFAULT_WEBCAM;
	const webcamBoxRect = webcamBox(webcamSettings, timeline.width / timeline.height, camera.scale);

	/**
	 * The camera file belonging to whichever take is under the playhead, seeked
	 * to that take's own source time — the same rule the encoder follows, so
	 * trimming or sliding the screen clip carries its camera with it.
	 */
	const recordedCamera = (() => {
		if (!webcamSettings.show) return null;
		for (const clip of visible) {
			if (clip.mediaType === "text" || !clip.assetId) continue;
			const asset = state.assets.find((entry) => entry.id === clip.assetId);
			if (!asset?.webcamAssetId) continue;
			const cameraAsset = state.assets.find((entry) => entry.id === asset.webcamAssetId);
			if (!cameraAsset || cameraAsset.offline || !cameraAsset.url) continue;
			return {
				url: cameraAsset.url,
				sourceSeconds: frameToClipSourceMs(clip, state.playhead, fps) / 1000,
			};
		}
		return null;
	})();

	const empty = totalFrames === 0;

	return (
		<div className="pmr-previewroot" ref={rootRef} data-fullscreen={fullscreen || undefined}>
			<PanelHeader title="Preview">
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					{timeline.width}×{timeline.height} · {fps}fps
				</span>
				<button
					type="button"
					className="pmr-btn"
					onClick={toggleFullscreen}
					title={fullscreen ? "Leave fullscreen (Esc)" : "Fullscreen preview (F)"}
					aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen preview"}
					aria-pressed={fullscreen}
				>
					{fullscreen ? <CollapseIcon /> : <ExpandIcon />}
				</button>
			</PanelHeader>

			{empty ? (
				<div className="pmr-blank">
					<span className="pmr-blank__icon">
						<FilmIcon size={28} />
					</span>
					<span className="pmr-blank__title">Nothing on the timeline</span>
					<span className="pmr-blank__body">
						Record your screen or bring in a file, then drop it on a track to see it
						here.
					</span>
					<div className="pmr-blank__actions">
						<button
							type="button"
							className="pmr-action pmr-action--record"
							onClick={onRecordClick}
						>
							<RecordIcon size={11} />
							Record screen
						</button>
					</div>
				</div>
			) : (
				<div className="pmr-preview">
					<CurveFilters clips={visible} />
					<div
						className="pmr-preview__canvas"
						ref={measureCanvas}
						onPointerDown={dragFocus}
						// The backdrop the footage sits on. It is the canvas' own
						// background rather than a layer, so nothing can be drawn
						// behind it by accident.
						style={backdropOn ? { background: backgroundCss(backdrop) } : undefined}
					>
						{/* The footage, inset and rounded inside the backdrop. The
						    encoder applies the same box, so the preview and the
						    file frame the shot identically. */}
						<div
							style={
								backdropOn
									? {
											position: "absolute",
											left: `${footage.x * 100}%`,
											top: `${footage.y * 100}%`,
											width: `${footage.width * 100}%`,
											height: `${footage.height * 100}%`,
											borderRadius: footage.radiusPx * previewScale,
											overflow: "hidden",
											boxShadow: backdropShadow
												? `0 ${backdropShadow.offsetY * previewScale}px ${backdropShadow.blur * previewScale}px rgba(0,0,0,${backdropShadow.alpha})`
												: undefined,
										}
									: { position: "absolute", inset: 0 }
							}
						>
							{/* Camera: one transform for the whole composited stack. */}
							<div
								style={{
									position: "absolute",
									inset: 0,
									transformOrigin: "0 0",
									transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
								}}
							>
								{[...visible].reverse().map((raw) => {
									// Keyframes resolve first: everything below reads the
									// clip as it is at this frame, not as it was authored.
									const clip = clipAtFrame(raw, state.playhead);
									const { transform, crop } = clip;
									// Fades are part of what the clip looks like, not
									// only what it sounds like.
									const opacity = clipOpacityAt(raw, state.playhead);
									const flip = `scale(${transform.flipHorizontal ? -1 : 1}, ${transform.flipVertical ? -1 : 1})`;
									const asset = state.assets.find(
										(entry) => entry.id === clip.assetId,
									);
									return (
										<div
											key={clip.id}
											style={{
												position: "absolute",
												left: `${(transform.centerX - transform.width / 2) * 100}%`,
												top: `${(transform.centerY - transform.height / 2) * 100}%`,
												width: `${transform.width * 100}%`,
												height: `${transform.height * 100}%`,
												transform: `rotate(${transform.rotation}deg) ${flip}`,
												opacity,
												mixBlendMode: BLEND_CSS[clip.blendMode] as never,
												borderRadius: `${clip.edgeRounding * 50}%`,
												maskImage:
													clip.edgeSoftness > 0
														? `radial-gradient(ellipse at center, #000 ${100 - clip.edgeSoftness * 60}%, transparent 100%)`
														: undefined,
												overflow: "hidden",
												filter: clipFilter(clip, true),
											}}
										>
											<div
												style={{
													position: "absolute",
													inset: 0,
													clipPath: `inset(${crop.top * 100}% ${crop.right * 100}% ${crop.bottom * 100}% ${crop.left * 100}%)`,
												}}
											>
												{clip.mediaType === "text" ? (
													(() => {
														// One resolver drives the preview and the encoder, so
														// what plays is what exports.
														const anim = resolveTextAnimation(
															clip,
															state.playhead,
															fps,
														);
														const style = clip.textStyle;
														const preset = style?.animation ?? "off";
														const size =
															stage.height > 0
																? ((style?.fontSize ?? 48) /
																		timeline.height) *
																	stage.height
																: 0;
														return (
															<div
																style={{
																	position: "absolute",
																	inset: 0,
																	display: "flex",
																	alignItems: "center",
																	justifyContent:
																		style?.alignment === "left"
																			? "flex-start"
																			: style?.alignment ===
																					"right"
																				? "flex-end"
																				: "center",
																	padding: "0 4%",
																	textAlign:
																		style?.alignment ??
																		"center",
																	whiteSpace: "pre-wrap",
																	fontFamily: style?.fontFamily,
																	fontSize: size,
																	fontWeight: style?.bold
																		? 700
																		: 400,
																	fontStyle: style?.italic
																		? "italic"
																		: "normal",
																	letterSpacing:
																		stage.height > 0
																			? ((style?.tracking ??
																					0) /
																					timeline.height) *
																				stage.height
																			: 0,
																	textTransform: style?.uppercase
																		? "uppercase"
																		: "none",
																	color: style?.color,
																	lineHeight: 1.15,
																	opacity: anim.opacity,
																	transform: `translateY(${anim.offsetY * 100}%) scale(${anim.scale})`,
																}}
															>
																{isPerWord(preset) &&
																anim.words.length > 0 ? (
																	<span
																		style={{
																			display: "inline",
																		}}
																	>
																		{anim.words.map(
																			(word, index) => {
																				const paint =
																					wordColor(
																						preset,
																						word,
																						style?.color ??
																							"#fff",
																						style?.highlightColor ??
																							"#F29933",
																					);
																				return (
																					<span
																						key={`${word.text}-${index}`}
																						style={{
																							color: paint.color,
																							opacity:
																								paint.opacity,
																							transition:
																								"color 0.08s linear",
																						}}
																					>
																						{
																							word.text
																						}{" "}
																					</span>
																				);
																			},
																		)}
																	</span>
																) : (
																	(anim.visibleText ??
																	clip.content)
																)}
															</div>
														);
													})()
												) : asset && needsPixelGrade(clip.color) ? (
													// Hue curves or a LUT: no CSS filter
													// can express either, so this frame
													// goes through the canvas path that
													// runs the encoder's own function.
													<ClipGradedCanvas
														url={asset.url}
														isImage={asset.type === "image"}
														grade={clip.color}
														sourceSeconds={
															frameToClipSourceMs(
																clip,
																state.playhead,
																fps,
															) / 1000
														}
													/>
												) : asset?.type === "image" ? (
													<img
														src={asset.url}
														alt=""
														style={{
															width: "100%",
															height: "100%",
															objectFit: "cover",
														}}
													/>
												) : asset ? (
													<ClipVideo
														url={asset.url}
														sourceSeconds={
															frameToClipSourceMs(
																clip,
																state.playhead,
																fps,
															) / 1000
														}
													/>
												) : (
													<div className="pmr-preview__missing">
														Media unavailable
													</div>
												)}
											</div>
										</div>
									);
								})}
							</div>
						</div>

						{/* The camera inset, composited over the capture. It sits
						    outside the zoom transform: a presenter shouldn't slide
						    off frame because the screen punched in. */}
						{webcamBoxRect && (recordedCamera || webcamStream) ? (
							<WebcamInset
								stream={webcamStream ?? null}
								recorded={recordedCamera}
								box={webcamBoxRect}
								mirror={webcamSettings.mirror}
								crop={webcamSettings.crop}
							/>
						) : null}

						{/* The drawn pointer, from the take's own telemetry. It sits
						    inside the camera transform so a punch-in magnifies it
						    exactly as it magnifies the picture. */}
						{/* The spotlight and the click ring sit under the pointer, so
						    the pointer is never dimmed by its own spotlight. The
						    same radii the encoder uses, in percentages. */}
						{cursorFrame && (cursorSettings.spotlight ?? 0) > 0 ? (
							<div
								aria-hidden="true"
								style={{
									position: "absolute",
									inset: 0,
									pointerEvents: "none",
									background: `radial-gradient(circle at ${cursorFrame.cx * 100}% ${cursorFrame.cy * 100}%, rgba(0,0,0,0) ${(cursorSettings.spotlightSize ?? 0.28) * 55}%, rgba(0,0,0,${(cursorSettings.spotlight * 0.72).toFixed(3)}) ${(cursorSettings.spotlightSize ?? 0.28) * 160}%)`,
								}}
							/>
						) : null}

						{cursorFrame?.ring !== null && cursorFrame && cursorSettings.clickRing
							? (() => {
									const shortEdge = Math.min(stage.width, stage.height) || 1;
									const { radius, alpha } = ringAt(
										cursorFrame.ring ?? 0,
										shortEdge,
									);
									return (
										<div
											aria-hidden="true"
											style={{
												position: "absolute",
												left: `${cursorFrame.cx * 100}%`,
												top: `${cursorFrame.cy * 100}%`,
												width: radius * 2,
												height: radius * 2,
												marginLeft: -radius,
												marginTop: -radius,
												borderRadius: "50%",
												border: `${Math.max(1.5, shortEdge / 320)}px solid ${cursorSettings.ringColor || "#FFFFFF"}`,
												opacity: alpha,
												pointerEvents: "none",
											}}
										/>
									);
								})()
							: null}

						{/* The directional smear. `stdDeviation` takes an x and a y,
						    so blurring only on x inside a rotated frame smears the
						    pointer along its travel and leaves the perpendicular
						    edges sharp — which is what reads as speed. */}
						{cursorFrame && cursorFrame.blur > 0.4 ? (
							<svg
								aria-hidden="true"
								style={{ position: "absolute", width: 0, height: 0 }}
							>
								<title>Cursor smear</title>
								<defs>
									<filter
										id="pmr-cursor-smear"
										x="-50%"
										y="-50%"
										width="200%"
										height="200%"
										filterUnits="objectBoundingBox"
									>
										<feGaussianBlur
											stdDeviation={`${Math.min(4, cursorFrame.blur).toFixed(2)} 0`}
											result="smear"
										/>
									</filter>
								</defs>
							</svg>
						) : null}

						{cursorFrame ? (
							<svg
								className="pmr-cursor"
								viewBox="0 0 24 24"
								aria-hidden="true"
								style={{
									left: `${cursorFrame.cx * 100}%`,
									top: `${cursorFrame.cy * 100}%`,
									width: 24 * cursorFrame.scale,
									height: 24 * cursorFrame.scale,
									// Directional: the smear is along the direction of
									// travel, which reads as speed. A plain blur()
									// fuzzes every edge equally and reads as a
									// rendering fault.
									filter:
										cursorFrame.blur > 0.4
											? "url(#pmr-cursor-smear)"
											: undefined,
									// The filter blurs on x only, so the element is
									// turned to face the direction of travel and the
									// glyph is turned back inside it.
									transform:
										cursorFrame.blur > 0.4
											? `rotate(${((cursorFrame.angle * 180) / Math.PI).toFixed(1)}deg)`
											: undefined,
								}}
							>
								<title>Cursor</title>
								<g
									// Turned back, so the pointer still points the way
									// it should while the smear runs along its travel.
									transform={
										cursorFrame.blur > 0.4
											? `rotate(${((-cursorFrame.angle * 180) / Math.PI).toFixed(1)} 12 12)`
											: undefined
									}
								>
									<path
										d={cursorPath(cursorSettings.style)}
										fill={cursorFill(cursorSettings.style).fill}
										stroke={cursorFill(cursorSettings.style).stroke}
										strokeWidth={1.2}
										strokeLinejoin="round"
									/>
								</g>
							</svg>
						) : null}

						{/* Editor guides, not part of the picture. They appear only
						    while the zoom under the playhead is the selected one —
						    otherwise a ring and a readout sit over every zoom in
						    normal playback, which reads as something burnt into
						    the video rather than a handle for moving it. They have
						    never been in the export; this is about the preview
						    looking like the finished thing. */}
						{camera.region && camera.region.id === state.selectedZoomRegionId ? (
							<>
								<span
									className="pmr-focus"
									style={{
										left: `${camera.focus.cx * 100}%`,
										top: `${camera.focus.cy * 100}%`,
										opacity: 0.5 + camera.strength * 0.5,
									}}
								/>
								<span className="pmr-zoombadge">
									ZOOM {camera.scale.toFixed(2)}× · {camera.region.mode} ·{" "}
									{Math.round(camera.strength * 100)}%
								</span>
							</>
						) : null}
					</div>
				</div>
			)}

			<div className="pmr-transport">
				<button
					type="button"
					className="pmr-btn"
					onClick={() => patch({ playhead: 0 })}
					title="Go to start"
					disabled={empty}
				>
					<SkipStartIcon />
				</button>
				<button
					type="button"
					className="pmr-btn"
					onClick={() => patch({ playing: !state.playing })}
					title={state.playing ? "Pause (Space)" : "Play (Space)"}
					disabled={empty}
				>
					{state.playing ? <PauseIcon /> : <PlayIcon />}
				</button>
				<button
					type="button"
					className="pmr-btn"
					onClick={() => patch({ playhead: totalFrames })}
					title="Go to end"
					disabled={empty}
				>
					<SkipEndIcon />
				</button>

				<span className="pmr-timecode">{formatTimecode(state.playhead, fps)}</span>
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					/ {formatTimecode(totalFrames, fps)}
				</span>

				<Slider
					value={state.playhead}
					min={0}
					max={Math.max(totalFrames, 1)}
					step={1}
					disabled={empty}
					ariaLabel="Playhead"
					onChange={(next) => patch({ playhead: next })}
				/>

				{/* Review speed. A continuous bar rather than 1×/2× buttons: the
				    rate that keeps a passage readable is one you find by
				    dragging, not one you pick from a list. It never touches the
				    timeline, so nothing here can reach the export. */}
				<div className="pmr-rate" title="Playback speed — double-click to reset">
					<Slider
						value={state.playbackRate ?? 1}
						min={PLAYBACK_RATE.min}
						max={PLAYBACK_RATE.max}
						step={PLAYBACK_RATE.step}
						disabled={empty}
						ariaLabel="Playback speed"
						onChange={api.setPlaybackRate}
					/>
					<button
						type="button"
						className="pmr-rate__value"
						onClick={() => api.setPlaybackRate(PLAYBACK_RATE.default)}
						title="Back to 1×"
						aria-label={`Playback speed ${(state.playbackRate ?? 1).toFixed(2)}×. Reset to 1×.`}
					>
						{(state.playbackRate ?? 1).toFixed(2)}×
					</button>
				</div>
			</div>
		</div>
	);
}
