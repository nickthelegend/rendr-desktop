// Transcription.
//
// Two engines, tried in order:
//
//   1. `hyperframes transcribe`, which returns WORD-level timestamps. That is
//      what karaoke captions actually need — without it, word timing has to be
//      guessed from character counts, and the highlight drifts off the speech.
//   2. Recordly's bundled whisper.cpp, which returns cue-level timing only.
//      Used when hyperframes isn't installed.
//
// Both run locally. No audio leaves the machine either way.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ipcMain } from "electron";

import { resolveWhisperExecutablePath } from "./ipc/captions/generate";
import { parseWhisperJsonCues } from "./ipc/captions/parser";
import { getWhisperSmallModelStatus } from "./ipc/captions/whisper";
import { getFfmpegBinaryPath } from "./ipc/ffmpeg/binary";

export const TRANSCRIBE_CHANNEL = "rendr-transcribe:run";

export interface TranscribedWord {
	text: string;
	startMs: number;
	endMs: number;
}

export interface TranscribeResult {
	ok: boolean;
	/** Word-level timing when the engine provided it. */
	words?: TranscribedWord[];
	/** Cue-level fallback, when only cues were available. */
	cues?: Array<{ id: string; startMs: number; endMs: number; text: string }>;
	engine?: string;
	reason?: string;
}

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
	const result = await run("npx", ["--yes", "hyperframes", "transcribe", audioPath, "--json"], {
		cwd: workDir,
	});
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

/** Recordly's bundled whisper.cpp. Cue-level timing only. */
async function transcribeWithWhisperCpp(wavPath: string): Promise<TranscribeResult["cues"] | null> {
	const model = await getWhisperSmallModelStatus();
	if (!model?.exists || !model.path) return null;

	const whisper = await resolveWhisperExecutablePath();
	if (!whisper) return null;

	const result = await run(whisper, [
		"-m",
		model.path,
		"-f",
		wavPath,
		"--output-json",
		"--max-len",
		"0",
	]);
	if (result.code !== 0) return null;

	try {
		const raw = await fs.readFile(`${wavPath}.json`, "utf8");
		const cues = parseWhisperJsonCues(raw);
		return cues.length > 0
			? cues.map((cue, index) => ({
					id: cue.id || String(index + 1),
					startMs: cue.startMs,
					endMs: cue.endMs,
					text: cue.text,
				}))
			: null;
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
				await toWhisperWav(sourcePath, wavPath);

				// Word timing first — it's what karaoke needs.
				const words = await transcribeWithHyperframes(wavPath, workDir);
				if (words) return { ok: true, words, engine: "hyperframes" };

				const cues = await transcribeWithWhisperCpp(wavPath);
				if (cues) return { ok: true, cues, engine: "whisper.cpp" };

				return {
					ok: false,
					reason: "No speech was found, and no transcription engine was available. Install the HyperFrames CLI (`npm i -g hyperframes`) or download the speech model in Settings.",
				};
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
