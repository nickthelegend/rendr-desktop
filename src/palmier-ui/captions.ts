// Captions: cues, subtitle files, and the caption clips they become.
//
// A cue is a span of speech with per-word timing. Cues come from three places:
// whisper (Electron only), an imported .srt/.vtt, or typing. Whichever the
// source, they land in the same shape, so everything downstream — the caption
// track, word-level editing, the karaoke animation — works the same way.

import { type ClipModel, DEFAULT_TEXT_STYLE, type TextAnimation, withDefaults } from "./model";
import type { TimelineModel, TrackModel } from "./reducers";

export interface CaptionWord {
	text: string;
	startMs: number;
	endMs: number;
}

export interface Cue {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
	/** Present when the source had word timing; karaoke needs it. */
	words?: CaptionWord[];
}

/** Ties every clip made from one transcription together. */
export type CaptionGroupId = string;

// ── Subtitle files ────────────────────────────────────────────────────

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

export function parseTimestamp(value: string): number | null {
	const match = SRT_TIME.exec(value.trim());
	if (!match) return null;
	const [, hours, minutes, seconds, fraction] = match;
	return (
		Number(hours) * 3_600_000 +
		Number(minutes) * 60_000 +
		Number(seconds) * 1000 +
		Number(fraction.padEnd(3, "0"))
	);
}

export function formatTimestamp(ms: number, separator: "," | "." = ","): string {
	const clamped = Math.max(0, Math.round(ms));
	const hours = Math.floor(clamped / 3_600_000);
	const minutes = Math.floor(clamped / 60_000) % 60;
	const seconds = Math.floor(clamped / 1000) % 60;
	const fraction = clamped % 1000;
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(fraction, 3)}`;
}

export class SubtitleParseError extends Error {}

/**
 * Parses SRT or WebVTT. The two differ mostly in a header and `.` versus `,`
 * in timestamps, so one parser covers both rather than two that drift.
 */
export function parseSubtitles(text: string): Cue[] {
	const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	const withoutHeader = body.startsWith("WEBVTT") ? body.slice(body.indexOf("\n") + 1) : body;

	const cues: Cue[] = [];
	for (const block of withoutHeader.split(/\n{2,}/)) {
		const lines = block.split("\n").filter((line) => line.trim().length > 0);
		if (lines.length === 0) continue;

		// An optional numeric or named index sits above the timing line.
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex < 0) continue;

		const [rawStart, rawEnd] = lines[timingIndex].split("-->");
		const startMs = parseTimestamp(rawStart ?? "");
		const endMs = parseTimestamp(rawEnd ?? "");
		if (startMs === null || endMs === null || endMs <= startMs) continue;

		const content = lines
			.slice(timingIndex + 1)
			.join("\n")
			// VTT inline tags carry styling this editor has its own model for.
			.replace(/<[^>]+>/g, "")
			.trim();
		if (!content) continue;

		cues.push({ id: `cue-${cues.length + 1}-${startMs}`, startMs, endMs, text: content });
	}

	if (cues.length === 0) {
		throw new SubtitleParseError("No cues found — is that an SRT or VTT file?");
	}
	return cues.sort((a, b) => a.startMs - b.startMs);
}

export function toSrt(cues: readonly Cue[]): string {
	return cues
		.map(
			(cue, index) =>
				`${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}\n`,
		)
		.join("\n");
}

export function toVtt(cues: readonly Cue[]): string {
	const body = cues
		.map(
			(cue) =>
				`${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n${cue.text}\n`,
		)
		.join("\n");
	return `WEBVTT\n\n${body}`;
}

// ── Cues → clips ──────────────────────────────────────────────────────

/** Splits a cue's text across its span when the source had no word timing. */
export function inferWordTiming(cue: Cue): CaptionWord[] {
	if (cue.words?.length) return cue.words;
	const tokens = cue.text.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [];

	// Weighted by length: longer words genuinely take longer to say, and an
	// even split makes karaoke drift audibly on any real sentence.
	const totalChars = tokens.reduce((sum, token) => sum + token.length, 0);
	const span = cue.endMs - cue.startMs;
	let cursor = cue.startMs;

	return tokens.map((token, index) => {
		const share = totalChars > 0 ? (token.length / totalChars) * span : span / tokens.length;
		const startMs = cursor;
		// The last word always lands exactly on the cue's end.
		const endMs = index === tokens.length - 1 ? cue.endMs : cursor + share;
		cursor = endMs;
		return { text: token, startMs, endMs };
	});
}

/**
 * Groups a flat word list into readable cues.
 *
 * A word-level transcript is unreadable as captions — one word per cue flashes
 * — so words are gathered until a sentence ends, a pause opens up, or the line
 * gets too long to read at a glance.
 */
export function groupWordsIntoCues(
	words: readonly CaptionWord[],
	options: { maxChars?: number; maxMs?: number; pauseMs?: number; maxWords?: number } = {},
): Cue[] {
	const maxChars = options.maxChars ?? 42;
	const maxMs = options.maxMs ?? 3500;
	const pauseMs = options.pauseMs ?? 700;
	// A word cap is what makes one-word-at-a-time captions possible; without one
	// the line-length rule decides, which is right for reading but not for pop-on.
	const maxWords = options.maxWords && options.maxWords > 0 ? options.maxWords : Infinity;

	const cues: Cue[] = [];
	let current: CaptionWord[] = [];

	const flush = () => {
		if (current.length === 0) return;
		cues.push({
			id: `cue-${cues.length + 1}`,
			startMs: current[0].startMs,
			endMs: current[current.length - 1].endMs,
			text: current.map((word) => word.text).join(" "),
			words: current,
		});
		current = [];
	};

	for (const word of words) {
		const previous = current[current.length - 1];
		const gap = previous ? word.startMs - previous.endMs : 0;
		const span = current.length > 0 ? word.endMs - current[0].startMs : 0;
		const chars = current.reduce((sum, w) => sum + w.text.length + 1, 0) + word.text.length;

		// A real pause, an over-long line, an over-long span, or a full caption
		// all break here.
		if (
			current.length > 0 &&
			(gap >= pauseMs || chars > maxChars || span > maxMs || current.length >= maxWords)
		) {
			flush();
		}
		current.push(word);
		// Sentence-final punctuation is the most natural break of all.
		if (/[.!?]["')\]]?$/.test(word.text)) flush();
	}
	flush();

	return cues;
}

const CAPTION_TRACK_NAME = "CC";

/** Style captions default to: legible over footage without being asked. */
const CAPTION_STYLE = {
	...DEFAULT_TEXT_STYLE,
	fontSize: 56,
	bold: true,
	alignment: "center" as const,
	animation: "karaoke" as TextAnimation,
};

export interface CaptionPlacement {
	timeline: TimelineModel;
	groupId: CaptionGroupId;
	clipCount: number;
}

/**
 * Turns cues into caption clips on their own track.
 *
 * Cue times are source milliseconds of the transcribed clip, so they map
 * through that clip's trim and speed the same way zoom regions do.
 */
export function placeCaptions(
	timeline: TimelineModel,
	cues: readonly Cue[],
	options: {
		groupId: CaptionGroupId;
		/** Maps a source millisecond to a timeline frame. */
		toFrame: (sourceMs: number) => number;
		style?: Partial<typeof CAPTION_STYLE>;
		centerY?: number;
	},
): CaptionPlacement {
	if (cues.length === 0) return { timeline, groupId: options.groupId, clipCount: 0 };

	const style = { ...CAPTION_STYLE, ...options.style };
	const centerY = options.centerY ?? 0.86;

	const clips: ClipModel[] = [];
	for (const cue of cues) {
		const startFrame = Math.max(0, Math.round(options.toFrame(cue.startMs)));
		const endFrame = Math.round(options.toFrame(cue.endMs));
		if (endFrame <= startFrame) continue;

		clips.push(
			withDefaults({
				id: `cap-${options.groupId}-${cue.id}`,
				name: cue.text.slice(0, 40),
				mediaType: "text",
				startFrame,
				endFrame,
				content: cue.text,
				textStyle: style,
				captionGroupId: options.groupId,
				captionWords: inferWordTiming(cue).map((word) => ({
					text: word.text,
					// Word timing is stored clip-relative so it survives moving.
					startFrame: Math.round(options.toFrame(word.startMs)) - startFrame,
					endFrame: Math.round(options.toFrame(word.endMs)) - startFrame,
				})),
				transform: {
					centerX: 0.5,
					centerY,
					width: 0.86,
					height: 0.2,
					rotation: 0,
					flipHorizontal: false,
					flipVertical: false,
				},
			}),
		);
	}

	if (clips.length === 0) return { timeline, groupId: options.groupId, clipCount: 0 };

	// Captions get their own track so they never fight the edit for space.
	const track: TrackModel = {
		id: `trk-cc-${options.groupId}`,
		name: CAPTION_TRACK_NAME,
		kind: "video",
		muted: false,
		hidden: false,
		clips: clips.sort((a, b) => a.startFrame - b.startFrame),
	};

	// Idempotent: a track for this group replaces the one that was there.
	//
	// Prepending unconditionally meant calling this twice produced two tracks
	// carrying the same id — which React renders with duplicate keys and the
	// compositor cannot tell apart, so the captions stopped appearing entirely.
	// A state updater is allowed to run more than once for one commit (React
	// does it in development), so "append once" is not a safe assumption; the
	// operation has to be safe to repeat.
	const withoutGroup = timeline.tracks.filter((entry) => entry.id !== track.id);

	return {
		timeline: { ...timeline, tracks: [track, ...withoutGroup] },
		groupId: options.groupId,
		clipCount: clips.length,
	};
}

/** Every caption clip belonging to one transcription. */
export function captionClips(timeline: TimelineModel, groupId: CaptionGroupId): ClipModel[] {
	return timeline.tracks
		.flatMap((track) => track.clips)
		.filter((clip) => clip.captionGroupId === groupId)
		.sort((a, b) => a.startFrame - b.startFrame);
}

export function captionGroups(timeline: TimelineModel): CaptionGroupId[] {
	const groups = new Set<CaptionGroupId>();
	for (const track of timeline.tracks) {
		for (const clip of track.clips) {
			if (clip.captionGroupId) groups.add(clip.captionGroupId);
		}
	}
	return [...groups];
}

/** Removes a whole caption group, and the track if it held nothing else. */
export function removeCaptionGroup(
	timeline: TimelineModel,
	groupId: CaptionGroupId,
): TimelineModel {
	const tracks = timeline.tracks
		.map((track) => ({
			...track,
			clips: track.clips.filter((clip) => clip.captionGroupId !== groupId),
		}))
		// A caption track with nothing left on it is noise.
		.filter((track) => !(track.id === `trk-cc-${groupId}` && track.clips.length === 0));
	return { ...timeline, tracks };
}

/** The transcript as one readable string, for reading rather than cutting. */
export function transcriptText(timeline: TimelineModel, groupId?: CaptionGroupId): string {
	const clips = timeline.tracks
		.flatMap((track) => track.clips)
		.filter((clip) => clip.captionGroupId && (!groupId || clip.captionGroupId === groupId))
		.sort((a, b) => a.startFrame - b.startFrame);
	return clips
		.map((clip) => clip.content ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Flat, globally indexed word list — what remove_words addresses. */
export interface TranscriptWord {
	index: number;
	text: string;
	clipId: string;
	startFrame: number;
	endFrame: number;
}

export function transcriptWords(
	timeline: TimelineModel,
	groupId?: CaptionGroupId,
): TranscriptWord[] {
	const clips = timeline.tracks
		.flatMap((track) => track.clips)
		.filter((clip) => clip.captionGroupId && (!groupId || clip.captionGroupId === groupId))
		.sort((a, b) => a.startFrame - b.startFrame);

	const words: TranscriptWord[] = [];
	for (const clip of clips) {
		for (const word of clip.captionWords ?? []) {
			words.push({
				index: words.length,
				text: word.text,
				clipId: clip.id,
				startFrame: clip.startFrame + word.startFrame,
				endFrame: clip.startFrame + word.endFrame,
			});
		}
	}
	return words;
}

/** Common filler tokens, for the one-click cleanup. */
const FILLER_WORDS = ["um", "uh", "erm", "hmm", "mmm", "ah", "eh"];

export function isFiller(text: string): boolean {
	return FILLER_WORDS.includes(text.toLowerCase().replace(/[^a-z]/gi, ""));
}

/**
 * Subtitles cut from the narration itself.
 *
 * The narration lines are the one transcript this app can be *certain* of —
 * the text is the script and the duration was measured off the rendered
 * audio — so subtitles come straight from them rather than from a speech
 * recogniser guessing at its own output. Word timing is inferred
 * length-weighted within each line, then regrouped into cues short enough to
 * read at a glance, and rendered with the karaoke per-word animation.
 */
export function narrationCues(
	lines: ReadonlyArray<{
		commentId: string;
		startFrame: number;
		seconds: number;
		text: string;
	}>,
	fps: number,
): Cue[] {
	const words: CaptionWord[] = [];
	for (const line of lines) {
		const startMs = (line.startFrame / fps) * 1000;
		words.push(
			...inferWordTiming({
				id: `narr-${line.commentId}`,
				startMs,
				endMs: startMs + line.seconds * 1000,
				text: line.text,
			}),
		);
	}
	// The gap between narration lines reads as a pause, so grouping never
	// merges two lines into one cue.
	return groupWordsIntoCues(words, { pauseMs: 500 });
}
