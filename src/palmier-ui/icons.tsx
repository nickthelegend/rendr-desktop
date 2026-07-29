// Inline SVG stand-ins for the SF Symbols Palmier Pro uses. Names match the
// symbol names in ToolbarView.swift / MediaPanelView.swift so the mapping is
// traceable.

interface IconProps {
	size?: number;
}

function svg(path: React.ReactNode, size: number, viewBox = "0 0 16 16") {
	return (
		<svg
			width={size}
			height={size}
			viewBox={viewBox}
			fill="none"
			stroke="currentColor"
			strokeWidth={1.4}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{path}
		</svg>
	);
}

/** arrow.uturn.backward */
export const UndoIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M3 7h7a3 3 0 0 1 0 6H7" />
			<path d="M5.5 4.5 3 7l2.5 2.5" />
		</>,
		size,
	);

/** arrow.uturn.forward */
export const RedoIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M13 7H6a3 3 0 0 0 0 6h3" />
			<path d="M10.5 4.5 13 7l-2.5 2.5" />
		</>,
		size,
	);

/** cursorarrow */
export const PointerIcon = ({ size = 14 }: IconProps) =>
	svg(<path d="M4 2.5 12 8l-3.6.8L10 13l-1.6.7-1.6-4.2L4 12z" />, size);

/** scissors */
export const RazorIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<circle cx="4" cy="12" r="1.8" />
			<circle cx="12" cy="12" r="1.8" />
			<path d="M5.3 10.7 12 2.5M10.7 10.7 4 2.5" />
		</>,
		size,
	);

/** arrow.left.and.right */
export const TrimIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M2 8h12" />
			<path d="M4.5 5.5 2 8l2.5 2.5M11.5 5.5 14 8l-2.5 2.5" />
		</>,
		size,
	);

/** square.split.2x1 */
export const SplitIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<rect x="2" y="3.5" width="12" height="9" rx="1.2" />
			<path d="M8 3.5v9" />
		</>,
		size,
	);

/** folder */
export const FolderIcon = ({ size = 15 }: IconProps) =>
	svg(
		<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />,
		size,
	);

/** captions.bubble */
export const CaptionsIcon = ({ size = 15 }: IconProps) =>
	svg(
		<>
			<path d="M2 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7l-3 2.5V11H4a2 2 0 0 1-2-2z" />
			<path d="M5.5 7h2M9 7h2" />
		</>,
		size,
	);

/** waveform */
export const WaveformIcon = ({ size = 15 }: IconProps) =>
	svg(<path d="M2 8h1.5M5 4.5v7M8 2.5v11M11 5.5v5M14 8h-.5" />, size);

/** play / pause */
export const PlayIcon = ({ size = 14 }: IconProps) =>
	svg(<path d="M4.5 3 12.5 8l-8 5z" fill="currentColor" strokeWidth={1} />, size);

export const PauseIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<rect
				x="4.5"
				y="3"
				width="2.6"
				height="10"
				rx="0.6"
				fill="currentColor"
				strokeWidth={0}
			/>
			<rect
				x="9"
				y="3"
				width="2.6"
				height="10"
				rx="0.6"
				fill="currentColor"
				strokeWidth={0}
			/>
		</>,
		size,
	);

export const SkipStartIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M4 3v10" />
			<path d="M13 3 6 8l7 5z" fill="currentColor" strokeWidth={1} />
		</>,
		size,
	);

export const SkipEndIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M12 3v10" />
			<path d="M3 3l7 5-7 5z" fill="currentColor" strokeWidth={1} />
		</>,
		size,
	);

/** minus.magnifyingglass / plus.magnifyingglass */
export const ZoomOutIcon = ({ size = 12 }: IconProps) =>
	svg(
		<>
			<circle cx="7" cy="7" r="4.2" />
			<path d="M10.2 10.2 14 14M5 7h4" />
		</>,
		size,
	);

export const ZoomInIcon = ({ size = 12 }: IconProps) =>
	svg(
		<>
			<circle cx="7" cy="7" r="4.2" />
			<path d="M10.2 10.2 14 14M5 7h4M7 5v4" />
		</>,
		size,
	);

/** record — Rendr's own; Palmier has no capture. */
export const RecordIcon = ({ size = 14 }: IconProps) =>
	svg(<circle cx="8" cy="8" r="4.5" fill="currentColor" strokeWidth={0} />, size);

/** magnifying glass over a frame — the zoom-region tool. */
export const ZoomRegionIcon = ({ size = 15 }: IconProps) =>
	svg(
		<>
			<rect x="2" y="3" width="12" height="10" rx="1.2" />
			<circle cx="8" cy="8" r="2.4" />
			<path d="M9.8 9.8 11.5 11.5" />
		</>,
		size,
	);

export const SparkleIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6z" />
			<path d="M12.4 11.6 12.9 13l1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" />
		</>,
		size,
	);

export const SendIcon = ({ size = 13 }: IconProps) =>
	svg(<path d="M2.5 8 13.5 3 9.5 13 8 9.2z" />, size);

export const ChevronIcon = ({ size = 10, open = true }: IconProps & { open?: boolean }) =>
	svg(<path d={open ? "M3 6l4 4 4-4" : "M6 3l4 4-4 4"} />, size, "0 0 14 14");

/** square.and.arrow.down — import media */
export const ImportIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M8 2v7" />
			<path d="M5 6.5 8 9.5l3-3" />
			<path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" />
		</>,
		size,
	);

/** plus */

/** trash */
export const TrashIcon = ({ size = 13 }: IconProps) =>
	svg(
		<>
			<path d="M2.5 4h11" />
			<path d="M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4" />
			<path d="M4 4v8.2a1.3 1.3 0 0 0 1.3 1.3h5.4A1.3 1.3 0 0 0 12 12.2V4" />
			<path d="M6.6 6.8v4M9.4 6.8v4" />
		</>,
		size,
	);

/** mic */
export const MicIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<rect x="6" y="2" width="4" height="7" rx="2" />
			<path d="M3.6 7.2a4.4 4.4 0 0 0 8.8 0M8 11.6V14" />
		</>,
		size,
	);

/** speaker.wave.2 — system audio */
export const SpeakerIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M2 6.2h2.2L7 3.8v8.4L4.2 9.8H2z" />
			<path d="M9.6 6a2.8 2.8 0 0 1 0 4M11.6 4.2a5.4 5.4 0 0 1 0 7.6" />
		</>,
		size,
	);

/** cursorarrow.rays — cursor telemetry */
export const CursorTrackIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M6 5.2 10.6 8.4l-2 .5.9 2.4-.9.4-.9-2.4-1.7 1.5z" />
			<path d="M3 3.2 4 4.2M13 3.2 12 4.2M2.4 8h1.4" />
		</>,
		size,
	);

/** monitor — screen source */
export const MonitorIcon = ({ size = 18 }: IconProps) =>
	svg(
		<>
			<rect x="1.8" y="3" width="12.4" height="8.4" rx="1.2" />
			<path d="M6 14h4M8 11.4V14" />
		</>,
		size,
	);

/** macwindow — window source */
export const WindowIcon = ({ size = 18 }: IconProps) =>
	svg(
		<>
			<rect x="1.8" y="3" width="12.4" height="10" rx="1.4" />
			<path d="M1.8 5.8h12.4M4 4.4h.01M5.8 4.4h.01" />
		</>,
		size,
	);

/** camera — webcam source */
export const CameraIcon = ({ size = 18 }: IconProps) =>
	svg(
		<>
			<rect x="1.8" y="4.4" width="9" height="7.2" rx="1.4" />
			<path d="M10.8 7.6 14.2 5.6v5.2l-3.4-2z" />
		</>,
		size,
	);

/** film — the timeline's empty state */
export const FilmIcon = ({ size = 22 }: IconProps) =>
	svg(
		<>
			<rect x="1.6" y="3" width="12.8" height="10" rx="1.4" />
			<path d="M4.6 3v10M11.4 3v10" />
			<path d="M1.6 8h12.8" />
		</>,
		size,
	);

/** pause bars for the HUD */
export const HudPauseIcon = ({ size = 13 }: IconProps) =>
	svg(
		<>
			<rect
				x="4.6"
				y="3"
				width="2.4"
				height="10"
				rx="0.8"
				fill="currentColor"
				strokeWidth={0}
			/>
			<rect
				x="9"
				y="3"
				width="2.4"
				height="10"
				rx="0.8"
				fill="currentColor"
				strokeWidth={0}
			/>
		</>,
		size,
	);

/** stop square for the HUD */
export const StopIcon = ({ size = 12 }: IconProps) =>
	svg(
		<rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" strokeWidth={0} />,
		size,
	);

/** x — dismiss */
export const CloseIcon = ({ size = 12 }: IconProps) => svg(<path d="M4 4l8 8M12 4l-8 8" />, size);

/** rectangle.stack.badge.plus — add a video track */
export const AddVideoTrackIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<rect x="1.8" y="4" width="8.4" height="6" rx="1" />
			<path d="M13 6v5M10.5 8.5h5" />
		</>,
		size,
	);

/** waveform.badge.plus — add an audio track */
export const AddAudioTrackIcon = ({ size = 14 }: IconProps) =>
	svg(
		<>
			<path d="M1.8 8h1M4 5.5v5M6.2 3.5v9M8.4 6v4" />
			<path d="M12.5 6v5M10 8.5h5" />
		</>,
		size,
	);

/** chevron.up / chevron.down for track reordering */
export const CaretUpIcon = ({ size = 10 }: IconProps) => svg(<path d="M4 9.5 8 5.5l4 4" />, size);
export const CaretDownIcon = ({ size = 10 }: IconProps) =>
	svg(<path d="M4 6.5 8 10.5l4-4" />, size);

/** speaker.slash / eye — track state */
export const SoloIcon = ({ size = 11 }: IconProps) =>
	svg(<path d="M8 2.6 9.7 6.3l4 .6-2.9 2.8.7 4L8 11.8 4.5 13.7l.7-4L2.3 6.9l4-.6z" />, size);

/** Corner arrows pointing outward — enter fullscreen. */
export function ExpandIcon({ size = 12 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** Corner arrows pointing inward — leave fullscreen. */
export function CollapseIcon({ size = 12 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
