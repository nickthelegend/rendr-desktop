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
];
