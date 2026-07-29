// Modal sheets. Reserved for tasks that genuinely need protected focus: an
// export you must not edit underneath, and a reference you read then dismiss.

import { useEffect, useState } from "react";

import { NumberField, Segmented, Slider } from "./controls";
import { type ExportProgress, type ExportSettings, exportDimensions } from "./export";
import { CloseIcon } from "./icons";
import { type OfflineSupport, offlineExportSupport } from "./offlineExport";
import type { TimelineModel } from "./reducers";
import { formatTimecode, type PromptRequest } from "./state";

function useEscape(onClose: () => void) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
}

export function ExportSheet({
	settings,
	onChange,
	progress,
	timeline,
	totalFrames,
	onStart,
	onCancel,
}: {
	settings: ExportSettings;
	onChange: (next: ExportSettings) => void;
	progress: ExportProgress | null;
	timeline: TimelineModel;
	totalFrames: number;
	onStart: () => void;
	onCancel: () => void;
}) {
	// Which encoder will take this size, asked once the dialog opens so the
	// dialog names the file the user is actually going to get.
	const [encoder, setEncoder] = useState<OfflineSupport | null>(null);
	useEscape(onCancel);
	const { width, height } = exportDimensions(timeline, settings);
	const running = progress !== null;

	// Re-asked when the size changes: an encoder that takes 720p may refuse the
	// timeline's own resolution, and the dialog must not promise the wrong one.
	useEffect(() => {
		let cancelled = false;
		setEncoder(null);
		void offlineExportSupport(width, height, timeline.fps).then((support) => {
			if (!cancelled) setEncoder(support);
		});
		return () => {
			cancelled = true;
		};
	}, [width, height, timeline.fps]);
	const seconds = totalFrames / timeline.fps;

	return (
		<div className="pmr-sheet__scrim" role="dialog" aria-modal="true" aria-label="Export">
			<div className="pmr-sheet">
				<div className="pmr-sheet__head">
					<span className="pmr-sheet__title">Export video</span>
					<button
						type="button"
						className="pmr-btn"
						onClick={onCancel}
						aria-label={running ? "Cancel export" : "Close"}
					>
						<CloseIcon />
					</button>
				</div>

				<div className="pmr-sheet__body">
					<div className="pmr-row">
						<span className="pmr-row__label">Resolution</span>
						<div className="pmr-row__control">
							<Segmented
								value={settings.resolution}
								ariaLabel="Resolution"
								options={[
									{ value: "source", label: "Source" },
									{ value: "1080p", label: "1080p" },
									{ value: "720p", label: "720p" },
								]}
								onChange={(resolution) => onChange({ ...settings, resolution })}
							/>
						</div>
					</div>

					<div className="pmr-row">
						<span className="pmr-row__label">Quality</span>
						<div className="pmr-row__control">
							<Slider
								value={settings.quality}
								min={0.2}
								max={1}
								step={0.05}
								ariaLabel="Quality"
								onChange={(quality) => onChange({ ...settings, quality })}
							/>
							<span className="pmr-num__suffix">
								{Math.round(settings.quality * 100)}%
							</span>
						</div>
					</div>

					<div className="pmr-sheet__facts">
						<span>
							{width}×{height} · {timeline.fps}fps ·{" "}
							{encoder === null
								? "checking encoder…"
								: encoder.supported
									? "MP4 (H.264 · AAC)"
									: "WebM (VP9) · real-time"}
						</span>
						<span>
							{formatTimecode(totalFrames, timeline.fps)} · {totalFrames} frames
						</span>
					</div>

					{running ? (
						<div className="pmr-sheet__progress">
							<div className="pmr-progress">
								<span
									className="pmr-progress__fill"
									style={
										{ "--pmr-progress": progress.ratio } as React.CSSProperties
									}
								/>
							</div>
							<span className="pmr-sheet__progresstext">
								{progress.stage === "audio"
									? "Mixing audio…"
									: progress.stage === "muxing"
										? "Muxing picture and sound…"
										: `Frame ${progress.frame + 1} of ${progress.totalFrames}`}{" "}
								· {Math.round(progress.ratio * 100)}%
							</span>
						</div>
					) : (
						<p className="pmr-sheet__note">
							{encoder?.supported
								? // Offline: not clock-paced, but seeking the source
									// is usually what it waits on, so an estimate is
									// given as an upper bound rather than a promise.
									`Encoded offline, so the timeline's own frame timing goes into the file. It runs as fast as frames can be composited — under ${Math.max(1, Math.round(seconds))}s for this timeline, faster on simple ones. Leave this open while it works.`
								: `Rendr encodes by playing the timeline through, so this takes about as long as the video runs — roughly ${Math.max(1, Math.round(seconds))}s. Leave this open while it works.`}
						</p>
					)}
				</div>

				<div className="pmr-sheet__foot">
					<button type="button" className="pmr-action" onClick={onCancel}>
						{running ? "Cancel" : "Close"}
					</button>
					<button
						type="button"
						className="pmr-action pmr-action--primary"
						onClick={onStart}
						disabled={running || totalFrames === 0}
					>
						{running ? "Exporting…" : "Export"}
					</button>
				</div>
			</div>
		</div>
	);
}

const FPS_CHOICES = [24, 25, 30, 48, 50, 60];

const ASPECTS: Array<{ label: string; ratio: number }> = [
	{ label: "16:9", ratio: 16 / 9 },
	{ label: "9:16", ratio: 9 / 16 },
	{ label: "1:1", ratio: 1 },
	{ label: "4:3", ratio: 4 / 3 },
	{ label: "2.4:1", ratio: 2.4 },
];

const QUALITIES: Array<{ label: string; shortEdge: number }> = [
	{ label: "720p", shortEdge: 720 },
	{ label: "1080p", shortEdge: 1080 },
	{ label: "2K", shortEdge: 1440 },
	{ label: "4K", shortEdge: 2160 },
];

const even = (value: number) => Math.max(16, Math.round(value / 2) * 2);

/**
 * Frame rate and canvas size — the same knobs `set_project_settings` turns.
 *
 * Changing the frame rate rescales every clip's frames so the cut keeps its
 * timing, which is why this is one Apply rather than live-updating controls:
 * the user should see what they're about to do to the whole timeline.
 */
export function ProjectSettingsSheet({
	timeline,
	onApply,
	onClose,
}: {
	timeline: TimelineModel;
	onApply: (settings: { fps: number; width: number; height: number }) => void;
	onClose: () => void;
}) {
	useEscape(onClose);
	const [fps, setFps] = useState(timeline.fps);
	const [width, setWidth] = useState(timeline.width);
	const [height, setHeight] = useState(timeline.height);

	const ratio = width / height;
	const activeAspect = ASPECTS.find((entry) => Math.abs(entry.ratio - ratio) < 0.01)?.label;
	const shortEdge = Math.min(width, height);
	const activeQuality = QUALITIES.find((entry) => entry.shortEdge === shortEdge)?.label;

	const setAspect = (next: number) => {
		const edge = Math.min(width, height);
		setWidth(even(next >= 1 ? edge * next : edge));
		setHeight(even(next >= 1 ? edge : edge / next));
	};

	const setQuality = (edge: number) => {
		setWidth(even(ratio >= 1 ? edge * ratio : edge));
		setHeight(even(ratio >= 1 ? edge : edge / ratio));
	};

	const rescales = fps !== timeline.fps;
	const changed = rescales || width !== timeline.width || height !== timeline.height;

	return (
		<div
			className="pmr-sheet__scrim"
			role="dialog"
			aria-modal="true"
			aria-label="Project settings"
		>
			<div className="pmr-sheet">
				<div className="pmr-sheet__head">
					<span className="pmr-sheet__title">Project settings</span>
					<button type="button" className="pmr-btn" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</div>

				<div className="pmr-sheet__body">
					<div className="pmr-row">
						<span className="pmr-row__label">Frame rate</span>
						<div className="pmr-row__control">
							<Segmented
								value={String(fps)}
								options={FPS_CHOICES.map((choice) => ({
									value: String(choice),
									label: String(choice),
								}))}
								ariaLabel="Frame rate"
								onChange={(next) => setFps(Number(next))}
							/>
						</div>
					</div>

					<div className="pmr-row">
						<span className="pmr-row__label">Aspect</span>
						<div className="pmr-row__control">
							<Segmented
								value={activeAspect ?? ""}
								options={ASPECTS.map((entry) => ({
									value: entry.label,
									label: entry.label,
								}))}
								ariaLabel="Aspect ratio"
								onChange={(next) => {
									const entry = ASPECTS.find((item) => item.label === next);
									if (entry) setAspect(entry.ratio);
								}}
							/>
						</div>
					</div>

					<div className="pmr-row">
						<span className="pmr-row__label">Resolution</span>
						<div className="pmr-row__control">
							<Segmented
								value={activeQuality ?? ""}
								options={QUALITIES.map((entry) => ({
									value: entry.label,
									label: entry.label,
								}))}
								ariaLabel="Resolution"
								onChange={(next) => {
									const entry = QUALITIES.find((item) => item.label === next);
									if (entry) setQuality(entry.shortEdge);
								}}
							/>
						</div>
					</div>

					<div className="pmr-row">
						<span className="pmr-row__label">Canvas</span>
						<div className="pmr-row__control">
							<NumberField
								value={width}
								step={2}
								width={64}
								ariaLabel="Canvas width"
								onChange={(next) => setWidth(even(next))}
							/>
							<span style={{ color: "var(--pmr-text-muted)", fontSize: 11 }}>×</span>
							<NumberField
								value={height}
								step={2}
								width={64}
								ariaLabel="Canvas height"
								onChange={(next) => setHeight(even(next))}
							/>
							<span style={{ color: "var(--pmr-text-muted)", fontSize: 11 }}>px</span>
						</div>
					</div>

					<p className="pmr-sheet__note">
						{rescales
							? `Changing the frame rate from ${timeline.fps} to ${fps} rescales every clip's position, trim and fades so the cut keeps its timing. One undo step.`
							: "Clip framing is stored as a fraction of the canvas, so a resolution change keeps every layout exactly as it is."}
					</p>
				</div>

				<div className="pmr-sheet__foot">
					<button type="button" className="pmr-action" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="pmr-action pmr-action--primary"
						disabled={!changed}
						onClick={() => {
							onApply({ fps, width, height });
							onClose();
						}}
					>
						Apply
					</button>
				</div>
			</div>
		</div>
	);
}

const SHORTCUTS: Array<{ group: string; rows: Array<[string, string]> }> = [
	{
		group: "Tools",
		rows: [
			["V", "Pointer"],
			["C", "Razor — click a clip to split it"],
			["T", "Trim"],
			["A", "Show / hide the agent chat"],
			["`", "Maximize the focused panel"],
		],
	},
	{
		group: "Playback",
		rows: [
			["Space", "Play / pause"],
			["Home / End", "Go to start / end"],
			["← / →", "Nudge selection one frame"],
			["⇧ ← / →", "Nudge selection ten frames"],
		],
	},
	{
		group: "Editing",
		rows: [
			["⌘K", "Split at playhead"],
			["Q", "Trim the selection's start to the playhead"],
			["← / →", "Move the selected zoom region"],
			["⌥ ← / →", "Resize the selected zoom region's end"],
			["W", "Trim the selection's end to the playhead"],
			["⌫", "Delete selection"],
			["⌘X / ⌘C / ⌘V", "Cut, copy, paste"],
			["⌘D", "Duplicate"],
			["⌘A", "Select all clips"],
			["⌘Z / ⇧⌘Z", "Undo / redo"],
		],
	},
	{
		group: "Project",
		rows: [
			["⌘S", "Save project"],
			["⌘O", "Open project"],
			["⌘I", "Import media"],
			["⇧⌘R", "Record"],
			["⌘E", "Export video"],
		],
	},
	{
		group: "Layout",
		rows: [
			["`", "Maximize the focused panel"],
			["?", "This sheet"],
		],
	},
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
	useEscape(onClose);
	return (
		<div
			className="pmr-sheet__scrim"
			role="dialog"
			aria-modal="true"
			aria-label="Keyboard shortcuts"
		>
			<div className="pmr-sheet pmr-sheet--wide">
				<div className="pmr-sheet__head">
					<span className="pmr-sheet__title">Keyboard shortcuts</span>
					<button type="button" className="pmr-btn" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</div>
				<div className="pmr-sheet__body pmr-sheet__body--columns">
					{SHORTCUTS.map((section) => (
						<div key={section.group} className="pmr-keys">
							<span className="pmr-keys__group">{section.group}</span>
							{section.rows.map(([key, label]) => (
								<div key={key} className="pmr-keys__row">
									<kbd className="pmr-kbd">{key}</kbd>
									<span>{label}</span>
								</div>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * Asks for one line of text.
 *
 * Electron's Chromium has `window.prompt` removed — it returns immediately and
 * logs a warning — so every rename in the app would silently do nothing. This
 * is that dialog, done properly: focused, escapable, and it commits on Enter.
 */
export function PromptSheet({ request, onClose }: { request: PromptRequest; onClose: () => void }) {
	const [value, setValue] = useState(request.initialValue);
	useEscape(onClose);

	const submit = () => {
		const trimmed = value.trim();
		if (trimmed.length === 0) return;
		request.onConfirm(trimmed);
		onClose();
	};

	return (
		<div
			className="pmr-sheet__scrim"
			role="dialog"
			aria-modal="true"
			aria-label={request.title}
		>
			<div className="pmr-sheet">
				<div className="pmr-sheet__head">
					<span className="pmr-sheet__title">{request.title}</span>
					<button type="button" className="pmr-btn" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</div>
				<div className="pmr-sheet__body">
					<div className="pmr-row">
						<span className="pmr-row__label">{request.label}</span>
						<div className="pmr-row__control">
							<input
								className="pmr-textinput"
								value={value}
								// The whole point of the dialog is this field, so
								// it takes focus with its text selected — typing
								// replaces the old name, as a rename should.
								ref={(node) => node?.select()}
								onChange={(event) => setValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										submit();
									}
								}}
							/>
						</div>
					</div>
				</div>
				<div className="pmr-sheet__foot">
					<button type="button" className="pmr-action" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="pmr-action pmr-action--primary"
						disabled={value.trim().length === 0}
						onClick={submit}
					>
						{request.confirmLabel ?? "Rename"}
					</button>
				</div>
			</div>
		</div>
	);
}
