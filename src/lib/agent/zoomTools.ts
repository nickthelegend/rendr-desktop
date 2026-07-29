// Zoom tools, implemented against Recordly's zoom modules
// (timeline/zoomSuggestionUtils.ts and videoPlayback/zoomTransform.ts).
// These are the tools that make Rendr worth building: an agent can punch in on a
// screen recording using the same cursor telemetry the human UI uses.

import { buildInteractionZoomSuggestions } from "@/components/video-editor/timeline/zoomSuggestionUtils";
import type { ZoomDepth, ZoomFocus, ZoomMode, ZoomRegion } from "@/components/video-editor/types";
import { ZOOM_DEPTH_SCALES } from "@/components/video-editor/types";

import { fail, ok } from "./result";
import type { AgentEditorContext, AgentToolResult } from "./types";

const MIN_REGION_MS = 600;
const DEFAULT_SUGGESTION_DURATION_MS = 2000;
const DEFAULT_MAX_REGIONS = 8;
const MAX_MAX_REGIONS = 32;
const DEFAULT_DEPTH: ZoomDepth = 2;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseFocus(raw: unknown): ZoomFocus | null | "invalid" {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object") return "invalid";
	const { cx, cy } = raw as { cx?: unknown; cy?: unknown };
	if (!isFiniteNumber(cx) || !isFiniteNumber(cy)) return "invalid";
	if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return "invalid";
	return { cx, cy };
}

function parseDepth(raw: unknown): ZoomDepth | "invalid" {
	if (!isFiniteNumber(raw) || !Number.isInteger(raw) || raw < 1 || raw > 6) return "invalid";
	return raw as ZoomDepth;
}

function parseMode(raw: unknown): ZoomMode | "invalid" {
	if (raw === undefined) return "auto";
	if (raw === "auto" || raw === "manual") return raw;
	return "invalid";
}

function overlaps(
	a: { startMs: number; endMs: number },
	b: { startMs: number; endMs: number },
): boolean {
	return a.startMs < b.endMs && b.startMs < a.endMs;
}

function describe(region: ZoomRegion) {
	return {
		id: region.id,
		startMs: Math.round(region.startMs),
		endMs: Math.round(region.endMs),
		depth: region.depth,
		scale: ZOOM_DEPTH_SCALES[region.depth],
		focus: region.focus,
		mode: region.mode ?? "auto",
	};
}

function newRegionId(): string {
	return `zoom-${Math.random().toString(36).slice(2, 10)}`;
}

export function suggestZooms(
	args: Record<string, unknown>,
	context: AgentEditorContext,
): AgentToolResult {
	const rawMax = args.maxRegions;
	if (
		rawMax !== undefined &&
		(!isFiniteNumber(rawMax) || !Number.isInteger(rawMax) || rawMax < 1)
	) {
		return fail("invalid_argument", "maxRegions must be a positive integer.");
	}
	const maxRegions = Math.min(
		typeof rawMax === "number" ? rawMax : DEFAULT_MAX_REGIONS,
		MAX_MAX_REGIONS,
	);

	const startMs = isFiniteNumber(args.startMs) ? args.startMs : 0;
	const endMs = isFiniteNumber(args.endMs) ? args.endMs : context.totalMs;
	if (endMs <= startMs) {
		return fail("invalid_argument", "endMs must be greater than startMs.");
	}

	if (context.totalMs <= 0) {
		return fail(
			"no_recording",
			"No recording is loaded, so there is no cursor telemetry to analyze.",
		);
	}

	const result = buildInteractionZoomSuggestions({
		cursorTelemetry: context.cursorTelemetry,
		totalMs: context.totalMs,
		defaultDurationMs: DEFAULT_SUGGESTION_DURATION_MS,
		// Never propose a region on top of one that already exists.
		reservedSpans: context.zoomRegions.map((region) => ({
			start: region.startMs,
			end: region.endMs,
		})),
	});

	const proposals = result.suggestions
		.filter((suggestion) => suggestion.end > startMs && suggestion.start < endMs)
		.slice(0, maxRegions)
		.map((suggestion) => ({
			startMs: Math.round(suggestion.start),
			endMs: Math.round(suggestion.end),
			depth: DEFAULT_DEPTH,
			focus: suggestion.focus,
			mode: "auto" as ZoomMode,
			reason: "click cluster",
		}));

	return ok({
		status: result.status,
		proposals,
		note:
			proposals.length === 0
				? "Nothing proposed. status 'no-telemetry' means this recording carries no cursor data (captureCursor was off); 'no-interactions' means the user never clicked."
				: "Not applied. Pass the ones you want to add_zoom_regions.",
	});
}

export function addZoomRegions(
	args: Record<string, unknown>,
	context: AgentEditorContext,
): AgentToolResult {
	const raw = args.regions;
	if (!Array.isArray(raw) || raw.length === 0) {
		return fail("invalid_argument", "regions must be a non-empty array.");
	}

	// Validate the whole batch before mutating: one bad region rejects the call
	// with no partial state.
	const parsed: ZoomRegion[] = [];
	for (let index = 0; index < raw.length; index++) {
		const entry = raw[index] as Record<string, unknown>;
		if (typeof entry !== "object" || entry === null) {
			return fail("invalid_argument", `regions[${index}] must be an object.`);
		}
		if (!isFiniteNumber(entry.startMs) || !isFiniteNumber(entry.endMs)) {
			return fail("invalid_argument", `regions[${index}] needs finite startMs and endMs.`);
		}
		if (entry.endMs <= entry.startMs) {
			return fail(
				"invalid_argument",
				`regions[${index}]: endMs must be greater than startMs.`,
			);
		}
		if (entry.startMs < 0 || entry.endMs > context.totalMs) {
			return fail(
				"out_of_range",
				`regions[${index}] spans [${entry.startMs}, ${entry.endMs}) but the recording is ${Math.round(context.totalMs)}ms long.`,
			);
		}
		if (entry.endMs - entry.startMs < MIN_REGION_MS) {
			return fail(
				"too_short",
				`regions[${index}] is ${Math.round(entry.endMs - entry.startMs)}ms; zooms under ${MIN_REGION_MS}ms read as a glitch.`,
			);
		}

		const depth = parseDepth(entry.depth);
		if (depth === "invalid") {
			return fail("invalid_argument", `regions[${index}]: depth must be an integer 1–6.`);
		}
		const focus = parseFocus(entry.focus);
		if (focus === "invalid") {
			return fail(
				"invalid_argument",
				`regions[${index}]: focus must be {cx, cy} with both in 0–1.`,
			);
		}
		const mode = parseMode(entry.mode);
		if (mode === "invalid") {
			return fail("invalid_argument", `regions[${index}]: mode must be 'auto' or 'manual'.`);
		}

		parsed.push({
			id: newRegionId(),
			startMs: entry.startMs,
			endMs: entry.endMs,
			depth,
			focus: focus ?? { cx: 0.5, cy: 0.5 },
			mode,
		});
	}

	const existing = context.zoomRegions;
	for (let i = 0; i < parsed.length; i++) {
		for (let j = i + 1; j < parsed.length; j++) {
			if (overlaps(parsed[i], parsed[j])) {
				return fail(
					"overlap",
					`regions[${i}] and regions[${j}] overlap; zoom regions must be disjoint.`,
				);
			}
		}
		const clash = existing.find((region) => overlaps(parsed[i], region));
		if (clash) {
			return fail(
				"overlap",
				`regions[${i}] overlaps existing region ${clash.id} at [${Math.round(clash.startMs)}, ${Math.round(clash.endMs)}). Move it, or change the existing one with update_zoom_regions.`,
			);
		}
	}

	const next = [...existing, ...parsed].sort((a, b) => a.startMs - b.startMs);
	context.setZoomRegions(next);

	return ok({ added: parsed.map(describe), totalRegions: next.length });
}

export function updateZoomRegions(
	args: Record<string, unknown>,
	context: AgentEditorContext,
): AgentToolResult {
	const setEntries = args.set === undefined ? [] : args.set;
	const removeIds = args.remove === undefined ? [] : args.remove;
	if (!Array.isArray(setEntries) || !Array.isArray(removeIds)) {
		return fail("invalid_argument", "set and remove must be arrays when provided.");
	}
	if (setEntries.length === 0 && removeIds.length === 0) {
		return fail("invalid_argument", "Pass at least one of set or remove.");
	}

	const byId = new Map(context.zoomRegions.map((region) => [region.id, region]));
	const patched = new Map<string, ZoomRegion>();

	for (let index = 0; index < setEntries.length; index++) {
		const entry = setEntries[index] as Record<string, unknown>;
		if (typeof entry !== "object" || entry === null || typeof entry.regionId !== "string") {
			return fail("invalid_argument", `set[${index}] needs a string regionId.`);
		}
		const current = byId.get(entry.regionId);
		if (!current) {
			return fail(
				"unknown_region",
				`No zoom region with id '${entry.regionId}'. Re-read get_timeline.`,
			);
		}

		const startMs = entry.startMs === undefined ? current.startMs : entry.startMs;
		const endMs = entry.endMs === undefined ? current.endMs : entry.endMs;
		if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs) || endMs <= startMs) {
			return fail(
				"invalid_argument",
				`set[${index}]: endMs must be a finite number greater than startMs.`,
			);
		}
		if (startMs < 0 || endMs > context.totalMs) {
			return fail(
				"out_of_range",
				`set[${index}] spans [${startMs}, ${endMs}) but the recording is ${Math.round(context.totalMs)}ms long.`,
			);
		}
		if (endMs - startMs < MIN_REGION_MS) {
			return fail("too_short", `set[${index}] would be under ${MIN_REGION_MS}ms.`);
		}

		const depth = entry.depth === undefined ? current.depth : parseDepth(entry.depth);
		if (depth === "invalid") {
			return fail("invalid_argument", `set[${index}]: depth must be an integer 1–6.`);
		}
		const focus = entry.focus === undefined ? current.focus : parseFocus(entry.focus);
		if (focus === "invalid" || focus === null) {
			return fail(
				"invalid_argument",
				`set[${index}]: focus must be {cx, cy} with both in 0–1.`,
			);
		}
		const mode = entry.mode === undefined ? (current.mode ?? "auto") : parseMode(entry.mode);
		if (mode === "invalid") {
			return fail("invalid_argument", `set[${index}]: mode must be 'auto' or 'manual'.`);
		}

		patched.set(current.id, { id: current.id, startMs, endMs, depth, focus, mode });
	}

	const removing = new Set<string>();
	for (const id of removeIds) {
		if (typeof id !== "string") {
			return fail("invalid_argument", "remove must contain only region id strings.");
		}
		if (!byId.has(id)) {
			return fail("unknown_region", `No zoom region with id '${id}'. Re-read get_timeline.`);
		}
		removing.add(id);
	}

	const next = context.zoomRegions
		.map((region) => patched.get(region.id) ?? region)
		.filter((region) => !removing.has(region.id))
		.sort((a, b) => a.startMs - b.startMs);

	for (let i = 1; i < next.length; i++) {
		if (overlaps(next[i - 1], next[i])) {
			return fail(
				"overlap",
				`The result would overlap regions ${next[i - 1].id} and ${next[i].id}. Nothing was changed.`,
			);
		}
	}

	context.setZoomRegions(next);

	return ok({
		updated: [...patched.values()].map(describe),
		removed: [...removing],
		totalRegions: next.length,
	});
}
