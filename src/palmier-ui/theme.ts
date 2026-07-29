// Design tokens ported from Palmier Pro (GPL-3.0),
// Sources/PalmierPro/UI/AppTheme.swift and Utilities/Constants.swift.
// Values are transcribed 1:1; Swift CGFloat points map to CSS px. See NOTICE.md.

export const Background = {
	base: "rgb(10, 10, 10)",
	surface: "rgb(22, 22, 22)",
	raised: "rgb(30, 30, 30)",
	prominent: "rgb(44, 44, 44)",
	/** Alias — empty media slot is a raised plate. */
	placeholder: "rgb(30, 30, 30)",
	previewCanvas: "#000000",
} as const;

export const Text = {
	primary: "rgba(255, 255, 255, 1)",
	secondary: "rgba(255, 255, 255, 0.8)",
	tertiary: "rgba(255, 255, 255, 0.62)",
	muted: "rgba(255, 255, 255, 0.34)",
} as const;

export const Opacity = {
	opaque: 1,
	subtle: 0.04,
	hint: 0.06,
	faint: 0.08,
	soft: 0.1,
	muted: 0.15,
	moderate: 0.25,
	medium: 0.35,
	strong: 0.55,
	high: 0.7,
	prominent: 0.8,
} as const;

export const Status = {
	error: "rgb(229, 79, 79)",
	success: "rgb(79, 184, 95)",
	warning: "rgb(255, 149, 0)",
} as const;

/** Timeline clip colors by media type. */
export const TrackColor = {
	video: "rgb(29, 88, 120)",
	audio: "rgb(46, 119, 101)",
	image: "rgb(113, 84, 134)",
	text: "rgb(113, 84, 134)",
	lottie: "rgb(160, 120, 34)",
	sequence: "rgb(185, 178, 154)",
	multicam: "rgb(255, 59, 48)",
} as const;

export const Radius = {
	xs: 3,
	xsSm: 4,
	sm: 6,
	md: 10,
	mdLg: 12,
	lg: 14,
	xl: 20,
} as const;

export const Shadow = {
	sm: "0 0.5px 1px rgba(0, 0, 0, 0.3)",
	md: "0 2px 4px rgba(0, 0, 0, 0.3)",
	lg: "0 8px 24px rgba(0, 0, 0, 0.25)",
} as const;

/** Layout constants — Utilities/Constants.swift. */
export const Layout = {
	mediaPanelDefault: 500,
	// Inlined from the panel token block, which was a second copy of what
	// palmier.css already declares — the CSS is the source of truth for
	// anything the stylesheet can express, and these two are the only numbers
	// the layout code needs in JS.
	inspectorDefault: 320,
	inspectorMin: 260,
	agentPanelMin: 240,
	agentPanelMax: 640,
	panelHeaderHeight: 28,
	toolbarHeight: 38,
	panelGap: 5,
	timelineMinHeight: 100,
	trackHeight: 50,
	rulerHeight: 24,
	/** Wide enough for the name plus its four controls; see --pmr-track-header. */
	trackHeaderWidth: 132,
	previewMinWidth: 400,
	previewMinHeight: 320,
} as const;

export type LayoutPreset = "default" | "media" | "vertical";

export const LAYOUT_PRESETS: Array<{ id: LayoutPreset; label: string }> = [
	{ id: "default", label: "Default" },
	{ id: "media", label: "Media" },
	{ id: "vertical", label: "Vertical" },
];

export type FocusedPanel = "agent" | "media" | "preview" | "inspector" | "timeline";

/** The active editing tool — Editor/ToolMode.swift. */
export type ToolMode = "pointer" | "razor" | "trim";
