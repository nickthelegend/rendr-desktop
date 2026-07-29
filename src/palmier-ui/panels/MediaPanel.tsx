// MediaPanelView — a vertical tab rail (Media / Captions / Audio) beside the
// tab's content.
//
// The whole panel is a drop target. A new project has no media, so the empty
// state is not a picture of emptiness: it is the three real ways to get media
// in — drop a file, record the screen, or ask the agent.

import { useCallback, useRef, useState } from "react";
import { captionGroups } from "../captions";
import {
	CameraIcon,
	CaptionsIcon,
	FolderIcon,
	ImportIcon,
	PointerIcon,
	RecordIcon,
	SparkleIcon,
	TrashIcon,
	WaveformIcon,
} from "../icons";
import { formatDuration, SUPPORTED_SUMMARY } from "../media";
import { PanelHeader } from "../Panel";
import { setClipContent } from "../reducers";
import { type EditorApi, formatTimecode } from "../state";
import { BackgroundSection, CursorSection, WebcamSection } from "./InspectorPanel";

type PanelTab = "media" | "captions" | "audio" | "background" | "cursor" | "camera";

const TABS: Array<{ id: PanelTab; label: string; icon: React.ReactNode }> = [
	{ id: "media", label: "Media", icon: <FolderIcon /> },
	{ id: "captions", label: "Captions", icon: <CaptionsIcon /> },
	{ id: "audio", label: "Audio", icon: <WaveformIcon /> },
	// The take-wide settings. They also live in the inspector when nothing is
	// selected, but that is a hard place to find them — these are the first
	// things you reach for after a recording, so they get their own tabs.
	{ id: "background", label: "Background", icon: <SparkleIcon size={18} /> },
	{ id: "cursor", label: "Cursor", icon: <PointerIcon /> },
	{ id: "camera", label: "Camera", icon: <CameraIcon /> },
];

/** A real frame from the asset, not a glyph standing in for one. */
function AssetThumb({ url, type }: { url: string; type: string }) {
	if (type === "image") {
		return <img src={url} alt="" loading="lazy" />;
	}
	if (type === "video") {
		// preload=metadata paints the poster frame without fetching the whole file.
		return <video src={url} preload="metadata" muted playsInline />;
	}
	return (
		<span style={{ color: "var(--pmr-text-muted)" }}>
			<WaveformIcon size={20} />
		</span>
	);
}

export function MediaPanel({ api, onRecordClick }: { api: EditorApi; onRecordClick: () => void }) {
	const [tab, setTab] = useState<PanelTab>("media");
	const [dragging, setDragging] = useState(false);
	const [query, setQuery] = useState("");
	const [renaming, setRenaming] = useState<string | null>(null);
	const subtitleInput = useRef<HTMLInputElement>(null);
	const dragDepth = useRef(0);
	const fileInput = useRef<HTMLInputElement>(null);
	const { state, patch, importMedia, removeAsset, placeAsset } = api;
	// Folders exist only as the paths assets carry, so "which folder am I in"
	// is view state, not project state.
	const [folder, setFolder] = useState("");

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			dragDepth.current = 0;
			setDragging(false);
			const files = Array.from(event.dataTransfer.files);
			if (files.length > 0) void importMedia(files);
		},
		[importMedia],
	);

	// dragenter/dragleave fire for every child, so depth-count instead of
	// toggling — otherwise the ring flickers as the pointer crosses elements.
	const onDragEnter = useCallback((event: React.DragEvent) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		dragDepth.current += 1;
		setDragging(true);
	}, []);

	const onDragLeave = useCallback(() => {
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDragging(false);
	}, []);

	const pickFiles = useCallback(() => fileInput.current?.click(), []);

	// Filtering is a plain substring match on the name; the library is small
	// enough that anything cleverer would be harder to predict.
	const needle = query.trim().toLowerCase();
	// A search looks through the whole library; browsing shows one folder.
	const visible = needle
		? state.assets.filter((asset) => asset.name.toLowerCase().includes(needle))
		: state.assets.filter((asset) => (asset.folder ?? "") === folder);

	const prefix = folder ? `${folder}/` : "";
	const subfolders = needle
		? []
		: [
				...new Set(
					state.assets
						.filter((asset) => asset.folder?.startsWith(prefix))
						.map((asset) => (asset.folder as string).slice(prefix.length).split("/")[0])
						.filter(Boolean),
				),
			].sort();
	const crumbs = folder ? folder.split("/") : [];

	const groups = captionGroups(api.timeline);
	// Captions attach to whatever clip carries the speech: the first audio clip,
	// or a video clip when audio came in with it.
	const hostClipId =
		api.timeline.tracks
			.flatMap((track) => track.clips)
			.find((clip) => clip.mediaType === "audio" || clip.mediaType === "video")?.id ?? null;
	const transcribing = state.transcribing;

	const audioTracks = api.timeline.tracks.filter((track) => track.kind === "audio");
	const hasAudioClips = audioTracks.some((track) => track.clips.length > 0);

	return (
		<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
			<div className="pmr-rail">
				{TABS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						className="pmr-rail__btn"
						data-active={tab === entry.id}
						onClick={() => setTab(entry.id)}
						title={entry.label}
						aria-label={entry.label}
					>
						{entry.icon}
					</button>
				))}
			</div>

			<div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
				<PanelHeader title={TABS.find((entry) => entry.id === tab)?.label ?? "Media"}>
					{tab === "media" ? (
						<>
							{state.assets.length > 0 ? (
								<input
									className="pmr-search"
									placeholder="Filter…"
									value={query}
									aria-label="Filter media"
									onChange={(event) => setQuery(event.target.value)}
								/>
							) : null}
							<button
								type="button"
								className="pmr-btn"
								onClick={pickFiles}
								title="Import media"
								aria-label="Import media"
							>
								<ImportIcon size={13} />
							</button>
						</>
					) : null}
				</PanelHeader>

				{tab === "media" ? (
					<div
						className="pmr-drop"
						onDrop={onDrop}
						onDragOver={(event) => event.preventDefault()}
						onDragEnter={onDragEnter}
						onDragLeave={onDragLeave}
					>
						<input
							ref={fileInput}
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

						{dragging ? (
							<div className="pmr-drop__ring">
								<ImportIcon size={16} />
								Drop to import
							</div>
						) : null}

						{visible.length === 0 && query.trim() ? (
							<div className="pmr-blank">
								<span className="pmr-blank__title">No matches</span>
								<span className="pmr-blank__body">
									Nothing in the library matches “{query.trim()}”.
								</span>
							</div>
						) : state.assets.length === 0 ? (
							<div className="pmr-blank">
								<span className="pmr-blank__icon">
									<FolderIcon size={26} />
								</span>
								<span className="pmr-blank__title">No media yet</span>
								<span className="pmr-blank__body">
									Drop files here, record your screen, or ask the agent to bring
									something in.
								</span>
								<div className="pmr-blank__actions">
									<button
										type="button"
										className="pmr-action pmr-action--primary"
										onClick={pickFiles}
									>
										<ImportIcon size={12} />
										Import files
									</button>
									<button
										type="button"
										className="pmr-action pmr-action--record"
										onClick={onRecordClick}
									>
										<RecordIcon size={11} />
										Record screen
									</button>
									<button
										type="button"
										className="pmr-action"
										onClick={() =>
											patch({
												agentPanelVisible: true,
												focusedPanel: "agent",
											})
										}
									>
										<SparkleIcon size={12} />
										Ask the agent
									</button>
								</div>
								<span
									style={{
										fontSize: 10,
										color: "var(--pmr-text-muted)",
										marginTop: 2,
									}}
								>
									{SUPPORTED_SUMMARY}
								</span>
							</div>
						) : (
							<div className="pmr-scroll">
								{needle ? null : (
									<div className="pmr-crumbs">
										<button
											type="button"
											className="pmr-crumb"
											data-active={folder === ""}
											onClick={() => setFolder("")}
										>
											Library
										</button>
										{crumbs.map((name, index) => {
											const path = crumbs.slice(0, index + 1).join("/");
											return (
												<span key={path} className="pmr-crumb__wrap">
													<span className="pmr-crumb__sep">/</span>
													<button
														type="button"
														className="pmr-crumb"
														data-active={path === folder}
														onClick={() => setFolder(path)}
													>
														{name}
													</button>
												</span>
											);
										})}
										<span style={{ flex: 1 }} />
										<button
											type="button"
											className="pmr-btn"
											style={{ fontSize: 10 }}
											disabled={!state.selectedAssetId}
											title={
												state.selectedAssetId
													? "Create a folder here and move the selected item into it"
													: "Select an item first — a folder exists only once something is filed in it"
											}
											onClick={() => {
												const selected = state.selectedAssetId;
												if (!selected) return;
												api.askFor({
													title: "New folder",
													label: "Folder name",
													initialValue: "",
													confirmLabel: "Create",
													onConfirm: (name) =>
														api.moveAssets(
															[selected],
															folder ? `${folder}/${name}` : name,
														),
												});
											}}
										>
											New folder…
										</button>
									</div>
								)}
								<div className="pmr-media-grid">
									{subfolders.map((name) => {
										const path = prefix + name;
										return (
											<button
												key={path}
												type="button"
												className="pmr-folder"
												onDoubleClick={() => setFolder(path)}
												onClick={() => setFolder(path)}
												title={`Open ${name}`}
												onDragOver={(event) => {
													if (
														event.dataTransfer.types.includes(
															"application/x-rendr-asset",
														)
													) {
														event.preventDefault();
														event.dataTransfer.dropEffect = "move";
													}
												}}
												onDrop={(event) => {
													const assetId = event.dataTransfer.getData(
														"application/x-rendr-asset",
													);
													if (!assetId) return;
													event.preventDefault();
													api.moveAssets([assetId], path);
												}}
											>
												<FolderIcon size={20} />
												<span className="pmr-folder__name">{name}</span>
											</button>
										);
									})}
									{visible.map((asset) => (
										<div
											key={asset.id}
											className="pmr-asset"
											data-selected={state.selectedAssetId === asset.id}
										>
											<button
												type="button"
												className="pmr-asset__thumb"
												onClick={() => patch({ selectedAssetId: asset.id })}
												onDoubleClick={() =>
													placeAsset(asset.id, state.playhead)
												}
												title={`${asset.name} — double-click to add at the playhead`}
												draggable
												onDragStart={(event) => {
													event.dataTransfer.setData(
														"application/x-rendr-asset",
														asset.id,
													);
													event.dataTransfer.effectAllowed = "copy";
												}}
											>
												<AssetThumb url={asset.url} type={asset.type} />
												{asset.hasCursorTelemetry ? (
													<span
														className="pmr-asset__badge"
														title="Has cursor telemetry"
													>
														cursor
													</span>
												) : null}
												{asset.isWebcam ? (
													<span
														className="pmr-asset__badge"
														title="The camera recorded alongside a screen take. It is composited as the inset — you don't need to place it on the timeline."
													>
														camera
													</span>
												) : null}
											</button>
											{renaming === asset.id ? (
												<input
													className="pmr-asset__rename"
													defaultValue={asset.name}
													autoFocus
													onBlur={(event) => {
														api.renameAsset(
															asset.id,
															event.target.value,
														);
														setRenaming(null);
													}}
													onKeyDown={(event) => {
														if (event.key === "Enter")
															event.currentTarget.blur();
														if (event.key === "Escape")
															setRenaming(null);
													}}
												/>
											) : (
												<button
													type="button"
													className="pmr-asset__name"
													title={`${asset.name} — double-click, or press Enter, to rename`}
													onDoubleClick={() => setRenaming(asset.id)}
													// Double-click is a mouse gesture with no keyboard
													// equivalent, so the same button renames on Enter
													// or F2 — otherwise renaming is unreachable without
													// a pointer.
													onKeyDown={(event) => {
														if (
															event.key === "Enter" ||
															event.key === "F2"
														) {
															event.preventDefault();
															setRenaming(asset.id);
														}
													}}
												>
													{asset.name}
												</button>
											)}
											<span className="pmr-asset__meta">
												{formatDuration(asset.durationSeconds)}
												{asset.width > 0
													? ` · ${asset.width}×${asset.height}`
													: ""}
											</span>
											<button
												type="button"
												className="pmr-asset__remove"
												title="Remove from library"
												aria-label={`Remove ${asset.name}`}
												onClick={() => removeAsset(asset.id)}
											>
												<TrashIcon size={11} />
											</button>
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				) : null}

				{tab === "captions" ? (
					<>
						<input
							ref={subtitleInput}
							type="file"
							accept=".srt,.vtt,text/vtt,text/plain"
							style={{ display: "none" }}
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (file) {
									void file
										.text()
										.then((text) => api.importSubtitles(text, hostClipId));
								}
								event.target.value = "";
							}}
						/>

						{groups.length === 0 ? (
							<div className="pmr-blank">
								<span className="pmr-blank__icon">
									<CaptionsIcon size={24} />
								</span>
								<span className="pmr-blank__title">No captions</span>
								<span className="pmr-blank__body">
									Transcribe the timeline's speech, or bring in subtitles you
									already have.
								</span>
								<div className="pmr-blank__actions">
									<button
										type="button"
										className="pmr-action pmr-action--primary"
										disabled={!hostClipId || transcribing}
										onClick={() =>
											hostClipId && void api.transcribe(hostClipId)
										}
									>
										<SparkleIcon size={12} />
										{transcribing ? "Transcribing…" : "Transcribe speech"}
									</button>
									<button
										type="button"
										className="pmr-action"
										onClick={() => subtitleInput.current?.click()}
									>
										<ImportIcon size={12} />
										Import .srt / .vtt
									</button>
								</div>
								{hostClipId ? null : (
									<span style={{ fontSize: 10, color: "var(--pmr-text-muted)" }}>
										Put a clip with audio on the timeline first.
									</span>
								)}
							</div>
						) : (
							<div className="pmr-scroll">
								{groups.map((groupId) => {
									const cues = api.timeline.tracks
										.flatMap((track) => track.clips)
										.filter((clip) => clip.captionGroupId === groupId)
										.sort((a, b) => a.startFrame - b.startFrame);
									return (
										<div key={groupId}>
											<div className="pmr-cuegroup">
												<span>{cues.length} cues</span>
												<button
													type="button"
													className="pmr-btn"
													style={{ width: 18, height: 18 }}
													title="Export as .srt"
													onClick={() => api.exportSubtitles(groupId)}
												>
													<ImportIcon size={11} />
												</button>
												<button
													type="button"
													className="pmr-btn"
													style={{ width: 18, height: 18 }}
													title="Remove these captions"
													onClick={() => api.dropCaptions(groupId)}
												>
													<TrashIcon size={11} />
												</button>
											</div>
											{cues.map((cue) => (
												<div
													key={cue.id}
													className="pmr-cue"
													data-active={
														state.playhead >= cue.startFrame &&
														state.playhead < cue.endFrame
													}
												>
													<button
														type="button"
														className="pmr-cue__time"
														title="Jump to this cue"
														onClick={() =>
															patch({ playhead: cue.startFrame })
														}
													>
														{formatTimecode(
															cue.startFrame,
															api.timeline.fps,
														)}
													</button>
													<span
														className="pmr-cue__text"
														role="textbox"
														tabIndex={0}
														aria-label="Caption text"
														contentEditable
														suppressContentEditableWarning
														onBlur={(event) => {
															const text =
																event.currentTarget.textContent ??
																"";
															if (text !== cue.content) {
																api.commit("Edit caption", (t) =>
																	setClipContent(
																		t,
																		[cue.id],
																		text,
																	),
																);
															}
														}}
													>
														{cue.content}
													</span>
												</div>
											))}
										</div>
									);
								})}
							</div>
						)}
					</>
				) : null}

				{/* The take-wide settings, the same components the inspector shows
				    when nothing is selected — one implementation, so the two
				    places can never drift apart. */}
				{tab === "background" ? (
					<div className="pmr-scroll">
						<BackgroundSection api={api} />
					</div>
				) : null}

				{tab === "cursor" ? (
					<div className="pmr-scroll">
						<CursorSection api={api} />
					</div>
				) : null}

				{tab === "camera" ? (
					<div className="pmr-scroll">
						<WebcamSection api={api} />
					</div>
				) : null}

				{tab === "audio" ? (
					hasAudioClips ? (
						<div className="pmr-scroll">
							<div
								style={{
									padding: 10,
									display: "flex",
									flexDirection: "column",
									gap: 8,
								}}
							>
								{audioTracks.map((track) => (
									<div key={track.id} className="pmr-audiorow">
										<div className="pmr-audiorow__head">
											<WaveformIcon size={13} />
											{track.name}
											<span
												style={{
													marginLeft: "auto",
													color: "var(--pmr-text-muted)",
												}}
											>
												{track.clips.length} clip
												{track.clips.length === 1 ? "" : "s"}
											</span>
										</div>
										{track.clips.map((clip) => (
											<div key={clip.id} className="pmr-audiorow__clip">
												<span className="pmr-audiorow__name">
													{clip.name}
												</span>
												<span className="pmr-audiorow__db">
													{clip.volumeDb === 0
														? "0 dB"
														: `${clip.volumeDb.toFixed(1)} dB`}
												</span>
											</div>
										))}
									</div>
								))}
							</div>
						</div>
					) : (
						<div className="pmr-blank">
							<span className="pmr-blank__icon">
								<WaveformIcon size={24} />
							</span>
							<span className="pmr-blank__title">No audio on the timeline</span>
							<span className="pmr-blank__body">
								Audio clips and their levels appear here once something is placed.
							</span>
						</div>
					)
				) : null}
			</div>
		</div>
	);
}
