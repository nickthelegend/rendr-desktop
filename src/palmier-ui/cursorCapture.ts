// Cursor telemetry captured alongside a recording.
//
// This is what suggest_zooms reads. Recordly captures it natively across the
// whole screen; in the browser only the app's own window reports pointer
// events, so telemetry is honest about its own coverage rather than pretending
// to have watched the desktop.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";

export interface CursorCapture {
	stop: () => Promise<CursorTelemetryPoint[]>;
	/** How much of the desktop this capture could actually observe. */
	coverage: () => "desktop" | "window-only" | "none";
}

const SAMPLE_INTERVAL_MS = 80;

/**
 * Starts recording pointer movement and clicks, normalised to 0–1 of the
 * viewport so the points mean the same thing as Recordly's.
 */
export function startCursorCapture(): CursorCapture {
	const points: CursorTelemetryPoint[] = [];
	const startedAt = performance.now();
	let lastSample = 0;
	let sawAny = false;

	const record = (
		event: PointerEvent,
		interactionType: CursorTelemetryPoint["interactionType"],
	) => {
		const timeMs = performance.now() - startedAt;
		// Moves are thinned; clicks are always kept because they are the signal.
		if (interactionType === "move") {
			if (timeMs - lastSample < SAMPLE_INTERVAL_MS) return;
			lastSample = timeMs;
		}
		sawAny = true;
		const cx = Math.min(1, Math.max(0, event.clientX / window.innerWidth));
		const cy = Math.min(1, Math.max(0, event.clientY / window.innerHeight));
		lastPoint = { cx, cy };
		points.push({ timeMs, cx, cy, interactionType });
	};

	const onMove = (event: PointerEvent) => record(event, "move");

	/*
	 * A stationary pointer must still be recorded.
	 *
	 * Pointer events only fire on movement, so a cursor resting somewhere
	 * produces no samples at all — and a dwell then looks like a single time gap
	 * between two distant points rather than a run of close-together ones. The
	 * dwell detector needs the run, so this repeats the last known position on
	 * the same interval the moves are thinned to. It is what makes "the user
	 * stopped and read something" a zoomable moment instead of nothing.
	 */
	let lastPoint: { cx: number; cy: number } | null = null;
	const heartbeat = window.setInterval(() => {
		if (!lastPoint) return;
		const timeMs = performance.now() - startedAt;
		if (timeMs - lastSample < SAMPLE_INTERVAL_MS) return;
		lastSample = timeMs;
		points.push({ timeMs, cx: lastPoint.cx, cy: lastPoint.cy, interactionType: "move" });
	}, SAMPLE_INTERVAL_MS);
	const onDown = (event: PointerEvent) =>
		record(event, event.button === 2 ? "right-click" : "click");
	const onUp = (event: PointerEvent) => record(event, "mouseup");

	window.addEventListener("pointermove", onMove, { passive: true });
	window.addEventListener("pointerdown", onDown, { passive: true });
	window.addEventListener("pointerup", onUp, { passive: true });

	// In the desktop app a native hook watches the whole screen, which is the
	// only way a recording of *another* application yields anything to zoom to.
	// The DOM listeners stay attached as a fallback for the browser build.
	const bridge = window.electronAPI;
	const native =
		typeof bridge?.setRecordingState === "function" &&
		typeof bridge?.getPendingCursorTelemetry === "function";
	if (native) void bridge?.setRecordingState?.(true);

	const detach = () => {
		window.clearInterval(heartbeat);
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerdown", onDown);
		window.removeEventListener("pointerup", onUp);
	};

	return {
		async stop() {
			detach();
			const own = points.sort((a, b) => a.timeMs - b.timeMs);
			if (!native) return own;

			// Stopping flushes the native samples into the pending buffer.
			try {
				await bridge?.setRecordingState?.(false);
				const result = await bridge?.getPendingCursorTelemetry?.();
				const samples = (result?.samples ?? []) as CursorTelemetryPoint[];
				// The native hook sees the whole desktop, so prefer it outright
				// rather than merging two clocks that started microseconds apart.
				if (samples.length > 0) return samples;
			} catch {
				// A missing or failed native hook falls back to what the window saw.
			}
			return own;
		},
		coverage: () => (native ? "desktop" : sawAny ? "window-only" : "none"),
	};
}
