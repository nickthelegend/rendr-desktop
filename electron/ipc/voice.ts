// Speech, generated on this machine.
//
// Kokoro-82M through kokoro-js / onnxruntime-node. It runs entirely locally:
// no key, no account, and nothing about the user's product leaves the machine —
// which matters here because narration is written against an unreleased demo.
//
// The model is ~90 MB quantised and is not shipped with the app. First use
// downloads it into Electron's userData directory and every later run reads it
// from there. "One-click setup" is that download, made explicit and resumable
// rather than happening invisibly the first time somebody asks for a line.
//
// It lives in the main process because the model belongs on disk, the download
// needs the filesystem, and a renderer that reloads must not restart a 90 MB
// fetch or hold the weights in a tab's heap.

import fs from "node:fs/promises";
import path from "node:path";
import { app, ipcMain } from "electron";

/** The quantised build. Full precision is ~330 MB for no audible gain here. */
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8" as const;

export interface VoiceStatus {
	/** Ready to speak without downloading anything. */
	installed: boolean;
	/** A download is running. */
	installing: boolean;
	/** 0–1 while installing, else null. */
	progress: number | null;
	modelId: string;
	/** Where the weights are cached. */
	cacheDir: string;
	/** Bytes on disk, or 0 if nothing is cached. */
	bytes: number;
	/** Why it isn't usable, when it isn't. */
	error?: string;
}

/** The loaded model, kept for the life of the process. */
let tts: unknown = null;
let loading: Promise<unknown> | null = null;
let installing = false;
let progress: number | null = null;
let lastError: string | undefined;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheDir(): string {
	return path.join(app.getPath("userData"), "voice-models");
}

async function directorySize(dir: string): Promise<number> {
	let total = 0;
	let entries: Array<{ name: string; isDirectory: () => boolean }>;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await directorySize(full);
			continue;
		}
		try {
			total += (await fs.stat(full)).size;
		} catch {
			// A file that vanished mid-walk contributes nothing.
		}
	}
	return total;
}

/**
 * Loads the model, downloading it if this machine has never had it.
 *
 * One in-flight load at a time: two callers asking at once must wait on the
 * same download rather than starting a second one over the top of it.
 */
async function load(onProgress?: (ratio: number) => void): Promise<unknown> {
	if (tts) return tts;
	if (loading) return loading;

	installing = true;
	progress = 0;
	lastError = undefined;

	loading = (async () => {
		const dir = cacheDir();
		await fs.mkdir(dir, { recursive: true });

		/*
		 * Point transformers.js at our cache — on its own module, not on the
		 * one kokoro-js re-exports.
		 *
		 * The env vars and the re-exported `env` both looked like they worked
		 * and neither did: the weights landed in
		 * node_modules/@huggingface/transformers/.cache instead. That is wrong
		 * twice over — a packaged app has node_modules inside a read-only asar,
		 * and `voiceStatus` measures our directory, so after a restart it would
		 * find 0 bytes and tell the user to download a model already on disk.
		 */
		const transformers = (await import("@huggingface/transformers")) as {
			env?: { cacheDir?: string; useBrowserCache?: boolean; allowLocalModels?: boolean };
		};
		if (transformers.env) transformers.env.cacheDir = dir;

		const { KokoroTTS, env } = (await import("kokoro-js")) as {
			KokoroTTS: {
				from_pretrained: (id: string, options: Record<string, unknown>) => Promise<unknown>;
			};
			env?: { cacheDir?: string; localModelPath?: string };
		};
		if (env) env.cacheDir = dir;

		const model = await KokoroTTS.from_pretrained(MODEL_ID, {
			dtype: DTYPE,
			device: "cpu",
			progress_callback: (event: { status?: string; progress?: number }) => {
				if (typeof event?.progress === "number") {
					progress = Math.min(1, Math.max(0, event.progress / 100));
					onProgress?.(progress);
				}
			},
		});
		tts = model;
		return model;
	})();

	try {
		return await loading;
	} catch (error) {
		lastError = error instanceof Error ? error.message : String(error);
		tts = null;
		throw error;
	} finally {
		installing = false;
		progress = null;
		loading = null;
	}
}

/**
 * Where kokoro-js keeps its voice files.
 *
 * The library resolves them from its own `__dirname`, so they only exist if the
 * package was installed and left unbundled. Checking directly means a broken
 * install reports *what* is broken instead of failing later with an ENOENT for
 * a path nobody recognises.
 */
async function voicesPresent(): Promise<boolean> {
	try {
		const entry = require.resolve("kokoro-js");
		const dir = path.join(path.dirname(entry), "..", "voices");
		const files = await fs.readdir(dir);
		return files.some((name) => name.endsWith(".bin"));
	} catch {
		return false;
	}
}

export async function voiceStatus(): Promise<VoiceStatus> {
	const dir = cacheDir();
	const bytes = await directorySize(dir);
	if (!(await voicesPresent())) {
		return {
			installed: false,
			installing,
			progress,
			modelId: MODEL_ID,
			cacheDir: dir,
			bytes,
			error: "kokoro-js is missing its voice files. Run npm install — in a packaged build it means the module was not unpacked from the asar.",
		};
	}
	return {
		installed: tts !== null || bytes > 1_000_000,
		installing,
		progress,
		modelId: MODEL_ID,
		cacheDir: dir,
		bytes,
		...(lastError ? { error: lastError } : {}),
	};
}

/** Float32 mono PCM wrapped as a 16-bit WAV, which every decoder accepts. */
function toWav(samples: Float32Array, sampleRate: number): Buffer {
	const bytes = Buffer.alloc(44 + samples.length * 2);
	bytes.write("RIFF", 0);
	bytes.writeUInt32LE(36 + samples.length * 2, 4);
	bytes.write("WAVE", 8);
	bytes.write("fmt ", 12);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(sampleRate, 24);
	bytes.writeUInt32LE(sampleRate * 2, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	for (let index = 0; index < samples.length; index++) {
		const clamped = Math.max(-1, Math.min(1, samples[index]));
		bytes.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2);
	}
	return bytes;
}

export interface SpokenLine {
	/** WAV bytes, base64, ready to become an asset. */
	wavBase64: string;
	seconds: number;
	sampleRate: number;
	voiceId: string;
}

export async function speak(
	text: string,
	options: { voice?: string; speed?: number } = {},
): Promise<SpokenLine> {
	const model = (await load()) as {
		generate: (
			text: string,
			options: { voice?: string; speed?: number },
		) => Promise<{ audio: Float32Array; sampling_rate: number }>;
	};

	const voice = options.voice ?? "af_heart";
	const result = await model.generate(text, {
		voice,
		// Kokoro's own speed control, which changes delivery rather than
		// resampling — resampling afterwards would raise the pitch.
		speed: Math.min(2, Math.max(0.5, options.speed ?? 1)),
	});

	const samples = result.audio;
	const sampleRate = result.sampling_rate ?? 24000;
	return {
		wavBase64: toWav(samples, sampleRate).toString("base64"),
		seconds: samples.length / sampleRate,
		sampleRate,
		voiceId: voice,
	};
}

export async function listVoices(): Promise<Array<{ id: string; name: string; language: string }>> {
	const model = (await load()) as {
		voices?: Record<string, { name?: string; language?: string; gender?: string }>;
	};
	const voices = model.voices ?? {};
	return Object.entries(voices).map(([id, meta]) => ({
		id,
		name: meta?.name ?? id,
		language: meta?.language ?? "en-us",
	}));
}

export function registerVoiceIpc(): void {
	ipcMain.handle("rendr-voice:status", () => voiceStatus());

	/*
	 * Starts the download and returns at once.
	 *
	 * It used to await the whole thing, which meant a first install on a normal
	 * connection outran the caller's timeout — the download kept going but the
	 * caller saw a failure, so it read as a hang. Progress is pushed to the
	 * renderer and `rendr-voice:status` reports it, so the caller can watch
	 * rather than block.
	 */
	ipcMain.handle("rendr-voice:install", async (event) => {
		if (tts) return voiceStatus();

		const started = load((ratio) => {
			if (!event.sender.isDestroyed()) {
				event.sender.send("rendr-voice:progress", ratio);
			}
		});
		// The rejection is recorded by `load` into lastError, which voiceStatus
		// reports. Swallowed here so an unawaited promise can't crash the app.
		started.catch(() => undefined);

		// A short grace period, so an already-cached model still returns
		// "installed" on the first call instead of making the caller poll for
		// something that was ready before it asked.
		await Promise.race([started.catch(() => undefined), delay(2500)]);
		return voiceStatus();
	});

	ipcMain.handle(
		"rendr-voice:speak",
		async (_event, text: string, options?: { voice?: string; speed?: number }) => {
			if (typeof text !== "string" || text.trim().length === 0) {
				throw new Error("Nothing to say.");
			}
			return speak(text, options ?? {});
		},
	);

	ipcMain.handle("rendr-voice:voices", () => listVoices());
}
