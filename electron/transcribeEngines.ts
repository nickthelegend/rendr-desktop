// Which transcription engine answers, and in what order.
//
// Kept apart from transcribe.ts, which owns the processes and the IPC, so the
// ordering — the part that decides whether a creator gets real word timing or
// guessed timing, and whether the network is touched at all — can be tested
// without spawning anything.

export interface TranscribedWord {
	text: string;
	startMs: number;
	endMs: number;
}

export interface TranscribedCue {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
}

export interface TranscribeResult {
	ok: boolean;
	/** Word-level timing when the engine provided it. */
	words?: TranscribedWord[];
	/** Cue-level fallback, when only cues were available. */
	cues?: TranscribedCue[];
	engine?: string;
	reason?: string;
}

/**
 * What the local whisper.cpp run produced. Null from the runner means it could
 * not run at all (no model, no binary, or it failed).
 */
export interface LocalTranscript {
	words: TranscribedWord[];
	cues: TranscribedCue[];
}

export const NO_ENGINE_REASON =
	"No transcription engine was available. Download the speech model in Settings (it works offline afterwards), or install the HyperFrames CLI (`npm i -g hyperframes`).";

/**
 * Local whisper.cpp first, because it needs nothing but a model on disk; then
 * hyperframes, which also gives word timing but goes through npx and so needs
 * the network the first time; then whisper's cue-level timing as a last resort.
 *
 * A local run that heard nothing at all is an answer, not a failure: asking
 * hyperframes to transcribe the same silence would only cost a network round
 * trip to be told the same thing.
 */
export async function runTranscriptionEngines(engines: {
	local: () => Promise<LocalTranscript | null>;
	hyperframes: () => Promise<TranscribedWord[] | null>;
}): Promise<TranscribeResult> {
	const local = await engines.local();
	if (local && local.words.length > 0) {
		return { ok: true, words: local.words, engine: "whisper.cpp" };
	}
	if (local && local.cues.length === 0) {
		return { ok: false, reason: "No speech was found in that clip." };
	}

	// Either no local model, or a runtime too old to time words: hyperframes can
	// still supply real word timing.
	const words = await engines.hyperframes();
	if (words && words.length > 0) return { ok: true, words, engine: "hyperframes" };

	if (local) return { ok: true, cues: local.cues, engine: "whisper.cpp" };
	return { ok: false, reason: NO_ENGINE_REASON };
}
