// Comments on the timeline.
//
// A note pinned to a moment, and optionally to a track. Two jobs:
//
//   - review, where somebody marks "this bit drags" against the frame it drags at
//   - narration, where a note says what should be *said* over a passage, which
//     `narrate_timeline` turns into speech
//
// They are anchored in timeline frames rather than seconds, because everything
// else on the timeline is, and a comment that drifts against the cut it refers
// to is worse than no comment.
//
// Deliberately not clips. A comment has no duration on a track, cannot be
// trimmed, and must never affect what renders — putting them in the clip model
// would mean every reducer had to remember to ignore them.

/** A note pinned to a frame, and optionally to one track. */
export interface CommentModel {
	id: string;
	/** Timeline frame the note is pinned to. */
	frame: number;
	text: string;
	/** Track it belongs to. Absent means the whole timeline at that moment. */
	trackId?: string;
	/**
	 * How long the note covers, in frames. Zero is a point marker; a span is
	 * what narration needs, because a line of speech covers a passage.
	 */
	durationFrames: number;
	/** Who wrote it — "you" or the agent. Shown, never acted on. */
	author: "user" | "agent";
	/** ISO timestamp, for ordering notes written at the same frame. */
	createdAt: string;
	/** Marked done. Kept rather than deleted, so a review trail survives. */
	resolved?: boolean;
	/**
	 * The speech generated from this note, if any.
	 *
	 * A comment is the script; this is the take. Held here rather than on the
	 * audio clip so re-generating a line replaces it in one place, and so a
	 * comment whose text changed can be seen to be out of date.
	 */
	voice?: {
		/** Asset holding the rendered speech. */
		assetId: string;
		/** The text it was generated from — if it differs, the take is stale. */
		fromText: string;
		voiceId: string;
	};
}

export interface CommentSeed {
	frame: number;
	text: string;
	trackId?: string;
	durationFrames?: number;
	author?: CommentModel["author"];
}

let counter = 0;

export function createComment(seed: CommentSeed): CommentModel {
	counter += 1;
	return {
		id: `note-${counter.toString(36)}-${Math.round(seed.frame)}`,
		frame: Math.max(0, Math.round(seed.frame)),
		text: seed.text.trim(),
		...(seed.trackId ? { trackId: seed.trackId } : {}),
		durationFrames: Math.max(0, Math.round(seed.durationFrames ?? 0)),
		author: seed.author ?? "user",
		createdAt: new Date().toISOString(),
	};
}

/** Earliest first, and stably ordered for notes sharing a frame. */
export function sortComments(comments: readonly CommentModel[]): CommentModel[] {
	return [...comments].sort(
		(a, b) =>
			a.frame - b.frame || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
}

/** The notes on one track, plus the timeline-wide ones when asked. */
export function commentsForTrack(
	comments: readonly CommentModel[],
	trackId: string,
	includeUnpinned = false,
): CommentModel[] {
	return sortComments(
		comments.filter(
			(comment) =>
				comment.trackId === trackId || (includeUnpinned && comment.trackId === undefined),
		),
	);
}

/** Whether a comment covers a frame. A point marker covers only its own frame. */
export function commentCovers(comment: CommentModel, frame: number): boolean {
	if (comment.durationFrames <= 0) return Math.round(frame) === comment.frame;
	return frame >= comment.frame && frame < comment.frame + comment.durationFrames;
}

/**
 * A comment's speech is stale when the text has moved on since it was spoken.
 *
 * Silently keeping the old audio would mean the timeline says one thing and
 * sounds like another, which is the kind of mismatch nobody notices until
 * export.
 */
export function voiceIsStale(comment: CommentModel): boolean {
	return Boolean(comment.voice && comment.voice.fromText !== comment.text);
}

/** Every note that should be spoken, in order, skipping resolved ones. */
export function narratableComments(comments: readonly CommentModel[]): CommentModel[] {
	return sortComments(comments).filter(
		(comment) => !comment.resolved && comment.text.trim().length > 0,
	);
}

/**
 * Shifts notes when frames are inserted or removed before them.
 *
 * A ripple edit that moved the clips but left the notes behind would leave
 * every note after the edit pointing at the wrong moment — which is exactly how
 * review notes stop being trusted.
 */
export function shiftComments(
	comments: readonly CommentModel[],
	atFrame: number,
	deltaFrames: number,
): CommentModel[] {
	if (deltaFrames === 0) return [...comments];
	return comments.map((comment) =>
		comment.frame >= atFrame
			? { ...comment, frame: Math.max(0, comment.frame + deltaFrames) }
			: comment,
	);
}

/** Parses stored notes, dropping anything malformed rather than throwing. */
export function parseComments(value: unknown): CommentModel[] {
	if (!Array.isArray(value)) return [];
	const out: CommentModel[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Partial<CommentModel>;
		if (typeof entry.id !== "string" || typeof entry.text !== "string") continue;
		if (typeof entry.frame !== "number" || !Number.isFinite(entry.frame)) continue;
		out.push({
			id: entry.id,
			frame: Math.max(0, Math.round(entry.frame)),
			text: entry.text,
			...(typeof entry.trackId === "string" ? { trackId: entry.trackId } : {}),
			durationFrames:
				typeof entry.durationFrames === "number" && Number.isFinite(entry.durationFrames)
					? Math.max(0, Math.round(entry.durationFrames))
					: 0,
			author: entry.author === "agent" ? "agent" : "user",
			createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
			...(entry.resolved ? { resolved: true } : {}),
			...(entry.voice && typeof entry.voice.assetId === "string"
				? {
						voice: {
							assetId: entry.voice.assetId,
							fromText:
								typeof entry.voice.fromText === "string"
									? entry.voice.fromText
									: "",
							voiceId:
								typeof entry.voice.voiceId === "string" ? entry.voice.voiceId : "",
						},
					}
				: {}),
		});
	}
	return sortComments(out);
}
