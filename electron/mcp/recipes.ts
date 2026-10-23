// Recipes: proven edit plans for creators, served as MCP prompts.
//
// A creator shouldn't have to know that a talking-head edit is "cut silences,
// then fillers, then punch-ins, then captions, then loudness" — or in which
// order, or that punch-ins must come after the cuts. MCP clients show prompts
// as slash commands (Claude Desktop, Claude Code, Cursor, …), so each recipe
// becomes one command that hands the agent a complete, ordered plan written
// in Rendr's own tool names. The agent still does the work, and still asks
// when taste is involved; the recipe just means it starts from a good plan.

export interface RecipeArgument {
	name: string;
	description: string;
	required?: boolean;
}

export interface Recipe {
	name: string;
	title: string;
	description: string;
	arguments: RecipeArgument[];
	build(args: Record<string, string>): string;
}

const MEDIA_ARG: RecipeArgument = {
	name: "media",
	description:
		"Which footage: an asset id or file name from get_media. Omit to use what's on the timeline.",
};

const which = (args: Record<string, string>) =>
	args.media
		? `the footage "${args.media}"`
		: "the footage on the active timeline (or the newest video in get_media if the timeline is empty)";

export const RECIPES: Recipe[] = [
	{
		name: "edit_talking_head",
		title: "Edit a talking-head video",
		description:
			"Cut pauses and filler words, punch in on the cuts, caption it, and level the audio for YouTube.",
		arguments: [
			MEDIA_ARG,
			{
				name: "style",
				description:
					"Caption look: 'bold' for Shorts-style word-by-word, 'clean' for YouTube. Default clean.",
			},
			{
				name: "music",
				description: "A music asset to put underneath, ducked under the voice. Optional.",
			},
		],
		build: (args) => `Edit ${which(args)} into a tight, watchable talking-head video in Rendr.

1. get_timeline, then get_media. If the footage isn't on a timeline yet, add_clips it at frame 0.
2. analyze_footage on the footage asset — it tells you whether it's really a talking head and where the face is.
3. remove_silence to cut the dead air (preview first if it's long), then get_transcript and remove_words for filler words ("um", "uh", "like", false starts and repeated takes — keep the LAST take of a repeated sentence).
4. add_punch_ins (style 'cut', amount ~1.15) so every other cut punches in on the face.
5. add_captions, then style_captions with the ${args.style === "bold" ? "bold, word-by-word Shorts look" : "clean, readable YouTube look"}.
6. normalize_audio to -14 LUFS.${args.music ? ` Add "${args.music}" on an audio track under the whole edit at about -18 dB, then duck_audio under the speech.` : ""}
7. view_frame at three points (start, middle, a punched-in segment) and check framing and captions with your own eyes before saying it's done.
8. Tell me what you cut (how many seconds, how many fillers) in one or two sentences, and ask before exporting.`,
	},
	{
		name: "make_short",
		title: "Make a Short / Reel / TikTok",
		description:
			"Find the best 30–60 seconds, reframe to 9:16 on the speaker, caption it word by word, export for Shorts/Reels/TikTok.",
		arguments: [
			MEDIA_ARG,
			{ name: "length", description: "Target length in seconds. Default 45." },
			{ name: "platform", description: "shorts, reels or tiktok. Default shorts." },
		],
		build: (
			args,
		) => `Turn ${which(args)} into a ${args.length ?? "45"}-second vertical clip for ${args.platform ?? "YouTube Shorts"}.

1. get_timeline and get_media. analyze_footage on the source so the vertical crop can follow the speaker's face.
2. get_transcript. Read it and pick the single strongest self-contained moment — a hook in the first 2 seconds, one idea, a clean ending. Tell me the line it opens on and why, in one sentence.
3. create_timeline for the Short (keep the original untouched), place just that span, and tighten it: remove_silence, then remove_words for fillers.
4. reframe_timeline to 9:16 — with the face track it frames the speaker, face in the upper third.
5. add_punch_ins (amount ~1.12) for energy on the cuts.
6. add_captions with 1–3 words per caption in the bold Shorts style, kept above the bottom fifth of the frame where the app's buttons sit.
7. normalize_audio to -14 LUFS.
8. view_frame at the hook, the middle and the end; fix anything cropped or covered.
9. Ask me, then export_project with preset '${args.platform ?? "shorts"}'.`,
	},
	{
		name: "explainer_look",
		title: "Creator explainer look",
		description:
			"Speaker cut out over a solid colour, with an animated mind map of the key ideas behind them and a QR code.",
		arguments: [
			MEDIA_ARG,
			{ name: "color", description: "Backdrop colour. Default deep green #0B4F3C." },
			{
				name: "topics",
				description:
					"Comma-separated ideas for the mind map. Default: pull 4–7 from the transcript.",
			},
			{ name: "link", description: "URL for a QR code in the corner. Optional." },
		],
		build: (
			args,
		) => `Give ${which(args)} the creator explainer look: the speaker cut out over a solid ${args.color ?? "#0B4F3C"} backdrop, an animated mind map of the ideas behind them${args.link ? ", and a QR code" : ""}.

1. get_timeline, get_media, then analyze_footage on the footage (this makes the person matte and face track; it can take a minute — call it again if it says 'running').
2. remove_background with mode 'color', color '${args.color ?? "#0B4F3C"}'.
3. ${args.topics ? `Use these topics: ${args.topics}.` : "get_transcript and choose 4–7 short topic words (one or two words each) in the order they're discussed."}
${args.link ? `4. add_graphic template 'qr' with data '${args.link}' and a short label like 'Scan me', in a top corner. Add it BEFORE the mind map so the map lays out around it.\n` : ""}${args.link ? "5" : "4"}. add_graphic template 'mind_map' with those nodes, linking related ideas. It goes BEHIND the speaker automatically, lasts as long as the footage, and the backdrop colour moves to its own track beneath it; cards are laid out around the speaker's face.
${args.link ? "6" : "5"}. Ideally time each card to appear when it's first mentioned: use the transcript times and pass a custom 'at' per card (template 'custom') if the default stagger doesn't match.
${args.link ? "7" : "6"}. view_frame after the last card lands and check nothing covers the face.`,
	},
	{
		name: "clean_audio",
		title: "Clean up the audio",
		description: "Denoise, level to platform loudness, and duck music under the voice.",
		arguments: [
			{
				name: "target",
				description: "Loudness target in LUFS. Default -14 (YouTube); -16 for podcasts.",
			},
		],
		build: (args) => `Make the audio on the active timeline sound professional.

1. get_timeline. measure_audio to see where it stands (integrated LUFS and true peak).
2. denoise_audio on the voice clips if there's audible hiss or room noise (listen-check by measuring before and after).
3. normalize_audio to ${args.target ?? "-14"} LUFS with a -1 dBTP ceiling. If it reports a shortfall, tell me — Rendr won't clip to hit the number.
4. If there's music, duck_audio with under 'speech' so it drops whenever the speaker talks.
5. measure_audio again and report the before/after in one sentence.`,
	},
	{
		name: "add_key_points",
		title: "Add key-point graphics",
		description:
			"Pull the key points from what's said and show them as animated cards at the right moments.",
		arguments: [MEDIA_ARG, { name: "count", description: "How many points. Default 3." }],
		build: (args) => `Add animated key-point cards to ${which(args)}.

1. get_timeline and get_transcript.
2. Pick the ${args.count ?? "3"} key points, each a short phrase (2–5 words), and the moment each is first said.
3. For each, add_graphic template 'callout' (or one 'key_points' list that builds up) starting at that moment's frame, placed away from the speaker's face (analyze_footage first if there's no face track).
4. view_frame on each to check the cards are readable and clear of the face.`,
	},
];

export function findRecipe(name: string): Recipe | undefined {
	return RECIPES.find((recipe) => recipe.name === name);
}

/** The prompts/list shape MCP clients expect. */
export function listPrompts() {
	return RECIPES.map(({ name, title, description, arguments: args }) => ({
		name,
		title,
		description,
		arguments: args,
	}));
}

/** The prompts/get shape: one user message carrying the plan. */
export function getPrompt(name: string, args: Record<string, unknown> = {}) {
	const recipe = findRecipe(name);
	if (!recipe) return null;
	const strings = Object.fromEntries(
		Object.entries(args)
			.filter(([, value]) => typeof value === "string" && value.trim())
			.map(([key, value]) => [key, (value as string).trim()]),
	);
	return {
		description: recipe.description,
		messages: [{ role: "user", content: { type: "text", text: recipe.build(strings) } }],
	};
}
