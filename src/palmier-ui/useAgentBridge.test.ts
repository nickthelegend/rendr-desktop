// @vitest-environment jsdom
//
// The IPC bridge every MCP tool call arrives through.
//
// This is the one place where a mistake is invisible from inside the app: a
// swallowed error, a call that never gets a response, or a stale handler all
// look like "the agent stopped working" from the client's side, with nothing in
// the editor to explain it. So the contract is pinned: every call is answered
// exactly once, a throwing tool answers with its message rather than hanging,
// and the handler set is never stale.

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorApi } from "./state";
import { useAgentBridge } from "./useAgentBridge";

type Call = { callId: string; name: string; args?: Record<string, unknown> };
type Response = { callId: string; result?: unknown; error?: string };

/** A bridge that captures what the hook sends back. */
function fakeBridge() {
	let handler: ((call: Call) => Promise<void>) | null = null;
	const responses: Response[] = [];
	const unsubscribe = vi.fn();
	return {
		responses,
		unsubscribe,
		fire: (call: Call) => handler?.(call) ?? Promise.resolve(),
		install() {
			(window as { electronAPI?: unknown }).electronAPI = {
				onAgentToolCall: (fn: (call: Call) => Promise<void>) => {
					handler = fn;
					return unsubscribe;
				},
				respondAgentToolCall: (response: Response) => responses.push(response),
			};
		},
	};
}

/** Only the slice of the editor the bridge itself touches. */
function fakeApi(over: Partial<EditorApi> = {}) {
	return {
		state: { agentConnected: false, assets: [], timelines: [], cursorTelemetry: [] },
		timeline: { id: "tl", name: "M", fps: 30, width: 1920, height: 1080, tracks: [] },
		logAgent: vi.fn(),
		patch: vi.fn(),
		commit: vi.fn(),
		...over,
	} as unknown as EditorApi;
}

afterEach(() => {
	(window as { electronAPI?: unknown }).electronAPI = undefined;
	vi.restoreAllMocks();
});

describe("useAgentBridge", () => {
	it("does nothing when there is no desktop bridge", () => {
		// The browser build has no IPC; mounting must not throw.
		expect(() => renderHook(() => useAgentBridge(fakeApi()))).not.toThrow();
	});

	it("answers an unknown tool instead of leaving the client waiting", async () => {
		const bridge = fakeBridge();
		bridge.install();
		const api = fakeApi();
		renderHook(() => useAgentBridge(api));

		await bridge.fire({ callId: "1", name: "no_such_tool" });

		expect(bridge.responses).toHaveLength(1);
		expect(bridge.responses[0].callId).toBe("1");
		expect(bridge.responses[0].error).toMatch(/not implemented/);
	});

	it("marks the session connected on the first call", async () => {
		const bridge = fakeBridge();
		bridge.install();
		const patch = vi.fn();
		renderHook(() => useAgentBridge(fakeApi({ patch })));

		await bridge.fire({ callId: "1", name: "get_timeline" });
		expect(patch).toHaveBeenCalledWith({ agentConnected: true });
	});

	it("answers a real tool with a result", async () => {
		const bridge = fakeBridge();
		bridge.install();
		renderHook(() => useAgentBridge(fakeApi()));

		await bridge.fire({ callId: "7", name: "get_timeline", args: {} });

		expect(bridge.responses).toHaveLength(1);
		expect(bridge.responses[0].callId).toBe("7");
		expect(bridge.responses[0].result).toBeDefined();
		expect(bridge.responses[0].error).toBeUndefined();
	});

	it("logs every call, so the agent panel shows what happened", async () => {
		const bridge = fakeBridge();
		bridge.install();
		const logAgent = vi.fn();
		renderHook(() => useAgentBridge(fakeApi({ logAgent })));

		await bridge.fire({ callId: "1", name: "get_timeline", args: {} });
		expect(logAgent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "tool", tool: "get_timeline" }),
		);
	});

	it("answers with the message when a tool throws, rather than hanging", async () => {
		const bridge = fakeBridge();
		bridge.install();
		// A tool that throws on bad input is the normal case; the client must get
		// the reason, not a timeout.
		renderHook(() => useAgentBridge(fakeApi()));

		await bridge.fire({ callId: "9", name: "add_clips", args: { entries: "not an array" } });

		expect(bridge.responses).toHaveLength(1);
		expect(bridge.responses[0].callId).toBe("9");
		// Either a structured refusal or a thrown message — never silence.
		expect(bridge.responses[0].result ?? bridge.responses[0].error).toBeDefined();
	});

	it("answers exactly once per call", async () => {
		const bridge = fakeBridge();
		bridge.install();
		renderHook(() => useAgentBridge(fakeApi()));

		await bridge.fire({ callId: "a", name: "get_timeline", args: {} });
		await bridge.fire({ callId: "b", name: "nope" });

		expect(bridge.responses.map((r) => r.callId)).toEqual(["a", "b"]);
	});

	it("subscribes once and unsubscribes on unmount", () => {
		const bridge = fakeBridge();
		bridge.install();
		const { rerender, unmount } = renderHook(() => useAgentBridge(fakeApi()));

		// Re-rendering must not stack a second listener — every call would then
		// be answered twice, and the second answer is a protocol violation.
		rerender();
		rerender();
		expect(bridge.unsubscribe).not.toHaveBeenCalled();
		unmount();
		expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("runs against the latest editor, not the one it mounted with", async () => {
		const bridge = fakeBridge();
		bridge.install();
		const firstLog = vi.fn();
		const secondLog = vi.fn();
		let api = fakeApi({ logAgent: firstLog });
		const { rerender } = renderHook(() => useAgentBridge(api));

		// The listener registers once, so a stale closure here would send every
		// later call into the editor state as it was at mount.
		api = fakeApi({ logAgent: secondLog });
		rerender();

		await bridge.fire({ callId: "1", name: "get_timeline", args: {} });
		expect(secondLog).toHaveBeenCalled();
		expect(firstLog).not.toHaveBeenCalled();
	});
});
