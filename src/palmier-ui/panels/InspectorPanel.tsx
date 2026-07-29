// InspectorView — a tab bar over collapsible groups of label/control rows.
// Tabs are resolved from the selection, exactly as InspectorView.ClipTab does:
// text clips get Content/Animate, visual clips get Video/Adjust, audio gets Audio.
//
// Every control here writes through a reducer in reducers.ts, so the inspector,
// the timeline, and the MCP tools all mutate the timeline the same way.

import { useEffect, useRef, useState } from "react";

import { measureNoiseFloor, suggestedDenoiseStrength } from "../analysis";
import { decodeAudio, monoSamples } from "../audio";
import {
	BACKGROUND_LIMITS,
	type BackgroundSettings,
	COLOR_PRESETS,
	DEFAULT_BACKGROUND,
	GRADIENT_PRESETS,
} from "../background";
import { narratableComments } from "../comments";
import { ColorField, NumberField, Segmented, Select, Slider, Switch } from "../controls";
import {
	CURSOR_LIMITS,
	CURSOR_STYLES,
	type CursorSettings,
	cursorFill,
	cursorPath,
	DEFAULT_CURSOR,
} from "../cursor";
import { hasBalance, hasCurves } from "../curves";
import { type AppliedEffect, EFFECTS, effectDefinition } from "../effects";
import { ChevronIcon, CloseIcon, SparkleIcon, ZoomRegionIcon } from "../icons";
import {
	animatedProperties,
	type KeyframeProperty,
	parseKeyframeRows,
	sampleTrack,
} from "../keyframes";
import { CLIP_LIMITS, type ClipModel, NEUTRAL_GRADE, type TextAnimation } from "../model";
import { type HueTarget, LutParseError, parseCubeLut } from "../pixelGrade";
import { getVoiceStatus, installVoice, type VoiceStatus, voiceSupported } from "../voice";
import {
	DEFAULT_WEBCAM,
	WEBCAM_LIMITS,
	WEBCAM_POSITIONS,
	WEBCAM_SHAPES,
	type WebcamSettings,
} from "../webcam";
import { DEFAULT_ZOOM_TIMING, ZOOM_TIMING_LIMITS, type ZoomTiming } from "../zoom";

/** The three tonal ranges, and which knob each one's third slider is. */
const BALANCE_RANGES = [
	{
		label: "Shadows",
		hue: "shadowsHue",
		amount: "shadowsAmount",
		level: "shadowsLum",
		levelLabel: "Lift",
		levelDefault: 0,
		levelMin: -1,
		levelMax: 1,
	},
	{
		label: "Midtones",
		hue: "midsHue",
		amount: "midsAmount",
		level: "midsGamma",
		levelLabel: "Gamma",
		levelDefault: 1,
		levelMin: 0.1,
		levelMax: 4,
	},
	{
		label: "Highlights",
		hue: "highsHue",
		amount: "highsAmount",
		level: "highsGain",
		levelLabel: "Gain",
		levelDefault: 1,
		levelMin: 0,
		levelMax: 4,
	},
] as const;

const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "softLight", "difference"] as const;

const TEXT_ANIMATIONS = [
	"off",
	"fade",
	"slide_up",
	"pop",
	"typewriter",
	"word_by_word",
	"karaoke",
] as const;

import { buildInteractionZoomSuggestions } from "@/components/video-editor/timeline/zoomSuggestionUtils";
import { PanelHeader } from "../Panel";
import {
	addZoomRegion,
	mapClips,
	removeZoomRegion,
	setClipBlendMode,
	setClipColor,
	setClipContent,
	setClipCrop,
	setClipDuration,
	setClipEffects,
	setClipFlag,
	setClipKeyframes,
	setClipNumber,
	setClipTextStyle,
	setClipTiming,
	setClipTransform,
	updateZoomRegion,
} from "../reducers";
import type { EditorApi } from "../state";
import { scaleForDepth } from "../zoom";

type ClipTab = "content" | "animate" | "video" | "adjust" | "effects" | "audio" | "zoom" | "ai";

const TAB_LABELS: Record<ClipTab, string> = {
	content: "Content",
	animate: "Animate",
	video: "Video",
	adjust: "Adjust",
	effects: "Effects",
	audio: "Audio",
	zoom: "Zoom",
	ai: "AI Edit",
};

function tabsFor(clips: ClipModel[]): ClipTab[] {
	if (clips.length === 0) return [];
	const tabs: ClipTab[] = [];
	const hasText = clips.some((clip) => clip.mediaType === "text");
	const hasVisual = clips.some((clip) => clip.mediaType !== "text" && clip.mediaType !== "audio");
	const hasAudio = clips.some((clip) => clip.mediaType === "audio");
	const hasZoom = clips.some((clip) => (clip.zoomRegions?.length ?? 0) > 0);

	if (hasText) tabs.push("content", "animate");
	if (hasVisual) tabs.push("video", "adjust", "effects");
	if (hasAudio) tabs.push("audio");
	if (hasZoom) tabs.push("zoom");
	tabs.push("ai");
	return tabs;
}

function Group({
	title,
	children,
	defaultOpen = true,
	action,
}: {
	title: string;
	children: React.ReactNode;
	defaultOpen?: boolean;
	action?: React.ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="pmr-group">
			<div className="pmr-group__header" style={{ display: "flex" }}>
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						flex: 1,
						border: "none",
						background: "transparent",
						color: "inherit",
						font: "inherit",
						cursor: "default",
						padding: 0,
					}}
				>
					<ChevronIcon open={open} />
					{title}
				</button>
				{action}
			</div>
			{open ? <div className="pmr-group__body">{children}</div> : null}
		</div>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="pmr-row">
			<span className="pmr-row__label">{label}</span>
			<div className="pmr-row__control">{children}</div>
		</div>
	);
}

/** A slider paired with its numeric field; both write the same value. */
function SliderRow({
	label,
	value,
	min,
	max,
	step = 0.01,
	suffix,
	onChange,
	origin,
	trackImage,
	after,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	suffix?: string;
	onChange: (next: number) => void;
	origin?: number;
	trackImage?: string;
	/** Trailing control — the keyframe diamond on animatable properties. */
	after?: React.ReactNode;
}) {
	return (
		<Row label={label}>
			<Slider
				value={value}
				min={min}
				max={max}
				step={step}
				origin={origin}
				trackImage={trackImage}
				ariaLabel={label}
				onChange={onChange}
			/>
			<NumberField
				value={value}
				step={step}
				onChange={onChange}
				suffix={suffix}
				width={48}
				ariaLabel={label}
			/>
			{after}
		</Row>
	);
}

/**
 * The diamond every NLE puts beside an animatable value: filled when this frame
 * carries a key, hollow when the property is animated but this frame isn't.
 *
 * Clicking writes a key at the playhead holding the value shown, so the first
 * click on a static value starts an animation that doesn't jump.
 */
function KeyButton({
	api,
	clip,
	property,
	value,
}: {
	api: EditorApi;
	clip: ClipModel;
	property: KeyframeProperty;
	value: number;
}) {
	const { commit, state } = api;
	const local = Math.round(state.playhead) - clip.startFrame;
	const track = clip.keyframes?.[property] ?? [];
	const existing = track.find((keyframe) => keyframe.frame === local);
	const inside = local >= 0 && local < clip.endFrame - clip.startFrame;

	const toggle = () => {
		const rows = existing
			? track.filter((keyframe) => keyframe.frame !== local)
			: [...track, { frame: local, values: [value], interp: "smooth" as const }];
		const parsed = parseKeyframeRows(
			property,
			rows.map((keyframe) => [keyframe.frame, ...keyframe.values, keyframe.interp]),
		);
		if (!parsed.ok) return;
		commit(existing ? "Remove keyframe" : "Add keyframe", (t) =>
			setClipKeyframes(t, clip.id, property, parsed.keyframes),
		);
	};

	return (
		<button
			type="button"
			className="pmr-key"
			data-state={existing ? "on" : track.length > 0 ? "track" : "off"}
			disabled={!inside}
			title={
				!inside
					? "Move the playhead over this clip to keyframe it"
					: existing
						? `Remove the ${property} keyframe at this frame`
						: `Keyframe ${property} at this frame`
			}
			aria-label={`Keyframe ${property}`}
			onClick={toggle}
		>
			<svg viewBox="0 0 10 10" width={9} height={9} aria-hidden="true">
				<title>Keyframe</title>
				<path d="M5 0.5 L9.5 5 L5 9.5 L0.5 5 Z" />
			</svg>
		</button>
	);
}

/**
 * The cursor Rendr draws over a screen recording.
 *
 * A capture's own pointer is a few hard pixels that disappear under a punch-in.
 * These are Recordly's controls and Recordly's default values, so a take feels
 * the same in both.
 */
export function CursorSection({ api }: { api: EditorApi }) {
	const { state, patch } = api;
	// A project saved before this setting existed has no cursor block, and an
	// autosave restored from such a session would otherwise crash the panel.
	const cursor = state.cursor ?? DEFAULT_CURSOR;
	const set = (next: Partial<CursorSettings>) => patch({ cursor: { ...cursor, ...next } });
	const telemetry = state.cursorTelemetry.length;

	return (
		<Group
			title="Cursor"
			action={
				<button
					type="button"
					className="pmr-btn"
					style={{ fontSize: 10 }}
					title="Back to Rendr's defaults"
					onClick={() => patch({ cursor: { ...DEFAULT_CURSOR } })}
				>
					Reset
				</button>
			}
		>
			<Row label="Show cursor">
				<Switch
					checked={cursor.show}
					label="Show cursor"
					onChange={(show) => set({ show })}
				/>
				<span style={{ flex: 1 }} />
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					{telemetry > 0 ? `${telemetry} samples` : "no telemetry"}
				</span>
			</Row>

			<Row label="Loop cursor">
				<Switch
					checked={cursor.loop}
					label="Loop cursor"
					onChange={(loop) => set({ loop })}
				/>
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					Replay the travel under a longer take
				</span>
			</Row>

			<Row label="Style">
				<div className="pmr-cursorstyles">
					{CURSOR_STYLES.map((entry) => (
						<button
							key={entry.id}
							type="button"
							className="pmr-cursorstyle"
							data-active={cursor.style === entry.id || undefined}
							title={entry.label}
							aria-label={entry.label}
							aria-pressed={cursor.style === entry.id}
							onClick={() => set({ style: entry.id })}
						>
							<svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true">
								<title>{entry.label}</title>
								<path
									d={cursorPath(entry.id)}
									fill={cursorFill(entry.id).fill}
									stroke={cursorFill(entry.id).stroke}
									strokeWidth={1.2}
									strokeLinejoin="round"
								/>
							</svg>
						</button>
					))}
				</div>
			</Row>

			<SliderRow
				label="Cursor size"
				value={cursor.size}
				min={CURSOR_LIMITS.size.min}
				max={CURSOR_LIMITS.size.max}
				step={CURSOR_LIMITS.size.step}
				suffix="×"
				onChange={(size) => set({ size })}
			/>
			<SliderRow
				label="Smoothing"
				value={cursor.smoothing}
				min={CURSOR_LIMITS.smoothing.min}
				max={CURSOR_LIMITS.smoothing.max}
				step={CURSOR_LIMITS.smoothing.step}
				onChange={(smoothing) => set({ smoothing })}
			/>
			<SliderRow
				label="Motion blur"
				value={cursor.motionBlur}
				min={CURSOR_LIMITS.motionBlur.min}
				max={CURSOR_LIMITS.motionBlur.max}
				step={CURSOR_LIMITS.motionBlur.step}
				suffix="×"
				onChange={(motionBlur) => set({ motionBlur })}
			/>
			<SliderRow
				label="Click bounce"
				value={cursor.clickBounce}
				min={CURSOR_LIMITS.clickBounce.min}
				max={CURSOR_LIMITS.clickBounce.max}
				step={CURSOR_LIMITS.clickBounce.step}
				suffix="×"
				onChange={(clickBounce) => set({ clickBounce })}
			/>
			<SliderRow
				label="Bounce speed"
				value={cursor.bounceSpeed}
				min={CURSOR_LIMITS.bounceSpeed.min}
				max={CURSOR_LIMITS.bounceSpeed.max}
				step={CURSOR_LIMITS.bounceSpeed.step}
				suffix="ms"
				onChange={(bounceSpeed) => set({ bounceSpeed })}
			/>
			<SliderRow
				label="Sway"
				value={cursor.sway}
				min={CURSOR_LIMITS.sway.min}
				max={CURSOR_LIMITS.sway.max}
				step={CURSOR_LIMITS.sway.step}
				suffix="×"
				onChange={(sway) => set({ sway })}
			/>

			<SliderRow
				label="Spotlight"
				value={cursor.spotlight ?? 0}
				min={CURSOR_LIMITS.spotlight.min}
				max={CURSOR_LIMITS.spotlight.max}
				step={CURSOR_LIMITS.spotlight.step}
				onChange={(spotlight) => set({ spotlight })}
			/>
			{(cursor.spotlight ?? 0) > 0 ? (
				<SliderRow
					label="Spot size"
					value={cursor.spotlightSize ?? 0.28}
					min={CURSOR_LIMITS.spotlightSize.min}
					max={CURSOR_LIMITS.spotlightSize.max}
					step={CURSOR_LIMITS.spotlightSize.step}
					onChange={(spotlightSize) => set({ spotlightSize })}
				/>
			) : null}
			<Row label="Click ring">
				<Switch
					checked={cursor.clickRing ?? true}
					label="Click ring"
					onChange={(clickRing) => set({ clickRing })}
				/>
				{cursor.clickRing !== false ? (
					<ColorField
						value={cursor.ringColor ?? "#FFFFFF"}
						onChange={(ringColor) => set({ ringColor })}
					/>
				) : null}
			</Row>
		</Group>
	);
}

/**
 * The camera inset composited over a capture.
 *
 * Recordly's controls: whether it shows, whether it grows when the zoom camera
 * punches in, mirroring, size, a nine-cell position grid, and a crop into the
 * camera image. The bubble is composited at edit time, so all of it stays
 * changeable after the take rather than being burned into the pixels.
 */
/**
 * The backdrop the footage sits on — Recordly's Background panel.
 *
 * It is a property of the take rather than of a clip, so it lives beside the
 * cursor and the camera: one backdrop for the recording, not one per cut.
 */
/** Backdrops ride inside the project file, so one has to stay a sane size. */
const MAX_BACKDROP_BYTES = 8_000_000;

/**
 * How a zoom moves — Recordly's Zoom tab.
 *
 * These are properties of the take, not of a region: every zoom in a recording
 * punches in and releases the same way, which is what makes a cut feel like one
 * piece rather than a series of unrelated moves.
 */
function ZoomMotionSection({ api }: { api: EditorApi }) {
	const { state, patch } = api;
	const timing = state.zoomTiming ?? DEFAULT_ZOOM_TIMING;
	const set = (next: Partial<ZoomTiming>) => patch({ zoomTiming: { ...timing, ...next } });

	return (
		<Group title="Zoom motion" defaultOpen={false}>
			<SliderRow
				label="Smoothness"
				value={timing.smoothness}
				min={ZOOM_TIMING_LIMITS.smoothness.min}
				max={ZOOM_TIMING_LIMITS.smoothness.max}
				step={ZOOM_TIMING_LIMITS.smoothness.step}
				onChange={(smoothness) => set({ smoothness })}
			/>
			<Row label="">
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					How much the camera eases toward the zoom curve. 0 cuts straight to it.
				</span>
			</Row>
			<SliderRow
				label="Punch in"
				value={timing.zoomInDurationMs}
				min={ZOOM_TIMING_LIMITS.zoomInDurationMs.min}
				max={ZOOM_TIMING_LIMITS.zoomInDurationMs.max}
				step={ZOOM_TIMING_LIMITS.zoomInDurationMs.step}
				suffix="ms"
				onChange={(zoomInDurationMs) => set({ zoomInDurationMs })}
			/>
			<SliderRow
				label="Release"
				value={timing.zoomOutDurationMs}
				min={ZOOM_TIMING_LIMITS.zoomOutDurationMs.min}
				max={ZOOM_TIMING_LIMITS.zoomOutDurationMs.max}
				step={ZOOM_TIMING_LIMITS.zoomOutDurationMs.step}
				suffix="ms"
				onChange={(zoomOutDurationMs) => set({ zoomOutDurationMs })}
			/>
			<Row label="Connect">
				<Switch
					checked={timing.connectZooms}
					label="Connect nearby zooms"
					onChange={(connectZooms) => set({ connectZooms })}
				/>
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					Two zooms close together pan between each other instead of releasing
				</span>
			</Row>
			<Row label="">
				<button
					type="button"
					className="pmr-btn pmr-btn--ghost"
					title="Back to Recordly's own timing"
					onClick={() => patch({ zoomTiming: { ...DEFAULT_ZOOM_TIMING } })}
				>
					Reset
				</button>
			</Row>
		</Group>
	);
}

/**
 * Narration: the model's install state, and the button that speaks the notes.
 *
 * The install is surfaced rather than hidden because it is a 90 MB download —
 * doing that silently the first time somebody asks for a line would look like
 * the app had hung.
 */
function NarrationSection({ api }: { api: EditorApi }) {
	const { state, toast } = api;
	const [status, setStatus] = useState<VoiceStatus | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [progress, setProgress] = useState<number | null>(null);

	useEffect(() => {
		void getVoiceStatus().then(setStatus);
	}, []);

	const script = narratableComments(state.comments);
	const supported = voiceSupported();

	if (!supported) {
		return (
			<Group title="Narration" defaultOpen={false}>
				<Row label="">
					<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
						Speech runs in Rendr's desktop process. It isn't available in the browser
						build.
					</span>
				</Row>
			</Group>
		);
	}

	return (
		<Group title="Narration" defaultOpen={script.length > 0}>
			<Row label="Script">
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					{script.length === 0
						? "No notes yet — double-click the Notes track to write one"
						: `${script.length} ${script.length === 1 ? "line" : "lines"}`}
				</span>
			</Row>

			<Row label="Voices">
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					{status === null
						? "checking…"
						: status.installed
							? `Kokoro ready · ${(status.bytes / 1_000_000).toFixed(0)} MB`
							: "not installed"}
				</span>
				{status && !status.installed ? (
					<button
						type="button"
						className="pmr-btn pmr-btn--ghost"
						disabled={busy !== null}
						title="Downloads Kokoro-82M (about 90 MB). It runs on this machine — no account, nothing uploaded."
						onClick={async () => {
							setBusy("install");
							setProgress(0);
							const result = await installVoice(setProgress);
							setBusy(null);
							setProgress(null);
							setStatus(await getVoiceStatus());
							toast(
								result.ok
									? "Voices installed — they run on this machine"
									: (result.error ?? "Couldn't install the voices"),
								result.ok ? "info" : "error",
							);
						}}
					>
						{busy === "install"
							? progress !== null
								? `${Math.round(progress * 100)}%`
								: "Installing…"
							: "Install voices"}
					</button>
				) : null}
			</Row>

			<Row label="">
				<button
					type="button"
					className="pmr-btn pmr-btn--ghost"
					disabled={busy !== null || script.length === 0 || !status?.installed}
					title="Speaks every unresolved note and lays it on the narration track"
					onClick={async () => {
						setBusy("speak");
						try {
							const result = await api.runNarration();
							toast(
								result.spoken > 0
									? `Narrated ${result.spoken} ${result.spoken === 1 ? "line" : "lines"}`
									: "Every note already has current audio",
							);
						} catch (error) {
							toast(
								error instanceof Error ? error.message : "Narration failed",
								"error",
							);
						} finally {
							setBusy(null);
						}
					}}
				>
					{busy === "speak" ? "Speaking…" : "Narrate the notes"}
				</button>
			</Row>
		</Group>
	);
}

export function BackgroundSection({ api }: { api: EditorApi }) {
	const { state, patch, toast } = api;
	const background = state.background ?? DEFAULT_BACKGROUND;
	const set = (next: Partial<BackgroundSettings>) =>
		patch({ background: { ...background, ...next } });
	const imageInput = useRef<HTMLInputElement>(null);

	return (
		<Group title="Background">
			<Row label="Backdrop">
				<Segmented
					value={background.kind}
					ariaLabel="Backdrop"
					options={[
						{ value: "none", label: "None" },
						{ value: "color", label: "Colour" },
						{ value: "gradient", label: "Gradient" },
						{ value: "image", label: "Image" },
					]}
					onChange={(next) => set({ kind: next as BackgroundSettings["kind"] })}
				/>
				<button
					type="button"
					className="pmr-btn pmr-btn--ghost"
					title="Back to the default backdrop"
					onClick={() => patch({ background: { ...DEFAULT_BACKGROUND } })}
				>
					Reset
				</button>
			</Row>

			{background.kind === "color" ? (
				<Row label="Colour">
					<ColorField
						value={background.color}
						onChange={(next) => set({ color: next })}
					/>
					{COLOR_PRESETS.map((preset) => (
						<button
							key={preset}
							type="button"
							className="pmr-swatch"
							title={preset}
							aria-label={`Use ${preset}`}
							style={{ background: preset }}
							onClick={() => set({ color: preset })}
						/>
					))}
				</Row>
			) : null}

			{background.kind === "gradient" ? (
				<>
					<Row label="Preset">
						{GRADIENT_PRESETS.map((preset) => (
							<button
								key={preset.id}
								type="button"
								className="pmr-swatch"
								title={preset.label}
								aria-label={preset.label}
								data-active={
									background.gradient.from === preset.gradient.from || undefined
								}
								style={{
									background: `linear-gradient(${preset.gradient.angle}deg, ${preset.gradient.from}, ${preset.gradient.to})`,
								}}
								onClick={() => set({ gradient: { ...preset.gradient } })}
							/>
						))}
					</Row>
					<Row label="From">
						<ColorField
							value={background.gradient.from}
							onChange={(next) =>
								set({ gradient: { ...background.gradient, from: next } })
							}
						/>
						<ColorField
							value={background.gradient.to}
							onChange={(next) =>
								set({ gradient: { ...background.gradient, to: next } })
							}
						/>
					</Row>
					<SliderRow
						label="Angle"
						value={background.gradient.angle}
						min={0}
						max={360}
						step={1}
						suffix="°"
						onChange={(next) =>
							set({ gradient: { ...background.gradient, angle: next } })
						}
					/>
				</>
			) : null}

			{background.kind === "image" ? (
				<Row label="Image">
					<input
						ref={imageInput}
						type="file"
						accept="image/*"
						style={{ display: "none" }}
						onChange={async (event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (!file) return;
							// Read as a data URI rather than an object URL, so the
							// backdrop is *in* the project file and a reopened
							// project still has it. Backdrops are small next to
							// the media they sit behind, so embedding one is
							// cheaper than asking the user to relink it.
							if (file.size > MAX_BACKDROP_BYTES) {
								toast(
									`That image is ${(file.size / 1e6).toFixed(1)} MB. Backdrops are embedded in the project file, so they're capped at ${MAX_BACKDROP_BYTES / 1e6} MB — scale it down first.`,
									"error",
								);
								return;
							}
							const dataUri = await new Promise<string | null>((resolve) => {
								const reader = new FileReader();
								reader.onload = () => resolve(String(reader.result));
								reader.onerror = () => resolve(null);
								reader.readAsDataURL(file);
							});
							if (!dataUri) {
								toast("Couldn't read that image.", "error");
								return;
							}
							set({ imageUrl: dataUri });
							toast(`Backdrop set to ${file.name}`);
						}}
					/>
					<button
						type="button"
						className="pmr-btn pmr-btn--ghost"
						onClick={() => imageInput.current?.click()}
					>
						{background.imageUrl ? "Replace…" : "Upload custom…"}
					</button>
					{background.imageUrl ? (
						<button
							type="button"
							className="pmr-btn pmr-btn--ghost"
							title="Remove the backdrop image"
							onClick={() => set({ imageUrl: undefined })}
						>
							<CloseIcon size={11} />
						</button>
					) : null}
				</Row>
			) : null}

			<SliderRow
				label="Padding"
				value={background.padding}
				min={BACKGROUND_LIMITS.padding.min}
				max={BACKGROUND_LIMITS.padding.max}
				step={BACKGROUND_LIMITS.padding.step}
				onChange={(next) => set({ padding: next })}
			/>
			<SliderRow
				label="Radius"
				value={background.radius}
				min={BACKGROUND_LIMITS.radius.min}
				max={BACKGROUND_LIMITS.radius.max}
				step={BACKGROUND_LIMITS.radius.step}
				onChange={(next) => set({ radius: next })}
			/>
			<SliderRow
				label="Shadow"
				value={background.shadow}
				min={BACKGROUND_LIMITS.shadow.min}
				max={BACKGROUND_LIMITS.shadow.max}
				step={BACKGROUND_LIMITS.shadow.step}
				onChange={(next) => set({ shadow: next })}
			/>
		</Group>
	);
}

export function WebcamSection({ api }: { api: EditorApi }) {
	const { state, patch } = api;
	const webcam = state.webcam ?? DEFAULT_WEBCAM;
	const set = (next: Partial<WebcamSettings>) => patch({ webcam: { ...webcam, ...next } });

	/*
	 * The take the pairing applies to: whichever video is under the playhead.
	 * Well-defined and needs no extra selection — the inset belongs to a take,
	 * and the take you are looking at is the one you mean.
	 */
	const screenTake = (() => {
		const clip = api.timeline.tracks
			.filter((track) => track.kind === "video" && !track.hidden)
			.flatMap((track) => track.clips)
			.find(
				(entry) =>
					state.playhead >= entry.startFrame &&
					state.playhead < entry.endFrame &&
					entry.mediaType === "video",
			);
		return state.assets.find((asset) => asset.id === clip?.assetId && !asset.isWebcam);
	})();

	// Anything that could stand in as a camera: another video, not this take,
	// and not something already paired to a different take.
	const cameraCandidates = state.assets.filter(
		(asset) =>
			asset.type === "video" &&
			!asset.offline &&
			asset.id !== screenTake?.id &&
			!asset.webcamAssetId,
	);

	return (
		<Group
			title="Webcam"
			defaultOpen={false}
			action={
				<button
					type="button"
					className="pmr-btn"
					style={{ fontSize: 10 }}
					title="Back to Rendr's defaults"
					onClick={() => patch({ webcam: { ...DEFAULT_WEBCAM } })}
				>
					Reset
				</button>
			}
		>
			<Row label="Show">
				<Switch
					checked={webcam.show}
					label="Show webcam"
					onChange={(show) => set({ show })}
				/>
			</Row>
			{/* Pairing an already-recorded camera file.
			    Recording both at once is the normal path, but a camera shot
			    separately — on a phone, or by another tool — is just as valid a
			    source for the inset, and without this there is no way to use one
			    from the interface. */}
			{screenTake ? (
				<Row label="Camera file">
					<Select
						value={screenTake.webcamAssetId ?? ""}
						ariaLabel="Camera file for this take"
						options={[
							{ value: "", label: "None — recorded with the take" },
							...cameraCandidates.map((asset) => ({
								value: asset.id,
								label: asset.name,
							})),
						]}
						onChange={(next) => api.pairCamera(screenTake.id, next || null)}
					/>
					<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
						{cameraCandidates.length === 0
							? "Import a camera video to pair one"
							: `for “${screenTake.name}”`}
					</span>
				</Row>
			) : null}
			<Row label="Reacts to zoom">
				<Switch
					checked={webcam.reactsToZoom}
					label="Webcam reacts to zoom"
					onChange={(reactsToZoom) => set({ reactsToZoom })}
				/>
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					Grows during a punch-in
				</span>
			</Row>
			<Row label="Mirror">
				<Switch
					checked={webcam.mirror}
					label="Mirror webcam"
					onChange={(mirror) => set({ mirror })}
				/>
			</Row>

			<SliderRow
				label="Size"
				value={webcam.size}
				min={WEBCAM_LIMITS.size.min}
				max={WEBCAM_LIMITS.size.max}
				step={WEBCAM_LIMITS.size.step}
				onChange={(size) => set({ size })}
			/>
			<SliderRow
				label="Margin"
				value={webcam.margin}
				min={WEBCAM_LIMITS.margin.min}
				max={WEBCAM_LIMITS.margin.max}
				step={WEBCAM_LIMITS.margin.step}
				onChange={(margin) => set({ margin })}
			/>

			<Row label="Shape">
				<Segmented
					value={webcam.shape}
					ariaLabel="Webcam shape"
					options={WEBCAM_SHAPES.map((entry) => ({
						value: entry.id,
						label: entry.label,
					}))}
					onChange={(shape) => set({ shape: shape as WebcamSettings["shape"] })}
				/>
			</Row>

			<Row label="Position">
				<div className="pmr-poscells">
					{WEBCAM_POSITIONS.flat().map((position) => (
						<button
							key={position}
							type="button"
							className="pmr-poscell"
							data-active={webcam.position === position || undefined}
							title={position.replace("-", " ")}
							aria-label={position.replace("-", " ")}
							aria-pressed={webcam.position === position}
							onClick={() => set({ position })}
						/>
					))}
				</div>
			</Row>

			<Row label="Crop">
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					Trim into the camera image
				</span>
			</Row>
			{(["top", "right", "bottom", "left"] as const).map((side) => (
				<SliderRow
					key={side}
					label={side[0].toUpperCase() + side.slice(1)}
					value={webcam.crop[side]}
					min={0}
					max={0.45}
					step={0.005}
					onChange={(value) => set({ crop: { ...webcam.crop, [side]: value } })}
				/>
			))}
		</Group>
	);
}

/** The hue wheel's named regions, so a target is picked rather than typed. */
const HUE_PRESETS: Array<{ label: string; hue: number }> = [
	{ label: "Red", hue: 0 },
	{ label: "Skin", hue: 30 },
	{ label: "Yellow", hue: 60 },
	{ label: "Green", hue: 120 },
	{ label: "Cyan", hue: 180 },
	{ label: "Sky", hue: 210 },
	{ label: "Blue", hue: 240 },
	{ label: "Magenta", hue: 300 },
];

/**
 * Qualified hue correction — "the sky is too blue", without a mask.
 *
 * Each target is a row; the swatch shows which hue it acts on, so the panel
 * reads as the colours it affects rather than as a list of numbers.
 */
function HueTargets({
	clip,
	ids,
	commit,
}: {
	clip: ClipModel;
	ids: string[];
	commit: EditorApi["commit"];
}) {
	const targets = clip.color.hueCurves?.targets ?? [];

	const write = (next: HueTarget[]) =>
		commit("Hue targets", (t) =>
			setClipColor(t, ids, { hueCurves: next.length > 0 ? { targets: next } : undefined }),
		);

	return (
		<>
			{targets.length === 0 ? (
				<span
					style={{
						fontSize: 11,
						color: "var(--pmr-text-muted)",
						padding: "2px 0",
						display: "block",
					}}
				>
					Pick a hue below to correct it on its own — its saturation, lightness and hue,
					without touching the rest of the picture.
				</span>
			) : null}

			{targets.map((target, index) => {
				const update = (patch: Partial<HueTarget>) =>
					write(
						targets.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
					);
				return (
					<div key={`${target.targetHue}-${index}`} className="pmr-effect">
						<Row label="Hue">
							<span
								title={`${Math.round(target.targetHue)}°`}
								style={{
									width: 14,
									height: 14,
									borderRadius: 3,
									flex: "0 0 14px",
									background: `hsl(${target.targetHue}, 80%, 50%)`,
									border: "1px solid var(--pmr-border-subtle)",
								}}
							/>
							<NumberField
								value={target.targetHue}
								suffix="°"
								onChange={(next) =>
									update({ targetHue: ((next % 360) + 360) % 360 })
								}
							/>
							<button
								type="button"
								className="pmr-btn pmr-btn--ghost"
								title="Remove this target"
								onClick={() => write(targets.filter((_, i) => i !== index))}
							>
								<CloseIcon size={11} />
							</button>
						</Row>
						<SliderRow
							label="Saturation"
							value={target.satScale ?? 1}
							min={0}
							max={2}
							step={0.01}
							onChange={(next) => update({ satScale: next })}
						/>
						<SliderRow
							label="Hue shift"
							value={target.hueShift ?? 0}
							min={-30}
							max={30}
							step={0.5}
							suffix="°"
							onChange={(next) => update({ hueShift: next })}
						/>
						<SliderRow
							label="Lightness"
							value={target.lumShift ?? 0}
							min={-0.5}
							max={0.5}
							step={0.01}
							onChange={(next) => update({ lumShift: next })}
						/>
					</div>
				);
			})}

			<Row label="Add">
				{HUE_PRESETS.map((preset) => (
					<button
						key={preset.label}
						type="button"
						className="pmr-btn pmr-btn--ghost"
						title={`Correct ${preset.label.toLowerCase()} (${preset.hue}°)`}
						style={{ gap: 4 }}
						onClick={() => write([...targets, { targetHue: preset.hue, satScale: 1 }])}
					>
						<span
							style={{
								width: 9,
								height: 9,
								borderRadius: 2,
								background: `hsl(${preset.hue}, 80%, 50%)`,
							}}
						/>
						{preset.label}
					</button>
				))}
			</Row>
		</>
	);
}

/** Loads a .cube and shows what is loaded, with a dry/wet mix. */
function LutRow({
	clip,
	ids,
	commit,
	toast,
}: {
	clip: ClipModel;
	ids: string[];
	commit: EditorApi["commit"];
	toast: EditorApi["toast"];
}) {
	const input = useRef<HTMLInputElement>(null);
	const lut = clip.color.lut;

	return (
		<>
			<input
				ref={input}
				type="file"
				accept=".cube"
				style={{ display: "none" }}
				onChange={async (event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (!file) return;
					try {
						const parsed = parseCubeLut(await file.text(), file.name);
						commit("Load LUT", (t) => setClipColor(t, ids, { lut: parsed }));
						toast(`Loaded ${parsed.name} — a ${parsed.size}³ cube`);
					} catch (error) {
						// A cube that doesn't parse is named, not swallowed: the
						// alternative is a grade that silently does nothing.
						toast(
							error instanceof LutParseError
								? error.message
								: "That isn't a readable .cube file.",
							"error",
						);
					}
				}}
			/>
			<Row label={lut ? lut.name : "File"}>
				<button
					type="button"
					className="pmr-btn pmr-btn--ghost"
					onClick={() => input.current?.click()}
				>
					{lut ? "Replace…" : "Load .cube…"}
				</button>
				{lut ? (
					<>
						<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
							{lut.size}³
						</span>
						<button
							type="button"
							className="pmr-btn pmr-btn--ghost"
							title="Remove this LUT"
							onClick={() =>
								commit("Remove LUT", (t) =>
									setClipColor(t, ids, { lut: undefined }),
								)
							}
						>
							<CloseIcon size={11} />
						</button>
					</>
				) : null}
			</Row>
			{lut ? (
				<SliderRow
					label="Strength"
					value={clip.color.lutAmount ?? 1}
					min={0}
					max={1}
					step={0.01}
					onChange={(next) =>
						commit("LUT strength", (t) => setClipColor(t, ids, { lutAmount: next }))
					}
				/>
			) : null}
		</>
	);
}

export function InspectorPanel({ api }: { api: EditorApi }) {
	const { state, selection, commit, timeline, patch } = api;
	const clips = selection.map((entry) => entry.clip);
	const ids = clips.map((clip) => clip.id);
	const tabs = tabsFor(clips);
	const [preferred, setPreferred] = useState<ClipTab>("video");
	// What the last "Auto" measurement found, so the number the button chose is
	// explained rather than just appearing.
	const [noiseFloor, setNoiseFloor] = useState<string | null>(null);
	const tab = tabs.includes(preferred) ? preferred : (tabs[0] ?? "video");
	const first = clips[0];

	// With nothing selected the inspector shows what belongs to the take as a
	// whole — the cursor Rendr draws over it.
	if (!first) {
		return (
			<>
				<PanelHeader title="Inspector" />
				<div className="pmr-scroll">
					<BackgroundSection api={api} />
					<ZoomMotionSection api={api} />
					<NarrationSection api={api} />
					<CursorSection api={api} />
					<WebcamSection api={api} />
					<div className="pmr-empty" style={{ paddingTop: 4 }}>
						<span>Nothing selected</span>
						<span style={{ maxWidth: 200 }}>
							Select a clip on the timeline to edit its properties.
						</span>
					</div>
				</div>
			</>
		);
	}

	const duration = first.endFrame - first.startFrame;
	const animated = animatedProperties(first);

	return (
		<>
			<PanelHeader title="Inspector">
				<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
					{clips.length === 1 ? first.name : `${clips.length} clips`}
				</span>
			</PanelHeader>

			<div className="pmr-tabs">
				{tabs.map((entry) => (
					<button
						key={entry}
						type="button"
						className="pmr-tab"
						data-active={tab === entry}
						onClick={() => setPreferred(entry)}
					>
						{entry === "ai" ? <SparkleIcon size={11} /> : null}
						{entry === "zoom" ? <ZoomRegionIcon size={11} /> : null}
						{TAB_LABELS[entry]}
					</button>
				))}
			</div>

			<div className="pmr-scroll">
				{tab === "video" ? (
					<>
						<Group title="Transform">
							<Row label="Position">
								<NumberField
									value={first.transform.centerX}
									step={0.004}
									width={48}
									onChange={(next) =>
										commit("Move clip", (t) =>
											setClipTransform(t, ids, { centerX: next }),
										)
									}
								/>
								<NumberField
									value={first.transform.centerY}
									step={0.004}
									width={48}
									onChange={(next) =>
										commit("Move clip", (t) =>
											setClipTransform(t, ids, { centerY: next }),
										)
									}
								/>
							</Row>
							<Row label="Scale">
								<NumberField
									value={first.transform.width}
									step={0.004}
									width={48}
									onChange={(next) =>
										commit("Scale clip", (t) =>
											setClipTransform(t, ids, { width: next }),
										)
									}
								/>
								<NumberField
									value={first.transform.height}
									step={0.004}
									width={48}
									onChange={(next) =>
										commit("Scale clip", (t) =>
											setClipTransform(t, ids, { height: next }),
										)
									}
								/>
							</Row>
							<SliderRow
								label="Rotation"
								value={first.transform.rotation}
								min={CLIP_LIMITS.rotation.min}
								max={CLIP_LIMITS.rotation.max}
								step={1}
								suffix="°"
								onChange={(next) =>
									commit("Rotate clip", (t) =>
										setClipTransform(t, ids, { rotation: next }),
									)
								}
								after={
									<KeyButton
										api={api}
										clip={first}
										property="rotation"
										value={first.transform.rotation}
									/>
								}
							/>
							<Row label="Flip">
								<button
									type="button"
									className="pmr-btn"
									data-active={first.transform.flipHorizontal}
									title="Flip horizontally"
									onClick={() =>
										commit("Flip clip", (t) =>
											setClipTransform(t, ids, {
												flipHorizontal: !first.transform.flipHorizontal,
											}),
										)
									}
								>
									↔
								</button>
								<button
									type="button"
									className="pmr-btn"
									data-active={first.transform.flipVertical}
									title="Flip vertically"
									onClick={() =>
										commit("Flip clip", (t) =>
											setClipTransform(t, ids, {
												flipVertical: !first.transform.flipVertical,
											}),
										)
									}
								>
									↕
								</button>
							</Row>
						</Group>

						<Group title="Crop" defaultOpen={false}>
							{(["top", "right", "bottom", "left"] as const).map((side) => (
								<SliderRow
									key={side}
									label={side[0].toUpperCase() + side.slice(1)}
									value={first.crop[side]}
									min={0}
									max={0.95}
									onChange={(next) =>
										commit("Crop clip", (t) =>
											setClipCrop(t, ids, { [side]: next }),
										)
									}
								/>
							))}
						</Group>

						<Group title="Compositing">
							<SliderRow
								label="Opacity"
								value={first.opacity}
								min={CLIP_LIMITS.opacity.min}
								max={CLIP_LIMITS.opacity.max}
								onChange={(next) =>
									commit("Set opacity", (t) =>
										setClipNumber(t, ids, "opacity", next),
									)
								}
								after={
									<KeyButton
										api={api}
										clip={first}
										property="opacity"
										value={first.opacity}
									/>
								}
							/>
							<Row label="Blend mode">
								<Select
									value={first.blendMode}
									ariaLabel="Blend mode"
									options={BLEND_MODES.map((mode) => ({
										value: mode,
										label: mode,
									}))}
									onChange={(next) =>
										commit("Set blend mode", (t) =>
											setClipBlendMode(t, ids, next),
										)
									}
								/>
							</Row>
							<SliderRow
								label="Edge rounding"
								value={first.edgeRounding}
								min={0}
								max={1}
								onChange={(next) =>
									commit("Round edges", (t) =>
										setClipNumber(t, ids, "edgeRounding", next),
									)
								}
							/>
							<SliderRow
								label="Edge softness"
								value={first.edgeSoftness}
								min={0}
								max={1}
								onChange={(next) =>
									commit("Soften edges", (t) =>
										setClipNumber(t, ids, "edgeSoftness", next),
									)
								}
							/>
						</Group>

						<Group title="Timing">
							<Row label="Start">
								<span style={{ fontSize: 11, color: "var(--pmr-text-3)" }}>
									{first.startFrame} f
								</span>
							</Row>
							<Row label="Duration">
								<NumberField
									value={duration}
									onChange={(next) =>
										commit("Set duration", (t) => setClipDuration(t, ids, next))
									}
									suffix="f"
								/>
							</Row>
							<SliderRow
								label="Speed"
								value={first.speed}
								min={CLIP_LIMITS.speed.min}
								max={4}
								step={0.05}
								suffix="×"
								onChange={(next) =>
									commit("Set speed", (t) => setClipNumber(t, ids, "speed", next))
								}
							/>
							<Row label="Trim start">
								<NumberField
									value={first.trimStartFrame}
									onChange={(next) =>
										commit("Trim start", (t) =>
											setClipTiming(t, ids, "trimStartFrame", next),
										)
									}
									suffix="f"
								/>
							</Row>
							<Row label="Trim end">
								<NumberField
									value={first.trimEndFrame}
									onChange={(next) =>
										commit("Trim end", (t) =>
											setClipTiming(t, ids, "trimEndFrame", next),
										)
									}
									suffix="f"
								/>
							</Row>
						</Group>
					</>
				) : null}

				{tab === "adjust" ? (
					<>
						<Group
							title="Primary"
							action={
								<button
									type="button"
									className="pmr-btn"
									title="Reset grade"
									style={{ width: 20, height: 20, fontSize: 10 }}
									onClick={() =>
										commit("Reset grade", (t) =>
											setClipColor(t, ids, NEUTRAL_GRADE),
										)
									}
								>
									↺
								</button>
							}
						>
							<SliderRow
								label="Exposure"
								origin={0}
								value={first.color.exposure}
								min={CLIP_LIMITS.exposure.min}
								max={CLIP_LIMITS.exposure.max}
								suffix="EV"
								onChange={(next) =>
									commit("Grade clip", (t) =>
										setClipColor(t, ids, { exposure: next }),
									)
								}
							/>
							<SliderRow
								label="Contrast"
								origin={1}
								value={first.color.contrast}
								min={CLIP_LIMITS.contrast.min}
								max={CLIP_LIMITS.contrast.max}
								onChange={(next) =>
									commit("Grade clip", (t) =>
										setClipColor(t, ids, { contrast: next }),
									)
								}
							/>
							<SliderRow
								label="Saturation"
								origin={1}
								value={first.color.saturation}
								min={CLIP_LIMITS.saturation.min}
								max={CLIP_LIMITS.saturation.max}
								onChange={(next) =>
									commit("Grade clip", (t) =>
										setClipColor(t, ids, { saturation: next }),
									)
								}
							/>
							<SliderRow
								label="Vibrance"
								origin={0}
								value={first.color.vibrance}
								min={CLIP_LIMITS.vibrance.min}
								max={CLIP_LIMITS.vibrance.max}
								onChange={(next) =>
									commit("Grade clip", (t) =>
										setClipColor(t, ids, { vibrance: next }),
									)
								}
							/>
						</Group>

						<Group title="White balance">
							<SliderRow
								label="Temperature"
								value={first.color.temperature}
								min={CLIP_LIMITS.temperature.min}
								max={CLIP_LIMITS.temperature.max}
								step={50}
								suffix="K"
								trackImage="linear-gradient(90deg, rgb(82,140,235), rgb(242,184,82))"
								onChange={(next) =>
									commit("Grade clip", (t) =>
										setClipColor(t, ids, { temperature: next }),
									)
								}
							/>
							<SliderRow
								label="Tint"
								value={first.color.tint}
								min={CLIP_LIMITS.tint.min}
								max={CLIP_LIMITS.tint.max}
								step={1}
								trackImage="linear-gradient(90deg, rgb(107,199,115), rgb(209,97,184))"
								onChange={(next) =>
									commit("Grade clip", (t) =>
										setClipColor(t, ids, { tint: next }),
									)
								}
							/>
						</Group>

						<Group title="Tonal" defaultOpen={false}>
							{(["highlights", "shadows", "whites", "blacks"] as const).map((key) => (
								<SliderRow
									key={key}
									label={key[0].toUpperCase() + key.slice(1)}
									value={first.color[key]}
									min={-1}
									max={1}
									origin={0}
									onChange={(next) =>
										commit("Grade clip", (t) =>
											setClipColor(t, ids, { [key]: next }),
										)
									}
								/>
							))}
						</Group>

						<Group title="Colour balance" defaultOpen={false}>
							{BALANCE_RANGES.map((range) => (
								<div key={range.label} className="pmr-effect">
									<Row label={range.label}>
										<Slider
											value={first.color.balance?.[range.hue] ?? 0}
											min={0}
											max={360}
											step={1}
											ariaLabel={`${range.label} hue`}
											trackImage="linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
											onChange={(next) =>
												commit("Balance colour", (t) =>
													setClipColor(t, ids, {
														balance: { [range.hue]: next },
													} as never),
												)
											}
										/>
										<NumberField
											value={first.color.balance?.[range.hue] ?? 0}
											step={1}
											width={44}
											suffix="°"
											ariaLabel={`${range.label} hue`}
											onChange={(next) =>
												commit("Balance colour", (t) =>
													setClipColor(t, ids, {
														balance: { [range.hue]: next },
													} as never),
												)
											}
										/>
									</Row>
									<SliderRow
										label="Amount"
										value={first.color.balance?.[range.amount] ?? 0}
										min={0}
										max={1}
										onChange={(next) =>
											commit("Balance colour", (t) =>
												setClipColor(t, ids, {
													balance: { [range.amount]: next },
												} as never),
											)
										}
									/>
									<SliderRow
										label={range.levelLabel}
										value={
											first.color.balance?.[range.level] ?? range.levelDefault
										}
										min={range.levelMin}
										max={range.levelMax}
										origin={range.levelDefault}
										onChange={(next) =>
											commit("Balance colour", (t) =>
												setClipColor(t, ids, {
													balance: { [range.level]: next },
												} as never),
											)
										}
									/>
								</div>
							))}
							<Row label="">
								<button
									type="button"
									className="pmr-btn"
									style={{ fontSize: 10 }}
									disabled={
										!hasBalance(first.color.balance) &&
										!hasCurves(first.color.curves)
									}
									title="Clear the balance and any tone curves on this clip"
									onClick={() =>
										commit("Reset balance", (t) =>
											mapClips(t, ids, (clip) => ({
												...clip,
												color: {
													...clip.color,
													balance: undefined,
													curves: undefined,
												},
											})),
										)
									}
								>
									Reset balance & curves
								</button>
								{hasCurves(first.color.curves) ? (
									<span style={{ fontSize: 10, color: "var(--pmr-timecode)" }}>
										tone curve set
									</span>
								) : null}
							</Row>
						</Group>

						<Group title="Secondary" defaultOpen={false}>
							<HueTargets clip={first} ids={ids} commit={commit} />
						</Group>

						<Group title="LUT" defaultOpen={false}>
							<LutRow clip={first} ids={ids} commit={commit} toast={api.toast} />
						</Group>
					</>
				) : null}

				{tab === "effects" ? (
					<>
						<Group title="Effects">
							{EFFECTS.map((definition) => {
								const applied = first.effects?.find(
									(effect) => effect.type === definition.id,
								);
								const on = Boolean(applied) && applied?.enabled !== false;
								return (
									<div key={definition.id} className="pmr-effect">
										<Row label={definition.displayName}>
											<Switch
												checked={on}
												label={definition.displayName}
												onChange={(next) =>
													commit(
														next
															? `Add ${definition.displayName}`
															: `Remove ${definition.displayName}`,
														(t) =>
															setClipEffects(
																t,
																ids,
																next
																	? [
																			{
																				type: definition.id,
																				params: {},
																			},
																		]
																	: [],
																next ? [] : [definition.id],
															),
													)
												}
											/>
										</Row>
										{applied
											? definition.params.map((spec) => (
													<SliderRow
														key={spec.key}
														label={spec.key}
														value={
															applied.params[spec.key] ??
															spec.defaultValue
														}
														min={spec.min}
														max={spec.max}
														step={(spec.max - spec.min) / 100}
														suffix={spec.unit || undefined}
														onChange={(next) =>
															commit(
																`Set ${definition.displayName}`,
																(t) =>
																	setClipEffects(t, ids, [
																		{
																			type: definition.id,
																			params: {
																				...applied.params,
																				[spec.key]: next,
																			},
																			enabled:
																				applied.enabled !==
																				false,
																		} as AppliedEffect,
																	]),
															)
														}
													/>
												))
											: null}
									</div>
								);
							})}
							{/* An effect the clip carries but this build has no
							    definition for — from a project written by a newer
							    Rendr. It is listed rather than silently dropped,
							    because it still renders nothing here and the user
							    would otherwise never learn why. */}
							{(first.effects ?? [])
								.filter((effect) => !effectDefinition(effect.type))
								.map((effect) => (
									<Row key={effect.type} label={effect.type}>
										<span
											style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}
										>
											Not in this build — kept but not rendered
										</span>
										<button
											type="button"
											className="pmr-btn pmr-btn--ghost"
											onClick={() =>
												commit("Remove effect", (t) =>
													setClipEffects(t, ids, [], [effect.type]),
												)
											}
										>
											Remove
										</button>
									</Row>
								))}
						</Group>

						<Group title="Animation" defaultOpen={animated.length > 0}>
							{animated.length === 0 ? (
								<span
									style={{
										fontSize: 11,
										color: "var(--pmr-text-muted)",
										padding: "2px 0",
									}}
								>
									Nothing is animated. Use the diamond beside Opacity, Rotation or
									Volume to key a value at the playhead.
								</span>
							) : (
								animated.map((property) => {
									const track = first.keyframes?.[property] ?? [];
									const at = sampleTrack(
										track,
										Math.round(state.playhead) - first.startFrame,
									);
									return (
										<Row key={property} label={property}>
											<span
												style={{
													fontSize: 11,
													color: "var(--pmr-text-secondary)",
												}}
											>
												{track.length} key{track.length === 1 ? "" : "s"} ·{" "}
												{at?.map((value) => value.toFixed(2)).join(", ")}
											</span>
											<button
												type="button"
												className="pmr-btn"
												style={{ fontSize: 10 }}
												onClick={() =>
													commit("Clear keyframes", (t) =>
														setClipKeyframes(t, first.id, property, []),
													)
												}
											>
												Clear
											</button>
										</Row>
									);
								})
							)}
						</Group>
					</>
				) : null}

				{tab === "audio" ? (
					<Group title="Levels">
						<SliderRow
							label="Volume"
							value={first.volumeDb}
							min={CLIP_LIMITS.volumeDb.min}
							max={CLIP_LIMITS.volumeDb.max}
							step={0.5}
							suffix="dB"
							onChange={(next) =>
								commit("Set volume", (t) => setClipNumber(t, ids, "volumeDb", next))
							}
							after={
								<KeyButton
									api={api}
									clip={first}
									property="volumeDb"
									value={first.volumeDb}
								/>
							}
						/>
						<Row label="Fade in">
							<NumberField
								value={first.fadeInFrames}
								onChange={(next) =>
									commit("Set fade in", (t) =>
										setClipTiming(t, ids, "fadeInFrames", next),
									)
								}
								suffix="f"
							/>
						</Row>
						<Row label="Fade out">
							<NumberField
								value={first.fadeOutFrames}
								onChange={(next) =>
									commit("Set fade out", (t) =>
										setClipTiming(t, ids, "fadeOutFrames", next),
									)
								}
								suffix="f"
							/>
						</Row>
						<Row label="Denoise">
							<Switch
								checked={first.denoiseEnabled}
								label="Denoise"
								onChange={(next) =>
									commit("Toggle denoise", (t) =>
										setClipFlag(t, ids, "denoiseEnabled", next),
									)
								}
							/>
							<Slider
								value={first.denoiseStrength}
								min={0}
								max={1}
								step={0.05}
								disabled={!first.denoiseEnabled}
								ariaLabel="Denoise strength"
								onChange={(next) =>
									commit("Set denoise", (t) =>
										setClipNumber(t, ids, "denoiseStrength", next),
									)
								}
							/>
							<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
								{first.denoiseStrength.toFixed(2)}
							</span>
							<button
								type="button"
								className="pmr-btn pmr-btn--ghost"
								title="Measure this clip's quiet passages and set the amount from them"
								onClick={async () => {
									const asset = state.assets.find(
										(entry) => entry.id === first.assetId,
									);
									if (!asset) return;
									const buffer = await decodeAudio(asset);
									if (!buffer) {
										setNoiseFloor("no audio");
										return;
									}
									const profile = measureNoiseFloor(
										monoSamples(buffer),
										buffer.sampleRate,
									);
									const strength = suggestedDenoiseStrength(profile);
									setNoiseFloor(`floor ${profile.floorDb} dB`);
									commit("Auto denoise", (t) =>
										setClipNumber(
											setClipFlag(t, ids, "denoiseEnabled", strength > 0),
											ids,
											"denoiseStrength",
											strength,
										),
									);
								}}
							>
								Auto
							</button>
						</Row>
						{noiseFloor ? (
							<Row label="">
								<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
									Measured {noiseFloor}
								</span>
							</Row>
						) : null}
					</Group>
				) : null}

				{tab === "content" && first.textStyle ? (
					<>
						<Group title="Text">
							<textarea
								className="pmr-agent__field"
								style={{
									border: "1px solid var(--pmr-border-subtle)",
									borderRadius: 4,
									background: "rgba(0,0,0,0.35)",
									minHeight: 60,
								}}
								value={first.content ?? ""}
								onChange={(event) =>
									commit("Edit text", (t) =>
										setClipContent(t, ids, event.target.value),
									)
								}
							/>
						</Group>
						<Group title="Typography">
							<Row label="Font">
								<Select
									value={first.textStyle.fontFamily}
									ariaLabel="Font"
									options={["SF Pro Display", "Inter", "Georgia", "Menlo"].map(
										(font) => ({
											value: font,
											label: font,
										}),
									)}
									onChange={(next) =>
										commit("Set font", (t) =>
											setClipTextStyle(t, ids, { fontFamily: next }),
										)
									}
								/>
							</Row>
							<SliderRow
								label="Size"
								value={first.textStyle.fontSize}
								min={CLIP_LIMITS.fontSize.min}
								max={CLIP_LIMITS.fontSize.max}
								step={1}
								onChange={(next) =>
									commit("Set font size", (t) =>
										setClipTextStyle(t, ids, { fontSize: next }),
									)
								}
							/>
							<SliderRow
								label="Tracking"
								value={first.textStyle.tracking}
								min={CLIP_LIMITS.tracking.min}
								max={CLIP_LIMITS.tracking.max}
								step={0.5}
								onChange={(next) =>
									commit("Set tracking", (t) =>
										setClipTextStyle(t, ids, { tracking: next }),
									)
								}
							/>
							<Row label="Style">
								{(["bold", "italic", "uppercase"] as const).map((trait) => (
									<button
										key={trait}
										type="button"
										className="pmr-btn"
										data-active={first.textStyle?.[trait]}
										title={trait}
										onClick={() =>
											commit("Set text style", (t) =>
												setClipTextStyle(t, ids, {
													[trait]: !first.textStyle?.[trait],
												}),
											)
										}
										style={{
											fontWeight: trait === "bold" ? 700 : 400,
											fontStyle: trait === "italic" ? "italic" : "normal",
											fontSize: 11,
										}}
									>
										{trait === "bold" ? "B" : trait === "italic" ? "I" : "AA"}
									</button>
								))}
							</Row>
							<Row label="Align">
								{(["left", "center", "right"] as const).map((align) => (
									<button
										key={align}
										type="button"
										className="pmr-btn"
										data-active={first.textStyle?.alignment === align}
										title={align}
										onClick={() =>
											commit("Set alignment", (t) =>
												setClipTextStyle(t, ids, { alignment: align }),
											)
										}
										style={{ fontSize: 11 }}
									>
										{align === "left" ? "⇤" : align === "center" ? "≡" : "⇥"}
									</button>
								))}
							</Row>
							<Row label="Color">
								<ColorField
									value={first.textStyle.color}
									ariaLabel="Text colour"
									onChange={(next) =>
										commit("Set text colour", (t) =>
											setClipTextStyle(t, ids, { color: next }),
										)
									}
								/>
							</Row>
						</Group>
					</>
				) : null}

				{tab === "animate" && first.textStyle ? (
					<Group title="Animation">
						<Row label="Preset">
							<Select
								value={first.textStyle.animation}
								ariaLabel="Animation preset"
								options={TEXT_ANIMATIONS.map((preset) => ({
									value: preset,
									label: preset,
								}))}
								onChange={(next) =>
									commit("Set animation", (t) =>
										setClipTextStyle(t, ids, {
											animation: next as TextAnimation,
										}),
									)
								}
							/>
						</Row>
						<Row label="Highlight">
							<ColorField
								value={first.textStyle.highlightColor}
								ariaLabel="Highlight colour"
								onChange={(next) =>
									commit("Set highlight", (t) =>
										setClipTextStyle(t, ids, { highlightColor: next }),
									)
								}
							/>
						</Row>
					</Group>
				) : null}

				{tab === "zoom" ? (
					<Group
						title="Zoom regions"
						action={
							<button
								type="button"
								className="pmr-btn"
								title="Suggest zooms from cursor telemetry"
								style={{ width: 20, height: 20 }}
								onClick={() => {
									const totalMs =
										((first.endFrame - first.startFrame) * first.speed * 1000) /
										timeline.fps;
									const result = buildInteractionZoomSuggestions({
										cursorTelemetry: state.cursorTelemetry,
										totalMs,
										defaultDurationMs: 2400,
										reservedSpans: (first.zoomRegions ?? []).map((region) => ({
											start: region.startMs,
											end: region.endMs,
										})),
									});
									if (result.suggestions.length === 0) {
										api.toast(
											result.status === "no-telemetry"
												? "No cursor telemetry for this recording — record with Track cursor on."
												: "No click clusters found to zoom on.",
											"error",
										);
										return;
									}
									let added = 0;
									commit("Suggest zooms", (t) => {
										let next = t;
										for (const suggestion of result.suggestions) {
											const outcome = addZoomRegion(
												next,
												first.id,
												(suggestion.start + suggestion.end) / 2,
												suggestion.end - suggestion.start,
												totalMs,
												suggestion.focus,
											);
											if (outcome.ok) {
												next = outcome.timeline;
												added += 1;
											}
										}
										return next;
									});
									api.toast(
										`Added ${added} zoom${added === 1 ? "" : "s"} from click clusters`,
									);
								}}
							>
								<SparkleIcon size={11} />
							</button>
						}
					>
						{(first.zoomRegions ?? []).map((region) => {
							const selected = state.selectedZoomRegionId === region.id;
							return (
								<div
									key={region.id}
									onPointerDown={() => patch({ selectedZoomRegionId: region.id })}
									style={{
										border: `1px solid ${selected ? "var(--pmr-timecode)" : "var(--pmr-border-subtle)"}`,
										borderRadius: 4,
										padding: 8,
										display: "flex",
										flexDirection: "column",
										gap: 4,
										marginBottom: 6,
									}}
								>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: 6,
											fontSize: 11,
											color: "var(--pmr-text-2)",
										}}
									>
										<ZoomRegionIcon size={12} />
										{(region.startMs / 1000).toFixed(1)}s →{" "}
										{(region.endMs / 1000).toFixed(1)}s
										<span
											style={{
												marginLeft: "auto",
												color: "var(--pmr-timecode)",
											}}
										>
											{scaleForDepth(region.depth).toFixed(2)}×
										</span>
										<button
											type="button"
											className="pmr-btn"
											title="Remove zoom region"
											style={{ width: 18, height: 18, fontSize: 12 }}
											onClick={() =>
												commit("Remove zoom", (t) => {
													const result = removeZoomRegion(
														t,
														first.id,
														region.id,
													);
													return result.ok ? result.timeline : t;
												})
											}
										>
											×
										</button>
									</div>

									<SliderRow
										label="Depth"
										value={region.depth}
										min={CLIP_LIMITS.depth.min}
										max={CLIP_LIMITS.depth.max}
										step={1}
										onChange={(next) =>
											commit("Set zoom depth", (t) => {
												const result = updateZoomRegion(
													t,
													first.id,
													region.id,
													{ depth: next },
													Number.MAX_SAFE_INTEGER,
												);
												return result.ok ? result.timeline : t;
											})
										}
									/>
									<Row label="Focus">
										<NumberField
											value={region.focus.cx}
											step={0.004}
											width={46}
											onChange={(next) =>
												commit("Aim zoom", (t) => {
													const result = updateZoomRegion(
														t,
														first.id,
														region.id,
														{ focus: { ...region.focus, cx: next } },
														Number.MAX_SAFE_INTEGER,
													);
													return result.ok ? result.timeline : t;
												})
											}
										/>
										<NumberField
											value={region.focus.cy}
											step={0.004}
											width={46}
											onChange={(next) =>
												commit("Aim zoom", (t) => {
													const result = updateZoomRegion(
														t,
														first.id,
														region.id,
														{ focus: { ...region.focus, cy: next } },
														Number.MAX_SAFE_INTEGER,
													);
													return result.ok ? result.timeline : t;
												})
											}
										/>
									</Row>
									<Row label="Mode">
										<Segmented
											value={region.mode}
											ariaLabel="Zoom mode"
											options={[
												{
													value: "auto",
													label: "auto",
													title: "Drift with the cursor",
												},
												{
													value: "manual",
													label: "manual",
													title: "Pin the focus point",
												},
											]}
											onChange={(mode) =>
												commit("Set zoom mode", (t) => {
													const result = updateZoomRegion(
														t,
														first.id,
														region.id,
														{ mode },
														Number.MAX_SAFE_INTEGER,
													);
													return result.ok ? result.timeline : t;
												})
											}
										/>
									</Row>
								</div>
							);
						})}
						<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
							Timing is source milliseconds, so zooms survive trimming. Drag in the
							preview to aim the active region.
						</span>
					</Group>
				) : null}

				{tab === "ai" ? (
					<Group title="AI Edit">
						<span style={{ fontSize: 11, color: "var(--pmr-text-3)", lineHeight: 1.5 }}>
							Ask the agent to act on this selection. It calls the same reducers this
							panel does — see the Agent panel for the receipts.
						</span>
					</Group>
				) : null}

				<Group title="Timeline" defaultOpen={false}>
					<Row label="Resolution">
						<span style={{ fontSize: 11, color: "var(--pmr-text-3)" }}>
							{timeline.width} × {timeline.height}
						</span>
					</Row>
					<Row label="Frame rate">
						<span style={{ fontSize: 11, color: "var(--pmr-text-3)" }}>
							{timeline.fps} fps
						</span>
					</Row>
				</Group>
			</div>
		</>
	);
}
