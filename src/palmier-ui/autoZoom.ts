// Cutting a take's zooms from its cursor telemetry.
//
// This is Recordly's `detectInteractionCandidates`, used as Recordly's own
// editor uses it: **both** kinds of candidate, not just clicks.
//
// Recordly exports `buildInteractionZoomSuggestions`, and it is tempting to
// call that and stop — but it filters to `source === "explicit"`, throwing away
// every dwell. On a real take that is the difference between one zoom and a
// dozen: most of the moments worth punching in on are moments where somebody
// stopped and looked at something, and a lot of those never involve a click at
// all — reading a diff, watching a log, hovering a menu.
//
// The candidates come from Recordly. The grouping into regions is here, because
// Rendr's regions carry a depth and a mode that Recordly's suggestion shape
// doesn't have.

import {
	detectInteractionCandidates,
	normalizeCursorTelemetry,
} from "@/components/video-editor/timeline/zoomSuggestionUtils";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";

export interface AutoZoomRegion {
	startMs: number;
	endMs: number;
	depth: number;
	focus: { cx: number; cy: number };
	mode: "auto";
	/** What triggered it, carried into the tool response. */
	reason: string;
}

export interface AutoZoomOptions {
	/** Length of the take, in source milliseconds. */
	totalMs: number;
	/** Spans already covered by a region — nothing is proposed over them. */
	reserved?: ReadonlyArray<{ start: number; end: number }>;
	/** Most regions to return. */
	max?: number;
}

/** How long a zoom runs when the candidate doesn't imply its own length. */
const DEFAULT_DURATION_MS = 2000;
/** Lead-in before the moment, so the punch-in lands as it happens. */
const PAD_BEFORE_MS = 500;
const PAD_AFTER_MS = 900;
/**
 * Candidates closer together than this become one region.
 *
 * Recordly merges click clusters at 2500 ms. Dwells are included here too and
 * they are much more frequent, so a gap that wide would swallow a whole take
 * into a single region that never releases. 1200 ms keeps distinct moments
 * distinct while still merging a double-click into one move.
 */
const MERGE_GAP_MS = 1200;
/** Below this a region is too brief to read as a deliberate move. */
const MIN_DURATION_MS = 900;

/**
 * Depth from how strong the moment was.
 *
 * Recordly's strengths run ~900 for a plain click to ~1500 for a double-click,
 * and a dwell's strength is its duration in ms. A firmer signal earns a tighter
 * punch-in; everything else sits at a comfortable middle depth.
 */
function depthFor(strength: number): number {
	if (strength >= 1400) return 3;
	if (strength >= 1000) return 2;
	return 2;
}

const overlaps = (
	start: number,
	end: number,
	spans: ReadonlyArray<{ start: number; end: number }>,
): boolean => spans.some((span) => start < span.end && end > span.start);

/**
 * Cuts a take's zooms.
 *
 * Returns regions in Rendr's own shape, ready for `add_zoom_regions` or to be
 * applied straight onto a fresh recording.
 */
export function autoZoomRegions(
	telemetry: readonly CursorTelemetryPoint[],
	options: AutoZoomOptions,
): AutoZoomRegion[] {
	const { totalMs, reserved = [], max = 24 } = options;
	if (totalMs <= 0 || telemetry.length === 0) return [];

	const samples = normalizeCursorTelemetry(telemetry as CursorTelemetryPoint[], totalMs);
	if (samples.length < 2) return [];

	// Both sources. This is the line that separates one zoom from a take's worth.
	const candidates = detectInteractionCandidates(samples)
		.slice()
		.sort((a, b) => a.centerTimeMs - b.centerTimeMs);
	if (candidates.length === 0) return [];

	// Group neighbours into one move, so a burst of clicks in one place is a
	// single punch-in that holds rather than a stutter of them.
	type Group = {
		start: number;
		end: number;
		cx: number;
		cy: number;
		weight: number;
		strength: number;
		explicit: boolean;
	};
	const groups: Group[] = [];
	for (const candidate of candidates) {
		const last = groups[groups.length - 1];
		const weight = Math.max(1, candidate.strength);
		const isClick = candidate.source === "explicit";
		if (last && candidate.centerTimeMs - last.end <= MERGE_GAP_MS) {
			// The focus is weighted by strength, so a firm click inside a group
			// pulls the shot toward itself rather than being averaged away.
			last.cx =
				(last.cx * last.weight + candidate.focus.cx * weight) / (last.weight + weight);
			last.cy =
				(last.cy * last.weight + candidate.focus.cy * weight) / (last.weight + weight);
			last.weight += weight;
			last.end = candidate.centerTimeMs;
			last.strength = Math.max(last.strength, candidate.strength);
			last.explicit = last.explicit || isClick;
			continue;
		}
		groups.push({
			start: candidate.centerTimeMs,
			end: candidate.centerTimeMs,
			cx: candidate.focus.cx,
			cy: candidate.focus.cy,
			weight,
			strength: candidate.strength,
			explicit: isClick,
		});
	}

	const regions: AutoZoomRegion[] = [];
	for (const group of groups) {
		let startMs = Math.max(0, group.start - PAD_BEFORE_MS);
		let endMs = Math.min(
			totalMs,
			Math.max(group.end + PAD_AFTER_MS, startMs + DEFAULT_DURATION_MS),
		);
		if (endMs - startMs < MIN_DURATION_MS) continue;

		// Never propose over a region that already exists, and never over one
		// this pass has already cut.
		const taken = [...reserved, ...regions.map((r) => ({ start: r.startMs, end: r.endMs }))];
		if (overlaps(startMs, endMs, taken)) {
			// Try to fit in whatever gap is left before giving up on the moment.
			const blocker = taken
				.filter((span) => startMs < span.end && endMs > span.start)
				.sort((a, b) => a.start - b.start)[0];
			if (!blocker) continue;
			if (blocker.start > startMs + MIN_DURATION_MS) endMs = blocker.start;
			else if (blocker.end < endMs - MIN_DURATION_MS) startMs = blocker.end;
			else continue;
			if (endMs - startMs < MIN_DURATION_MS || overlaps(startMs, endMs, taken)) continue;
		}

		regions.push({
			startMs: Math.round(startMs),
			endMs: Math.round(endMs),
			depth: depthFor(group.strength),
			focus: {
				cx: Math.min(1, Math.max(0, group.cx)),
				cy: Math.min(1, Math.max(0, group.cy)),
			},
			mode: "auto",
			reason: group.explicit ? "click" : "dwell",
		});
		if (regions.length >= max) break;
	}

	return regions;
}
