// The app's own menu bar. Rendr runs in a frameless window, so the menus travel
// with the app rather than living in the OS bar — and the same actions have to
// work in the browser, where there is no OS bar at all.
//
// Every item here does something. An action that isn't built yet says so
// through a toast rather than sitting in the menu looking available.

import { useCallback, useEffect, useRef, useState } from "react";

import { toFcpxml, toXmeml } from "./interchange";
import { splitAt } from "./reducers";
import type { EditorApi } from "./state";
import { LAYOUT_PRESETS } from "./theme";

interface MenuItem {
	label: string;
	shortcut?: string;
	action?: () => void;
	disabled?: boolean;
	/** Renders a divider instead of a row. */
	separator?: boolean;
	checked?: boolean;
}

interface Menu {
	label: string;
	items: MenuItem[];
}

const MOD = typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

export function MenuBar({
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
	const { state, patch, commit, undo, redo, canUndo, canRedo, toast } = api;
	const [open, setOpen] = useState<string | null>(null);
	const barRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => setOpen(null), []);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close, open]);

	const hasSelection = state.selectedClipIds.length > 0;
	const recording = state.recording.phase !== "idle";

	const menus: Menu[] = [
		{
			label: "File",
			items: [
				{
					label: "New Project",
					shortcut: `${MOD}N`,
					action: () => {
						// Unsaved work is only discarded on an explicit confirmation.
						if (
							state.dirty &&
							!window.confirm("Discard unsaved changes and start a new project?")
						) {
							return;
						}
						api.newProject();
					},
				},
				{ label: "Open Project…", shortcut: `${MOD}O`, action: onOpenClick },
				{ label: "Import Media…", shortcut: `${MOD}I`, action: onImportClick },
				{
					label: "Record…",
					shortcut: `${MOD}⇧R`,
					action: onRecordClick,
					disabled: recording,
				},
				{ separator: true, label: "" },
				{ label: "Save Project", shortcut: `${MOD}S`, action: api.saveProject },
				{
					label: "Rename Project…",
					action: () =>
						api.askFor({
							title: "Rename project",
							label: "Project name",
							initialValue: state.projectName,
							onConfirm: api.renameProject,
						}),
				},
				{
					label: "Project Settings…",
					action: onProjectSettings,
				},
				{ separator: true, label: "" },
				{
					label: "Export Frame as PNG",
					action: onExportFrame,
					disabled: api.totalFrames === 0,
				},
				{
					label: "Export Video…",
					shortcut: `${MOD}E`,
					action: onExportClick,
					disabled: api.totalFrames === 0,
				},
				{
					label: "Export XML (Premiere Pro)",
					disabled: api.totalFrames === 0,
					action: () => {
						const result = toXmeml(api.timeline, state.assets, state.projectName);
						api.downloadText(
							result.xml,
							`${state.projectName.replace(/[/\\?%*:|"<>]/g, "-")}.xml`,
							"application/xml",
						);
						for (const warning of result.warnings) toast(warning, "error");
					},
				},
				{
					label: "Export FCPXML (Resolve · Final Cut)",
					disabled: api.totalFrames === 0,
					action: () => {
						const result = toFcpxml(api.timeline, state.assets, state.projectName);
						api.downloadText(
							result.xml,
							`${state.projectName.replace(/[/\\?%*:|"<>]/g, "-")}.fcpxml`,
							"application/xml",
						);
						for (const warning of result.warnings) toast(warning, "error");
					},
				},
			],
		},
		{
			label: "Edit",
			items: [
				{ label: "Undo", shortcut: `${MOD}Z`, action: undo, disabled: !canUndo },
				{ label: "Redo", shortcut: `${MOD}⇧Z`, action: redo, disabled: !canRedo },
				{ separator: true, label: "" },
				{
					label: "Split at Playhead",
					shortcut: `${MOD}K`,
					action: () => commit("Split at playhead", (t) => splitAt(t, state.playhead)),
					disabled: api.totalFrames === 0,
				},
				{
					label: "Delete Selected",
					shortcut: "⌫",
					action: api.deleteSelection,
					disabled: !hasSelection,
				},
				{ separator: true, label: "" },
				{
					label: "Select All Clips",
					shortcut: `${MOD}A`,
					action: () =>
						patch({
							selectedClipIds: api.timeline.tracks.flatMap((track) =>
								track.clips.map((clip) => clip.id),
							),
						}),
					disabled: api.totalFrames === 0,
				},
				{
					label: "Deselect",
					shortcut: `${MOD}⇧A`,
					action: () => patch({ selectedClipIds: [], selectedZoomRegionId: null }),
					disabled: !hasSelection,
				},
			],
		},
		{
			label: "View",
			items: [
				...LAYOUT_PRESETS.map((preset) => ({
					label: `${preset.label} Layout`,
					checked: state.layoutPreset === preset.id,
					action: () => patch({ layoutPreset: preset.id, maximizedPanel: null }),
				})),
				{ separator: true, label: "" },
				{
					label: "Media Panel",
					checked: state.mediaPanelVisible,
					action: () => patch({ mediaPanelVisible: !state.mediaPanelVisible }),
				},
				{
					label: "Inspector",
					checked: state.inspectorPanelVisible,
					action: () => patch({ inspectorPanelVisible: !state.inspectorPanelVisible }),
				},
				{
					label: "Agent Panel",
					checked: state.agentPanelVisible,
					action: () => patch({ agentPanelVisible: !state.agentPanelVisible }),
				},
				{ separator: true, label: "" },
				{
					label: "Maximize Focused Panel",
					shortcut: "`",
					action: () => state.focusedPanel && api.toggleMaximize(state.focusedPanel),
					disabled: !state.focusedPanel,
				},
			],
		},
		{
			label: "Timeline",
			items: [
				{
					label: "Zoom In",
					shortcut: "+",
					action: () => patch({ zoomScale: Math.min(8, state.zoomScale * 1.25) }),
				},
				{
					label: "Zoom Out",
					shortcut: "−",
					action: () => patch({ zoomScale: Math.max(0.25, state.zoomScale / 1.25) }),
				},
				{ label: "Reset Zoom", action: () => patch({ zoomScale: 1 }) },
				{ separator: true, label: "" },
				{
					label: "Pointer Tool",
					shortcut: "V",
					checked: state.toolMode === "pointer",
					action: () => patch({ toolMode: "pointer" }),
				},
				{
					label: "Razor Tool",
					shortcut: "C",
					checked: state.toolMode === "razor",
					action: () => patch({ toolMode: "razor" }),
				},
				{
					label: "Trim Tool",
					shortcut: "T",
					checked: state.toolMode === "trim",
					action: () => patch({ toolMode: "trim" }),
				},
				{ separator: true, label: "" },
				{
					label: "Go to Start",
					shortcut: "Home",
					action: () => patch({ playhead: 0 }),
				},
				{
					label: "Go to End",
					shortcut: "End",
					action: () => patch({ playhead: api.totalFrames }),
				},
				{ separator: true, label: "" },
				// One project can hold several timelines: alternate cuts, a 9:16
				// version, a section assembled on its own. Switching swaps what
				// every panel — and every agent tool — is looking at.
				...state.timelines.map((entry) => ({
					label: entry.name,
					checked: entry.id === state.activeTimelineId,
					action: () => api.setActiveTimeline(entry.id),
				})),
				{
					label: "New Timeline",
					action: () => {
						const created = api.createTimeline();
						if (created) toast(`Switched to ${created.name}`);
					},
				},
				{
					label: "Duplicate Timeline",
					action: () => {
						const created = api.createTimeline({ from: state.activeTimelineId });
						if (created) toast(`Switched to ${created.name}`);
					},
				},
				{
					label: "Rename Timeline…",
					action: () =>
						api.askFor({
							title: "Rename timeline",
							label: "Timeline name",
							initialValue: api.timeline.name,
							onConfirm: (name) => api.renameTimeline(state.activeTimelineId, name),
						}),
				},
				{
					label: "Delete Timeline",
					disabled: state.timelines.length <= 1,
					action: () => api.removeTimeline(state.activeTimelineId),
				},
			],
		},
		{
			label: "Help",
			items: [
				{
					label: "Keyboard Shortcuts",
					shortcut: "?",
					action: () =>
						toast(
							"V pointer · C razor · T trim · Space play · ⌘K split · ` maximize panel",
						),
				},
				{
					label: "Agent Tools (MCP)",
					action: () =>
						toast(
							state.agentConnected
								? "An MCP client is connected on 127.0.0.1:19790."
								: "MCP server listens on 127.0.0.1:19790. No client is connected.",
						),
				},
				{ separator: true, label: "" },
				{
					label: "About Rendr",
					action: () =>
						toast(
							"Rendr — record and edit in one app. AGPL-3.0, built on Recordly and Palmier Pro.",
						),
				},
			],
		},
	];

	return (
		<div className="pmr-menubar" ref={barRef}>
			{menus.map((menu) => (
				<div key={menu.label} className="pmr-menubar__slot">
					<button
						type="button"
						className="pmr-menubar__trigger"
						data-open={open === menu.label}
						aria-haspopup="menu"
						aria-expanded={open === menu.label}
						onClick={() => setOpen(open === menu.label ? null : menu.label)}
						// Once one menu is open, hovering the others switches between them.
						onPointerEnter={() => open && setOpen(menu.label)}
					>
						{menu.label}
					</button>

					{open === menu.label ? (
						<div className="pmr-menu" role="menu">
							{menu.items.map((item, index) =>
								item.separator ? (
									<div className="pmr-menu__sep" key={`sep-${index}`} />
								) : (
									<button
										key={item.label}
										type="button"
										role="menuitem"
										className="pmr-menu__item"
										disabled={item.disabled}
										onClick={() => {
											item.action?.();
											close();
										}}
									>
										<span
											style={{
												width: 10,
												color: "var(--pmr-accent)",
												fontSize: 11,
												flex: "0 0 10px",
											}}
										>
											{item.checked ? "✓" : ""}
										</span>
										<span className="pmr-menu__label">{item.label}</span>
										{item.shortcut ? (
											<span className="pmr-menu__shortcut">
												{item.shortcut}
											</span>
										) : null}
									</button>
								),
							)}
						</div>
					) : null}
				</div>
			))}

			{open ? (
				// Click-outside only — Escape closes the menu from the window handler,
				// so this must not enter the tab order.
				<div className="pmr-menu__scrim" onClick={close} aria-hidden="true" />
			) : null}
		</div>
	);
}
