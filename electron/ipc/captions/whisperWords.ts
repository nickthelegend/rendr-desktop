// Word timing from whisper.cpp's full JSON output (`-ojf`).
//
// whisper.cpp reports BPE tokens, not words: " tim" + "est" + "amps" is one
// word, "'re" belongs to the "we" before it, and "," arrives as its own token
// with a zero-length span. A leading space is what marks the start of a word,
// so tokens are glued together until the next one that carries a space.
// Punctuation attaches to the word it follows (or, for an opening bracket or
// quote, to the word it precedes) without stretching that word's timing — a
// comma's timestamp is where the pause is, not where the word ended.
//
// Kept free of Electron imports so it can be tested against real captured
// output without a main process.

export interface WhisperToken {
	text: string;
	/** Milliseconds from the start of the audio, or null when whisper gave none. */
	fromMs: number | null;
	toMs: number | null;
}

export interface WhisperWord {
	text: string;
	startMs: number;
	endMs: number;
	/** True when the word was preceded by a space in whisper's output. */
	leadingSpace: boolean;
}

/** `[_BEG_]`, `[_TT_240]`, `[_SOT_]`, `<|endoftext|>` — control tokens, not speech. */
const SPECIAL_TOKEN = /^(\[_[^\]]*\]|<\|[^|]*\|>)$/;
/** No letter or digit anywhere: punctuation, quotes, dashes. */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;
/** Punctuation that opens something, so it belongs to the next word. */
const OPENING_PUNCTUATION = /^[([{"'“‘«¿¡]+$/;
/** Music glyphs and asterisks are how whisper marks sound that isn't speech. */
const NON_SPEECH_GLYPHS = /^[♪♫*\s]+$/;
/** A whole segment that is one annotation, e.g. " [BLANK_AUDIO]" or " (upbeat music)". */
const ANNOTATION_SEGMENT = /^\s*(\[[^\]]*\]|\([^)]*\)|[♪♫*\s]+)\s*$/;

/** How long a word whisper gave no duration to is held, at most. */
const MIN_WORD_MS = 100;

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Glues sub-word tokens into words.
 *
 * Bracketed and parenthesised runs are dropped: whisper writes "[BLANK_AUDIO]",
 * "(laughs)" or "[Music]" for sound it heard but nobody said, and a caption or
 * a remove_words index should only ever contain speech.
 */
export function mergeWhisperTokens(tokens: readonly WhisperToken[]): WhisperWord[] {
	const words: WhisperWord[] = [];
	// Opening punctuation waiting for the word it belongs to.
	let prefix = "";
	let prefixSpace = false;
	// A space seen at the end of one token still starts the next word.
	let spacePending = false;

	for (const token of tokens) {
		if (!token.text || SPECIAL_TOKEN.test(token.text.trim())) continue;

		// A token is normally " word" or "word", but nothing guarantees it, so
		// whitespace inside one is honoured as a word break too.
		for (const part of token.text.match(/\s+|\S+/g) ?? []) {
			if (/^\s+$/.test(part)) {
				spacePending = true;
				continue;
			}
			const startsWord = spacePending || words.length === 0;
			spacePending = false;
			const previous = words[words.length - 1];

			if (PUNCTUATION_ONLY.test(part)) {
				if (startsWord && OPENING_PUNCTUATION.test(part)) {
					if (!prefix) prefixSpace = words.length > 0;
					prefix += part;
				} else if (prefix) {
					// `("` — still opening, still waiting for its word.
					prefix += part;
				} else if (previous) {
					// Closing punctuation, or a hyphen joining "word-level": it
					// belongs to the word before, and leaves its timing alone. The
					// piece after an unspaced hyphen carries no space either, so it
					// continues the same word.
					previous.text += part;
				}
				continue;
			}

			const fromMs = token.fromMs ?? previous?.endMs ?? 0;
			const toMs = Math.max(fromMs, token.toMs ?? fromMs);
			if (startsWord || prefix || !previous) {
				words.push({
					text: prefix + part,
					startMs: fromMs,
					endMs: toMs,
					leadingSpace: prefix ? prefixSpace : startsWord && words.length > 0,
				});
				prefix = "";
				prefixSpace = false;
			} else {
				previous.text += part;
				previous.endMs = Math.max(previous.endMs, toMs);
			}
		}
	}

	return dropNonSpeech(words).map((word, index, all) => {
		// A one-token word whisper timed as an instant would flash in karaoke;
		// hold it until the next word starts, within reason.
		if (word.endMs > word.startMs) return word;
		const next = all[index + 1];
		const until =
			next && next.startMs > word.startMs ? next.startMs : word.startMs + MIN_WORD_MS;
		return { ...word, endMs: Math.min(until, word.startMs + MIN_WORD_MS * 5) };
	});
}

function dropNonSpeech(words: readonly WhisperWord[]): WhisperWord[] {
	const kept: WhisperWord[] = [];
	let closing: string | null = null;
	for (const word of words) {
		if (closing) {
			if (word.text.includes(closing)) closing = null;
			continue;
		}
		if (NON_SPEECH_GLYPHS.test(word.text)) continue;
		const opener = word.text[0];
		if (opener === "[" || opener === "(") {
			const close = opener === "[" ? "]" : ")";
			if (!word.text.includes(close)) closing = close;
			continue;
		}
		kept.push(word);
	}
	return kept;
}

/**
 * Reads one segment's `tokens` array. Returns null when a speech token has no
 * timing, so a caller that needs real timing can fall back instead of being
 * handed guesses dressed up as measurements.
 */
export function readWhisperTokens(raw: unknown): WhisperToken[] | null {
	if (!Array.isArray(raw)) return null;
	const tokens: WhisperToken[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const token = entry as { text?: unknown; offsets?: { from?: unknown; to?: unknown } };
		if (typeof token.text !== "string" || !token.text) continue;
		const fromMs = finite(token.offsets?.from);
		const toMs = finite(token.offsets?.to);
		if ((fromMs === null || toMs === null) && !SPECIAL_TOKEN.test(token.text.trim())) {
			return null;
		}
		tokens.push({ text: token.text, fromMs, toMs });
	}
	return tokens;
}

/**
 * Every spoken word in a whisper.cpp `-ojf` transcript, in order.
 *
 * Tokens are merged across segment boundaries rather than per segment, because
 * whisper occasionally ends a segment mid-word and the next one carries on
 * without a space. Returns an empty list for a transcript with no token timing
 * (output written without `-ojf`, or unparseable JSON).
 */
export function parseWhisperFullJsonWords(content: string): WhisperWord[] {
	let parsed: { transcription?: unknown };
	try {
		parsed = JSON.parse(content) as typeof parsed;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed.transcription)) return [];

	const tokens: WhisperToken[] = [];
	for (const segment of parsed.transcription) {
		if (!segment || typeof segment !== "object") continue;
		const data = segment as { text?: unknown; tokens?: unknown };
		if (typeof data.text === "string" && ANNOTATION_SEGMENT.test(data.text)) continue;
		const segmentTokens = readWhisperTokens(data.tokens);
		if (!segmentTokens) return [];
		tokens.push(...segmentTokens);
	}
	return mergeWhisperTokens(tokens);
}
