// Tool surface ported from Palmier Pro (GPL-3.0),
// Sources/PalmierPro/Agent/Tools/ToolDefinitions.swift.
// Tool names, JSON Schemas, and descriptions are transcribed near-verbatim; the product
// name is Rendr and the recording/zoom tools at the bottom are Rendr's own. See NOTICE.md.

export type JsonSchema = Record<string, unknown>;

export interface AgentTool {
	name: string;
	description: string;
	inputSchema: JsonSchema;
}

function object(properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
	const schema: JsonSchema = { type: "object" };
	if (Object.keys(properties).length > 0) schema.properties = properties;
	if (required.length > 0) schema.required = required;
	return schema;
}

const VOLUME_FLOOR_DB = -60;
const VOLUME_CEILING_DB = 15;

export const BLEND_MODES = [
	"normal",
	"darken",
	"multiply",
	"colorBurn",
	"lighten",
	"screen",
	"colorDodge",
	"overlay",
	"softLight",
	"hardLight",
	"difference",
	"exclusion",
	"hue",
	"saturation",
	"color",
	"luminosity",
] as const;

export const VIDEO_LAYOUTS = [
	"full",
	"side_by_side",
	"top_bottom",
	"pip_bottom_right",
	"pip_bottom_left",
	"pip_top_right",
	"pip_top_left",
	"grid_2x2",
	"grid_3x3",
	"grid_4x4",
	"main_sidebar",
	"three_up",
] as const;

export const TEXT_ANIMATIONS = [
	"off",
	"fade",
	"slide_up",
	"pop",
	"typewriter",
	"word_by_word",
	"karaoke",
	"bounce",
] as const;

function textBoxTransformProperties(): Record<string, JsonSchema> {
	return {
		centerX: { type: "number", description: "0-1 horizontal center." },
		centerY: { type: "number", description: "0-1 vertical center." },
		width: { type: "number", description: "0-1 width." },
		height: { type: "number", description: "0-1 height." },
		rotation: { type: "number", description: "Clockwise degrees." },
	};
}

const TEXT_STYLE_SCHEMA: JsonSchema = {
	type: "object",
	description: "Partial text-style patch. Omit properties to keep defaults or existing values.",
	properties: {
		fontName: { type: "string", description: "Font PostScript name." },
		fontSize: {
			type: "number",
			minimum: 12,
			maximum: 300,
			description: "Font size in canvas points.",
		},
		widthScale: {
			type: "number",
			minimum: 0.5,
			maximum: 2,
			description: "Glyph width multiplier. 1 preserves the font's original width.",
		},
		heightScale: {
			type: "number",
			minimum: 0.5,
			maximum: 2,
			description: "Glyph height multiplier. 1 preserves the font's original height.",
		},
		bold: { type: "boolean", description: "Bold font trait." },
		italic: { type: "boolean", description: "Italic font trait." },
		underline: { type: "boolean", description: "Draw a line below the text." },
		strikethrough: { type: "boolean", description: "Draw a line through the text." },
		overline: { type: "boolean", description: "Draw a line above the text." },
		tracking: {
			type: "number",
			minimum: -20,
			maximum: 100,
			description: "Spacing between characters in canvas points.",
		},
		lineSpacing: {
			type: "number",
			minimum: -100,
			maximum: 300,
			description: "Additional spacing between lines in canvas points.",
		},
		fontCase: {
			type: "string",
			enum: ["mixed", "uppercase", "lowercase"],
			description: "Non-destructive display casing.",
		},
		alignment: {
			type: "string",
			enum: ["left", "center", "right"],
			description: "Text alignment.",
		},
		color: { type: "string", description: "Text color as #RGB, #RRGGBB, or #RRGGBBAA." },
		outline: {
			type: "object",
			properties: {
				enabled: { type: "boolean" },
				color: { type: "string", description: "Outline color hex." },
				width: {
					type: "number",
					minimum: 0,
					maximum: 40,
					description: "Width in canvas points.",
				},
			},
		},
		shadow: {
			type: "object",
			properties: {
				enabled: { type: "boolean" },
				color: {
					type: "string",
					description: "Shadow color hex. Six-digit colors preserve the current opacity.",
				},
				opacity: { type: "number", minimum: 0, maximum: 1 },
				offset: {
					type: "object",
					properties: {
						x: { type: "number", minimum: -200, maximum: 200 },
						y: { type: "number", minimum: -200, maximum: 200 },
					},
				},
				blur: {
					type: "number",
					minimum: 0,
					maximum: 100,
					description: "Blur radius in canvas points.",
				},
			},
		},
		background: {
			type: "object",
			properties: {
				enabled: { type: "boolean" },
				color: {
					type: "string",
					description:
						"Background color hex. Six-digit colors preserve the current opacity.",
				},
				opacity: { type: "number", minimum: 0, maximum: 1 },
				padding: {
					type: "object",
					properties: {
						x: { type: "number", minimum: 0, maximum: 300 },
						y: { type: "number", minimum: 0, maximum: 300 },
					},
				},
				center: {
					type: "object",
					properties: {
						x: { type: "number", minimum: -500, maximum: 500 },
						y: { type: "number", minimum: -500, maximum: 500 },
					},
				},
				cornerRadius: {
					type: "number",
					minimum: 0,
					maximum: 300,
					description: "Corner radius in canvas points.",
				},
				outline: {
					type: "object",
					properties: {
						color: { type: "string", description: "Background outline color hex." },
						width: {
							type: "number",
							minimum: 0,
							maximum: 40,
							description: "Background outline width in canvas points.",
						},
					},
				},
			},
		},
	},
};

/** Editing tools, transcribed from Palmier Pro. */
export const EDITING_TOOLS: AgentTool[] = [
	{
		name: "get_timeline",
		description:
			"Always call at the start of a session. Returns project settings (fps, resolution, totalFrames, durationSeconds), tracks with a stable trackId, their current index (what every trackIndex parameter takes), type, and clips. Clip ids are accepted by clip mutation tools; trackId is accepted by manage_tracks.\n\nEvery clip occupies frames: [start, end) — timeline frames, end exclusive, duration = end − start. gaps on a track lists its empty [start, end) spans; no gaps key means contiguous. A video clip's linked audio partner is folded into it as audio: {id, track, …} carrying only what deviates (volumeDb, effects, differing trims); the partner is not repeated on its own track, which instead reports linkedClips (its folded count). Address the audio side by its nested id.\n\nFields equal to their defaults are omitted: mediaType 'video', sourceClipType = mediaType, speed 1, volumeDb 0, opacity 1, edgeRounding 0, edgeSoftness 0, trims/fades 0, identity transform/crop, default textStyle, track muted/hidden false. Text clips never report trims. Keyframe tracks that animate nothing are shown as what they are: identity tracks are dropped, constant ones appear as the static field (e.g. crop: {left: 0.31}). A graded clip carries `color` — its grade in apply_color's own vocabulary, pasteable to other clips via apply_color's color parameter. Other effects appear as effects: [{type, params}], the exact shape apply_effect accepts.\n\nA screen-recording clip additionally carries zoomRegions: [{id, startMs, endMs, depth, focus, mode}] in SOURCE milliseconds — see add_zoom_regions. Clips with no zooms omit the key.\n\nCaption clips (sharing a captionGroupId) come back per track as captionGroups summaries: clipCount, frameRange, shared style, and a textPreview — individual caption clips and their ids are NOT listed. That summary is all you need to restyle (update_text with captionGroupId) or judge coverage; the spoken words live in get_transcript. Only when you must touch individual caption clips (retime one, delete one, fix one word's style), re-read with captionDetail:true — ideally windowed — to get [clipId, startFrame, endFrame, text] rows, capped at 200 per group. Caption clips whose properties deviate from the group always appear individually in clips.",
		inputSchema: object({
			startFrame: {
				type: "integer",
				description:
					"Optional. Window start (inclusive); only clips intersecting [startFrame, endFrame) are returned. Tracks report totalClips when the window hides some.",
			},
			endFrame: { type: "integer", description: "Optional. Window end (exclusive)." },
			captionDetail: {
				type: "boolean",
				description:
					"Optional. true expands captionGroups into per-clip [clipId, startFrame, endFrame, text] rows. Combine with a window; only needed to edit individual caption clips.",
			},
		}),
	},
	{
		name: "inspect_timeline",
		description:
			"See the composited timeline — what the user actually sees in the preview at a given frame: all video tracks stacked with their transforms, opacity, crop, edge softness, edge rounding, zoom regions, and keyframes applied, plus text and caption overlays baked in. Use this to verify your edits landed (a zoom's framing, a PIP's position, a title's placement, layer order) — inspect_media shows the raw source asset, not the cut.\n\nFrames are project frames (from get_timeline). Pass a single startFrame for one composited frame; add endFrame to sample maxFrames evenly across [startFrame, endFrame) for a transition or sequence. Frames past content render black. Each image carries its frame number burned into the top-left (f157), and the metadata lists, per rendered frame, the clip ids visible on screen top-down (caption clips as their captionGroupId) — so what you see maps straight back to the clips to edit.",
		inputSchema: object({
			startFrame: {
				type: "integer",
				description:
					"Project frame to render (default 0). With no endFrame, a single frame is returned.",
			},
			endFrame: {
				type: "integer",
				description:
					"Optional. Sample maxFrames evenly across [startFrame, endFrame) instead of one frame.",
			},
			maxFrames: {
				type: "integer",
				description: "Frames to sample when endFrame is set (default 6, max 12).",
			},
		}),
	},
	{
		name: "create_timeline",
		description:
			"Creates a timeline and switches to it — every read and edit tool now targets it. Without 'from', the new timeline is empty and inherits fps/resolution from the previously active one. With 'from', it's a full copy of that timeline — the versioning primitive: copy, then edit the copy (\"a tighter cut\", \"a 9:16 version\") while the original stays intact; every clip and track id in the copy is NEW, so re-read get_timeline before editing. Undoable.\n\nUse timelines to organize a project: alternate versions, sections assembled separately, or reusable groups. A timeline can be placed inside another as a single clip (add_clips with the timelineId as mediaRef); it then appears as a clip with mediaType 'sequence'.",
		inputSchema: object({
			name: {
				type: "string",
				description:
					"Optional display name. Defaults to 'Timeline N', or '<source> copy' when duplicating.",
			},
			from: {
				type: "string",
				description: "Optional timelineId to duplicate instead of creating empty.",
			},
		}),
	},
	{
		name: "set_active_timeline",
		description:
			"Switches the active timeline — the one every read and edit tool targets and the one the user sees. get_media lists the project's timelines (with timelineId). Always re-read get_timeline after switching; clip and track ids from the previous timeline are no longer valid targets.\n\nTo edit the contents of a nested timeline (a clip with mediaType 'sequence'), switch to its mediaRef.",
		inputSchema: object(
			{
				timelineId: {
					type: "string",
					description:
						"Timeline id from get_media's timelines list (or a sequence clip's mediaRef).",
				},
			},
			["timelineId"],
		),
	},
	{
		name: "set_project_settings",
		description:
			"Change the project's frame rate, resolution, or aspect ratio. Pass any combination of fps, explicit width+height, aspectRatio, and quality. aspectRatio and explicit width/height are mutually exclusive; quality scales the current aspect ratio (or the selected preset when combined with aspectRatio). The timeline's existing clips are re-fitted automatically: auto-fit transforms recalculate for the new canvas size, and all frame positions/durations rescale when fps changes. Undoable.",
		inputSchema: object({
			fps: {
				type: "integer",
				description:
					"Frame rate in frames per second. Common values: 24, 25, 30, 48, 50, 60.",
			},
			width: {
				type: "integer",
				description:
					"Canvas width in pixels. Use with height for an exact resolution. Mutually exclusive with aspectRatio.",
			},
			height: {
				type: "integer",
				description:
					"Canvas height in pixels. Use with width for an exact resolution. Mutually exclusive with aspectRatio.",
			},
			aspectRatio: {
				type: "string",
				enum: ["16:9", "9:16", "1:1", "4:3", "2.4:1", "9:14"],
				description:
					"Preset aspect ratio — sets both width and height from the preset, or combined with quality to pick a specific size. Mutually exclusive with width/height.",
			},
			quality: {
				type: "string",
				enum: ["720p", "1080p", "2K", "4K"],
				description:
					"Resolution quality preset — scales the short edge to the target while preserving the current (or specified) aspect ratio.",
			},
		}),
	},
	{
		name: "export_project",
		description:
			"Queues an export from the current project using the same modes as the Export dialog. mode defaults to video. video renders H.264, H.265, or ProRes; xml writes XMEML timeline XML; fcpxml writes FCPXML; rendr writes a self-contained .rendr project package. For timeline interchange, pick the format by the target editor: Premiere Pro -> xml; DaVinci Resolve or Final Cut Pro -> fcpxml (fcpxml also carries text, transforms, crop, opacity, and keyframes that xml cannot). Video exports render zoom regions, edge softness, and edge rounding; Rendr project exports preserve them; xml/fcpxml interchange omits them. Omit outputPath to write a unique file to ~/Downloads. Existing direct outputPath files are overwritten by default to match the UI save flow; pass overwrite=false to refuse. Every mode returns status=started or status=queued with a jobId and destination path. Use manage_exports to check progress, warnings/results, or cancel by jobId.",
		inputSchema: object({
			mode: {
				type: "string",
				enum: ["video", "xml", "fcpxml", "rendr"],
				description:
					"Optional. Default video. Use xml for Premiere Pro, fcpxml for DaVinci Resolve or Final Cut Pro.",
			},
			codec: {
				type: "string",
				enum: ["H.264", "H.265", "ProRes"],
				description: "Video mode only. Optional. Default H.264.",
			},
			resolution: {
				type: "string",
				enum: ["720p", "1080p", "2K", "4K", "Match Timeline"],
				description: "Video mode only. Optional. Default Match Timeline.",
			},
			outputPath: {
				type: "string",
				description:
					"Optional. Absolute destination path. If omitted, a unique project-named file is written to ~/Downloads. If no extension is provided, the mode's extension is appended.",
			},
			overwrite: {
				type: "boolean",
				description:
					"Optional. Default true, matching the UI save flow. false refuses when outputPath already exists.",
			},
			fcpxmlTarget: {
				type: "string",
				enum: ["resolve", "fcp"],
				description:
					"fcpxml mode only. Optional, default resolve. DaVinci Resolve and Final Cut interpret crop and position values differently; pick the app the file will be imported into.",
			},
			timelineId: {
				type: "string",
				description:
					"Optional. Timeline to export. Defaults to the active timeline. Not valid for rendr mode, which packages every timeline.",
			},
		}),
	},
	{
		name: "manage_exports",
		description:
			"Lists or cancels exports for the current project. action=list returns newest first with jobId, filename, path, status, progress percent, and any warnings/result. action=cancel requires the exact jobId returned by export_project or list; a waiting job is removed from the queue and an active job begins canceling. Cancel only when the user asks, or to undo an export just queued with incorrect settings. Never infer that an export is stuck from elapsed time alone.",
		inputSchema: object(
			{
				action: { type: "string", enum: ["list", "cancel"] },
				jobId: {
					type: "string",
					description:
						"Required for cancel. Exact jobId from export_project or manage_exports list.",
				},
			},
			["action"],
		),
	},
	{
		name: "get_media",
		description:
			"The library inventory: media assets, folders, and timelines. Call before referencing any asset — every mediaRef in other tools comes from the asset ids returned here. Assets report name, type, durationSeconds, width/height/fps, hasAudio, folder path, and for screen recordings, hasCursorTelemetry (whether suggest_zooms can run on them). generationStatus appears only while an async import is unresolved (preparing | downloading | failed) — its absence means the asset is ready.\n\nFilters: ids (poll specific placeholders cheaply), folder (a path; includes subfolders), pending:true (only unresolved imports). Filtered reads return just the matching assets; unfiltered reads also include folders (as paths) and timelines.",
		inputSchema: object({
			ids: {
				type: "array",
				items: { type: "string" },
				description:
					"Optional. Return only these asset ids — the cheap way to poll a pending import.",
			},
			folder: {
				type: "string",
				description:
					"Optional folder path filter, e.g. 'B-roll/Sunset'. Includes subfolders.",
			},
			pending: {
				type: "boolean",
				description:
					"Optional. true returns only assets with an unresolved generationStatus.",
			},
		}),
	},
	{
		name: "inspect_media",
		description:
			"Look at a media asset before referencing or editing it. Images: the image plus dimensions and EXIF. Video: sample frames plus a transcription of the audio track. Audio: transcription. Transcription is sentence-level segments — [text, start, end] tuples, capped at 400 — in source seconds, or project frames when clipId is set. When capped, pass the returned nextStartSeconds as startSeconds for the next page.\n\nLong media: pass overview=true for a one-image storyboard, read the segments, then re-call with startSeconds/endSeconds to zoom — windowed calls only transcribe that span, so they are fast.",
		inputSchema: object(
			{
				mediaRef: { type: "string", description: "Asset ID from get_media." },
				clipId: {
					type: "string",
					description:
						"Optional. A clip referencing this mediaRef; transcript times come back as project frames for that clip (out-of-range entries dropped).",
				},
				maxFrames: {
					type: "integer",
					description: "Video only. Sample frame count (default 6, max 12).",
				},
				startSeconds: {
					type: "number",
					description:
						"Video/audio. Source-time window start; scopes frames and transcription.",
				},
				endSeconds: {
					type: "number",
					description: "Video/audio. Window end (default: asset duration).",
				},
				wordTimestamps: {
					type: "boolean",
					description:
						"Video/audio. Add word-level [text, start, end] tuples (capped at 10000). Use for word-boundary edits like filler-word removal.",
				},
				overview: {
					type: "boolean",
					description:
						"Video only. One storyboard grid of visually distinct, timestamped moments instead of frames — far more coverage per token; few tiles means static footage. maxFrames ignored.",
				},
				language: {
					type: "string",
					description:
						"Optional BCP-47 language tag of the spoken audio (e.g. 'es', 'fr', 'ja', 'zh-Hans'). Defaults to the system language. Specify when the spoken language differs from the system locale — on-device models are language-specific and will produce garbled output if the wrong language is used.",
				},
			},
			["mediaRef"],
		),
	},
	{
		name: "search_media",
		description:
			"Search the media library by content: what's on screen (visual) and what's said (spoken). Visual matching is semantic and on-device — phrase the query like an image caption ('a wide shot of a harbor at sunset'), not keywords; covers videos and stills. Spoken matching layers exact keywords over on-device semantic matching of transcript segments — quote the words said, or paraphrase them. The two groups rank independently and are never blended. Scores are uncalibrated — use them for ordering only.\n\nHits are source-second ranges (image hits have no time range). To place exactly that moment, pass [startSeconds, endSeconds] straight to add_clips as source — no unit conversion.\n\nAn `index` object appears only while it can explain missing results (status: indexing | modelNotInstalled | downloadingModel | preparing | disabled | failed, with indexedAssets vs indexableAssets). When present, moments may be incomplete — report that instead of concluding the footage doesn't exist, and don't poll in a loop.",
		inputSchema: object(
			{
				query: {
					type: "string",
					description:
						"What to find. Visual: a caption-style scene description. Spoken: the words to match.",
				},
				scope: {
					type: "string",
					enum: ["visual", "spoken", "both"],
					description: "Optional. Default both.",
				},
				mediaRef: {
					type: "string",
					description: "Optional. Restrict the search to one asset from get_media.",
				},
				limit: {
					type: "integer",
					description: "Optional. Max hits per group (default 10, max 50).",
				},
			},
			["query"],
		),
	},
	{
		name: "import_media",
		description:
			"Imports external media into the project's library — the bridge for assets coming from other MCP servers (stock libraries, music services, web search) or local files the user already has. The 'source' object must set exactly one of: url (HTTPS only — downloaded in the background, the dominant case; max 1 GB), path (absolute local file path — referenced in place and not copied into the project; may also be a directory, which is imported recursively, mirroring its subfolder structure as media folders), bytes (base64-encoded inline data — max ~15 MB of base64 ≈ 11 MB binary; use url/path for anything larger), or matte (a generated solid-color PNG). For url, type is inferred from the URL path's file extension unless source.mimeType is set as an override (needed for signed URLs whose path has no usable extension). For bytes, source.mimeType is required.\n\nSupported types and extensions: video (mov, mp4, m4v, webm), audio (mp3, wav, aac, m4a, aiff, aifc, caf, flac), image (png, jpg, jpeg, tiff, heic). Anything else is rejected — the caller must transcode externally.\n\nURL imports run in the background and return {mediaRef, status:'downloading'} — poll get_media with ids:[mediaRef] until generationStatus clears, then the asset is usable in add_clips. Path, directory, bytes, and matte imports finish inline with status:'ready'. Costs nothing.",
		inputSchema: object(
			{
				source: {
					type: "object",
					description:
						"Exactly one of url, path, bytes, or matte must be set. mimeType is required when bytes is set; for url it acts as a type-inference override.",
					properties: {
						url: {
							type: "string",
							description:
								"HTTPS URL. Pre-signed URLs are fine but must not expire mid-download.",
						},
						path: {
							type: "string",
							description:
								"Absolute local file or directory path, readable by the Rendr process. Files are referenced in place and must remain available. A directory is imported recursively and its folder structure is replicated as media folders.",
						},
						bytes: {
							type: "string",
							description:
								"Base64-encoded media data. Prefer url or path for anything over ~10MB.",
						},
						matte: {
							type: "object",
							description:
								"Generates a solid-color PNG matte instead of importing a file.",
							properties: {
								hex: {
									type: "string",
									description: "Hex color, e.g. '#000000' or '#FFFFFF'.",
								},
								aspectRatio: {
									type: "string",
									enum: [
										"Project",
										"16:9",
										"9:16",
										"1:1",
										"4:3",
										"9:14",
										"2.4:1",
									],
									description:
										"Defaults to Project (timeline resolution). Other values use the project's short edge.",
								},
							},
							required: ["hex"],
						},
						mimeType: {
							type: "string",
							description:
								"Required when bytes is set. Optional override for url when its path has no usable extension (e.g. signed URLs). Accepted: video/mp4, video/quicktime, video/webm, audio/mpeg, audio/wav, audio/aac, audio/mp4, image/png, image/jpeg, image/tiff, image/heic.",
						},
					},
				},
				name: {
					type: "string",
					description:
						"Display name in the library. Defaults to the filename derived from url/path, or 'Imported asset' for bytes.",
				},
				folder: {
					type: "string",
					description:
						"Optional destination folder path, e.g. 'B-roll/Sunset'. Created if missing. Omit for the project root.",
				},
			},
			["source"],
		),
	},
	{
		name: "capture_frame",
		description:
			"Capture one video frame as a full-resolution PNG media asset. Use timelineFrame to capture the active timeline's final composited image, including transforms, crop, zoom regions, edge softness, edge rounding, color, effects, text, and captions. Use mediaRef with sourceSeconds to capture an unedited frame directly from a source video instead. Pass the asset's durationSeconds as sourceSeconds to capture its final decodable frame. Exactly one mode is allowed. The returned mediaRef is ready for add_clips or inspect_media. Every call creates one new undoable media asset.",
		inputSchema: object({
			timelineFrame: {
				type: "integer",
				description:
					"Project frame in the active timeline. Use this alone for the composited timeline image.",
			},
			mediaRef: {
				type: "string",
				description:
					"Video asset ID from get_media. Use with sourceSeconds for a raw source frame.",
			},
			sourceSeconds: {
				type: "number",
				description:
					"Source time in seconds for mediaRef. May equal durationSeconds to select the final decodable frame.",
			},
			name: {
				type: "string",
				description: "Optional media-library name for the captured PNG.",
			},
		}),
	},
	{
		name: "organize_media",
		description:
			"Reorganizes the library in one undoable action: create folders, move items into folders, rename items, delete items. An item is a media asset id (from get_media), a timelineId, or a folder path like 'B-roll/Sunset' — the tool tells them apart. Folders are always addressed by path, never by id; destination paths are created if missing. Arrays apply in order (createFolders, moves, renames, deletes), but item references resolve against the library as it was before the call — only 'into' destinations may name folders the same call creates.\n\nDeleting an asset also removes every clip referencing it (reported as clipsRemoved). Deleting a folder deletes its subfolders and assets; timelines inside move to the root instead. Deleting a timeline leaves nest clips referencing it rendering black (a warning reports how many); the last remaining timeline can't be deleted. Returns only what actually happened — createdFolders, moved, renamed, deleted, clipsRemoved, warnings.",
		inputSchema: object({
			createFolders: {
				type: "array",
				items: { type: "string" },
				description:
					"Folder paths to ensure exist, e.g. ['Hero shots/Takes']. Existing folders are left alone. Rarely needed — moves create folders on their own.",
			},
			moves: {
				type: "array",
				description: "Each entry files items into one destination folder.",
				items: {
					type: "object",
					properties: {
						items: {
							type: "array",
							items: { type: "string" },
							description: "Asset ids, timeline ids, and/or folder paths to move.",
						},
						into: {
							type: "string",
							description:
								"Destination folder path; created if missing. Omit to move to the project root.",
						},
					},
					required: ["items"],
				},
			},
			renames: {
				type: "array",
				items: {
					type: "object",
					properties: {
						item: {
							type: "string",
							description: "Asset id, timeline id, or folder path.",
						},
						name: {
							type: "string",
							description:
								"New display name (a name, not a path — renaming never moves).",
						},
					},
					required: ["item", "name"],
				},
			},
			deletes: {
				type: "array",
				items: { type: "string" },
				description: "Asset ids, timeline ids, and/or folder paths to delete.",
			},
		}),
	},
	{
		name: "add_clips",
		description:
			"Places one or more media assets on the timeline as a single undoable action. Each entry's asset type must be compatible with its target track (video/image are interchangeable across video/image tracks; audio requires an audio track). When a video asset with audio is placed on a video track, a linked audio clip is automatically created on an audio track (an existing one if available, otherwise a new one). The whole batch is one undo step.\n\ntrackIndex is optional. Omit it on all entries and the tool auto-creates the needed tracks — one shared video track for visual entries (above existing visuals) and one shared audio track for audio entries (appended below existing audio, so linked dialogue on A1 stays put and music/VO land on A2+). To target existing tracks, set trackIndex on every entry. Mixing (some entries specify, others omit) is rejected — split into two calls.\n\nTracks work as layers: clips on the SAME track are sequential — if a new clip's range overlaps an existing clip on that track, the existing clip is trimmed/split/removed to make room, matching the UI's drag-onto-track overwrite behavior.\n\nNESTING: mediaRef may also be a timelineId — the timeline is placed as a single live nested clip (mediaType 'sequence'), with a linked audio clip when the child has audio. Duration defaults to the child's full length; source and endFrame work as for video. Cycles (a timeline containing itself) and empty timelines are rejected.",
		inputSchema: object(
			{
				entries: {
					type: "array",
					description:
						"Clips to add. Each entry is validated up front; one bad entry rejects the whole call with no partial state.",
					items: {
						type: "object",
						properties: {
							mediaRef: {
								type: "string",
								description: "ID of the media asset from get_media",
							},
							trackIndex: {
								type: "integer",
								description:
									"Optional. Track index (0-based). Omit on every entry to auto-create one shared track per asset zone (video/audio).",
							},
							startFrame: {
								type: "integer",
								description:
									"Timeline frame position to place the clip (project frames).",
							},
							endFrame: {
								type: "integer",
								description:
									"Optional. Occupy timeline frames [startFrame, endFrame) — a gap from get_timeline copies straight in. For stills and frame-exact fills. Mutually exclusive with source.",
							},
							source: {
								type: "array",
								items: { type: "number" },
								description:
									"Optional. [startSeconds, endSeconds] — which span of the source to use, in the source seconds search_media hits and inspect_media segments speak. For stills this is the display length in seconds. Omit both for the whole asset. Mutually exclusive with endFrame.",
							},
						},
						required: ["mediaRef", "startFrame"],
					},
				},
			},
			["entries"],
		),
	},
	{
		name: "insert_clips",
		description:
			"Inserts one or more media assets at a single point and RIPPLES: every clip at or after atFrame is pushed right to open a gap, so nothing is overwritten. This is the non-destructive counterpart to add_clips (which clears the landing region, trimming/splitting/removing whatever's there). Use insert_clips to splice footage in without losing existing clips; use add_clips to fill empty space or deliberately overwrite.\n\nEntries are laid end-to-end starting at atFrame on the target track (entry[0] at atFrame, entry[1] immediately after, ...). The push equals the sum of the entries' durations and is applied to the target track, every sync-locked track, AND the audio track any auto-created linked audio lands on — so a clip and its linked audio stay aligned. As in add_clips, a video asset with audio spawns a linked audio clip. One undoable action; one bad entry rejects the whole call with no partial state.\n\ntrackIndex is required — ripple needs an existing track to push. For placement into empty space, use add_clips.\n\nAs in add_clips, mediaRef may be a timelineId to splice in a nested timeline.",
		inputSchema: object(
			{
				trackIndex: {
					type: "integer",
					description:
						"Track index (0-based, from get_timeline) to insert into and ripple.",
				},
				atFrame: {
					type: "integer",
					description:
						"Timeline frame (project frames) where insertion begins. Every clip at or after this frame on rippled tracks shifts right by the total inserted duration.",
				},
				entries: {
					type: "array",
					description:
						"Clips to insert, placed sequentially from atFrame. Validated up front; one bad entry rejects the whole call.",
					items: {
						type: "object",
						properties: {
							mediaRef: {
								type: "string",
								description: "ID of the media asset from get_media.",
							},
							source: {
								type: "array",
								items: { type: "number" },
								description:
									"Optional. [startSeconds, endSeconds] — which span of the source to use, in source seconds; for stills, the display length. Omit for the whole asset. Mutually exclusive with durationFrames.",
							},
							durationFrames: {
								type: "integer",
								description:
									"Optional. Exact length in project frames (entries stack end-to-end, so they have lengths, not positions). Mutually exclusive with source.",
							},
						},
						required: ["mediaRef"],
					},
				},
			},
			["trackIndex", "atFrame", "entries"],
		),
	},
	{
		name: "move_clips",
		description:
			"Moves one or more clips to a new track and/or frame position. Single undoable action. Each move specifies the clip ID and at least one of toTrack (must be compatible with the clip's media type) and toFrame. Overlap on the destination is resolved as in add_clips (existing clips on the destination track are trimmed/split/removed). Linked partners follow the named clip: startFrame propagates as a delta to preserve l-cut / j-cut offsets; tracks stay with the named clip.",
		inputSchema: object(
			{
				moves: {
					type: "array",
					description:
						"Per-clip move requests. At least one of toTrack or toFrame is required per entry.",
					items: {
						type: "object",
						properties: {
							clipId: { type: "string", description: "The clip ID to move." },
							toTrack: {
								type: "integer",
								description:
									"Destination track index (0-based). Omit to keep the clip on its current track.",
							},
							toFrame: {
								type: "integer",
								description:
									"Destination start frame. Omit to keep the clip at its current start.",
							},
						},
						required: ["clipId"],
					},
				},
			},
			["moves"],
		),
	},
	{
		name: "remove_clips",
		description:
			"Removes one or more clips by ID as a single undoable action. Any clip that belongs to a link group (e.g. a video with its paired audio) takes its whole group with it, matching the UI's linked-delete behavior.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					description: "Clip IDs to remove.",
					items: { type: "string" },
				},
			},
			["clipIds"],
		),
	},
	{
		name: "manage_tracks",
		description:
			"Reorders, configures, or removes tracks in one undoable action. Prefer stable trackId selectors; numeric indexes use the order at call time. Index 0 renders on top, and reorder destinations must stay within the track's video/audio zone. Arrays run reorder → set → remove. Returns receipts and the resulting track order.",
		inputSchema: object({
			reorder: {
				type: "array",
				description:
					"Moves, applied in order. Use to fix stacking, e.g. bring a PIP inset's track to index 0.",
				items: {
					type: "object",
					properties: {
						trackId: {
							type: "string",
							description: "Stable track ID from get_timeline.",
						},
						index: {
							type: "integer",
							description: "Track to move (0-based, current order).",
						},
						to: {
							type: "integer",
							description: "Exact destination index in the same type zone.",
						},
					},
					required: ["to"],
				},
			},
			set: {
				type: "array",
				items: {
					type: "object",
					properties: {
						trackId: {
							type: "string",
							description: "Stable track ID from get_timeline.",
						},
						index: {
							type: "integer",
							description: "Track to change (0-based, current order).",
						},
						muted: {
							type: "boolean",
							description: "Silence/unsilence the track's audio.",
						},
						solo: {
							type: "boolean",
							description:
								"true toggles this track's solo. Solo is not the same as muting the others: it is an override, so clearing it restores whatever each track's own mute was and a track muted beforehand stays muted. Omit or pass false to leave it alone.",
						},
						hidden: {
							type: "boolean",
							description: "Exclude/include a video track in the render.",
						},
						syncLocked: {
							type: "boolean",
							description: "Whether ripple edits shift this track along.",
						},
					},
				},
			},
			remove: {
				type: "array",
				description:
					"Tracks to remove with all their clips. Prefer {trackId}; bare integers are legacy current indexes.",
				items: { type: ["integer", "object"], properties: { trackId: { type: "string" } } },
			},
		}),
	},
	{
		name: "split_clips",
		description:
			"Splits clips into two at one or more cut points, all in a single undoable action. A split only inserts a boundary — it never trims media or moves clips, so unlike ripple_delete_ranges nothing shifts and there's no gap to close.\n\nTwo modes — pass exactly one:\n• splits: an array of {clipId, atFrame} (project frames). Use when you know the clip IDs.\n• trackIndex + frames: cut one track at the given project frames; each frame is matched to whichever clip on that track contains it. Pairs naturally with get_transcript / get_timeline project frames.\n\nEvery frame must fall strictly between a clip's start and end. Multiple cuts on the SAME clip are allowed — pass all the frames at once and each is resolved against the current sub-clips. Duplicate cut points are ignored. Linked audio/video partners are split at the same frame so A/V stays in sync, and the right halves are regrouped into their own link pair. One bad cut point rejects the whole call with no partial state.",
		inputSchema: object({
			splits: {
				type: "array",
				description: "Explicit cuts. Each item is {clipId, atFrame}.",
				items: object(
					{
						clipId: { type: "string", description: "The clip ID to split" },
						atFrame: {
							type: "integer",
							description:
								"Project frame to split at (strictly between clip start and end)",
						},
					},
					["clipId", "atFrame"],
				),
			},
			trackIndex: { type: "integer", description: "Track to cut (use with 'frames')" },
			frames: {
				type: "array",
				description:
					"Project frames to cut on trackIndex; each is matched to the clip containing it.",
				items: { type: "integer" },
			},
		}),
	},
	{
		name: "ripple_delete_ranges",
		description:
			"Cuts one or more ranges out and closes the gaps in one undoable action — the fast path for filler-word/dead-air removal. Replaces hand-cranked split_clips → remove_clips → move_clips loops: pass every range at once.\n\nTwo modes — pass exactly one of clipId or trackIndex:\n• trackIndex (preferred for transcript-driven cuts): ranges are PROJECT frames and may span any number of clips on that track. get_transcript returns a clips array with nested words in project frames — collect every cut across the whole timeline and pass them in ONE call, no per-clip splitting and no re-reading the timeline between cuts. units must be 'frames'.\n• clipId: ranges are cut within that single clip only, clamped to its visible span. Allows units 'seconds' (source-media seconds); 'frames' = project frames.\n\nOverlapping ranges merge. Linked audio/video partners of every touched clip are cut on the same span so A/V stays in sync. Remaining clips shift left to close every gap; sync-locked tracks shift along to preserve alignment (their content isn't cut). Refuses without changing anything if a sync-locked track can't absorb the shift (e.g. it would move past frame 0). The refusal names the blocking track (e.g. \"V2\") — map it to its index via get_timeline and pass that index in ignoreSyncLockedTracks to cut anyway. Returns the anchor track's post-cut layout (clip ids/frames) so you don't need to re-read.",
		inputSchema: object(
			{
				trackIndex: {
					type: "integer",
					description:
						"Cut project-frame ranges spanning every clip they cross on this track, in one call. From get_transcript's clips array. Mutually exclusive with clipId; requires units 'frames'.",
				},
				clipId: {
					type: "string",
					description:
						"Cut ranges within this single clip only, clamped to its visible span. Mutually exclusive with trackIndex.",
				},
				ranges: {
					type: "array",
					description:
						"Ranges to remove, each a [start, end] pair (end > start). In the unit given by 'units'.",
					items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
				},
				units: {
					type: "string",
					enum: ["seconds", "frames"],
					description:
						"Interpretation of range values. 'frames' (default) = project/timeline frames, matching get_transcript and inspect_media-with-clipId. 'seconds' = source-media seconds (clipId mode only).",
				},
				ignoreSyncLockedTracks: {
					type: "array",
					items: { type: "integer" },
					description:
						"Track indices to exempt from sync-lock for this call only. Their clips stay put instead of shifting to close the gap.",
				},
			},
			["ranges"],
		),
	},
	{
		name: "set_clip_properties",
		description:
			"Apply the same generic clip property values to one or more clips in a single undoable action. Pass any combination of durationFrames, trimStartFrame, trimEndFrame, speed, volumeDb, opacity, fades, edgeRounding, edgeSoftness, transform, or blendMode (video/image clips only). For text content, typography, captions, and text animation, use update_text. For zoom punch-ins on a screen recording, use add_zoom_regions.\n\nNOT for preview layout — split screen, picture-in-picture, grid, sidebar, and any multi-clip canvas arrangement belong to apply_layout, which sets transform and crop together. Do not use transform here (or set_keyframes position/scale/crop) to build those layouts.\n\nAll values apply to every clip in clipIds; for per-clip differences, make separate calls. trimStartFrame/trimEndFrame are offsets from the source media, not the timeline. speed 1.0 is normal, <1.0 slows (clip gets longer on the timeline), >1.0 speeds up. volumeDb is −60 through +15 dB; 0 dB keeps source level and −60 dB is mute. opacity is 0.0–1.0. fadeInFrames/fadeOutFrames are clip-relative lengths; 0 clears that fade, and their sum must fit within the resulting clip duration. Fades multiply existing opacity or volume keyframes instead of replacing them: visual/text clips fade opacity, while audio clips fade gain. Fades are per-clip and don't propagate to linked media — include both the visual clip id and its nested audio.id from get_timeline to fade picture and sound together. edgeRounding and edgeSoftness are 0.0–1.0, where 1 reaches half the shorter visible edge. transform is for rare single-clip tweaks only — 0–1 normalized canvas coords, partial merge; rotation is clockwise degrees; flipHorizontal/flipVertical mirror across the axis.\n\nFor moves and start-frame changes, use move_clips. For animated values (keyframes), use set_keyframes — setting volumeDb, opacity, or transform.rotation here clears any existing keyframe track on that property.\n\nTiming changes (durationFrames, trimStartFrame, trimEndFrame, speed) on a linked clip carry over to its linked partner so audio/video stay in sync — same as the timeline UI. Per-clip fields (volumeDb, opacity, fades, edgeRounding, edgeSoftness, transform, blendMode) don't propagate. trim and speed are skipped for text partners.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					description:
						"Clip IDs to update. The property values below apply to every clip in this list.",
					items: { type: "string" },
				},
				durationFrames: { type: "integer", description: "New duration in frames." },
				trimStartFrame: {
					type: "integer",
					description:
						"SOURCE-media offset, NOT a timeline frame: frames trimmed off the start of the source — measured in PROJECT frames (the timeline's fps, same units as startFrame/durationFrames; never the source's own fps). To turn a get_transcript project frame P into this clip's source offset, use trimStartFrame + (P − startFrame) × speed; setting trimStartFrame to that value makes the clip begin at P's source content.",
				},
				trimEndFrame: {
					type: "integer",
					description:
						"SOURCE-media offset, NOT a timeline frame: frames trimmed off the end of the source, in PROJECT frames. Maps the same way as trimStartFrame via startFrame/speed.",
				},
				speed: {
					type: "number",
					description:
						"Playback speed multiplier (default 1.0). >1 speeds up, <1 slows down. The clip's timeline length is rescaled to keep the same source content (2x speed → half the frames), unless you also pass durationFrames to set the length explicitly.",
				},
				volumeDb: {
					type: "number",
					minimum: VOLUME_FLOOR_DB,
					maximum: VOLUME_CEILING_DB,
					description:
						"Volume in decibels from −60 through +15. 0 dB keeps source level; −60 dB is mute. Clears existing volume keyframes.",
				},
				opacity: {
					type: "number",
					description: "Opacity 0.0-1.0. Clears any existing opacity keyframes.",
				},
				fadeInFrames: {
					type: "integer",
					minimum: 0,
					description:
						"Fade length from the clip's first frame. 0 clears it. Multiplies existing opacity/volume keyframes.",
				},
				fadeOutFrames: {
					type: "integer",
					minimum: 0,
					description:
						"Fade length ending at the clip's last frame. 0 clears it. fadeInFrames + fadeOutFrames must not exceed the resulting clip duration.",
				},
				fadeInInterpolation: {
					type: "string",
					enum: ["linear", "smooth"],
					description: "Curve for the fade in. Omit to keep the current curve.",
				},
				fadeOutInterpolation: {
					type: "string",
					enum: ["linear", "smooth"],
					description: "Curve for the fade out. Omit to keep the current curve.",
				},
				edgeRounding: {
					type: "number",
					minimum: 0,
					maximum: 1,
					description:
						"Video, image, and nested timeline clips only. Uniform edge rounding from 0 (square) to 1 (half the shorter visible edge).",
				},
				edgeSoftness: {
					type: "number",
					minimum: 0,
					maximum: 1,
					description:
						"Video, image, and nested timeline clips only. Edge feathering from 0 (crisp) to 1 (half the shorter visible edge).",
				},
				transform: {
					type: "object",
					description:
						"Single-clip only — not for split screen, PIP, or grid (use apply_layout). Partial transform; omitted fields keep current values. Static rotation uses clockwise degrees and clears rotation keyframes.",
					properties: {
						centerX: { type: "number" },
						centerY: { type: "number" },
						width: { type: "number" },
						height: { type: "number" },
						rotation: { type: "number", description: "Clockwise degrees." },
						flipHorizontal: {
							type: "boolean",
							description: "Mirror across the vertical axis.",
						},
						flipVertical: {
							type: "boolean",
							description: "Mirror across the horizontal axis.",
						},
					},
				},
				blendMode: {
					type: "string",
					enum: [...BLEND_MODES],
					description:
						"Video/image clips only. How the clip composites over the tracks below it (Premiere/Photoshop blend modes). 'normal' is the default (source-over) and clears any blend. Rejected on text/audio clips.",
				},
			},
			["clipIds"],
		),
	},
	{
		name: "set_keyframes",
		description:
			"Set animated keyframes on one property of one clip. Replaces the existing keyframe track for that property (pass an empty array to clear). Frames are CLIP-RELATIVE offsets (0 = first frame of the clip), so keyframes follow the clip when it moves. Rows are sorted by frame internally and the LAST row for any duplicate frame wins. Values must be finite numbers. Each row is `[frame, ...values, interp?]` where interp ∈ {linear, hold, smooth} (default smooth).\n\nProperties and their value layouts:\n  • volumeDb `[frame, decibels]` — −60 through +15 dB; 0 dB keeps source level and −60 dB is mute\n  • opacity `[frame, value]` — value 0.0–1.0\n  • rotation `[frame, degrees]` — clockwise degrees\n  • position `[frame, topLeftX, topLeftY]` — TOP-LEFT corner in 0–1 normalized canvas coords. NOT the center. (Default static transform centers a full-canvas clip, so top-left of the static is (0, 0); a centered half-size clip has top-left (0.25, 0.25).)\n  • scale `[frame, width, height]` — clip's normalized width and height in 0–1 canvas coords (1.0 = fills the canvas axis). NOT a scale factor.\n  • crop `[frame, top, right, bottom, left]` — side insets in 0–1 of the source media.\n\nMotion keyframes (position/scale/rotation) override the static `transform` value when active. For a punch-in on a screen recording prefer add_zoom_regions — it eases and follows the cursor for you.",
		inputSchema: object(
			{
				clipId: { type: "string", description: "The clip ID." },
				property: {
					type: "string",
					enum: ["volumeDb", "opacity", "rotation", "position", "scale", "crop"],
					description: "Which property's keyframe track to set.",
				},
				keyframes: {
					type: "array",
					description:
						"Replacement keyframe rows. Empty array clears the track. Row shape depends on property — see tool description.",
					items: { type: "array" },
				},
			},
			["clipId", "property", "keyframes"],
		),
	},
	{
		name: "apply_layout",
		description:
			"Arrange multiple clips into a common multi-video layout (split screen, picture-in-picture, grid) in one undoable action — the fast path for composing several videos in one frame. Use this instead of hand-setting transforms and screenshot-checking alignment with inspect_timeline.\n\nYou pick a named layout and assign a clip to each of its slots; the tool computes every transform and crop so each clip FILLS its region edge-to-edge WITHOUT stretching — the source is cropped to the slot's shape (cover), like a layout template the videos are dropped into. Pass fit='fit' to letterbox the whole source inside its slot instead (no crop, may leave bars) — use only when the full frame must stay visible (e.g. a screen recording).\n\nThe crop is centered by default. When that chops off something important (a face cropped at the forehead, a subject off to one side), bias which part survives: 'anchor' is a coarse shortcut ('top' keeps the top, etc.), while anchorX/anchorY (0–1) give continuous control for in-between framing — e.g. anchorY 0.35 moves the crop only slightly toward the top, not all the way. To nudge framing after the fact, call apply_layout again with adjusted anchorX/anchorY (clipIds mode re-crops in place).\n\nTwo modes (don't mix across slots):\n• Place new clips: give each slot a 'mediaRef' (from get_media) plus top-level startFrame (default 0) and endFrame. Creates one stacked video track per slot at that time range; for PIP the inset is placed on top automatically. Video clips bring their linked audio.\n• Re-layout existing clips: give each slot 'clipIds' — one or more existing clips, all framed into that slot (handy when a track holds several sequential takes). Only transforms/crop change — timing and tracks are untouched (so existing track order decides stacking).\n\nEvery slot of the chosen layout must be filled. Layouts and their slot names:\n  • full — main\n  • side_by_side — left, right\n  • top_bottom — top, bottom\n  • pip_bottom_right / pip_bottom_left / pip_top_right / pip_top_left — main, inset\n  • grid_2x2 / grid_3x3 / grid_4x4 — equal cells named rNcN, counting from the TOP-LEFT: row 1 is the top row, column 1 is the left column. So r1c1 is top-left, a 3x3's middle is r2c2, and a 3x3's bottom-right is r3c3\n  • main_sidebar — main (70%), sidebar (30%)\n  • three_up — left, center, right",
		inputSchema: object(
			{
				layout: {
					type: "string",
					enum: [...VIDEO_LAYOUTS],
					description: "Which layout template to apply.",
				},
				slots: {
					type: "array",
					description:
						"One entry per slot of the chosen layout. Each entry names a 'slot' and gives exactly one of 'mediaRef' (place a new clip) or 'clipIds' (re-layout existing clip(s) into that slot). Don't mix placement (mediaRef) with re-layout (clipIds) across slots.",
					items: object(
						{
							slot: {
								type: "string",
								description:
									"Slot name for the chosen layout (e.g. 'left', 'inset', or 'r1c1' for the top-left grid cell).",
							},
							mediaRef: {
								type: "string",
								description:
									"Asset ID from get_media to place into this slot. Use this OR clipIds.",
							},
							clipIds: {
								type: "array",
								items: { type: "string" },
								description:
									"Existing clip(s) to frame into this slot — every listed clip gets this slot's transform/crop. Use this OR mediaRef. Clips sharing a slot may sit on the same track; clips in DIFFERENT slots still must not overlap on one track.",
							},
							anchor: {
								type: "string",
								enum: [
									"center",
									"top",
									"bottom",
									"left",
									"right",
									"top_left",
									"top_right",
									"bottom_left",
									"bottom_right",
								],
								description:
									"Coarse shortcut for which part of the source to keep when cover-cropping (default center). For in-between framing use anchorX/anchorY instead.",
							},
							anchorX: {
								type: "number",
								description:
									"Fine horizontal framing, 0–1: 0 keeps the left edge, 0.5 centers (default), 1 keeps the right. Only affects slots cropped horizontally. Overrides anchor's x.",
							},
							anchorY: {
								type: "number",
								description:
									"Fine vertical framing, 0–1: 0 keeps the top (e.g. a forehead), 0.5 centers (default), 1 keeps the bottom. Nudge by small amounts (e.g. 0.35) to move the crop gradually. Only affects slots cropped vertically. Overrides anchor's y.",
							},
						},
						["slot"],
					),
				},
				startFrame: {
					type: "integer",
					description:
						"Placement mode only (mediaRef slots). Project frame where the layout begins. Default 0.",
				},
				endFrame: {
					type: "integer",
					description:
						"Placement mode only (mediaRef slots). The placed clips occupy [startFrame, endFrame). Required when placing new clips.",
				},
				fit: {
					type: "string",
					enum: ["fill", "fit"],
					description:
						"How each clip fills its slot. 'fill' (default) covers the slot and center-crops the source (no stretch). 'fit' letterboxes the whole source inside the slot.",
				},
			},
			["layout", "slots"],
		),
	},
	{
		name: "sync_clips",
		description:
			"Align one or more clips to a reference clip by shifting targets on the timeline — use for dual-system sound (camera + external audio) or a separately recorded webcam track. Default mode 'auto' aligns by embedded source timecode when both files carry one (exact, confidence 1.0), falling back to audio cross-correlation otherwise (seeded by capture dates when present); force a method with mode. referenceClipId stays put unless a target would land before frame 0, in which case the whole group shifts right together (reported as shiftedFrames). Returns offsetFrames, confidence (0–1), and method (timecode|audio) per target; refuses weak audio matches.",
		inputSchema: object(
			{
				referenceClipId: {
					type: "string",
					description: "Clip the others align to. Stays put.",
				},
				targetClipId: {
					type: "string",
					description: "Single clip to align. Use targetClipIds for several.",
				},
				targetClipIds: {
					type: "array",
					items: { type: "string" },
					description: "Clips to align with the reference.",
				},
				mode: {
					type: "string",
					enum: ["auto", "audio", "timecode"],
					description:
						"auto (default): timecode when available, else audio. audio/timecode force that method.",
				},
				searchWindowSeconds: {
					type: "number",
					description:
						"Optional max ± offset to search in seconds. Omit to search the full feasible overlap.",
				},
				minConfidence: {
					type: "number",
					description: "Minimum audio correlation confidence 0–1 (default 0.5).",
				},
			},
			["referenceClipId"],
		),
	},
	{
		name: "undo",
		description:
			"Reverts the latest action from the editor's shared undo history, whether the user or agent made it. Call only when that latest action should be reversed. For example, verify a cut with get_transcript, then undo if it overshot and retry with corrected ranges. After undoing, ids and frames returned by the reverted action may be invalid; re-read with get_timeline or get_transcript before editing again. Recording is not undoable and is never reverted by this tool. Takes no arguments.",
		inputSchema: object(),
	},
	{
		name: "get_transcript",
		description:
			"Returns the spoken transcript of the CURRENT timeline in project frames — the post-edit caption track in one call. Unlike inspect_media (which transcribes one source asset in isolation, in source seconds), this walks every audio/video clip on the timeline, maps each word through that clip's trim/speed/position, and concatenates in timeline order. Deleted ranges are gone by construction, so after cuts this always reflects what's actually audible — no stale results, no per-clip frame math.\n\nReturns clips in timeline order, each with its words as compact [index, text, startFrame] rows (a word runs to the next word's start; the last word to its clip's end). Speakers, when identified, arrive as run-length turns: speakers = [[firstWordIndex, name], ...]. The index is a stable, global, 0-based position in timeline order; pass it straight to remove_words to cut that word (the intuitive path for text-based editing). Indices stay global even when scoped with clipId or paged with a window. Capped at 10000 words; page with startFrame/endFrame using nextStartFrame.\n\nFor comprehension rather than cutting — summarizing, finding a topic, take selection on long media — pass granularity='segments': sentence rows [firstWordIndex, text, start, end] at a fraction of the tokens, whose firstWordIndex jumps you back into word mode for the cut window.\n\nUse for transcript-driven edits (filler-word / dead-air removal, locating a quote, take selection) and to verify what remains after cutting. To cut, prefer remove_words (give it the indices); drop to ripple_delete_ranges only for non-word-aligned spans.",
		inputSchema: object({
			startFrame: {
				type: "integer",
				description:
					"Optional. Only return words ending after this project frame. Use with the returned nextStartFrame to page a long timeline.",
			},
			endFrame: {
				type: "integer",
				description: "Optional. Only return words starting before this project frame.",
			},
			clipId: {
				type: "string",
				description:
					'Scope the transcript to a single clip — returns only what that clip says, in project frames. Answers "what\'s in clip X?" without scanning the whole timeline.',
			},
			granularity: {
				type: "string",
				enum: ["words", "segments"],
				description:
					"words (default) for cutting with remove_words; segments for cheap sentence-level reading — rows carry firstWordIndex to drill back into words.",
			},
			language: { type: "string", description: "Optional BCP-47 speech language." },
		}),
	},
	{
		name: "remove_words",
		description:
			'Cut speech by the word, Descript-style — the primary tool for text-based editing (filler words, flubbed sentences, dropped retakes, tightening a ramble). Pass words for precise get_transcript indices/ranges, or matches for exact filler tokens like "um" and "uh". This resolves them to frames, removes the surrounding pause so survivors don\'t end up double-spaced, merges adjacent removals, cuts linked A/V partners, and closes the gaps. You never deal in frame numbers — that\'s the whole point versus ripple_delete_ranges.\n\nWorkflow: call get_transcript, read it as prose, then pass the indices of the words to drop. Words across multiple clips on ONE track are handled in a single undoable action, and any linked A/V partner is cut automatically. Edit one track at a time: if your indices span multiple unlinked tracks (e.g. two separate mics), the call is refused — cut each track in its own call, or link the tracks into one unit first. After it runs, indices have shifted — re-read get_transcript before another remove_words.\n\nWhen to use which: words for selective edits after reading the transcript; matches for removing every exact filler token; ripple_delete_ranges only for spans that aren\'t word-aligned. Verify reworded retakes and sub-frame seam fragments against the word list, not a summary.',
		inputSchema: object({
			words: {
				type: "array",
				description:
					"Words to remove, by get_transcript index. Each element is either a single index (e.g. 42) or an inclusive [startIndex, endIndex] span (e.g. [12, 18]). Mutually exclusive with matches. Re-read after any edit.",
				items: { type: ["integer", "array"] },
			},
			matches: {
				type: "array",
				items: { type: "string" },
				description:
					'Exact single-word tokens to remove everywhere, case-insensitive with surrounding punctuation ignored, e.g. ["um", "uh", "hmm"]. Mutually exclusive with words. Avoid broad words like "like" unless the user explicitly wants every occurrence removed.',
			},
			cutAggressiveness: {
				type: "string",
				enum: ["tight", "balanced", "loose"],
				description:
					"How much silence to leave between the words on either side of a cut. 'tight' butts them close (snappy, can feel clipped), 'balanced' (default) keeps a natural beat, 'loose' leaves more breathing room. The removed words' own frames always go regardless.",
			},
			language: {
				type: "string",
				description:
					"Optional BCP-47 speech language for local transcription. Omit to reuse the previous get_transcript language.",
			},
		}),
	},
	{
		name: "remove_silence",
		description:
			"Remove dead air — quiet, speech-free sections — from the timeline's audio, ripple-closing the gaps. Sections come from on-device speech detection (the same spans marked red on waveforms): non-speech runs whose level sits well below the recording's own speech level, so music beds and loud ambience are never cut, and speech-boundary slop keeps the cuts from feeling clipped. Cuts linked A/V partners and honors sync lock; the whole pass is one undoable action.\n\nUse this to tighten pacing (long pauses, dead space between takes) before or instead of word-level edits: remove_silence handles pauses, remove_words handles fillers and flubbed lines. No transcript needed. If it reports no dead air, speech analysis may still be running in the background — wait a moment and retry. Takes no arguments.",
		inputSchema: object(),
	},
	{
		name: "detect_beats",
		description:
			"Detect musical beats and downbeats in a media asset's audio, on-device. Returns beats and downbeats in SOURCE seconds (multiply by fps for frame values, same convention as search_media hits) plus estimated bpm. Downbeats mark bar starts — cut on downbeats for edits that land musically; beats are fine for faster montage rhythms.\n\nUse for beat-synced editing: snapping cuts to a music bed, building montages where clip boundaries hit the beat, or timing text/caption entrances to the bar. To place a cut at a beat B on a clip, the timeline frame is startFrame + (B × fps − trimStartFrame) / speed. Works on music; speech or ambience returns few or no beats. Runs locally.",
		inputSchema: object(
			{
				mediaRef: {
					type: "string",
					description: "Audio or video asset id from get_media.",
				},
				startSeconds: {
					type: "number",
					description:
						"Optional. Return only beats at or after this source-media second. The whole file is analyzed once and cached; windowing trims the response, not the work.",
				},
				endSeconds: {
					type: "number",
					description:
						"Optional. Return only beats at or before this source-media second.",
				},
			},
			["mediaRef"],
		),
	},
	{
		name: "add_texts",
		description:
			"Adds text clips as timeline layers. Omit trackIndex on every entry to create one new top video track; otherwise set trackIndex on every entry. Transform is normalized text-box center/size; center-only auto-fits, all four fields override the box. Use the nested style object for typography, outline, shadow, and background. fillMode 'footage' stencils layers below through the letter shapes. Use add_captions for spoken audio captions. Unknown fields are rejected.",
		inputSchema: object(
			{
				entries: {
					type: "array",
					description: "Text clips to add.",
					items: {
						type: "object",
						properties: {
							trackIndex: {
								type: "integer",
								description:
									"Existing non-audio track. Omit on all entries to create a new top track.",
							},
							startFrame: { type: "integer", description: "Timeline start frame." },
							endFrame: {
								type: "integer",
								description:
									"Occupy timeline frames [startFrame, endFrame) — copy a clip's frames pair to title exactly that span.",
							},
							content: { type: "string", description: "Text. Supports \\n." },
							transform: {
								type: "object",
								description:
									"Text box. Omit for centered auto-fit; rotation alone rotates an auto-fit box; center only auto-fits size; all four override.",
								properties: textBoxTransformProperties(),
							},
							style: TEXT_STYLE_SCHEMA,
							animation: {
								type: "string",
								enum: [...TEXT_ANIMATIONS],
								description: "Animation preset; off clears.",
							},
							highlightColor: { type: "string", description: "Active-word hex." },
							fillMode: {
								type: "string",
								enum: ["color", "footage"],
								description:
									"color = solid typography (default). footage = stencil layers below through the letter shapes.",
							},
						},
						required: ["startFrame", "endFrame", "content"],
					},
				},
			},
			["entries"],
		),
	},
	{
		name: "update_text",
		description:
			"Updates text clips or a captionGroupId. The nested style object is a partial patch: omitted values stay unchanged. Use it for typography, color, outline, shadow, and background. fillMode 'footage' stencils layers below through the glyphs. Content and layout-affecting style changes auto-fit the box unless transform includes box geometry; rotation alone keeps auto-fit. Static rotation uses clockwise degrees and clears rotation keyframes. Unknown fields are rejected.",
		inputSchema: object({
			clipIds: {
				type: "array",
				items: { type: "string" },
				description: "Text clip IDs. Optional if captionGroupId is given.",
			},
			captionGroupId: { type: "string", description: "Caption group id from get_timeline." },
			content: { type: "string", description: "Replacement text. Supports \\n." },
			transform: {
				type: "object",
				description: "Partial text-box transform; omitted fields keep current values.",
				properties: textBoxTransformProperties(),
			},
			style: TEXT_STYLE_SCHEMA,
			animation: {
				type: "string",
				enum: [...TEXT_ANIMATIONS],
				description: "Animation preset; off clears.",
			},
			highlightColor: { type: "string", description: "Active-word hex." },
			fillMode: {
				type: "string",
				enum: ["color", "footage"],
				description:
					"color = solid typography. footage = stencil layers below through the letter shapes.",
			},
		}),
	},
	{
		name: "add_captions",
		description:
			"Transcribes the timeline's spoken audio and creates styled caption text clips on their own track — no targeting needed; it finds the spoken content itself. Per-word animations are timed from the transcript. Returns the caption group summary (captionGroupId, clipCount, frameRange, shared style, textPreview) — restyle it later with update_text and that captionGroupId.",
		inputSchema: object({
			language: { type: "string", description: "BCP-47 speech language." },
			transform: {
				type: "object",
				description: "Caption box position; size is auto-fit per caption.",
				properties: {
					centerX: { type: "number", description: "0-1 horizontal center." },
					centerY: { type: "number", description: "0-1 vertical center." },
				},
			},
			censorProfanity: { type: "boolean", description: "Mask profanity." },
			maxWords: { type: "integer", description: "Max words per caption." },
			style: TEXT_STYLE_SCHEMA,
			animation: {
				type: "string",
				enum: [...TEXT_ANIMATIONS],
				description: "Caption animation preset.",
			},
			highlightColor: { type: "string", description: "Active-word hex." },
		}),
	},
	{
		name: "apply_color",
		description:
			"Author/refine a color grade on video/image clips with named controls — the colorist path, distinct from apply_effect (looks/FX). Returns the clips with their resulting grade as a `color` object — the same object get_timeline shows; pass one back via the `color` parameter to copy a grade between clips (replaces the whole grade). MERGES with the clip's current grade: only the params you pass change, the rest are preserved, so you can nudge one knob at a time (pass reset:true to start from neutral). Applies as live, editable color.* effects; non-color effects untouched. Iterate: apply_color → inspect_color(clipId, reference) → read the gap → adjust → repeat. Undoable. All knobs optional. Color WHEELS use HUE (0–360°, standard) + AMOUNT per tonal zone — to push shadows teal, set shadowsHue 180 and shadowsAmount ~0.15. CURVES (master + per-channel R/G/B) give precise tone shaping — per-channel curves are tone-selective (e.g. pull the blue curve down in the highlights to tame a bright sky). HUE CURVES do secondary/qualified correction — target a source hue and shift its hue/saturation/lightness (e.g. desaturate greens, warm the skin) without a mask; pair with inspect_color's hueHistogram to find which hues are present. LUT applies a .cube film-look pack on top of the grade.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					items: { type: "string" },
					description: "Clip ids from get_timeline.",
				},
				reset: {
					type: "boolean",
					description:
						"Start from neutral instead of merging onto the clip's current grade. Default false.",
				},
				color: {
					type: "object",
					description:
						"A complete grade object as read from a clip's `color` key. Replaces the target clips' grade — the grade-copy path. Mutually exclusive with reset and individual knobs.",
				},
				exposure: {
					type: "number",
					description: "-3…3 EV. Overall brightness in linear light.",
				},
				contrast: { type: "number", description: "0.5…1.5 (1 = neutral)." },
				saturation: { type: "number", description: "0…2 (1 = neutral; <1 mutes)." },
				vibrance: { type: "number", description: "-1…1 (protects skin tones)." },
				temperature: {
					type: "number",
					description:
						"2000…11000 K. HIGHER = WARMER, lower = cooler/bluer (6500 = neutral).",
				},
				tint: {
					type: "number",
					description: "-100…100. Positive = green, negative = magenta.",
				},
				highlights: {
					type: "number",
					description: "-1…1. Recover (<0) or lift (>0) highlights.",
				},
				shadows: { type: "number", description: "-1…1. Lift (>0) or deepen (<0) shadows." },
				blacks: {
					type: "number",
					description:
						"-1…1. Black point. Negative deepens, positive lifts (faded look).",
				},
				whites: { type: "number", description: "-1…1. White point." },
				shadowsHue: {
					type: "number",
					description:
						"Shadow color-push hue 0–360° (0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta). Use with shadowsAmount.",
				},
				shadowsAmount: {
					type: "number",
					description: "0…1 strength of the shadow color push (0 = neutral).",
				},
				shadowsLum: { type: "number", description: "-0.5…0.5 shadow lift (brightness)." },
				midsHue: {
					type: "number",
					description:
						"Midtone color-push hue 0–360° (see shadowsHue). Use with midsAmount.",
				},
				midsAmount: {
					type: "number",
					description: "0…1 strength of the midtone color push.",
				},
				midsGamma: {
					type: "number",
					description: "0.5…2 midtone brightness (gamma; 1 = neutral).",
				},
				highsHue: {
					type: "number",
					description:
						"Highlight color-push hue 0–360° (see shadowsHue). Use with highsAmount.",
				},
				highsAmount: {
					type: "number",
					description: "0…1 strength of the highlight color push.",
				},
				highsGain: {
					type: "number",
					description: "0.5…1.5 highlight brightness (gain; 1 = neutral).",
				},
				masterCurve: {
					type: "array",
					items: { type: "array", items: { type: "number" } },
					description:
						"Luma tone curve as [x,y] control points in 0–1 (input→output), preserves chroma. E.g. [[0,0.06],[1,0.95]] = lifted/faded film toe.",
				},
				redCurve: {
					type: "array",
					items: { type: "array", items: { type: "number" } },
					description: "Red-channel tone curve, [x,y] points 0–1.",
				},
				greenCurve: {
					type: "array",
					items: { type: "array", items: { type: "number" } },
					description: "Green-channel tone curve, [x,y] points 0–1.",
				},
				blueCurve: {
					type: "array",
					items: { type: "array", items: { type: "number" } },
					description:
						"Blue-channel tone curve, [x,y] points 0–1. Tone-selective: e.g. [[0,0],[0.7,0.7],[1,0.85]] pulls blue only in the highlights (tames a sky) and leaves shadows.",
				},
				hueCurves: {
					type: "object",
					description:
						"Secondary/qualified correction (Resolve-style Hue-vs-Hue/Sat/Lum). Targets replace any existing hue curve; pass an empty targets array to clear them. Selectivity is ~±22° around each target hue, with a raised-cosine falloff so the edge of a target's reach doesn't show as a line — and it wraps, so a target on 350° reaches pure red. Overlapping targets compose rather than the last one winning. Out-of-range values are clamped, not refused. A clip carrying hue targets is graded per pixel in the preview and the export alike, which is slower to scrub than a tone curve.",
					properties: {
						targets: {
							type: "array",
							description:
								"One or more source-hue regions to adjust (e.g. skin at 30, sky at 210).",
							items: object(
								{
									targetHue: {
										type: "number",
										description:
											"Source hue to act on, 0–360° (0 red, 30 orange/skin, 60 yellow, 120 green, 180 cyan, 210 sky-blue, 240 blue, 300 magenta).",
									},
									hueShift: {
										type: "number",
										description: "Rotate that hue by -30…30°.",
									},
									satScale: {
										type: "number",
										description:
											"Saturation multiplier for that hue, 0–2 (1 = neutral; 1.3 pops it, 0.6 mutes it, 0 fully desaturates).",
									},
									lumShift: {
										type: "number",
										description: "Lightness shift for that hue, -0.5…0.5.",
									},
								},
								["targetHue"],
							),
						},
					},
				},
				lut: {
					type: "object",
					description:
						"Apply a .cube 3D LUT (e.g. a film-look pack) on top of the primary grade; replaces any prior LUT. The agent does not author LUT data — pass a real file, either by path or as its text. Pass null to remove the LUT. The cube is parsed and stored in the project, so it survives a save without the original file. 3D cubes only, up to LUT_3D_SIZE 64; a 1D LUT is refused (the tone curves are that). Sampling is trilinear, and a clip carrying a LUT is graded per pixel in the preview and the export alike — which is slower to scrub than a tone curve.",
					properties: {
						path: {
							type: "string",
							description:
								"Absolute path to a .cube file, read through Rendr's desktop bridge.",
						},
						cube: {
							type: "string",
							description:
								"The .cube file's contents, when you have the text rather than a path on the machine Rendr is running on.",
						},
						name: {
							type: "string",
							description: "Label for the look. Defaults to the file name.",
						},
						strength: { type: "number", description: "Dry/wet mix 0-1 (default 1)." },
					},
				},
			},
			["clipIds"],
		),
	},
	{
		name: "apply_effect",
		description:
			"Apply non-color effects (blur, sharpen, stylize, detail) to video/image clips as a live, editable effect stack — the looks/FX path, distinct from apply_color (grading). MERGES: each effect you pass is added or updated by type; effects you don't mention are left in place. Pass enabled:false to bypass one without removing it, or list its type in `remove` to delete it. Out-of-range params are clamped; params you omit keep their current (or default) value. Effects render in a fixed canonical order regardless of the order you pass them. Undoable. Returns the clips with their resulting effects as [{type, params}] — the same shape this tool accepts, so copying effects between clips is passing a clip's effects array back in.\n\nCall with no effects and no remove to read the available effect catalog for this build: the response lists every effect type with its params, ranges, and defaults.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					items: { type: "string" },
					description: "Clip ids from get_timeline.",
				},
				effects: {
					type: "array",
					description: "Effects to add or update on the clips.",
					items: object(
						{
							type: {
								type: "string",
								description:
									"Effect type id, e.g. stylize.glow. Call with no effects to list the catalog.",
							},
							params: {
								type: "object",
								description:
									"Param values keyed by name. Out-of-range values are clamped; omitted params keep their current/default value.",
							},
							enabled: {
								type: "boolean",
								description:
									"Default true. false bypasses the effect without removing it.",
							},
						},
						["type"],
					),
				},
				remove: {
					type: "array",
					items: { type: "string" },
					description: "Effect type ids to remove from the clips.",
				},
			},
			["clipIds"],
		),
	},
	{
		name: "inspect_color",
		description:
			"Measure color scopes of a timeline clip's current graded look (clipId) OR a raw media asset (mediaRef) — black/white points, % clipping, mean & per-channel levels, shadow/mid/highlight color tilt, saturation, warm-cool / green-magenta balance, and a saturation-weighted hueHistogram (12 bins of 30° from 0°/red — shows which hues are present, e.g. an orange cluster = skin, a cyan/blue cluster = sky) — and return the rendered frame too. Use this to grade by the numbers instead of eyeballing, to find hues to target with apply_color's hueCurves, or to measure footage/references before grading. clipId applies the clip's effects (graded look); mediaRef measures the raw asset. Pass a reference image/video id to also measure it and get the subject−reference GAP plus hints that map onto apply_color knobs. The loop: apply_color → inspect_color(clipId, reference) → read the gap → adjust → repeat until the gap is small.",
		inputSchema: object({
			clipId: {
				type: "string",
				description:
					"Timeline clip to measure — returns its current GRADED look (effects applied). Provide this or mediaRef.",
			},
			mediaRef: {
				type: "string",
				description:
					"Media asset id from get_media to measure RAW (no grade). Provide this or clipId.",
			},
			atFrame: {
				type: "integer",
				description:
					"Optional project frame to sample a clip. Defaults to the clip's midpoint. Ignored for mediaRef.",
			},
			reference: {
				type: "string",
				description:
					"Optional image/video asset id from get_media to compare against; returns its scopes + the subject−reference gap.",
			},
		}),
	},
	{
		name: "denoise_audio",
		description:
			"Reduce background noise on audio clips. This is spectral subtraction — the noise profile is measured from the clip's own quiet passages and subtracted from every frame — not a speech-enhancement model, so it removes steady hiss and hum well and does nothing for a slamming door. strength is a dry/wet mix 0-1: 0 leaves the audio untouched, 1 subtracts the full measured profile, which can sound thin or watery. Pass auto:true to measure the clip's noise floor and pick the strength from it. It applies on playback and on export with no bake step. Pass enabled:false to turn denoise off. Undoable.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					items: { type: "string" },
					description: "Audio clip ids from get_timeline.",
				},
				strength: {
					type: "number",
					description:
						"Dry/wet mix, 0–1 (default 0.6). Lower it if voices sound thin or watery.",
				},
				auto: {
					type: "boolean",
					description:
						"Measure each clip's noise floor and set strength from it, ignoring the strength argument. The measured floor is returned in dB below peak.",
				},
				enabled: {
					type: "boolean",
					description: "Default true. false removes the denoise effect from the clips.",
				},
			},
			["clipIds"],
		),
	},
];

/** MCP server only — project selection is per-session. */
export const MANAGE_PROJECT_TOOL: AgentTool = {
	name: "manage_project",
	description:
		"List, open, create, or close Rendr projects for this MCP session. Set `action` to: `list` for known projects plus session-active and visible state; `open` with a name, id from list, or .rendr path; `create` with an optional name and initial fps/aspectRatio/quality; or `close` to save and close the session project, optionally targeting another open project by name/id/path. Opening or creating changes only this session's target. Closing always completes a final save first. This tool never deletes projects or files.",
	inputSchema: object(
		{
			action: {
				type: "string",
				enum: ["list", "open", "create", "close"],
				description: "Project operation.",
			},
			name: {
				type: "string",
				description:
					"Project name. For open/close, matched case-insensitively; for create, defaults to 'Untitled Project'.",
			},
			id: {
				type: "string",
				description: "Project id returned by action='list'. Used by open or close.",
			},
			path: {
				type: "string",
				description: "Filesystem path to a .rendr package. Used by open or close.",
			},
			fps: {
				type: "integer",
				description: "Create only. Optional timeline frame rate (1-120).",
			},
			aspectRatio: {
				type: "string",
				enum: ["16:9", "9:16", "1:1", "4:3", "2.4:1", "9:14"],
				description: "Create only. Optional canvas aspect ratio.",
			},
			quality: {
				type: "string",
				enum: ["720p", "1080p", "2K", "4K"],
				description: "Create only. Optional resolution preset applied to the aspect ratio.",
			},
		},
		["action"],
	),
};

/**
 * Rendr's own tools. Palmier Pro has no equivalent: it edits footage it is given,
 * while Rendr also captures it. These wrap Recordly's recording pipeline and
 * zoom camera, which is the whole point of putting the two together.
 */
export const RECORDING_TOOLS: AgentTool[] = [
	{
		name: "list_capture_sources",
		description:
			"Lists what this machine can capture right now: screens, individual windows, and cameras, each with a stable sourceId, a display name, and its pixel dimensions. Screens also report whether they are the primary display; windows report their owning application. Call this before start_recording and pass a sourceId back exactly as given — never construct one.\n\nThe list is a snapshot: windows open and close. If start_recording reports an unknown sourceId, re-list rather than guessing. On macOS and Windows, screen capture requires an OS permission the user grants once; when it is missing the response carries a permissionRequired flag naming what to enable instead of an empty list, so report that to the user rather than concluding nothing is capturable.",
		inputSchema: object({
			kind: {
				type: "string",
				enum: ["screen", "window", "camera", "all"],
				description: "Optional filter. Default all.",
			},
		}),
	},
	{
		name: "start_recording",
		description:
			"Begins a screen, window, or camera recording and returns a recordingId immediately — capture runs in the background. NOT undoable: it writes a real file to disk and captures whatever is on the user's screen, including anything private. Confirm with the user before starting unless they just asked for a recording in so many words.\n\nOnly one recording runs at a time; starting a second is refused, not queued. While a recording is active the timeline is read-only and edit tools are refused — stop first, then edit.\n\nCursor telemetry (position, clicks, interaction type) is captured alongside the video by default. It is what suggest_zooms reads, so leave captureCursor on unless the user objects — without it, zooms have to be authored blind.\n\nPoll get_recording_status for state and elapsed time; call stop_recording to finish. A crash or forced quit mid-recording leaves a partial file that Rendr recovers on next launch.",
		inputSchema: object(
			{
				sourceId: {
					type: "string",
					description:
						"Stable id from list_capture_sources. Pass it back exactly as given.",
				},
				microphoneDeviceId: {
					type: "string",
					description:
						"Optional. Microphone device id from list_capture_sources cameras/audio entries. Omit to record no microphone.",
				},
				systemAudio: {
					type: "boolean",
					description:
						"Optional. Capture the machine's own output (application audio). Default false. Not available on every platform; the response reports systemAudioCaptured so you can tell the user if it was dropped.",
				},
				captureCursor: {
					type: "boolean",
					description:
						"Optional, default true. Record cursor position and click telemetry alongside the video. suggest_zooms needs this; turning it off makes automatic zoom suggestion impossible for the resulting clip.",
				},
				countdownSeconds: {
					type: "integer",
					minimum: 0,
					maximum: 10,
					description:
						"Optional. Show the on-screen countdown before capture starts (default 3). 0 starts immediately — use only when the user asked for no countdown.",
				},
				name: {
					type: "string",
					description:
						"Optional media-library name for the resulting asset. Defaults to a timestamped name.",
				},
			},
			["sourceId"],
		),
	},
	{
		name: "stop_recording",
		description:
			"Ends the active recording, finalizes the file, and imports it into the media library. Returns the mediaRef (ready for add_clips), durationSeconds, dimensions, the file path on disk, and whether cursor telemetry was captured. Blocks until the file is written and readable — the mediaRef it returns is immediately usable, no polling.\n\nRefused when no recording is active. Stopping is not undoable and the captured file is kept; delete it through organize_media if the user doesn't want it.",
		inputSchema: object({
			recordingId: {
				type: "string",
				description:
					"Optional. The id from start_recording. Omit to stop whatever recording is active — there is only ever one.",
			},
			discard: {
				type: "boolean",
				description:
					"Optional, default false. true finalizes and deletes the file instead of importing it, for a take the user has already rejected. Returns no mediaRef.",
			},
		}),
	},
	{
		name: "set_cursor",
		description:
			"Controls the pointer Rendr *draws* over a screen recording. A capture records the real pointer as a few hard pixels that disappear at any zoom, so Rendr captures its position separately and draws its own on top — which is what makes it scalable, smoothable and clickable-looking. This is a display setting on the whole take, not per clip, and it applies to playback and export alike.\n\nIt needs cursor telemetry to draw anything: get_media reports hasCursorTelemetry per asset, and a recording made with captureCursor:false has none. Setting show:true without telemetry changes the setting but draws nothing.\n\nCall with no arguments to read the current settings back.",
		inputSchema: object({
			show: { type: "boolean", description: "Draw the pointer at all. Default true." },
			style: {
				type: "string",
				enum: ["arrow", "arrow-shadow", "arrow-solid", "dot", "pointer"],
				description: "Pointer shape. arrow-shadow is the default.",
			},
			size: {
				type: "number",
				description: "Multiplier on the system pointer size, 0.5–6 (default 2.5).",
			},
			smoothing: {
				type: "number",
				description:
					"0–1 (default 0.67). How far the drawn pointer lags the raw samples — this is what turns jittery hardware sampling into a glide. High values feel floaty on fast movement.",
			},
			motionBlur: {
				type: "number",
				description: "0–1 (default 0.4). How far the pointer smears along its travel.",
			},
			clickBounce: {
				type: "number",
				description: "0–8 (default 3.5). Size of the pop on a click. 0 disables it.",
			},
			bounceSpeed: {
				type: "number",
				description: "How long that pop lasts, 80–1200 ms (default 350).",
			},
			sway: {
				type: "number",
				description:
					"0–1 (default 0.2). A slight drift across the direction of travel, so motion isn't robotic. Scales with speed, so a still pointer never drifts.",
			},
			loop: {
				type: "boolean",
				description:
					"Replay the captured path from the start when the timeline outlives it, instead of parking the pointer where the samples ran out.",
			},
			spotlight: {
				type: "number",
				description:
					"0–1 (default 0). Dims everything outside a soft circle around the pointer, so the eye goes where the hand is. The falloff is a radial gradient, not a hard mask.",
			},
			spotlightSize: {
				type: "number",
				description:
					"0.08–0.8 (default 0.28). Radius of that circle, as a fraction of the frame's short edge.",
			},
			clickRing: {
				type: "boolean",
				description:
					"Default true. A ring that expands and fades from each click — it outlives the bounce, so it is what actually reads on a fast click.",
			},
			ringColor: {
				type: "string",
				description: "Hex colour for that ring. Default '#FFFFFF'.",
			},
		}),
	},
	{
		name: "set_webcam",
		description:
			"Controls the camera inset. When show is true the camera is opened for the preview and a second file is recorded alongside the next screen capture; the bubble is composited at export time rather than burnt into the capture, so its size, corner and shape stay editable afterwards.\n\nTurning it on before start_recording is what makes a take have a camera at all — switching it on after the fact has nothing to composite. Existing takes report whether they have one through get_media.\n\nCall with no arguments to read the current settings back.",
		inputSchema: object({
			show: { type: "boolean", description: "Capture and composite the camera." },
			deviceId: {
				type: "string",
				description:
					"Camera to use, from list_capture_sources with kind:'camera'. Omit for the system default.",
			},
			position: {
				type: "string",
				enum: [
					"top-left",
					"top",
					"top-right",
					"left",
					"center",
					"right",
					"bottom-left",
					"bottom",
					"bottom-right",
				],
				description: "Which corner or edge the bubble sits in. Default bottom-right.",
			},
			shape: {
				type: "string",
				enum: ["rounded", "circle", "square"],
				description: "Default rounded.",
			},
			size: {
				type: "number",
				description:
					"0.1–1 (default 0.4), as a fraction of the frame's short edge — so the bubble is the same physical size in a vertical project as a horizontal one.",
			},
			margin: {
				type: "number",
				description: "0–0.2 (default 0.03). Inset from the frame edge.",
			},
			mirror: {
				type: "boolean",
				description:
					"Selfie view — what the presenter expects to see of themselves. Default true.",
			},
			reactsToZoom: {
				type: "boolean",
				description:
					"Grow the bubble slightly while the zoom camera is punched in, so the presenter doesn't shrink away against the magnified detail. Default true.",
			},
			pairForAsset: {
				type: "string",
				description:
					"Screen take to attach a camera file to. Recording both at once is the normal path, but a camera shot separately — on a phone, or by another tool — works too, and this is how to use one. The two are assumed to share a clock: the camera is seeked to the screen clip's own source time.",
			},
			pairCameraAsset: {
				type: "string",
				description:
					"The camera video to use for pairForAsset. Pass pairForAsset alone to unpair. Both must be video assets from get_media, and a take cannot be its own camera.",
			},
			crop: {
				type: "object",
				description:
					"Side insets into the camera image, each 0–1 of that side. Applied before the bubble's own centre-crop-to-fill.",
				properties: {
					top: { type: "number" },
					right: { type: "number" },
					bottom: { type: "number" },
					left: { type: "number" },
				},
			},
		}),
	},
	{
		name: "set_background",
		description:
			"Controls the backdrop a screen recording sits on, and how its zooms move — Rendr's Background panel. A raw capture fills the frame edge to edge and reads as a document; insetting it, rounding its corners, dropping a shadow under it and putting a colour or gradient behind is what makes it read as a shot. This is a property of the take, not of a clip: one backdrop for the recording.\n\nIt composes with the zoom camera — the backdrop stays put while the footage punches in — and it renders in the preview and the export identically.\n\nCall with no arguments to read the current settings back.",
		inputSchema: object({
			kind: {
				type: "string",
				enum: ["none", "color", "gradient", "image"],
				description:
					"What sits behind the footage. 'none' is black — but padding and shadow still apply, so 'none' with padding is inset footage over black.",
			},
			color: {
				type: "string",
				description: "Hex colour for kind 'color', e.g. '#101014'.",
			},
			gradientFrom: { type: "string", description: "Hex start colour for kind 'gradient'." },
			gradientTo: { type: "string", description: "Hex end colour for kind 'gradient'." },
			gradientAngle: {
				type: "number",
				description: "Degrees clockwise from up, as CSS reads them. Default 135.",
			},
			padding: {
				type: "number",
				description:
					"0–0.35. How far the footage is inset, as a fraction of the frame's SHORT edge — so a vertical project gets the same visual margin as a wide one. Default 0.06.",
			},
			radius: {
				type: "number",
				description:
					"0–1. Corner rounding of the footage; 1 is an eighth of the inset footage's short edge. Default 0.35.",
			},
			shadow: {
				type: "number",
				description: "0–1 drop shadow under the footage. Default 0.55.",
			},
			zoomSmoothness: {
				type: "number",
				description:
					"0–1 (default 0.5). How much the camera's spring eases toward the zoom curve — higher is floatier, 0 cuts straight to it. This is the setting that makes a punch-in feel weighted rather than stepped.",
			},
			zoomInDurationMs: {
				type: "number",
				description:
					"200–4000 (default 1522.6, Recordly's own). How long a punch-in takes to reach full strength. This is a property of the take: every zoom in the recording moves the same way.",
			},
			zoomOutDurationMs: {
				type: "number",
				description: "200–4000 (default 1015.1). How long a zoom takes to release.",
			},
			connectZooms: {
				type: "boolean",
				description:
					"Default true. Two zooms close together become one continuous move that pans between them, instead of releasing and punching in again.",
			},
			imageDataUri: {
				type: "string",
				description:
					"A base64 data URI of an image to use as the backdrop, e.g. 'data:image/png;base64,…'. Supplying one sets kind to 'image'. Backdrops are embedded in the project file so they survive a save, which is why they're capped at ~11 MB as a data URI.",
			},
			imagePath: {
				type: "string",
				description:
					"Absolute path to an image Rendr reads itself, instead of imageDataUri. Also sets kind to 'image'.",
			},
		}),
	},
	{
		name: "get_recording_status",
		description:
			"Reports whether a recording is active and, if so, its recordingId, elapsed seconds, the source being captured, and whether audio and cursor telemetry are being recorded. Returns {active: false} when idle. Cheap — but don't poll it in a tight loop; a recording ends when the user or stop_recording says so, not on a timer.",
		inputSchema: object(),
	},
];

export const WORKFLOW_TOOLS: AgentTool[] = [
	{
		name: "manage_workflows",
		description:
			"Workflows: a graph that describes an edit instead of performing one by hand. A timeline is where you place things; a workflow is what you run — the difference between editing one video and describing an edit that applies to any recording, repeatedly.\n\nThe case it exists for: one long screen recording in, several short vertical clips out. Doing that on a timeline is N manual edits; as a workflow it is one graph and N runs.\n\nA graph is a pipeline, not a general dataflow language: every node takes one timeline-ish input and produces one, and a node may have only one input — two would mean deciding how to merge two timelines, which is an edit rather than a wiring choice. Cycles are refused.\n\nActions: list (default), create, create_clips_preset (the short-form pipeline, ready to run), rename, delete, describe (the run order in one line, plus anything that would stop it running).",
		inputSchema: object({
			action: {
				type: "string",
				enum: ["list", "create", "create_clips_preset", "rename", "delete", "describe"],
				description: "Default list.",
			},
			workflowId: { type: "string", description: "rename/delete/describe: which workflow." },
			name: { type: "string", description: "create/create_clips_preset/rename: its name." },
		}),
	},
	{
		name: "edit_workflow",
		description:
			"Builds a workflow's graph: add and remove nodes, wire them, move them, and set their parameters.\n\nNode kinds — source (a recording; where every workflow starts), detect-highlights (marks the moments worth keeping, from cursor activity and speech), split-clips (cuts the take at those moments), reframe (recomposes to another aspect: 9:16 vertical, 1:1 square), auto-zoom (punch-ins from the cursor), narrate (speaks the notes with the local voice), subtitle (word-timed captions from the narration), grade (a look — curves, balance, backdrop), export (writes a file; terminal).\n\nInvalid connections are refused with the reason rather than silently dropped, because a wire that appears to exist and does nothing is the worst outcome in a visual editor.",
		inputSchema: object(
			{
				workflowId: { type: "string", description: "Which workflow to edit." },
				action: {
					type: "string",
					enum: [
						"add_node",
						"remove_node",
						"connect",
						"disconnect",
						"move_node",
						"set_params",
					],
				},
				kind: {
					type: "string",
					enum: [
						"source",
						"detect-highlights",
						"split-clips",
						"reframe",
						"auto-zoom",
						"narrate",
						"subtitle",
						"grade",
						"export",
					],
					description: "add_node: what kind of node.",
				},
				nodeId: {
					type: "string",
					description: "remove_node/move_node/set_params: which node.",
				},
				from: { type: "string", description: "connect: the feeding node." },
				to: { type: "string", description: "connect: the receiving node." },
				edgeId: { type: "string", description: "disconnect: which wire." },
				x: { type: "number", description: "add_node/move_node: canvas position." },
				y: { type: "number", description: "add_node/move_node: canvas position." },
				params: {
					type: "object",
					description:
						"set_params: merged onto the node's existing settings, e.g. {aspect: '9:16'} on a reframe node.",
				},
			},
			["workflowId", "action"],
		),
	},
];

export const CLIP_EDIT_TOOLS: AgentTool[] = [
	{
		name: "trim_dead_air",
		description:
			"Cuts the fumble off each end of a take — the seconds after you hit record and before you reach the browser, and the reach back for the stop button. For a screen recording this is the most common edit there is.\n\nFound from the cursor rather than from audio: a screen recording often has no audio at all, and a still pointer is what nothing-happening actually looks like on a screen. Travel is summed over half a second, so a slow deliberate drag counts as activity while a hand resting on a trackpad does not — differencing frame to frame would trim away the very thing the demo is about.\n\nA beat is left either side, because cutting to the exact first movement lands the viewer mid-gesture. Call with measureOnly to see what it would cut. Undoable.",
		inputSchema: object({
			measureOnly: {
				type: "boolean",
				description: "Report the dead air at each end and change nothing.",
			},
		}),
	},
	{
		name: "fit_to_duration",
		description:
			"Retimes the timeline to land on an exact length, by speeding up or slowing down every visual clip together. This is the tool for a platform limit — sixty seconds for a Short, ninety for a Reel — where the cut is right and only the total is wrong.\n\nEvery clip takes the same speed factor, so the rhythm of the edit survives; retiming one clip and not the rest would change the cut. Clip speed is limited to 0.1-8x, so a target needing more than that is refused with the closest achievable length rather than silently landing somewhere else.\n\nAudio moves with its clip and will change pitch — speech beyond about 1.2x starts to sound wrong, which is why the response says what factor was applied rather than only that it succeeded. Narration is left alone by default, since re-pitching a generated voice is worse than letting it sit slightly early. Undoable.",
		inputSchema: object(
			{
				seconds: { type: "number", description: "Exact length to land on." },
				includeNarration: {
					type: "boolean",
					description:
						"Default false. true retimes narration too, which re-pitches the voice — usually worse than leaving it.",
				},
			},
			["seconds"],
		),
	},
	{
		name: "export_subtitles",
		description:
			"Writes the timeline's captions as a subtitle file — SRT for most platforms, VTT for the web. This is what you upload alongside a demo so it is searchable and watchable muted, which is how most of a feed watches it.\n\nCues come from the caption clips as they stand, so anything edited on the timeline is in the file. Timings are taken from each clip's position, so moving a caption moves its cue.\n\nCall with no groupId to use the only group present; pass one when a project has more than one. get_transcript lists the groups. Returns the text as well as writing the file, so an agent can read back what it produced.",
		inputSchema: object({
			format: {
				type: "string",
				enum: ["srt", "vtt"],
				description: "Default srt.",
			},
			groupId: {
				type: "string",
				description: "Which caption group. Omit when there is only one.",
			},
			download: {
				type: "boolean",
				description:
					"Default true — writes the file. false returns the text only, for inspection or for embedding elsewhere.",
			},
		}),
	},
	{
		name: "match_color",
		description:
			"Grades one clip to match another. Renders a frame from each, measures both, and applies the exposure, contrast, saturation, temperature and tint that close the gap.\n\nThis is the tool for the shot that doesn't cut with the one before it — a take recorded under different light, or a clip from another session.\n\nThe correction is applied on top of whatever the clip already carries rather than replacing it, because a match is a correction and not a reset: discarding a look somebody chose in order to fix exposure would be the wrong trade. Pass measureOnly to see the gap and the grade it would apply without changing anything.\n\nOnly the five global controls. Matching shadows and highlights separately needs a per-band solve a mean-luma comparison cannot honestly support, and guessing would produce a grade that measures closer while looking worse. A gap under what anyone can see is left alone rather than dirtying the grade for no visible gain. Undoable.",
		inputSchema: object(
			{
				clipId: { type: "string", description: "The clip to change." },
				referenceClipId: {
					type: "string",
					description: "The clip to match. Left untouched.",
				},
				measureOnly: {
					type: "boolean",
					description: "Report the gap and the grade it would apply, and change nothing.",
				},
			},
			["clipId", "referenceClipId"],
		),
	},
	{
		name: "normalize_audio",
		description:
			"Measures each clip's actual loudness and sets its level to match a target, so a demo doesn't jump in volume between a screen recording and a narration line.\n\nThe average is taken over the audible passages only — a take with thirty seconds of silence at the head is not quiet, and averaging the silence in would push the gain far too high.\n\nGain is held back rather than clipping: if reaching the target would push the peak past the ceiling, it goes as far as it can and reports the shortfall, because reaching a target by clipping the transients is not reaching it. Call with measureOnly to read the levels without changing anything.\n\nThis is unweighted program RMS, not ITU-R BS.1770, so the figures are not LUFS and are not labelled as such. For matching clips from the same capture, which is what this is for, that is the number that matters. Undoable.",
		inputSchema: object({
			clipIds: {
				type: "array",
				items: { type: "string" },
				description: "Clips to normalise. Omit for every clip that carries audio.",
			},
			targetDb: {
				type: "number",
				description:
					"Program level to aim for, in dBFS. Default -18, which leaves room for a narration line on top.",
			},
			ceilingDb: {
				type: "number",
				description: "Peak must not cross this. Default -1.",
			},
			measureOnly: {
				type: "boolean",
				description:
					"Report each clip's loudness and the gain it would need, and change nothing.",
			},
		}),
	},
	{
		name: "reframe_timeline",
		description:
			"Recomposes every visual clip for another aspect — 9:16 for vertical, 1:1 or 4:5 for square-ish feeds, 16:9 to go back. The project keeps its pixel size; what changes is the box the footage occupies, centred and cover-fitted, so a 16:9 screen recording reframed to 9:16 shows the middle of the screen at full height rather than a letterboxed miniature.\n\nThis is the one call that turns a landscape recording into something postable vertically. Text and captions are left alone, since they are already composed for the frame rather than cropped from a source. Undoable as one step.",
		inputSchema: object(
			{
				aspect: {
					type: "string",
					enum: ["9:16", "1:1", "4:5", "16:9"],
					description: "Target aspect as width:height.",
				},
				followCursor: {
					type: "boolean",
					description:
						"Default true when the recording carries cursor telemetry. Pans the crop to keep the pointer in shot instead of holding the centre — a centred vertical crop of a screen recording often misses the sidebar or corner where the work is happening. The motion is smoothed, so it follows the subject rather than mirroring every flick, and clamped so no edge is ever exposed. Pass false to hold the centre.",
				},
			},
			["aspect"],
		),
	},
	{
		name: "duck_audio",
		description:
			"Drops a clip's level under the narration so speech stays intelligible over it — the mix problem every voiced demo has.\n\nBy default it ducks every clip that isn't narration, under every narration clip it finds, so a whole demo is balanced in one call. Pass clipIds to duck only those.\n\nWritten as volume keyframes rather than a separate audio stage, because those already drive both playback and the export mixdown: a duck is audible while scrubbing and present in the file, with no bake step. Each line gets four points — full, down, down, back up — because ramping is what stops a duck sounding like a gate. Lines closer together than two ramps duck once and stay down between them, so the bed doesn't pump.\n\nRun it again after re-narrating: it replaces the automation rather than layering more. Undoable.",
		inputSchema: object({
			clipIds: {
				type: "array",
				items: { type: "string" },
				description: "Clips to duck. Omit to duck everything that isn't narration.",
			},
			amountDb: {
				type: "number",
				description:
					"How far to drop, in dB. Default -12, which keeps a bed audible under speech. -18 or lower effectively silences it.",
			},
			rampFrames: {
				type: "number",
				description:
					"Frames to ramp over, each side. Default 8 — about a quarter second at 30fps.",
			},
		}),
	},
	{
		name: "add_transition",
		description:
			"Cross-dissolves the cut between two touching clips. Pass the frame the cut is at (from get_timeline's clip boundaries) and how many frames the dissolve should run for.\n\nBuilt from fades rather than a separate effect: the incoming clip is pulled earlier so the two overlap, the outgoing one fades out across the overlap and the incoming one fades in across it. Both already render, so a dissolve behaves exactly like the fades you can set by hand.\n\nRefused, with the reason, when it cannot honestly be made — a dissolve longer than the clips it joins, or one needing source footage before the incoming clip's in point that doesn't exist. Pass removeClipId instead to restore a hard cut. Undoable.",
		inputSchema: object({
			atFrame: {
				type: "number",
				description: "The frame the cut is at — where one clip ends and the next begins.",
			},
			frames: {
				type: "number",
				description: "Length of the dissolve. 12–24 reads as a soft cut at 30fps.",
			},
			removeClipId: {
				type: "string",
				description: "Instead of adding: clears this clip's fades, restoring a hard cut.",
			},
		}),
	},
	{
		name: "duplicate_clips",
		description:
			"Copies clips and places each copy immediately after its original on the same track, pushing nothing aside — a copy that overwrote its neighbour would be a move, not a duplicate. Returns the new clip ids so the copies can be edited straight away. Undoable as one step.\n\nUse for repeating a beat, or for making a variant to grade differently while keeping the original.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					items: { type: "string" },
					description: "Clip ids from get_timeline.",
				},
			},
			["clipIds"],
		),
	},
	{
		name: "nudge_clips",
		description:
			"Shifts clips along their own track by a number of frames — negative earlier, positive later. The whole set moves together, so relative timing inside the selection is preserved, and nothing is pushed past frame 0.\n\nThis is the tool for fixing sync by a few frames. For a large move, or to another track, use move_clips.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					items: { type: "string" },
					description: "Clip ids from get_timeline.",
				},
				deltaFrames: {
					type: "number",
					description: "Frames to shift by. Negative moves earlier.",
				},
			},
			["clipIds", "deltaFrames"],
		),
	},
	{
		name: "trim_clips",
		description:
			"Trims a clip's head or tail to a frame, adjusting its source offset so the picture doesn't slide — trimming the head keeps the same frame visible at the new start rather than showing earlier footage.\n\nPass toFrame to trim to an absolute frame, or atPlayhead:true to trim to where the playhead is, which is the common case. edge picks which end.\n\nTrimming is not the same as moving: the clip's other edge stays where it is, so the timeline around it is undisturbed. Undoable.",
		inputSchema: object(
			{
				clipIds: {
					type: "array",
					items: { type: "string" },
					description: "Clip ids. With atPlayhead, several can be trimmed at once.",
				},
				edge: {
					type: "string",
					enum: ["start", "end"],
					description: "Which end to trim. Default end.",
				},
				toFrame: {
					type: "number",
					description: "Absolute frame to trim to. Ignored when atPlayhead is true.",
				},
				atPlayhead: {
					type: "boolean",
					description: "Trim to the playhead instead of a given frame.",
				},
			},
			["clipIds"],
		),
	},
];

export const WORKFLOW_RUN_TOOLS: AgentTool[] = [
	{
		name: "run_workflow",
		description:
			"Runs a workflow against the current timeline. Each node is a step that takes a timeline and returns one, so a run is a fold over the graph's order.\n\nAll or nothing: nothing is committed until every step has succeeded, so a failure at step five leaves the timeline exactly as it was rather than half-edited. A step that cannot do its work stops the run and says why, rather than passing the timeline through unchanged — a node that silently no-ops would make a run report success having produced nothing.\n\nThe response lists what each step actually did, and the output path when an Export ran. Undoable as one step. Check manage_workflows describe first if you want to know what would stop it before spending the time.",
		inputSchema: object(
			{
				workflowId: { type: "string", description: "Which workflow to run." },
				dryRun: {
					type: "boolean",
					description:
						"Default false. true reports what each step would do and what would stop the run, without committing anything or writing a file.",
				},
			},
			["workflowId"],
		),
	},
];

export const NARRATION_TOOLS: AgentTool[] = [
	{
		name: "manage_comments",
		description:
			"Notes pinned to timeline frames. Two jobs: review marks ('this bit drags'), and the narration script — narrate_timeline speaks every unresolved note in order, so writing the voiceover means writing comments.\n\nA note is not a clip: it has no picture, cannot be trimmed, and never affects what renders. Pin it to a trackId to attach it to one track, or omit that for a note about the timeline at that moment.\n\nActions: list (default), add, update, remove, resolve, unresolve.",
		inputSchema: object({
			action: {
				type: "string",
				enum: ["list", "add", "update", "remove", "resolve", "unresolve"],
				description: "Default list.",
			},
			frame: { type: "number", description: "add: the timeline frame to pin to." },
			text: { type: "string", description: "add/update: what the note says." },
			trackId: {
				type: "string",
				description: "add: attach to one track. Omit for a timeline-wide note.",
			},
			durationFrames: {
				type: "number",
				description:
					"add/update: how many frames the note covers. 0 (default) is a point marker.",
			},
			commentId: {
				type: "string",
				description: "update/remove/resolve/unresolve: which note.",
			},
		}),
	},
	{
		name: "setup_voice",
		description:
			"Installs the local text-to-speech model so narration can be generated. Kokoro-82M runs entirely on this machine through onnxruntime — no API key, no account, and nothing about the project is uploaded, which matters because narration is usually written against something unreleased.\n\nThe model is ~90 MB and is not shipped with Rendr. The first call downloads it into the app's data directory; later calls load it from there and return immediately, so this is safe to call before any narration whatever state the machine is in. Downloading takes a minute or two on a normal connection and the call does not return until it finishes.\n\nCall with no arguments to report status without installing.",
		inputSchema: object({
			install: {
				type: "boolean",
				description:
					"Default false, which only reports status. true downloads the model if it is missing.",
			},
		}),
	},
	{
		name: "narrate_timeline",
		description:
			"Speaks the timeline's notes and lays the audio onto a narration track, one clip per note, each starting at the frame its note is pinned to.\n\nThis is how a demo gets a voiceover: write the script as comments with manage_comments (one per beat of the demo), then call this. Notes are spoken in timeline order and resolved notes are skipped.\n\nNotes already voiced from the same text are skipped rather than re-spoken — pass regenerate:true to redo them, which is what you want after editing the wording. A note whose text changed since it was voiced is reported as stale and is always re-spoken.\n\nRequires setup_voice to have installed the model. Generation is roughly real-time: a two-minute voiceover takes about two minutes, and the call does not return until every line is rendered. Undoable as one step.",
		inputSchema: object({
			voice: {
				type: "string",
				description:
					"Kokoro voice id, e.g. af_heart (default), af_bella, am_michael. setup_voice lists what this install has.",
			},
			speed: {
				type: "number",
				description:
					"0.5–2 (default 1). Kokoro's own delivery speed, which changes pacing without changing pitch.",
			},
			regenerate: {
				type: "boolean",
				description:
					"Default false. true re-speaks notes that already have current audio, replacing it.",
			},
			subtitles: {
				type: "boolean",
				description:
					"Default true. Karaoke word-by-word subtitles on the CC track, cut from the narration script itself with length-weighted word timing — the one transcript that is exact rather than recognised. Replaced wholesale on every run. Pass false for narration with no captions.",
			},
			commentIds: {
				type: "array",
				items: { type: "string" },
				description: "Only these notes. Omit to narrate the whole timeline.",
			},
		}),
	},
];

export const ZOOM_TOOLS: AgentTool[] = [
	{
		name: "suggest_zooms",
		description:
			"Reads the cursor telemetry captured with a screen recording and proposes zoom regions around the moments that actually matter — click clusters, drags, and sustained interaction in one area of the screen — with a focus point on where the cursor was and a depth scaled to how tight the activity was. This is the intended way to zoom a screen recording: run it first, review what it proposes, then adjust or drop individual regions rather than authoring them blind.\n\nProposals are NOT applied. The response is an array of candidate regions in add_zoom_regions' exact input shape, each with a `reason` naming what triggered it. Pass the ones you want straight to add_zoom_regions, editing depth/focus/timing first if the user asked for something specific. There is no confidence score — the detector fires on explicit click events, not a heuristic, so a proposal means a click actually happened there.\n\nRequires a clip whose asset has cursor telemetry — get_media reports hasCursorTelemetry per asset, and recordings made with captureCursor:false do not have it. Without telemetry this returns an empty list with a status of 'no-telemetry', which means 'nothing to go on', not 'nothing worth zooming'. A status of 'no-interactions' means telemetry exists but the user never clicked.",
		inputSchema: object(
			{
				clipId: {
					type: "string",
					description:
						"Optional. Reserved for the multi-clip timeline. Rendr currently holds one recording per project, so omit this — the active recording is analyzed.",
				},
				maxRegions: {
					type: "integer",
					description:
						"Optional cap on proposals returned, earliest first (default 8, max 32).",
				},
				startMs: {
					type: "number",
					description:
						"Optional. Only analyze source milliseconds at or after this point.",
				},
				endMs: {
					type: "number",
					description: "Optional. Only analyze source milliseconds before this point.",
				},
			},
			[],
		),
	},
	{
		name: "add_zoom_regions",
		description:
			"Adds zoom punch-ins to a screen-recording clip in one undoable action. A zoom region scales the frame up over a span of time and eases back out, which is what makes a raw screen capture readable — text that is unreadable at full-screen becomes legible at depth 2 or 3.\n\nTiming is in SOURCE milliseconds of the recording, [startMs, endMs) — NOT project frames. This is deliberate: zooms belong to the recording, so they survive trimming and moving the clip. get_timeline reports existing regions in the same units.\n\ndepth is 1–6, mapping to 1.25x, 1.5x, 1.8x, 2.2x, 3.5x, and 5x. Beyond depth 4 a screen recording reads as pixelated; prefer 2 or 3 unless asked to go closer. focus is the normalized 0–1 point on the canvas the zoom centers on, {cx: 0.5, cy: 0.5} being frame center — Rendr clamps it so the zoomed frame never shows past the edge of the footage, so an extreme focus is corrected rather than refused (the receipt reports the clamped value).\n\nmode 'auto' lets the camera drift with the cursor inside the region — right for scrolling, dragging, or following a pointer across the screen. mode 'manual' pins the focus point — right for a fixed target like a button or a form field. Default is auto.\n\nRegions on one clip must not overlap; an overlapping entry rejects the whole call with no partial state. Keep them at least ~600ms or the punch reads as a glitch. Prefer suggest_zooms to author these from real cursor data.",
		inputSchema: object(
			{
				clipId: {
					type: "string",
					description:
						"Optional. Reserved for the multi-clip timeline. Rendr currently holds one recording per project, so omit this — regions apply to the active recording.",
				},
				regions: {
					type: "array",
					description:
						"Zoom regions to add. Validated up front; one bad or overlapping region rejects the whole call.",
					items: object(
						{
							startMs: {
								type: "number",
								description:
									"Start of the zoom in SOURCE milliseconds of the recording (inclusive).",
							},
							endMs: {
								type: "number",
								description:
									"End in SOURCE milliseconds (exclusive). Must be > startMs; spans under ~600ms read as a glitch.",
							},
							depth: {
								type: "integer",
								minimum: 1,
								maximum: 6,
								description:
									"1=1.25x, 2=1.5x, 3=1.8x, 4=2.2x, 5=3.5x, 6=5x. Prefer 2–3 for screen recordings.",
							},
							focus: {
								type: "object",
								description:
									"Normalized canvas point the zoom centers on. Omit to center ({cx: 0.5, cy: 0.5}); clamped so the frame never shows past the footage edge.",
								properties: {
									cx: {
										type: "number",
										minimum: 0,
										maximum: 1,
										description: "Horizontal center, 0 (left) to 1 (right).",
									},
									cy: {
										type: "number",
										minimum: 0,
										maximum: 1,
										description: "Vertical center, 0 (top) to 1 (bottom).",
									},
								},
								required: ["cx", "cy"],
							},
							mode: {
								type: "string",
								enum: ["auto", "manual"],
								description:
									"auto (default) drifts with the cursor inside the region; manual pins the focus point.",
							},
						},
						["startMs", "endMs", "depth"],
					),
				},
			},
			["regions"],
		),
	},
	{
		name: "update_zoom_regions",
		description:
			"Retimes, re-depths, refocuses, or removes existing zoom regions on a clip in one undoable action — the adjust pass after suggest_zooms → add_zoom_regions. Address regions by the id get_timeline reports.\n\n`set` entries are partial patches: pass only what changes, the rest is preserved. `remove` takes region ids. Both run in one undo step, remove after set. The resulting regions still must not overlap; a patch that would create an overlap rejects the whole call with no partial state.\n\nTo replace a clip's zooms wholesale, remove them all here rather than adding on top — add_zoom_regions never removes anything.",
		inputSchema: object(
			{
				clipId: {
					type: "string",
					description:
						"Optional. Reserved for the multi-clip timeline. Rendr currently holds one recording per project, so omit this — regions apply to the active recording.",
				},
				set: {
					type: "array",
					description:
						"Partial patches by region id. Omitted fields keep their current values.",
					items: object(
						{
							regionId: {
								type: "string",
								description: "Zoom region id from get_timeline's zoomRegions.",
							},
							startMs: {
								type: "number",
								description: "New start in SOURCE milliseconds.",
							},
							endMs: {
								type: "number",
								description: "New end in SOURCE milliseconds (exclusive).",
							},
							depth: {
								type: "integer",
								minimum: 1,
								maximum: 6,
								description: "New depth, 1–6.",
							},
							focus: {
								type: "object",
								properties: {
									cx: { type: "number", minimum: 0, maximum: 1 },
									cy: { type: "number", minimum: 0, maximum: 1 },
								},
								required: ["cx", "cy"],
							},
							mode: { type: "string", enum: ["auto", "manual"] },
						},
						["regionId"],
					),
				},
				remove: {
					type: "array",
					items: { type: "string" },
					description: "Zoom region ids to delete from the clip.",
				},
			},
			[],
		),
	},
];

/** Everything the MCP server advertises. */
export const MCP_TOOLS: AgentTool[] = [
	...EDITING_TOOLS,
	MANAGE_PROJECT_TOOL,
	...RECORDING_TOOLS,
	...NARRATION_TOOLS,
	...WORKFLOW_TOOLS,
	...CLIP_EDIT_TOOLS,
	...WORKFLOW_RUN_TOOLS,
	...ZOOM_TOOLS,
];

export const TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
