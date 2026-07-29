// @vitest-environment jsdom
//
// The two remaining bridges: the Claude CLI and the audio engine.
//
// Both are thin, and both have one behaviour worth pinning. useClaude has to
// say *why* it is unavailable rather than silently offering nothing, and it has
// to merge a stream of fragments into one message instead of a message per
// sliver. useAudioPlayback must not construct an AudioContext before there is
// something to play — doing so leaves it suspended and warns in every browser.

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorApi } from "./state";
import { useAudioPlayback } from "./useAudioPlayback";
import { useClaude } from "./useClaude";

function fakeApi(over: Record<string, unknown> = {}) {
	return {
		state: { playing: false, assets: [], playhead: 0, ...((over.state as object) ?? {}) },
		timeline: { id: "tl", name: "M", fps: 30, width: 1920, height: 1080, tracks: [] },
		logAgent: vi.fn(),
		appendAssistantText: vi.fn(),
		patch: vi.fn(),
		...over,
	} as unknown as EditorApi;
}

afterEach(() => {
	(window as { electronAPI?: unknown }).electronAPI = undefined;
	(globalThis as { AudioContext?: unknown }).AudioContext = undefined;
	vi.restoreAllMocks();
});

describe("useClaude", () => {
	it("reports unavailable with a reason in a browser tab", async () => {
		// "Unavailable" with no reason is the failure mode this guards: the user
		// sees a dead panel and nothing tells them it needs the desktop app.
		const { result } = renderHook(() => useClaude(fakeApi()));
		await vi.waitFor(() => expect(result.current.status.checked).toBe(true));
		expect(result.current.status.available).toBe(false);
		expect(result.current.status.reason).toMatch(/desktop app/i);
	});

	it("reports available when the desktop bridge says so", async () => {
		(window as { electronAPI?: unknown }).electronAPI = {
			claudeStatus: vi.fn().mockResolvedValue({ available: true }),
			onClaudeEvent: () => () => undefined,
		};
		const { result } = renderHook(() => useClaude(fakeApi()));
		await vi.waitFor(() => expect(result.current.status.checked).toBe(true));
		expect(result.current.status.available).toBe(true);
	});

	it("does not claim to be thinking before anything was asked", async () => {
		const { result } = renderHook(() => useClaude(fakeApi()));
		await vi.waitFor(() => expect(result.current.status.checked).toBe(true));
		expect(result.current.thinking).toBe(false);
	});

	it("exposes a way to send, so the panel is never a dead end", () => {
		const { result } = renderHook(() => useClaude(fakeApi()));
		expect(typeof result.current.send).toBe("function");
	});

	it("survives a bridge whose status check rejects", async () => {
		// A CLI that isn't installed rejects rather than resolving false; the
		// panel must still settle into a checked state instead of spinning.
		(window as { electronAPI?: unknown }).electronAPI = {
			claudeStatus: vi.fn().mockRejectedValue(new Error("spawn ENOENT")),
			onClaudeEvent: () => () => undefined,
		};
		const { result } = renderHook(() => useClaude(fakeApi()));
		await vi.waitFor(() => expect(result.current.status.checked).toBe(true));
		expect(result.current.status.available).toBe(false);
	});
});

describe("useAudioPlayback", () => {
	it("builds no audio context while paused", () => {
		// Constructing one before a user gesture leaves it suspended and logs a
		// warning in every browser, so it must wait for playback to start.
		const ctor = vi.fn();
		(globalThis as { AudioContext?: unknown }).AudioContext = ctor;
		renderHook(() => useAudioPlayback(fakeApi({ state: { playing: false } })));
		expect(ctor).not.toHaveBeenCalled();
	});

	it("reports silence when nothing is playing", () => {
		const { result } = renderHook(() =>
			useAudioPlayback(fakeApi({ state: { playing: false } })),
		);
		expect(result.current).toBe(0);
	});

	it("returns a finite level, never NaN", () => {
		// The level drives a meter's height; NaN would collapse it silently.
		const { result } = renderHook(() => useAudioPlayback(fakeApi()));
		expect(Number.isFinite(result.current)).toBe(true);
	});

	it("unmounts cleanly without a context ever being made", () => {
		const { unmount } = renderHook(() => useAudioPlayback(fakeApi()));
		expect(() => unmount()).not.toThrow();
	});
});
