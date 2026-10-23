// Finding retakes in a talking-head transcript.
//
// Nobody records a talking-head video in one go. They start a line, stumble,
// and start it again: "so today we're — so today we're going to look at…".
// The finished edit keeps the last attempt and cuts the earlier ones, and
// finding them is the most tedious part of the job: scrubbing for the moment
// a sentence starts over.
//
// In a transcript it's a pattern: an opening of a few words that recurs a
// moment later. The earlier attempt runs from its opening up to where the
// next attempt begins, and that span is what goes. Immediate stutters ("the
// the", "I think I think") are the same thing at the scale of a phrase.

export interface RetakeWord {
	index: number;
	text: string;
	startFrame: number;
	endFrame: number;
}

export interface Retake {
	kind: "restart" | "stutter";
	/** Inclusive transcript indices to remove — the abandoned attempt. */
	removeFrom: number;
	removeTo: number;
	/** What was abandoned, and the attempt that's kept, for the report. */
	removedText: string;
	keptText: string;
	startFrame: number;
	endFrame: number;
}

export interface RetakeOptions {
	fps: number;
	/** How many opening words must match to call it a restart. Default 3. */
	minMatch?: number;
	/** How far ahead (seconds) a restart can come. Default 25. */
	maxGapSeconds?: number;
}

/** Words compared without case or punctuation: "Today," and "today" are the same word. */
export function normalizeWord(text: string): string {
	return text
		.toLowerCase()
		.replace(/[’']/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Where sentences start: the first word, and every word after a full stop or a long pause. */
export function sentenceStarts(words: readonly RetakeWord[], fps: number): number[] {
	const starts: number[] = [];
	for (let position = 0; position < words.length; position++) {
		if (position === 0) {
			starts.push(position);
			continue;
		}
		const previous = words[position - 1];
		const endsSentence = /[.!?…]["')\]]*$/.test(previous.text.trim());
		const pause = (words[position].startFrame - previous.endFrame) / fps > 0.6;
		if (endsSentence || pause) starts.push(position);
	}
	return starts;
}

function textOf(words: readonly RetakeWord[], from: number, to: number): string {
	return words
		.slice(from, to + 1)
		.map((word) => word.text)
		.join(" ")
		.trim();
}

/**
 * Finds abandoned attempts. Positions in the returned spans are transcript
 * indices (word.index), ready for remove_words. Spans never overlap: when two
 * restarts chain (three attempts at one line), both earlier attempts go.
 */
export function findRetakes(words: readonly RetakeWord[], options: RetakeOptions): Retake[] {
	const minMatch = Math.max(2, options.minMatch ?? 3);
	const maxGap = (options.maxGapSeconds ?? 25) * options.fps;
	const norm = words.map((word) => normalizeWord(word.text));
	const found: Retake[] = [];
	const claimed = new Set<number>();

	// Restarts: a sentence opening that recurs within the window.
	const starts = sentenceStarts(words, options.fps);
	for (let s = 0; s < starts.length; s++) {
		const first = starts[s];
		if (claimed.has(first)) continue;
		for (let t = s + 1; t < starts.length; t++) {
			const second = starts[t];
			if (words[second].startFrame - words[first].startFrame > maxGap) break;
			let length = 0;
			while (
				first + length < second &&
				second + length < words.length &&
				norm[first + length] &&
				norm[first + length] === norm[second + length]
			) {
				length += 1;
			}
			if (length < minMatch) continue;
			// The abandoned attempt is everything from its start to the restart.
			const last = second - 1;
			for (let position = first; position <= last; position++) claimed.add(position);
			found.push({
				kind: "restart",
				removeFrom: words[first].index,
				removeTo: words[last].index,
				removedText: textOf(words, first, last),
				keptText: textOf(
					words,
					second,
					Math.min(words.length - 1, second + Math.max(minMatch, 7)),
				),
				startFrame: words[first].startFrame,
				endFrame: words[last].endFrame,
			});
			break;
		}
	}

	// Stutters: a 1–4 word phrase said twice in a row ("I think I think").
	for (let position = 0; position < words.length; position++) {
		if (claimed.has(position)) continue;
		for (let size = 4; size >= 1; size--) {
			const end = position + size * 2;
			if (end > words.length) continue;
			let repeated = true;
			for (let offset = 0; offset < size; offset++) {
				const a = norm[position + offset];
				const b = norm[position + size + offset];
				if (
					!a ||
					a !== b ||
					claimed.has(position + offset) ||
					claimed.has(position + size + offset)
				) {
					repeated = false;
					break;
				}
			}
			// A single repeated short word is often deliberate ("very very", "no no").
			if (
				!repeated ||
				(size === 1 && norm[position].length <= 2 && !["i", "a"].includes(norm[position]))
			)
				continue;
			if (size === 1 && ["very", "no", "yes", "so"].includes(norm[position])) continue;
			const last = position + size - 1;
			for (let index = position; index <= last; index++) claimed.add(index);
			found.push({
				kind: "stutter",
				removeFrom: words[position].index,
				removeTo: words[last].index,
				removedText: textOf(words, position, last),
				keptText: textOf(
					words,
					position + size,
					Math.min(words.length - 1, position + size * 2 + 3),
				),
				startFrame: words[position].startFrame,
				endFrame: words[last].endFrame,
			});
			position = last;
			break;
		}
	}

	return found.sort((a, b) => a.startFrame - b.startFrame);
}
