// Panel shell — Palmier Pro's makeHosting(): surface fill clipped to a small
// radius, inset by half the panel gap over the base background, with an accent
// focus ring (PanelFocusRing) that fades in on the focused panel.

import type { ReactNode } from "react";

import type { FocusedPanel } from "./theme";

interface PanelProps {
	panel: FocusedPanel;
	focused: FocusedPanel | null;
	onFocus: (panel: FocusedPanel) => void;
	children: ReactNode;
}

export function Panel({ panel, focused, onFocus, children }: PanelProps) {
	return (
		<div
			className={`pmr-panel${focused === panel ? " pmr-panel--focused" : ""}`}
			onPointerDownCapture={() => onFocus(panel)}
			data-panel={panel}
		>
			<div className="pmr-panel__inner">{children}</div>
			<div className="pmr-panel__ring" />
		</div>
	);
}

interface PanelHeaderProps {
	title: string;
	children?: ReactNode;
}

/** panelHeaderBar() — 28px raised bar with a hairline bottom border. */
export function PanelHeader({ title, children }: PanelHeaderProps) {
	return (
		<div className="pmr-header">
			<span className="pmr-header__title">{title}</span>
			<span className="pmr-header__spacer" />
			{children}
		</div>
	);
}
