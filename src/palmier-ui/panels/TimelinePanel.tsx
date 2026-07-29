// The timeline panel, assembled exactly as Palmier Pro's timelineHC:
//   TimelineTabBar
//   ToolbarView (38px, hairline bottom border)
//   HStack { TimelineContainerView, AudioMeterView }
//
// The toolbar's buttons are live: undo/redo drive the shared history, the razor
// splits at the playhead, and the zoom button adds a region on the clip under
// the playhead using Recordly's depth scale.

import { useCallback, useRef, useState } from "react";
import { ClipWaveform } from "../ClipWaveform";
import { voiceIsStale } from "../comments";
import { Slider } from "../controls";
import {
	AddAudioTrackIcon,
	AddVideoTrackIcon,
	CaretDownIcon,
	CaretUpIcon,
	CloseIcon,
	FilmIcon,
	ImportIcon,
	PointerIcon,
	RazorIcon,
	RedoIcon,
	SoloIcon,
	SplitIcon,
	TrimIcon,
	UndoIcon,
	ZoomInIcon,
	ZoomOutIcon,
	ZoomRegionIcon,
} from "../icons";
import {
	addTrack,
	addZoomRegion,
	removeTrack,
	renameTrack,
	reorderTrack,
	setTrackFlag,
	splitAt,
	toggleSolo,
	trimSelectionToPlayhead,
} from "../reducers";
import { clipSourceMsToFrame, type EditorApi, formatTimecode, frameToClipSourceMs } from "../state";
import { Layout, TrackColor } from "../theme";
import { useAudioPlayback } from "../useAudioPlayback";
import { TRIM_HANDLE_PX, useTimelineDrag } from "../useTimelineDrag";
import { cursorFocusAt, scaleForDepth } from "../zoom";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;
const BASE_PX_PER_FRAME = 1.6;
const NEW_ZOOM_DURATION_MS = 2400;

export function TimelinePanel({
	api,
	onImportClick,
}: {
	api: EditorApi;
	onImportClick: () => void;
}) {
	const { state, patch, timeline, totalFrames, commit, undo, redo, canUndo, canRedo, toast } =
		api;
	const laneRef = useRef<HTMLDivElement>(null);
	const [dropping, setDropping] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const pxPerFrame = BASE_PX_PER_FRAME * state.zoomScale;

	/** Asks for a note's text, then pins it. */
	const askForNote = useCallback(
		(frame: number, trackId?: string) => {
			api.askFor({
				title: trackId ? "Note on this track" : "Note",
				label: `At ${formatTimecode(frame, timeline.fps)}`,
				initialValue: "",
				confirmLabel: "Pin",
				onConfirm: (text) => api.addComment({ frame, text, trackId }),
			});
		},
		[api, timeline.fps],
	);

	// The drag layer needs live geometry, read at gesture time rather than
	// captured, so a timeline zoom mid-drag doesn't desync the pointer.
	const geometry = useCallback(() => {
		const lane = laneRef.current;
		const rect = lane?.getBoundingClientRect();
		return {
			pxPerFrame,
			originX: (rect?.left ?? 0) - (lane?.scrollLeft ?? 0) + Layout.trackHeaderWidth,
			fps: timeline.fps,
		};
	}, [pxPerFrame, timeline.fps]);

	const { drag, marquee, displayed, beginClipDrag, beginZoomDrag, beginMarquee } =
		useTimelineDrag(api, geometry);
	// The meter reads the real output, not an animation of one.
	const outputLevel = useAudioPlayback(api);
	const contentWidth = Math.max(totalFrames * pxPerFrame + 160, 400);

	const setZoom = (next: number) => {
		patch({ zoomScale: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) });
	};

	// Both the ruler and the track lanes sit inside the scroll container but start
	// after the sticky track headers, so frame 0 is trackHeaderWidth in.
	const frameAt = (clientX: number): number | null => {
		const lane = laneRef.current;
		if (!lane) return null;
		const rect = lane.getBoundingClientRect();
		const x = clientX - rect.left + lane.scrollLeft - Layout.trackHeaderWidth;
		return Math.max(0, Math.min(Math.round(x / pxPerFrame), totalFrames));
	};

	const scrubTo = (event: React.PointerEvent<HTMLDivElement>) => {
		const frame = frameAt(event.clientX);
		if (frame !== null) patch({ playhead: frame });
	};

	/** The clip under the playhead that can host a zoom (a screen recording). */
	const zoomTarget = timeline.tracks
		.filter((track) => track.kind === "video")
		.flatMap((track) => track.clips)
		.find(
			(clip) =>
				clip.mediaType === "video" &&
				state.playhead >= clip.startFrame &&
				state.playhead < clip.endFrame,
		);

	/**
	 * Adds a zoom centred on a timeline frame.
	 *
	 * The zoom track is addressed in timeline frames, but a region is stored in
	 * the *source* milliseconds of the clip it belongs to — so the clip under
	 * that frame is what decides where the region actually lands.
	 */
	const addZoomAtFrame = (frame: number) => {
		const host = timeline.tracks
			.filter((track) => track.kind === "video")
			.flatMap((track) => track.clips)
			.find(
				(clip) =>
					clip.mediaType === "video" && frame >= clip.startFrame && frame < clip.endFrame,
			);
		if (!host) {
			toast(
				"Zooms attach to a screen recording — put one under the playhead first.",
				"error",
			);
			return;
		}

		const atMs = frameToClipSourceMs(host, frame, timeline.fps);
		const limitMs = ((host.endFrame - host.startFrame) * host.speed * 1000) / timeline.fps;

		// Start the region where the cursor was, so a punch-in lands on the work
		// even before the follow takes over.
		const focus = cursorFocusAt(state.cursorTelemetry, atMs) ?? undefined;

		let refusal: string | null = null;
		let addedId: string | null = null;
		commit("Add zoom", (current) => {
			const result = addZoomRegion(
				current,
				host.id,
				atMs,
				NEW_ZOOM_DURATION_MS,
				limitMs,
				focus,
			);
			if (!result.ok) {
				refusal = result.reason;
				return current;
			}
			addedId = result.regionId ?? null;
			return result.timeline;
		});
		if (refusal) {
			toast(refusal, "error");
			return;
		}
		patch({ selectedClipIds: [host.id], selectedZoomRegionId: addedId });
	};

	const addZoomHere = () => addZoomAtFrame(state.playhead);

	/**
	 * Every zoom region on the timeline, converted to timeline frames.
	 *
	 * Regions live in each clip's source milliseconds, so the lane can only draw
	 * them once they are mapped back through that clip's trim and speed.
	 */
	const zoomRows = displayed.tracks
		.filter((track) => track.kind === "video")
		.flatMap((track) => track.clips)
		.flatMap((clip) =>
			(clip.zoomRegions ?? []).map((region) => ({
				clip,
				region,
				startFrame: clipSourceMsToFrame(clip, region.startMs, timeline.fps),
				endFrame: clipSourceMsToFrame(clip, region.endMs, timeline.fps),
			})),
		)
		.sort((a, b) => a.startFrame - b.startFrame);

	const splitHere = () => {
		commit("Split at playhead", (current) => splitAt(current, state.playhead));
	};

	// One tick per second, thinning out as the timeline zooms out.
	const secondsPerTick = pxPerFrame * timeline.fps < 46 ? 5 : 1;
	const tickCount = Math.ceil(totalFrames / timeline.fps / secondsPerTick) + 1;

	return (
		<>
			{/* TimelineTabBar */}
			<div className="pmr-timeline-tabs">
				{state.timelines.map((entry) => (
					<button
						key={entry.id}
						type="button"
						className="pmr-timeline-tab"
						data-active={entry.id === state.activeTimelineId}
						onClick={() => patch({ activeTimelineId: entry.id })}
					>
						{entry.name}
					</button>
				))}
				<span style={{ marginLeft: "auto", fontSize: 10, color: "var(--pmr-text-muted)" }}>
					{state.lastAction ?? `${timeline.tracks.length} tracks`}
				</span>
			</div>

			{/* ToolbarView */}
			<div className="pmr-toolbar">
				<div className="pmr-toolbar__group">
					<button
						type="button"
						className="pmr-btn"
						title="Undo (⌘Z)"
						disabled={!canUndo}
						onClick={undo}
					>
						<UndoIcon />
					</button>
					<button
						type="button"
						className="pmr-btn"
						title="Redo (⇧⌘Z)"
						disabled={!canRedo}
						onClick={redo}
					>
						<RedoIcon />
					</button>
				</div>

				<span className="pmr-toolbar-divider" />

				<div className="pmr-toolbar__group">
					<button
						type="button"
						className="pmr-btn"
						data-active={state.toolMode === "pointer"}
						onClick={() => patch({ toolMode: "pointer" })}
						title="Pointer (V)"
					>
						<PointerIcon />
					</button>
					<button
						type="button"
						className="pmr-btn"
						data-active={state.toolMode === "razor"}
						onClick={() => patch({ toolMode: "razor" })}
						title="Razor (C) — click a clip to split it"
					>
						<RazorIcon />
					</button>
					<button
						type="button"
						className="pmr-btn"
						data-active={state.toolMode === "trim"}
						onClick={() => patch({ toolMode: "trim" })}
						title="Trim (T)"
					>
						<TrimIcon />
					</button>
				</div>

				<span className="pmr-toolbar-divider" />

				<div className="pmr-toolbar__group">
					<button
						type="button"
						className="pmr-btn"
						title="Split at Playhead (⌘K)"
						onClick={splitHere}
					>
						<SplitIcon />
					</button>
					<button
						type="button"
						className="pmr-btn pmr-btn--glyph"
						title="Trim Start to Playhead (Q)"
						disabled={state.selectedClipIds.length === 0}
						onClick={() =>
							commit("Trim start to playhead", (current) =>
								trimSelectionToPlayhead(
									current,
									state.selectedClipIds,
									state.playhead,
									"start",
								),
							)
						}
					>
						[
					</button>
					<button
						type="button"
						className="pmr-btn pmr-btn--glyph"
						title="Trim End to Playhead (W)"
						disabled={state.selectedClipIds.length === 0}
						onClick={() =>
							commit("Trim end to playhead", (current) =>
								trimSelectionToPlayhead(
									current,
									state.selectedClipIds,
									state.playhead,
									"end",
								),
							)
						}
					>
						]
					</button>
				</div>

				<span className="pmr-toolbar-divider" />

				<div className="pmr-toolbar__group">
					<button
						type="button"
						className="pmr-btn pmr-btn--serif"
						title="Add Text at playhead"
						onClick={api.addTextAtPlayhead}
					>
						T
					</button>
					<button
						type="button"
						className="pmr-btn"
						title="Add zoom region at playhead"
						disabled={!zoomTarget}
						onClick={addZoomHere}
					>
						<ZoomRegionIcon size={14} />
					</button>
				</div>

				<span className="pmr-toolbar-divider" />

				<div className="pmr-toolbar__group">
					<button
						type="button"
						className="pmr-btn"
						title="Add video track"
						onClick={() => commit("Add video track", (t) => addTrack(t, "video"))}
					>
						<AddVideoTrackIcon />
					</button>
					<button
						type="button"
						className="pmr-btn"
						title="Add audio track"
						onClick={() => commit("Add audio track", (t) => addTrack(t, "audio"))}
					>
						<AddAudioTrackIcon />
					</button>
				</div>

				<span style={{ flex: 1 }} />

				<div className="pmr-toolbar__group" style={{ gap: 4 }}>
					<button
						type="button"
						className="pmr-btn"
						title="Zoom Out"
						disabled={state.zoomScale <= ZOOM_MIN}
						onClick={() => setZoom(state.zoomScale / ZOOM_STEP)}
					>
						<ZoomOutIcon />
					</button>
					{/* Log-mapped so slider travel is uniform per zoom factor. */}
					<Slider
						className="pmr-zoom-slider"
						min={Math.log(ZOOM_MIN)}
						max={Math.log(ZOOM_MAX)}
						step={0.01}
						value={Math.log(state.zoomScale)}
						origin={0}
						ariaLabel="Timeline zoom"
						onChange={(next) => setZoom(Math.exp(next))}
					/>
					<button
						type="button"
						className="pmr-btn"
						title="Zoom In"
						disabled={state.zoomScale >= ZOOM_MAX}
						onClick={() => setZoom(state.zoomScale * ZOOM_STEP)}
					>
						<ZoomInIcon />
					</button>
				</div>
			</div>

			{/* TimelineContainerView + AudioMeterView */}
			<div className="pmr-timeline">
				<div className="pmr-timeline__body">
					<div
						className="pmr-tracks"
						ref={laneRef}
						data-dropping={dropping || undefined}
						onDragOver={(event) => {
							if (!event.dataTransfer.types.includes("application/x-rendr-asset"))
								return;
							event.preventDefault();
							event.dataTransfer.dropEffect = "copy";
							setDropping(true);
						}}
						onDragLeave={() => setDropping(false)}
						onDrop={(event) => {
							const assetId = event.dataTransfer.getData("application/x-rendr-asset");
							if (!assetId) return;
							event.preventDefault();
							setDropping(false);
							api.placeAsset(assetId, frameAt(event.clientX) ?? 0);
						}}
					>
						{totalFrames === 0 ? (
							<div className="pmr-blank" style={{ minHeight: 132 }}>
								<span className="pmr-blank__icon">
									<FilmIcon size={24} />
								</span>
								<span className="pmr-blank__title">Empty timeline</span>
								<span className="pmr-blank__body">
									Drag media from the library onto a track, or double-click an
									item to drop it at the playhead.
								</span>
								<div className="pmr-blank__actions">
									<button
										type="button"
										className="pmr-action"
										onClick={onImportClick}
									>
										<ImportIcon size={12} />
										Import files
									</button>
								</div>
							</div>
						) : null}
						<div
							style={{
								width: contentWidth,
								position: "relative",
								minWidth: "100%",
								display: totalFrames === 0 ? "none" : undefined,
							}}
						>
							{/* Ruler */}
							<div
								className="pmr-ruler"
								style={{ position: "sticky", top: 0, zIndex: 2 }}
								onPointerDown={scrubTo}
							>
								<div className="pmr-ruler__lane">
									{Array.from({ length: tickCount }, (_, index) => {
										const seconds = index * secondsPerTick;
										return (
											<span
												key={seconds}
												className="pmr-ruler__tick"
												style={{
													left: seconds * timeline.fps * pxPerFrame,
												}}
											>
												{seconds}s
											</span>
										);
									})}
								</div>
							</div>

							{/* Zoom track — Recordly's punch-ins get their own lane rather
							    than hiding as a stripe inside the footage. Clicking empty
							    space here adds a region at that point. */}
							<div className="pmr-track pmr-track--zoom" style={{ height: 30 }}>
								<div className="pmr-track__header">
									<span
										className="pmr-track__kind"
										style={{ background: "var(--pmr-timecode)" }}
									/>
									<span className="pmr-track__name" style={{ cursor: "default" }}>
										Zoom
									</span>
									<button
										type="button"
										className="pmr-track__tool"
										title="Add a zoom at the playhead"
										aria-label="Add a zoom at the playhead"
										onClick={() => addZoomHere()}
									>
										+
									</button>
								</div>

								<button
									type="button"
									className="pmr-track__lane pmr-zoomtrack"
									title="Click to add a zoom here"
									aria-label="Zoom track — click to add a zoom"
									onDoubleClick={(event) => {
										const rect = event.currentTarget.getBoundingClientRect();
										addZoomAtFrame(
											Math.max(0, (event.clientX - rect.left) / pxPerFrame),
										);
									}}
									onClick={(event) => {
										// A click on empty track adds; a click on a
										// region selects it and stops here.
										if (event.target !== event.currentTarget) return;
										const rect = event.currentTarget.getBoundingClientRect();
										addZoomAtFrame(
											Math.max(0, (event.clientX - rect.left) / pxPerFrame),
										);
									}}
								>
									{zoomRows.map(({ clip, region, startFrame, endFrame }) => (
										<span
											key={region.id}
											className="pmr-zoomblock"
											data-active={
												state.selectedZoomRegionId === region.id ||
												undefined
											}
											style={{
												left: startFrame * pxPerFrame,
												width: Math.max(
													(endFrame - startFrame) * pxPerFrame,
													6,
												),
											}}
											title={`Zoom ${scaleForDepth(region.depth).toFixed(1)}× · ${region.mode}`}
											onPointerDown={(event) => {
												event.stopPropagation();
												patch({
													selectedClipIds: [clip.id],
													selectedZoomRegionId: region.id,
												});
												beginZoomDrag(
													event,
													clip.id,
													region.id,
													"zoom-move",
												);
											}}
										>
											<span
												className="pmr-zoomblock__edge pmr-zoomblock__edge--l"
												onPointerDown={(event) => {
													event.stopPropagation();
													beginZoomDrag(
														event,
														clip.id,
														region.id,
														"zoom-start",
													);
												}}
											/>
											<span className="pmr-zoomblock__label">
												{scaleForDepth(region.depth).toFixed(1)}×
											</span>
											<span
												className="pmr-zoomblock__edge pmr-zoomblock__edge--r"
												onPointerDown={(event) => {
													event.stopPropagation();
													beginZoomDrag(
														event,
														clip.id,
														region.id,
														"zoom-end",
													);
												}}
											/>
										</span>
									))}
									{zoomRows.length === 0 ? (
										<span className="pmr-zoomtrack__hint">
											Click to add a zoom
										</span>
									) : null}
								</button>
							</div>

							{/* Notes. Their own lane, above the media: a comment pinned
							    to a frame is not a clip — it has no picture, cannot be
							    trimmed, and must never change what renders — so it is
							    kept out of the tracks entirely. Double-click empty
							    space to pin one where you clicked. */}
							<div className="pmr-track pmr-track--notes" style={{ height: 26 }}>
								<div className="pmr-track__header">
									<span
										className="pmr-track__kind"
										style={{ background: "var(--pmr-note)" }}
									/>
									<span className="pmr-track__name" style={{ cursor: "default" }}>
										Notes
									</span>
									<button
										type="button"
										className="pmr-track__tool"
										title="Pin a note at the playhead"
										aria-label="Pin a note at the playhead"
										onClick={() => askForNote(Math.round(state.playhead))}
									>
										+
									</button>
								</div>

								<button
									type="button"
									className="pmr-track__lane pmr-notetrack"
									title="Double-click to pin a note here"
									aria-label="Notes track — double-click to pin a note"
									onDoubleClick={(event) => {
										if (event.target !== event.currentTarget) return;
										const rect = event.currentTarget.getBoundingClientRect();
										askForNote(
											Math.max(
												0,
												Math.round(
													(event.clientX - rect.left) / pxPerFrame,
												),
											),
										);
									}}
								>
									{state.comments.map((comment) => (
										<span
											key={comment.id}
											className="pmr-note"
											data-resolved={comment.resolved || undefined}
											data-stale={voiceIsStale(comment) || undefined}
											data-voiced={Boolean(comment.voice) || undefined}
											style={{
												left: comment.frame * pxPerFrame,
												width:
													comment.durationFrames > 0
														? Math.max(
																comment.durationFrames * pxPerFrame,
																10,
															)
														: undefined,
											}}
											title={`${comment.text}${
												comment.voice
													? voiceIsStale(comment)
														? " — voiced, but the text changed since"
														: " — voiced"
													: ""
											}\nClick to edit · ⌥-click to ${comment.resolved ? "reopen" : "resolve"} · ⌘-click to delete`}
											onPointerDown={(event) => {
												event.stopPropagation();
												if (event.metaKey || event.ctrlKey) {
													api.removeComment(comment.id);
													return;
												}
												if (event.altKey) {
													api.updateComment(comment.id, {
														resolved: !comment.resolved,
													});
													return;
												}
												patch({ playhead: comment.frame });
												api.askFor({
													title: "Edit note",
													label: "Note",
													initialValue: comment.text,
													confirmLabel: "Save",
													onConfirm: (text) =>
														api.updateComment(comment.id, { text }),
												});
											}}
										>
											{comment.text}
										</span>
									))}
								</button>
							</div>

							{displayed.tracks.map((track) => (
								<div
									className="pmr-track"
									key={track.id}
									style={{ height: Layout.trackHeight }}
								>
									<div className="pmr-track__header">
										<span
											className="pmr-track__kind"
											style={{
												background:
													track.kind === "video"
														? TrackColor.video
														: TrackColor.audio,
											}}
										/>
										{renaming === track.id ? (
											<input
												className="pmr-track__rename"
												defaultValue={track.name}
												autoFocus
												onBlur={(event) => {
													commit("Rename track", (t) =>
														renameTrack(
															t,
															track.id,
															event.target.value,
														),
													);
													setRenaming(null);
												}}
												onKeyDown={(event) => {
													if (event.key === "Enter")
														event.currentTarget.blur();
													if (event.key === "Escape") setRenaming(null);
												}}
											/>
										) : (
											<button
												type="button"
												className="pmr-track__name"
												title="Double-click, or press Enter, to rename"
												// Same reason as the asset name: a
												// double-click has no keyboard path.
												onKeyDown={(event) => {
													if (
														event.key === "Enter" ||
														event.key === "F2"
													) {
														event.preventDefault();
														setRenaming(track.id);
													}
												}}
												onDoubleClick={() => setRenaming(track.id)}
											>
												{track.name}
											</button>
										)}

										<div className="pmr-track__tools">
											<button
												type="button"
												className="pmr-track__tool"
												title="Move track up"
												onClick={() =>
													commit("Reorder track", (t) =>
														reorderTrack(t, track.id, -1),
													)
												}
											>
												<CaretUpIcon />
											</button>
											<button
												type="button"
												className="pmr-track__tool"
												title="Move track down"
												onClick={() =>
													commit("Reorder track", (t) =>
														reorderTrack(t, track.id, 1),
													)
												}
											>
												<CaretDownIcon />
											</button>
											{track.kind === "audio" ? (
												<button
													type="button"
													className="pmr-track__tool"
													data-on={track.solo}
													title={track.solo ? "Unsolo" : "Solo"}
													onClick={() =>
														commit("Toggle solo", (t) =>
															toggleSolo(t, track.id),
														)
													}
												>
													<SoloIcon />
												</button>
											) : null}
											<button
												type="button"
												className="pmr-track__tool"
												data-on={
													track.kind === "audio"
														? track.muted
														: track.hidden
												}
												title={
													track.kind === "audio"
														? track.muted
															? "Unmute"
															: "Mute"
														: track.hidden
															? "Show"
															: "Hide"
												}
												onClick={() =>
													commit(
														track.kind === "audio"
															? "Toggle mute"
															: "Toggle visibility",
														(t) =>
															track.kind === "audio"
																? setTrackFlag(
																		t,
																		track.id,
																		"muted",
																		!track.muted,
																	)
																: setTrackFlag(
																		t,
																		track.id,
																		"hidden",
																		!track.hidden,
																	),
													)
												}
											>
												{track.kind === "audio"
													? track.muted
														? "M"
														: "\u266a"
													: track.hidden
														? "H"
														: "\u25c9"}
											</button>
											<button
												type="button"
												className="pmr-track__tool"
												title="Remove track"
												onClick={() =>
													commit("Remove track", (t) =>
														removeTrack(t, track.id),
													)
												}
											>
												<CloseIcon size={9} />
											</button>
										</div>
									</div>

									<div
										className="pmr-track__lane"
										data-track-id={track.id}
										onPointerDown={(event) => {
											// An empty-lane press scrubs, or draws a marquee once it moves.
											scrubTo(event);
											beginMarquee(event);
										}}
									>
										{track.clips.map((clip) => {
											const left = clip.startFrame * pxPerFrame;
											const width =
												(clip.endFrame - clip.startFrame) * pxPerFrame;
											const selected = state.selectedClipIds.includes(
												clip.id,
											);
											const dimmed =
												(track.kind === "audio" && track.muted) ||
												(track.kind === "video" && track.hidden);
											const asset = state.assets.find(
												(entry) => entry.id === clip.assetId,
											);
											return (
												<div
													key={clip.id}
													className="pmr-clip"
													data-clip-id={clip.id}
													data-selected={selected}
													data-offline={asset?.offline || undefined}
													style={{
														left,
														width: Math.max(width, 4),
														background:
															TrackColor[clip.mediaType] ??
															TrackColor.video,
														opacity: dimmed ? 0.4 : 1,
													}}
													onPointerDown={(event) => {
														if (state.toolMode === "razor") {
															event.stopPropagation();
															const frame = frameAt(event.clientX);
															if (frame !== null) {
																patch({ playhead: frame });
																commit("Split clip", (t) =>
																	splitAt(t, frame),
																);
															}
															return;
														}
														// Edges trim; the body moves.
														const rect =
															event.currentTarget.getBoundingClientRect();
														const fromLeft = event.clientX - rect.left;
														const fromRight =
															rect.right - event.clientX;
														const kind =
															width > TRIM_HANDLE_PX * 3 &&
															fromLeft <= TRIM_HANDLE_PX
																? "trim-start"
																: width > TRIM_HANDLE_PX * 3 &&
																		fromRight <= TRIM_HANDLE_PX
																	? "trim-end"
																	: "move";
														beginClipDrag(event, clip.id, kind);
													}}
													title={
														asset?.offline
															? `${clip.name} — media offline, import the file to relink`
															: clip.name
													}
												>
													{clip.mediaType === "audio" && width > 8 ? (
														<ClipWaveform
															clip={clip}
															asset={asset}
															width={width}
															height={Layout.trackHeight - 8}
															fps={timeline.fps}
														/>
													) : null}
													{width > 32 ? (
														<span className="pmr-clip__label">
															{clip.name}
														</span>
													) : null}
													{width > TRIM_HANDLE_PX * 3 ? (
														<>
															<span className="pmr-clip__handle pmr-clip__handle--l" />
															<span className="pmr-clip__handle pmr-clip__handle--r" />
														</>
													) : null}
													{/* Zoom regions are drawn in the Zoom track above, not
													    as a stripe inside the footage — a stripe can't be
													    clicked when the clip is short, and drawing both
													    put the same region on screen twice. */}
												</div>
											);
										})}
									</div>
								</div>
							))}

							{/* Rubber-band selection, drawn in viewport space while dragging. */}
							{marquee ? (
								<div
									className="pmr-marquee"
									style={{
										position: "fixed",
										left: Math.min(marquee.x1, marquee.x2),
										top: Math.min(marquee.y1, marquee.y2),
										width: Math.abs(marquee.x2 - marquee.x1),
										height: Math.abs(marquee.y2 - marquee.y1),
									}}
								/>
							) : null}

							{/* Snap indicator, drawn only while a drag is locked to a boundary. */}
							{drag?.snappedTo != null ? (
								<div
									className="pmr-snapline"
									style={{ left: drag.snappedTo * pxPerFrame }}
								/>
							) : null}

							<div
								className="pmr-playhead"
								style={{ left: state.playhead * pxPerFrame }}
							/>
						</div>
					</div>
				</div>

				{/* AudioMeterView */}
				<div className="pmr-meter" title={`Output ${Math.round(outputLevel * 100)}%`}>
					{["L", "R"].map((channel) => (
						<div className="pmr-meter__bar" key={channel}>
							<span
								className="pmr-meter__fill"
								style={{ height: `${Math.max(2, outputLevel * 100)}%` }}
							/>
						</div>
					))}
				</div>
			</div>
		</>
	);
}
