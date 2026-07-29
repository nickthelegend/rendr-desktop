import { describe, expect, it, vi } from "vitest";

import type { ZoomRegion } from "@/components/video-editor/types";

import type { AgentEditorContext, AgentToolResult } from "./types";
import { addZoomRegions, suggestZooms, updateZoomRegions } from "./zoomTools";

function payload(result: AgentToolResult): Record<string, unknown> {
	const first = result.content[0];
	if (first.type !== "text") throw new Error("expected a text receipt");
	return JSON.parse(first.text) as Record<string, unknown>;
}

function context(overrides: Partial<AgentEditorContext> = {}): AgentEditorContext {
	return {
		totalMs: 60_000,
		zoomRegions: [],
		cursorTelemetry: [],
		setZoomRegions: vi.fn(),
		isRecording: false,
		...overrides,
	};
}

const region = (id: string, startMs: number, endMs: number): ZoomRegion => ({
	id,
	startMs,
	endMs,
	depth: 2,
	focus: { cx: 0.5, cy: 0.5 },
	mode: "auto",
});

describe("addZoomRegions", () => {
	it("adds a valid region and reports its resolved scale", () => {
		const ctx = context();
		const result = addZoomRegions(
			{ regions: [{ startMs: 1000, endMs: 3000, depth: 3, focus: { cx: 0.2, cy: 0.8 } }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const added = payload(result).added as Array<Record<string, unknown>>;
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({
			startMs: 1000,
			endMs: 3000,
			depth: 3,
			scale: 1.8,
			mode: "auto",
		});
		expect(ctx.setZoomRegions).toHaveBeenCalledTimes(1);
	});

	it("defaults focus to frame center and mode to auto", () => {
		const ctx = context();
		addZoomRegions({ regions: [{ startMs: 0, endMs: 2000, depth: 1 }] }, ctx);

		const next = vi.mocked(ctx.setZoomRegions).mock.calls[0][0];
		expect(next[0].focus).toEqual({ cx: 0.5, cy: 0.5 });
		expect(next[0].mode).toBe("auto");
	});

	it("keeps the resulting list sorted by start time", () => {
		const ctx = context({ zoomRegions: [region("a", 10_000, 12_000)] });
		addZoomRegions({ regions: [{ startMs: 1000, endMs: 3000, depth: 2 }] }, ctx);

		const next = vi.mocked(ctx.setZoomRegions).mock.calls[0][0];
		expect(next.map((r) => r.startMs)).toEqual([1000, 10_000]);
	});

	it("rejects a region that overlaps an existing one without mutating", () => {
		const ctx = context({ zoomRegions: [region("existing", 1000, 5000)] });
		const result = addZoomRegions({ regions: [{ startMs: 4000, endMs: 8000, depth: 2 }] }, ctx);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("overlap");
		expect(ctx.setZoomRegions).not.toHaveBeenCalled();
	});

	it("rejects the whole batch when two new regions overlap each other", () => {
		const ctx = context();
		const result = addZoomRegions(
			{
				regions: [
					{ startMs: 0, endMs: 3000, depth: 2 },
					{ startMs: 2000, endMs: 5000, depth: 2 },
				],
			},
			ctx,
		);

		expect(payload(result).error).toBe("overlap");
		expect(ctx.setZoomRegions).not.toHaveBeenCalled();
	});

	it("rejects a batch for one bad entry, leaving no partial state", () => {
		const ctx = context();
		const result = addZoomRegions(
			{
				regions: [
					{ startMs: 0, endMs: 3000, depth: 2 },
					{ startMs: 5000, endMs: 9000, depth: 99 },
				],
			},
			ctx,
		);

		expect(payload(result).error).toBe("invalid_argument");
		expect(ctx.setZoomRegions).not.toHaveBeenCalled();
	});

	it("refuses regions shorter than the glitch threshold", () => {
		const result = addZoomRegions(
			{ regions: [{ startMs: 0, endMs: 200, depth: 2 }] },
			context(),
		);
		expect(payload(result).error).toBe("too_short");
	});

	it("refuses a region running past the end of the recording", () => {
		const result = addZoomRegions(
			{ regions: [{ startMs: 59_000, endMs: 70_000, depth: 2 }] },
			context({ totalMs: 60_000 }),
		);
		expect(payload(result).error).toBe("out_of_range");
	});

	it("refuses an out-of-range focus rather than silently clamping it", () => {
		const result = addZoomRegions(
			{ regions: [{ startMs: 0, endMs: 2000, depth: 2, focus: { cx: 1.4, cy: 0.5 } }] },
			context(),
		);
		expect(payload(result).error).toBe("invalid_argument");
	});

	it("refuses a non-finite start", () => {
		const result = addZoomRegions(
			{ regions: [{ startMs: Number.NaN, endMs: 2000, depth: 2 }] },
			context(),
		);
		expect(payload(result).error).toBe("invalid_argument");
	});

	it("refuses an empty batch", () => {
		expect(payload(addZoomRegions({ regions: [] }, context())).error).toBe("invalid_argument");
	});
});

describe("updateZoomRegions", () => {
	it("patches only the named fields", () => {
		const ctx = context({ zoomRegions: [region("a", 1000, 5000)] });
		updateZoomRegions({ set: [{ regionId: "a", depth: 4 }] }, ctx);

		const next = vi.mocked(ctx.setZoomRegions).mock.calls[0][0];
		expect(next[0]).toMatchObject({ id: "a", startMs: 1000, endMs: 5000, depth: 4 });
	});

	it("removes regions by id", () => {
		const ctx = context({ zoomRegions: [region("a", 0, 2000), region("b", 5000, 8000)] });
		const result = updateZoomRegions({ remove: ["a"] }, ctx);

		expect(payload(result).removed).toEqual(["a"]);
		expect(vi.mocked(ctx.setZoomRegions).mock.calls[0][0].map((r) => r.id)).toEqual(["b"]);
	});

	it("refuses a patch that would create an overlap, changing nothing", () => {
		const ctx = context({ zoomRegions: [region("a", 0, 3000), region("b", 5000, 8000)] });
		const result = updateZoomRegions({ set: [{ regionId: "a", endMs: 6000 }] }, ctx);

		expect(payload(result).error).toBe("overlap");
		expect(ctx.setZoomRegions).not.toHaveBeenCalled();
	});

	it("refuses an unknown region id", () => {
		const ctx = context({ zoomRegions: [region("a", 0, 3000)] });
		const result = updateZoomRegions({ set: [{ regionId: "nope", depth: 3 }] }, ctx);

		expect(payload(result).error).toBe("unknown_region");
		expect(ctx.setZoomRegions).not.toHaveBeenCalled();
	});

	it("refuses a call with neither set nor remove", () => {
		expect(payload(updateZoomRegions({}, context())).error).toBe("invalid_argument");
	});
});

describe("suggestZooms", () => {
	it("reports no-telemetry rather than an empty success when cursor data is missing", () => {
		const result = suggestZooms({}, context({ cursorTelemetry: [] }));

		expect(result.isError).toBeUndefined();
		const body = payload(result);
		expect(body.status).toBe("no-telemetry");
		expect(body.proposals).toEqual([]);
	});

	it("proposes regions around explicit clicks and applies nothing", () => {
		const ctx = context({
			totalMs: 20_000,
			cursorTelemetry: [
				{ timeMs: 0, cx: 0.1, cy: 0.1, interactionType: "move" },
				{ timeMs: 5000, cx: 0.4, cy: 0.6, interactionType: "click" },
				{ timeMs: 5200, cx: 0.41, cy: 0.61, interactionType: "click" },
				{ timeMs: 15_000, cx: 0.8, cy: 0.2, interactionType: "click" },
			],
		});

		const body = payload(suggestZooms({}, ctx));
		expect(body.status).toBe("ok");
		const proposals = body.proposals as Array<Record<string, unknown>>;
		expect(proposals.length).toBeGreaterThan(0);
		expect(proposals[0]).toHaveProperty("reason", "click cluster");
		expect(proposals[0]).toHaveProperty("depth");
		// Suggestions are proposals only.
		expect(ctx.setZoomRegions).not.toHaveBeenCalled();
	});

	it("caps proposals at maxRegions", () => {
		const telemetry = Array.from({ length: 12 }, (_, index) => ({
			timeMs: index * 4000,
			cx: 0.1 + index * 0.05,
			cy: 0.5,
			interactionType: "click" as const,
		}));
		const body = payload(
			suggestZooms(
				{ maxRegions: 2 },
				context({ totalMs: 60_000, cursorTelemetry: telemetry }),
			),
		);

		expect((body.proposals as unknown[]).length).toBeLessThanOrEqual(2);
	});

	it("refuses a non-positive maxRegions", () => {
		expect(payload(suggestZooms({ maxRegions: 0 }, context())).error).toBe("invalid_argument");
	});

	it("refuses an inverted window", () => {
		const result = suggestZooms({ startMs: 5000, endMs: 1000 }, context());
		expect(payload(result).error).toBe("invalid_argument");
	});
});
