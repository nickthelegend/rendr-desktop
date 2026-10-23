// Footage analysis: a person matte and a face track, made on this Mac.
//
// The editor sends the footage's bytes; rendr-vision (electron/native/RendrVision.swift)
// runs Apple's Vision person segmentation and face detection over it and writes a
// greyscale matte video plus a JSON face track. Results are cached by a hash of the
// footage, so asking again — or reopening a project — costs nothing.
//
// Nothing is uploaded and no model is downloaded: Vision ships with macOS. Other
// platforms get a plain refusal rather than a half-working fallback.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { app, type BrowserWindow, ipcMain } from "electron";

import { ensureSwiftHelperBinary, resolveUnpackedAppPath } from "./ipc/paths/binaries";

export const VISION_CHANNEL = "rendr-vision:analyze";
export const VISION_PROGRESS_CHANNEL = "rendr-vision:progress";
export const SAVE_GENERATED_CHANNEL = "rendr-files:save-generated";

/**
 * Where things Rendr makes (thumbnails, stills) are kept: a folder the user
 * can find and upload from, rather than a blob that dies with the window.
 */
export async function saveGenerated(bytes: ArrayBuffer, name: string): Promise<string> {
	const safe = name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Rendr image.png";
	const dir = path.join(app.getPath("pictures"), "Rendr");
	await fs.mkdir(dir, { recursive: true });
	// Never overwrite: a second variant with the same title gets a number.
	const ext = path.extname(safe);
	const stem = safe.slice(0, safe.length - ext.length);
	let candidate = path.join(dir, safe);
	for (let n = 2; existsSync(candidate); n++) candidate = path.join(dir, `${stem} ${n}${ext}`);
	await fs.writeFile(candidate, Buffer.from(bytes));
	return candidate;
}

export interface VisionRequest {
	name: string;
	/** The footage's own file, when it has one; read in place rather than copied. */
	sourcePath?: string;
	matte: boolean;
	faces: boolean;
	quality?: "fast" | "balanced" | "accurate";
}

export interface FaceBox {
	x: number;
	y: number;
	w: number;
	h: number;
	confidence: number;
}

export interface FaceTrackFile {
	version: number;
	width: number;
	height: number;
	duration: number;
	interval: number;
	samples: Array<{ t: number; faces: FaceBox[] }>;
}

export interface VisionResult {
	ok: boolean;
	/** Content hash of the footage, so the renderer can tell runs apart. */
	key?: string;
	mattePath?: string;
	faces?: FaceTrackFile;
	width?: number;
	height?: number;
	duration?: number;
	/** Share of analysed frames where Vision found a person at all. */
	personCoverage?: number;
	cached?: boolean;
	reason?: string;
}

function cacheRoot(): string {
	return path.join(app.getPath("userData"), "vision-cache");
}

async function helperBinary(): Promise<string> {
	return ensureSwiftHelperBinary(
		resolveUnpackedAppPath("electron", "native", "RendrVision.swift"),
		path.join(app.getPath("userData"), "native-tools", "rendr-vision"),
		"footage analysis helper",
		"rendr-vision",
	);
}

/** Runs the helper, forwarding its progress lines. Resolves with its final line. */
function runHelper(
	binary: string,
	args: string[],
	onProgress: (progress: number) => void,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let last: Record<string, unknown> | null = null;
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline: number;
			// biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitting loop
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				try {
					const message = JSON.parse(line) as Record<string, unknown>;
					if (typeof message.progress === "number") onProgress(message.progress);
					else last = message;
				} catch {
					// Not ours; the helper only speaks JSON lines.
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-2000);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (last?.error) return reject(new Error(String(last.error)));
			if (code !== 0 || !last?.done) {
				return reject(
					new Error(stderr.trim() || `The analysis helper exited with code ${code}.`),
				);
			}
			resolve(last);
		});
	});
}

async function readCached(dir: string, request: VisionRequest): Promise<VisionResult | null> {
	try {
		const summary = JSON.parse(
			await fs.readFile(path.join(dir, "result.json"), "utf8"),
		) as VisionResult;
		if (request.matte && !(summary.mattePath && existsSync(summary.mattePath))) return null;
		if (request.faces && !summary.faces) return null;
		return { ...summary, cached: true };
	} catch {
		return null;
	}
}

/** A content hash of a file, streamed — the file may be far bigger than memory wants. */
async function hashFile(filePath: string): Promise<string> {
	const { createReadStream } = await import("node:fs");
	return await new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		createReadStream(filePath)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex").slice(0, 32)));
	});
}

export async function analyzeFootage(
	bytes: ArrayBuffer | null,
	request: VisionRequest,
	onProgress: (progress: number) => void,
): Promise<VisionResult> {
	if (process.platform !== "darwin") {
		return {
			ok: false,
			reason: "Footage analysis (background removal, face tracking) uses Apple's Vision framework, so it runs on macOS only for now.",
		};
	}
	const inPlace =
		!bytes && request.sourcePath && existsSync(request.sourcePath) ? request.sourcePath : null;
	if (!bytes && !inPlace) {
		return {
			ok: false,
			reason: "The footage's file isn't where it was imported from. Import it again.",
		};
	}
	const key = inPlace
		? await hashFile(inPlace)
		: crypto
				.createHash("sha256")
				.update(Buffer.from(bytes as ArrayBuffer))
				.digest("hex")
				.slice(0, 32);
	const dir = path.join(cacheRoot(), key);
	const cached = await readCached(dir, request);
	if (cached) return cached;

	await fs.mkdir(dir, { recursive: true });
	// Footage read in place is the user's own file: never written, never removed.
	// Only a copy Rendr made itself is cleaned up afterwards.
	const sourcePath = inPlace ?? path.join(dir, `source${path.extname(request.name) || ".mp4"}`);
	try {
		if (!inPlace) await fs.writeFile(sourcePath, Buffer.from(bytes as ArrayBuffer));
		const args = ["analyze", sourcePath, "--out", dir];
		// Always produce both when either is missing: the second pass would decode
		// the whole file again for a few kilobytes of JSON.
		args.push("--matte", "--faces");
		if (request.quality) args.push("--quality", request.quality);
		const done = await runHelper(await helperBinary(), args, onProgress);

		const faces = JSON.parse(
			await fs.readFile(path.join(dir, "faces.json"), "utf8"),
		) as FaceTrackFile;
		const personFrames = Number(done.personFrames) || 0;
		const matteFrames = Number(done.matteFrames) || 0;
		const result: VisionResult = {
			ok: true,
			key,
			mattePath: typeof done.matte === "string" ? done.matte : undefined,
			faces,
			width: Number(done.width) || undefined,
			height: Number(done.height) || undefined,
			duration: Number(done.duration) || undefined,
			personCoverage: matteFrames > 0 ? personFrames / matteFrames : 0,
		};
		await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(result));
		return result;
	} catch (error) {
		return { ok: false, key, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		// The footage already lives in the project; only the outputs are worth keeping.
		if (!inPlace) await fs.rm(sourcePath, { force: true });
	}
}

export function registerVision(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(SAVE_GENERATED_CHANNEL, async (_event, bytes: ArrayBuffer, name: string) => {
		try {
			return {
				ok: true,
				path: await saveGenerated(bytes, String(name ?? "Rendr image.png")),
			};
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle(
		VISION_CHANNEL,
		async (_event, bytes: ArrayBuffer | null, request: Partial<VisionRequest>) => {
			const name = request?.name ?? "footage.mp4";
			const job: VisionRequest = {
				name,
				matte: true,
				faces: true,
				quality: request?.quality,
				sourcePath:
					typeof request?.sourcePath === "string" ? request.sourcePath : undefined,
			};
			return analyzeFootage(bytes, job, (progress) => {
				const window = getWindow();
				if (window && !window.isDestroyed()) {
					window.webContents.send(VISION_PROGRESS_CHANNEL, { name, progress });
				}
			});
		},
	);
}
