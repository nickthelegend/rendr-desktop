// Real media import. Files come from a drop, a file picker, or a finished
// recording; each one is probed for its actual duration and dimensions before
// it enters the library, so the timeline never places a clip of guessed length.

export type MediaKind = "video" | "audio" | "image";

export interface AssetModel {
	id: string;
	name: string;
	type: MediaKind;
	/** Real duration read from the decoded file. Stills report 0. */
	durationSeconds: number;
	width: number;
	height: number;
	hasAudio: boolean;
	/** Object URL for the decoded source. Revoked when the asset is dropped. */
	url: string;
	/** Library folder path, e.g. "B-roll/Sunset". Absent means the root. */
	folder?: string;
	/** True for Rendr's own captures, which carry cursor telemetry. */
	fromRecording?: boolean;
	hasCursorTelemetry?: boolean;
	/**
	 * The camera take captured alongside this screen take.
	 *
	 * The inset is composited at export time rather than burnt into the capture,
	 * so its size, corner and shape stay editable after the fact.
	 */
	webcamAssetId?: string;
	/** True for that camera take, so the library can label and group it. */
	isWebcam?: boolean;
	/**
	 * Restored from a project file with no source behind it. Projects reference
	 * media rather than embedding it, so an opened project needs relinking.
	 */
	offline?: boolean;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|aiff|aifc|caf|flac|ogg)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|tiff?|heic|avif|svg)$/i;

export function kindOf(file: File): MediaKind | null {
	if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
	if (file.type.startsWith("audio/") || AUDIO_EXT.test(file.name)) return "audio";
	if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name)) return "image";
	return null;
}

/**
 * Every folder on the way to a path: "B-roll/Sunset" → ["B-roll", "B-roll/Sunset"].
 *
 * Folders exist only as the paths their assets carry, so this is how an
 * intermediate folder is known to exist at all.
 */
export function folderChain(path: string | undefined): string[] {
	if (!path) return [];
	const parts = path.split("/").filter(Boolean);
	return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Normalises a folder path: no leading, trailing, or doubled separators. */
export function normalizeFolder(path: string | undefined): string | undefined {
	const cleaned = (path ?? "").split("/").filter(Boolean).join("/");
	return cleaned || undefined;
}

/** Human-readable list of what can be imported, for the empty state and errors. */
export const SUPPORTED_SUMMARY = "MP4, MOV, WebM · MP3, WAV, M4A · PNG, JPEG, HEIC";

let assetCounter = 0;

/**
 * Asset ids must survive a reload: a restored project keeps its own ids, and a
 * counter that restarts at 1 would hand the same id to a freshly imported file.
 * That collision silently attaches clips to the wrong media, so ids carry a
 * random component as well as a sequence.
 */
function nextId(): string {
	assetCounter += 1;
	const salt =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID().slice(0, 8)
			: Math.random().toString(36).slice(2, 10);
	return `asset-${assetCounter}-${salt}`;
}

/**
 * Whether a decoded element actually carries an audio track.
 *
 * This used to be assumed true for every video, which meant a silent screen
 * recording advertised audio: the mixer tried to sound it, and detect_beats
 * refused with a confusing "no decodable audio track" after the fact. Chromium
 * exposes the truth through `captureStream`, with the vendor counters as a
 * fallback for engines that don't.
 */
function detectAudioTrack(element: HTMLVideoElement): boolean {
	const media = element as HTMLVideoElement & {
		mozHasAudio?: boolean;
		webkitAudioDecodedByteCount?: number;
		audioTracks?: { length: number };
		captureStream?: () => MediaStream;
	};
	if (typeof media.mozHasAudio === "boolean") return media.mozHasAudio;
	if (typeof media.audioTracks?.length === "number") return media.audioTracks.length > 0;
	try {
		const stream = media.captureStream?.();
		if (stream) {
			const tracks = stream.getAudioTracks().length;
			for (const track of stream.getTracks()) track.stop();
			return tracks > 0;
		}
	} catch {
		// captureStream throws before the first frame on some sources.
	}
	if (typeof media.webkitAudioDecodedByteCount === "number") {
		return media.webkitAudioDecodedByteCount > 0;
	}
	// Unknowable here: claim audio so nothing is silently dropped, and let the
	// decoder be the one to find out.
	return true;
}

function probeVideo(
	url: string,
): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }> {
	return new Promise((resolve, reject) => {
		const element = document.createElement("video");
		element.preload = "metadata";
		element.muted = true;
		const done = () => {
			// A stream with no known duration reports Infinity; treat it as unknown
			// rather than letting it reach the timeline.
			const duration = Number.isFinite(element.duration) ? element.duration : 0;
			resolve({
				duration,
				width: element.videoWidth,
				height: element.videoHeight,
				hasAudio: detectAudioTrack(element),
			});
		};
		// captureStream only reports tracks once data has arrived, so the probe
		// waits for the first frame rather than for metadata alone.
		element.onloadeddata = done;
		element.onerror = () => reject(new Error("could not be decoded"));
		element.src = url;
	});
}

function probeAudio(url: string): Promise<{ duration: number }> {
	return new Promise((resolve, reject) => {
		const element = document.createElement("audio");
		element.preload = "metadata";
		element.onloadedmetadata = () =>
			resolve({ duration: Number.isFinite(element.duration) ? element.duration : 0 });
		element.onerror = () => reject(new Error("could not be decoded"));
		element.src = url;
	});
}

function probeImage(url: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const element = new Image();
		element.onload = () =>
			resolve({ width: element.naturalWidth, height: element.naturalHeight });
		element.onerror = () => reject(new Error("could not be decoded"));
		element.src = url;
	});
}

export interface ImportOutcome {
	assets: AssetModel[];
	/** One line per file that could not be imported, naming the file and why. */
	rejected: string[];
}

/**
 * Import files into the library. Unsupported or undecodable files are reported
 * rather than silently dropped, and never leave a half-built asset behind.
 */
export async function importFiles(files: readonly File[]): Promise<ImportOutcome> {
	const assets: AssetModel[] = [];
	const rejected: string[] = [];

	for (const file of files) {
		const type = kindOf(file);
		if (!type) {
			rejected.push(`${file.name} — unsupported format`);
			continue;
		}

		const url = URL.createObjectURL(file);
		try {
			if (type === "video") {
				const probe = await probeVideo(url);
				assets.push({
					id: nextId(),
					name: file.name,
					type,
					durationSeconds: probe.duration,
					width: probe.width,
					height: probe.height,
					hasAudio: probe.hasAudio,
					url,
				});
			} else if (type === "audio") {
				const probe = await probeAudio(url);
				assets.push({
					id: nextId(),
					name: file.name,
					type,
					durationSeconds: probe.duration,
					width: 0,
					height: 0,
					hasAudio: true,
					url,
				});
			} else {
				const probe = await probeImage(url);
				assets.push({
					id: nextId(),
					name: file.name,
					type,
					durationSeconds: 0,
					width: probe.width,
					height: probe.height,
					hasAudio: false,
					url,
				});
			}
		} catch (error) {
			// The object URL is useless once decoding failed; don't leak it.
			URL.revokeObjectURL(url);
			rejected.push(
				`${file.name} — ${error instanceof Error ? error.message : "failed to import"}`,
			);
		}
	}

	return { assets, rejected };
}

/** Wraps a finished capture as a library asset. */
export function assetFromRecording(
	blob: Blob,
	name: string,
	durationSeconds: number,
	width: number,
	height: number,
	hasCursorTelemetry: boolean,
	/** Known exactly from the captured stream, not guessed from the file. */
	hasAudio = false,
	extra?: Partial<Pick<AssetModel, "isWebcam" | "webcamAssetId">>,
): AssetModel {
	return {
		id: nextId(),
		name,
		type: "video",
		durationSeconds,
		width,
		height,
		hasAudio,
		url: URL.createObjectURL(blob),
		fromRecording: true,
		hasCursorTelemetry,
		...extra,
	};
}

export function releaseAsset(asset: AssetModel): void {
	URL.revokeObjectURL(asset.url);
}

export function formatDuration(seconds: number): string {
	if (seconds <= 0) return "still";
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}
