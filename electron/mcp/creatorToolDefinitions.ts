// Tools for creators editing camera footage: talking-head videos, Shorts, Reels,
// TikToks. Rendr's own, not part of the Palmier Pro surface. Kept in their own
// module so the editing surface above stays a faithful transcription.

import type { AgentTool, JsonSchema } from "./toolDefinitions";

function object(properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
	const schema: JsonSchema = { type: "object" };
	if (Object.keys(properties).length > 0) schema.properties = properties;
	if (required.length > 0) schema.required = required;
	return schema;
}

const WAIT_SECONDS = {
	type: "number",
	description:
		"How long to wait for the analysis before answering, 0–100 seconds (default 90). Analysis runs at roughly half real time on Apple Silicon, so a long take may still be running — the result then says status 'running' with its progress, and calling again picks the same job up rather than starting over.",
};

export const CREATOR_TOOLS: AgentTool[] = [
	{
		name: "analyze_footage",
		description:
			"Analyses camera footage on this Mac with Apple's Vision framework: a person matte (for remove_background) and a face track (for face-following reframes and punch-ins). Nothing is uploaded and nothing is downloaded. Results are cached by file, so asking again is instant.\n\nReports whether this is talking-head footage at all: personCoverage and faceCoverage are the share of the footage with a person / a face in shot, and typicalFace is where the speaker's face usually sits (normalized centre and height). macOS only.",
		inputSchema: object(
			{
				assetId: {
					type: "string",
					description: "The video asset to analyse (get_media lists them).",
				},
				quality: {
					type: "string",
					enum: ["fast", "balanced", "accurate"],
					description:
						"Matte quality. 'balanced' (default) is right for almost everything; 'accurate' is several times slower and helps with hair against busy backgrounds.",
				},
				waitSeconds: WAIT_SECONDS,
			},
			["assetId"],
		),
	},
	{
		name: "remove_background",
		description:
			"Removes or replaces the background behind the person in camera footage — a green screen without a green screen. Runs analyze_footage first when the footage has no matte yet (same waiting rules).\n\nModes:\n• 'remove' — transparent: whatever is on the tracks BELOW shows through. This is how graphics go behind the speaker: put an add_graphic or a colour/image clip on a lower track.\n• 'color' — a flat colour behind them (e.g. '#0B4F3C' for the deep-green creator look).\n• 'blur' — their own background, blurred (a portrait-mode look).\n• 'image' — a library image behind them.\n• 'off' — back to the original footage.\n\nPreview and export render it identically. Undoable.",
		inputSchema: object({
			clipIds: {
				type: "array",
				items: { type: "string" },
				description:
					"Video clips to change. Omit to apply to every video clip whose footage has a person in it.",
			},
			mode: { type: "string", enum: ["remove", "color", "blur", "image", "off"] },
			color: { type: "string", description: "CSS colour for mode 'color'." },
			imageAssetId: { type: "string", description: "Library image for mode 'image'." },
			blur: {
				type: "number",
				description: "Blur radius in pixels at 1080p for mode 'blur'. Default 24.",
			},
			feather: {
				type: "number",
				description:
					"Softens the cut-out edge, pixels at 1080p. Default 1.5; raise for hair, lower for crisp edges.",
			},
			quality: { type: "string", enum: ["fast", "balanced", "accurate"] },
			waitSeconds: WAIT_SECONDS,
		}),
	},
	{
		name: "add_graphic",
		description:
			"Adds an animated graphic: cards, lines, labels and QR codes drawn by Rendr (not imported images), animating in on their own. Everything is in FRAME coordinates (0–1, top-left origin) and drawn in frame space, so a punch-in on the speaker doesn't move the graphic. Preview and export match exactly.\n\nTemplates:\n• 'mind_map' — labelled cards that pop in one by one, joined by lines that draw themselves (the classic talking-head explainer look). nodes: ['Ideas', 'Storylines', …] or [{label, x, y}]; links: [[0,1], ['Ideas','Brands'], …] (default: a chain in order). Cards are laid out around the speaker, avoiding their face and body when the footage has been through analyze_footage.\n• 'key_points' — a stacked list of cards, one at a time. items: ['…'].\n• 'lower_third' — name plate. title, subtitle.\n• 'qr' — a scannable QR code. data (URL/text), corner (top_right default), label (e.g. 'Scan me').\n• 'callout' — one card, optionally with an arrow: label, x, y, pointTo [x, y].\n• 'custom' — pass elements directly: {type:'box', id, label, x, y, at}, {type:'line', from: id|[x,y], to: id|[x,y], arrow, at}, {type:'text', text, x, y, size, at}, {type:'rect', x, y, w, h, fill, at}, {type:'qr', data, x, y, size, at}. `at` is seconds after the graphic starts.\n\nlayer: 'front' (overlay on top — default for everything but mind_map) or 'behind' (on its own track directly under the speaker's footage — default for mind_map when the footage has a matte). For 'behind' to show, the footage needs remove_background; if the footage had a flat 'color' background, that colour moves onto this graphic and the footage becomes transparent, giving: colour → graphic → person. Pass clipId to restyle or re-time an existing graphic instead of adding one.",
		inputSchema: object({
			template: {
				type: "string",
				enum: ["mind_map", "key_points", "lower_third", "qr", "callout", "custom"],
			},
			clipId: {
				type: "string",
				description: "An existing graphic clip to replace in place.",
			},
			name: { type: "string" },
			startFrame: {
				type: "number",
				description: "Timeline frame it starts at. Default 0 (or the existing clip's).",
			},
			durationFrames: {
				type: "number",
				description:
					"Length in frames. Default: until every element has landed, plus 3 seconds to read it.",
			},
			layer: { type: "string", enum: ["front", "behind"] },
			nodes: {
				type: "array",
				items: {},
				description: "mind_map/key_points: labels, or {label, x, y} to pin a card.",
			},
			links: {
				type: "array",
				items: { type: "array", items: {} },
				description: "mind_map: pairs of node indexes or labels to connect.",
			},
			items: {
				type: "array",
				items: { type: "string" },
				description: "key_points: one card per item.",
			},
			title: { type: "string", description: "lower_third: the name or headline." },
			subtitle: { type: "string", description: "lower_third: the role or detail line." },
			data: { type: "string", description: "qr: what the code encodes — usually a URL." },
			label: {
				type: "string",
				description: "qr: caption under the code. callout: the card's text.",
			},
			corner: {
				type: "string",
				enum: ["top_left", "top_right", "bottom_left", "bottom_right"],
			},
			x: { type: "number", description: "callout/key_points/qr: centre x, 0–1." },
			y: { type: "number", description: "callout/qr: centre y, 0–1." },
			pointTo: {
				type: "array",
				items: { type: "number" },
				description: "callout: [x, y] the arrow points at.",
			},
			stagger: {
				type: "number",
				description: "Seconds between one card's entrance and the next. Default 0.45.",
			},
			elements: {
				type: "array",
				items: { type: "object" },
				description: "template 'custom': the elements.",
			},
			background: {
				type: "string",
				description:
					"A colour filling the whole frame behind the elements (e.g. '#0B4F3C').",
			},
			style: {
				type: "object",
				description:
					"Overrides: accent (lines, default '#F5D90A'), boxFill ('#FBF3D5'), boxText ('#1F2A24'), textColor, fontFamily, fontWeight, radius (px at 1080p), lineWidth (px at 1080p), shadow (bool), uppercase (bool).",
			},
		}),
	},
	{
		name: "add_punch_ins",
		description:
			"Jump-cut punch-ins for talking-head footage: pushes in on the speaker's face on alternating segments, so each cut reads as a deliberate camera change instead of a skip. Run it AFTER cutting (remove_silence / remove_words), when the footage track is a run of short segments. Uses the face track from analyze_footage to keep the face exactly where it was on screen while everything grows; without one it aims at the upper middle. Never uncovers the frame's edge.\n\nstyle 'cut' (default) is the classic hard punch; 'push' is a slow push-in across each chosen segment (good for a single long take). Re-running replaces earlier punch-ins rather than stacking them; mode 'off' (or amount 1) restores the original framing. Clips with motion you authored yourself are skipped. Undoable.",
		inputSchema: object({
			clipIds: {
				type: "array",
				items: { type: "string" },
				description:
					"Segments to consider, in timeline order. Default: every clip on the main footage track.",
			},
			amount: { type: "number", description: "Push-in scale, 1.02–1.8. Default 1.15." },
			pattern: {
				type: "string",
				enum: ["alternate", "every"],
				description:
					"'alternate' (default) punches every other segment; 'every' punches all of them.",
			},
			startWith: {
				type: "string",
				enum: ["wide", "tight"],
				description: "Whether the first segment is wide (default) or punched.",
			},
			style: { type: "string", enum: ["cut", "push"] },
			mode: { type: "string", enum: ["on", "off"] },
		}),
	},
	{
		name: "find_retakes",
		description:
			"Finds retakes in the transcript: lines the speaker started, abandoned and said again ('so today we're— so today we're going to…'), and stutters ('I think I think'). Proposes cutting the EARLIER attempt and keeping the last one, which is what an editor does. Needs captions (add_captions) — it reads the same transcript get_transcript shows.\n\nBy default it only reports, with the removed and kept text side by side; pass apply:true to cut them all in one undoable remove_words step. Run it after remove_silence and before add_punch_ins.",
		inputSchema: object({
			apply: {
				type: "boolean",
				description: "Cut what was found. Default false: report only.",
			},
			include: {
				type: "string",
				enum: ["all", "restarts"],
				description: "'restarts' skips phrase stutters. Default 'all'.",
			},
			minMatch: {
				type: "number",
				description:
					"Opening words that must repeat to count as a restart. Default 3; raise to be more conservative.",
			},
			maxGapSeconds: {
				type: "number",
				description: "How far apart two attempts can be. Default 25.",
			},
			captionGroupId: {
				type: "string",
				description: "Which transcript, when there are several caption groups.",
			},
			cutAggressiveness: { type: "string", enum: ["tight", "balanced", "loose"] },
		}),
	},
	{
		name: "create_thumbnail",
		description:
			"Makes a YouTube-style thumbnail from the footage: the speaker cut out (from the moment they're closest to camera, unless atSeconds is given) with a white sticker outline, on a bold backdrop, next to a huge stroked title with highlight words in an accent colour. Needs analyze_footage (runs it if missing). The PNG lands in the media library, optionally also at outputPath, and a preview comes back so you can judge it — make two or three variants and let the user pick. format 'youtube' is 1280×720; 'shorts' is a 1080×1920 cover with the title on top.",
		inputSchema: object(
			{
				title: {
					type: "string",
					description: "3–5 punchy words. Uppercased automatically.",
				},
				highlight: {
					type: "array",
					items: { type: "string" },
					description: "Words of the title to paint in the accent colour.",
				},
				assetId: {
					type: "string",
					description:
						"Footage to take the speaker from. Default: the timeline's main footage.",
				},
				atSeconds: {
					type: "number",
					description: "Source time to take the speaker from. Default: largest face.",
				},
				background: {
					description:
						"A colour, or [from, to] for a diagonal gradient. Default deep green.",
				},
				accent: { type: "string", description: "Highlight colour. Default '#F5D90A'." },
				textColor: { type: "string" },
				side: {
					type: "string",
					enum: ["left", "right"],
					description: "Where the speaker stands. Default right.",
				},
				outline: {
					type: "number",
					description: "Sticker outline width, px at 720p. 0 for none. Default 10.",
				},
				format: { type: "string", enum: ["youtube", "shorts"] },
				name: { type: "string" },
				outputPath: {
					type: "string",
					description: "Also write the PNG here (absolute path).",
				},
				waitSeconds: WAIT_SECONDS,
			},
			["title"],
		),
	},
];
