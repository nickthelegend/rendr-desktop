// The order transcription engines are tried in.
//
// What is being pinned: a local model with word timing answers without the
// network ever being touched, and the cue-only fallback is used only when
// nothing better is available — because cue timing means guessed karaoke.

import { describe, expect, it, vi } from "vitest";

import { NO_ENGINE_REASON, runTranscriptionEngines } from "./transcribeEngines";

const word = { text: "hey", startMs: 0, endMs: 200 };
const cue = { id: "1", startMs: 0, endMs: 1000, text: "hey there" };

describe("choosing a transcription engine", () => {
	it("uses local whisper.cpp word timing and never calls hyperframes", async () => {
		const hyperframes = vi.fn(async () => [word]);
		const result = await runTranscriptionEngines({
			local: async () => ({ words: [word], cues: [cue] }),
			hyperframes,
		});
		expect(result).toEqual({ ok: true, words: [word], engine: "whisper.cpp" });
		expect(hyperframes).not.toHaveBeenCalled();
	});

	it("falls back to hyperframes when there is no local model", async () => {
		const result = await runTranscriptionEngines({
			local: async () => null,
			hyperframes: async () => [word],
		});
		expect(result.engine).toBe("hyperframes");
		expect(result.words).toEqual([word]);
	});

	it("prefers hyperframes words over local cue-only timing", async () => {
		const result = await runTranscriptionEngines({
			local: async () => ({ words: [], cues: [cue] }),
			hyperframes: async () => [word],
		});
		expect(result.engine).toBe("hyperframes");
	});

	it("keeps local cues when hyperframes can't run", async () => {
		const result = await runTranscriptionEngines({
			local: async () => ({ words: [], cues: [cue] }),
			hyperframes: async () => null,
		});
		expect(result).toEqual({ ok: true, cues: [cue], engine: "whisper.cpp" });
	});

	it("reports silence as silence without asking the network", async () => {
		const hyperframes = vi.fn(async () => null);
		const result = await runTranscriptionEngines({
			local: async () => ({ words: [], cues: [] }),
			hyperframes,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/no speech/i);
		expect(hyperframes).not.toHaveBeenCalled();
	});

	it("says how to get an engine when none is available", async () => {
		const result = await runTranscriptionEngines({
			local: async () => null,
			hyperframes: async () => null,
		});
		expect(result).toEqual({ ok: false, reason: NO_ENGINE_REASON });
	});
});
