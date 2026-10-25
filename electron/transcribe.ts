// Transcription.
//
// Engines, tried in the order transcribeEngines.ts sets out:
//
//   1. whisper.cpp with full JSON output (`-ojf`), which carries per-token
//      timestamps that whisperWords.ts merges into words. Fully offline once a
//      model is on disk, so it goes first whenever one is.
//   2. `hyperframes transcribe`, which also returns word-level timestamps but
//      runs through npx and so needs the network on first use.
//   3. whisper.cpp's cue-level timing, when the runtime is too old for `-ojf`
//      and hyperframes isn't reachable. Karaoke timing is then inferred from
//      character counts, which drifts — hence last.
//
// Word timing is what karaoke captions and remove_words actually need. All of
// these run locally; no audio leaves the machine either way.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ipcMain } from "electron";

import { resolveWhisperExecutablePath } from "./ipc/captions/generate";
import { parseWhisperJsonCues, shouldRetryWhisperWithoutJson } from "./ipc/captions/parser";
import { getWhisperSmallModelStatus } from "./ipc/captions/whisper";
import { parseWhisperFullJsonWords } from "./ipc/captions/whisperWords";
import { getFfmpegBinaryPath } from "./ipc/ffmpeg/binary";
import {
	type LocalTranscript,
	runTranscriptionEngines,
	type TranscribedWord,
	type TranscribeResult,
} from "./transcribeEngines";

export type { TranscribedWord, TranscribeResult } from "./transcribeEngines";

export const TRANSCRIBE_CHANNEL = "rendr-transcribe:run";

function run(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

/** whisper.cpp wants 16 kHz mono PCM; anything else it mis-hears. */
async function toWhisperWav(inputPath: string, outputPath: string): Promise<void> {
	const result = await run(getFfmpegBinaryPath(), [
		"-y",
		"-i",
		inputPath,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-c:a",
		"pcm_s16le",
		outputPath,
	]);
	if (result.code !== 0) {
		throw new Error(
			result.stderr.split("\n").slice(-3).join(" ").trim() || "audio extraction failed",
		);
	}
}

/**
 * hyperframes writes a sidecar of `{text, start, end}` in seconds, one entry
 * per word, and reports its path on stdout as JSON.
 */
async function transcribeWithHyperframes(
	audioPath: string,
	workDir: string,
): Promise<TranscribedWord[] | null> {
	let result: Awaited<ReturnType<typeof run>>;
	try {
		result = await run("npx", ["--yes", "hyperframes", "transcribe", audioPath, "--json"], {
			cwd: workDir,
		});
	} catch {
		// No npx on PATH (a packaged app launched from the Dock often has none).
		return null;
	}
	if (result.code !== 0) return null;

	const line = result.stdout
		.split("\n")
		.reverse()
		.find((entry) => entry.trim().startsWith("{"));
	if (!line) return null;

	let envelope: { ok?: boolean; transcriptPath?: string };
	try {
		envelope = JSON.parse(line) as typeof envelope;
	} catch {
		return null;
	}
	if (!envelope.ok || !envelope.transcriptPath) return null;

	try {
		const raw = await fs.readFile(envelope.transcriptPath, "utf8");
		const entries = JSON.parse(raw) as Array<{ text?: string; start?: number; end?: number }>;
		const words = entries
			.filter(
				(entry) =>
					typeof entry.text === "string" &&
					typeof entry.start === "number" &&
					typeof entry.end === "number",
			)
			.map((entry) => ({
				text: (entry.text as string).trim(),
				startMs: (entry.start as number) * 1000,
				endMs: (entry.end as number) * 1000,
			}))
			// A transcript of silence comes back as music glyphs, not speech.
			.filter((word) => word.text.length > 0 && !/^[♪♫\s]+$/.test(word.text));
		return words.length > 0 ? words : null;
	} catch {
		return null;
	}
}

/**
 * A whisper.cpp model already on this machine, if there is one.
 *
 * Recordly's own download comes first. After that, the model hyperframes
 * fetched for itself: it is the same ggml format, and reusing it means a
 * creator who has transcribed once with hyperframes never needs the network
 * for it again, nor a second half-gigabyte copy of the same model.
 */
async function findLocalWhisperModel(): Promise<string | null> {
	const recordly = await getWhisperSmallModelStatus();
	if (recordly?.exists && recordly.path) return recordly.path;

	const candidates: string[] = [];
	const override = process.env["WHISPER_CPP_MODEL"]?.trim();
	if (override) candidates.push(override);

	const hyperframesDir = path.join(os.homedir(), ".cache", "hyperframes", "whisper", "models");
	try {
		const entries = (await fs.readdir(hyperframesDir)).filter((name) =>
			/^ggml-.+\.bin$/.test(name),
		);
		// Small first: it is the size Recordly ships, and the accuracy/speed
		// balance the rest of the caption pipeline was tuned against.
		entries.sort((a, b) => Number(b.includes("small")) - Number(a.includes("small")));
		candidates.push(...entries.map((name) => path.join(hyperframesDir, name)));
	} catch {
		// No hyperframes cache.
	}

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			// An interrupted download is a truncated file whisper would refuse to
			// load, so it isn't offered. The smallest real model is ~75 MB.
			if (stat.isFile() && stat.size > 10 * 1024 * 1024) return candidate;
		} catch {
			// Missing or unreadable — try the next one.
		}
	}
	return null;
}

/**
 * whisper.cpp, offline, with token timestamps merged into words.
 *
 * Null means it couldn't run at all (no model, no binary, or it failed). An
 * outcome with no words and no cues means it ran and heard no speech.
 */
async function transcribeWithWhisperCpp(
	wavPath: string,
	workDir: string,
): Promise<LocalTranscript | null> {
	const modelPath = await findLocalWhisperModel();
	if (!modelPath) return null;

	let whisper: string;
	try {
		whisper = await resolveWhisperExecutablePath();
	} catch {
		// It throws, rather than returning null, when nothing is installed.
		return null;
	}

	const outputBase = path.join(workDir, "whisper");
	const baseArgs = [
		"-m",
		modelPath,
		"-f",
		wavPath,
		"-of",
		outputBase,
		"-np",
		// An English-only model can't detect a language; a multilingual one
		// should, rather than transcribing every creator as English.
		"-l",
		/\.en\.bin$/i.test(modelPath) ? "en" : "auto",
		"-t",
		String(Math.max(1, Math.min(8, os.cpus().length))),
	];

	let result: Awaited<ReturnType<typeof run>>;
	try {
		result = await run(whisper, [...baseArgs, "-ojf"]);
		if (result.code !== 0 && shouldRetryWhisperWithoutJson(result.stderr)) {
			// A runtime from before `-ojf` still writes plain JSON with cue timing.
			result = await run(whisper, [...baseArgs, "-oj"]);
		}
	} catch {
		return null;
	}
	if (result.code !== 0) return null;

	try {
		const raw = await fs.readFile(`${outputBase}.json`, "utf8");
		const words = parseWhisperFullJsonWords(raw).map(({ text, startMs, endMs }) => ({
			text,
			startMs,
			endMs,
		}));
		const cues = parseWhisperJsonCues(raw)
			// "[BLANK_AUDIO]" is whisper describing silence, not a line of speech.
			.filter((cue) => !/^\s*(\[[^\]]*\]|\([^)]*\)|[♪♫*\s]+)\s*$/.test(cue.text))
			.map((cue, index) => ({
				id: cue.id || String(index + 1),
				startMs: cue.startMs,
				endMs: cue.endMs,
				text: cue.text,
			}));
		return { words, cues };
	} catch {
		return null;
	}
}

export function registerTranscribe(): void {
	ipcMain.handle(
		TRANSCRIBE_CHANNEL,
		async (_event, bytes: ArrayBuffer, name: string): Promise<TranscribeResult> => {
			const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "rendr-stt-"));
			const sourcePath = path.join(workDir, `source${path.extname(name) || ".bin"}`);
			const wavPath = path.join(workDir, "audio.wav");

			try {
				await fs.writeFile(sourcePath, Buffer.from(bytes));
				// ffmpeg in the main process pulls the audio out of whatever the
				// container is, so the engines only ever see 16 kHz mono PCM.
				await toWhisperWav(sourcePath, wavPath);

				return await runTranscriptionEngines({
					local: () => transcribeWithWhisperCpp(wavPath, workDir),
					hyperframes: () => transcribeWithHyperframes(wavPath, workDir),
				});
			} catch (error) {
				return {
					ok: false,
					reason: error instanceof Error ? error.message : "Transcription failed.",
				};
			} finally {
				// Temp audio can be large; remove it whatever happened.
				await fs.rm(workDir, { recursive: true, force: true });
			}
		},
	);
}
