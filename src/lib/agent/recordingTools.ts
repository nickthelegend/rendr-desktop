// Recording tools. These drive Recordly's own recording state machine
// (useScreenRecorder) rather than reimplementing capture, so an agent-started
// recording is byte-for-byte the same as a human-started one.

import { fail, ok } from "./result";
import type { AgentToolResult } from "./types";

/** What the recorder surface must provide for these tools to work. */
export interface RecordingControls {
	recording: boolean;
	paused: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	toggleRecording: () => void | Promise<void>;
	setMicrophoneEnabled: (enabled: boolean) => void;
	setMicrophoneDeviceId: (id: string | undefined) => void;
	setSystemAudioEnabled: (enabled: boolean) => void;
	setCountdownDelay: (seconds: number) => void;
	selectedSourceName: string | null;
	elapsedMs: number;
	/** Path of the last finished recording; set once finalizing completes. */
	lastRecordingPath: string | null;
}

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a live getter until it satisfies `done`, or give up. Returns whether it settled. */
async function waitFor(
	read: () => RecordingControls,
	done: (c: RecordingControls) => boolean,
	timeoutMs: number,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (done(read())) return true;
		await delay(POLL_INTERVAL_MS);
	}
	return false;
}

export async function listCaptureSources(args: Record<string, unknown>): Promise<AgentToolResult> {
	const kind = args.kind === undefined ? "all" : args.kind;
	if (kind !== "all" && kind !== "screen" && kind !== "window" && kind !== "camera") {
		return fail("invalid_argument", "kind must be one of screen, window, camera, all.");
	}

	const types: Array<"screen" | "window"> = [];
	if (kind === "all" || kind === "screen") types.push("screen");
	if (kind === "all" || kind === "window") types.push("window");

	const screens: Array<Record<string, unknown>> = [];
	if (types.length > 0) {
		try {
			const sources = (await window.electronAPI.getSources({ types })) as Array<{
				id: string;
				name: string;
				display_id?: string;
			}>;
			for (const source of sources) {
				screens.push({
					sourceId: source.id,
					name: source.name,
					kind: source.id.startsWith("screen:") ? "screen" : "window",
					displayId: source.display_id || undefined,
				});
			}
		} catch (error) {
			return fail(
				"capture_unavailable",
				`Could not enumerate capture sources: ${error instanceof Error ? error.message : String(error)}. On macOS and Windows this usually means the screen-recording permission has not been granted — ask the user to enable it for Rendr in system settings.`,
			);
		}
	}

	const cameras: Array<Record<string, unknown>> = [];
	if (kind === "all" || kind === "camera") {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			for (const device of devices) {
				if (device.kind === "videoinput") {
					cameras.push({
						sourceId: `camera:${device.deviceId}`,
						name: device.label || "Camera",
						kind: "camera",
					});
				}
			}
		} catch {
			// Camera enumeration failing is not fatal — screens are the primary surface.
		}
	}

	const sources = [...screens, ...cameras];
	return ok({
		sources,
		note:
			sources.length === 0
				? "No capture sources returned. If this is macOS or Windows, the screen-recording permission is the usual cause; ask the user to grant it and retry."
				: undefined,
	});
}

export async function startRecording(
	args: Record<string, unknown>,
	read: () => RecordingControls,
): Promise<AgentToolResult> {
	const controls = read();
	if (controls.recording || controls.countdownActive) {
		return fail(
			"already_recording",
			"A recording is already running. Stop it before starting another.",
		);
	}
	if (controls.finalizing) {
		return fail(
			"busy",
			"The previous recording is still being written to disk. Retry in a moment.",
		);
	}
	if (typeof args.sourceId !== "string" || args.sourceId.length === 0) {
		return fail("invalid_argument", "sourceId is required; take it from list_capture_sources.");
	}

	const countdown = args.countdownSeconds;
	if (countdown !== undefined) {
		if (
			typeof countdown !== "number" ||
			!Number.isInteger(countdown) ||
			countdown < 0 ||
			countdown > 10
		) {
			return fail("invalid_argument", "countdownSeconds must be an integer 0–10.");
		}
		controls.setCountdownDelay(countdown);
	}

	if (args.microphoneDeviceId !== undefined) {
		if (typeof args.microphoneDeviceId !== "string") {
			return fail("invalid_argument", "microphoneDeviceId must be a string.");
		}
		controls.setMicrophoneDeviceId(args.microphoneDeviceId);
		controls.setMicrophoneEnabled(true);
	} else {
		controls.setMicrophoneEnabled(false);
	}

	if (args.systemAudio !== undefined) {
		if (typeof args.systemAudio !== "boolean") {
			return fail("invalid_argument", "systemAudio must be a boolean.");
		}
		controls.setSystemAudioEnabled(args.systemAudio);
	}

	try {
		window.electronAPI.selectSource({ id: args.sourceId } as never);
	} catch (error) {
		return fail(
			"unknown_source",
			`Could not select sourceId '${args.sourceId}': ${error instanceof Error ? error.message : String(error)}. Re-run list_capture_sources — windows open and close.`,
		);
	}

	await controls.toggleRecording();

	const started = await waitFor(read, (c) => c.recording, START_TIMEOUT_MS);
	if (!started) {
		return fail("start_failed", "Capture did not start within 30s. Nothing was recorded.");
	}

	return ok({
		recordingId: "active",
		state: "recording",
		source: read().selectedSourceName,
		note: "Recording is running. The timeline is read-only until stop_recording. This is not undoable.",
	});
}

export async function stopRecording(
	args: Record<string, unknown>,
	read: () => RecordingControls,
): Promise<AgentToolResult> {
	if (!read().recording) {
		return fail("not_recording", "No recording is active.");
	}
	if (args.discard !== undefined && typeof args.discard !== "boolean") {
		return fail("invalid_argument", "discard must be a boolean.");
	}
	if (args.discard === true) {
		return fail(
			"not_implemented",
			"discard:true is not wired up yet — Rendr always keeps the take. Stop normally, then delete the file through the editor.",
		);
	}

	const elapsedMs = read().elapsedMs;
	await read().toggleRecording();

	const settled = await waitFor(read, (c) => !c.recording && !c.finalizing, STOP_TIMEOUT_MS);
	if (!settled) {
		return fail(
			"finalize_timeout",
			"Capture stopped but the file was still being written after 60s. The recording may still land in the editor; check before re-recording.",
		);
	}

	const path = read().lastRecordingPath;
	return ok({
		state: "stopped",
		videoPath: path,
		durationSeconds: Math.round(elapsedMs / 100) / 10,
		loadedIntoEditor: true,
		note: "The recording is loaded in the editor and is the project's active footage. Run suggest_zooms next to find where to punch in.",
	});
}

export function getRecordingStatus(read: () => RecordingControls): AgentToolResult {
	const controls = read();
	if (!controls.recording && !controls.countdownActive && !controls.finalizing) {
		return ok({ active: false });
	}
	return ok({
		active: controls.recording,
		state: controls.countdownActive
			? "countdown"
			: controls.finalizing
				? "finalizing"
				: controls.paused
					? "paused"
					: "recording",
		recordingId: "active",
		elapsedSeconds: Math.round(controls.elapsedMs / 100) / 10,
		source: controls.selectedSourceName,
	});
}
