// Named grades.
//
// A look is a ColorGrade with a name on it, stored beside the timelines rather
// than inside them: the whole point is that it outlives the clip it was pulled
// from and can be applied to a different project's footage.
//
// Nothing here renders. A look is applied by writing its grade onto clips
// through the same setClipColor every other colour tool uses, so a look can
// never disagree with a grade set by hand — there is only one grading path.

import type { ColorGrade } from "./model";

export interface LookModel {
	id: string;
	name: string;
	grade: ColorGrade;
	/** ISO timestamp, or "" when a stored file didn't carry one. */
	createdAt: string;
	/** What it was pulled from, for the "where did this come from" question. */
	sourceClip?: string;
}

/** Ids carry a random suffix so a look saved after a restart cannot collide. */
let counter = 0;
export function freshLookId(): string {
	counter += 1;
	return `look-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Case- and space-insensitive, so "Warm Film" and "warm film" are one look. */
export function sameName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function findLook(looks: readonly LookModel[], nameOrId: string): LookModel | null {
	const wanted = nameOrId.trim();
	return (
		looks.find((look) => look.id === wanted) ??
		looks.find((look) => sameName(look.name, wanted)) ??
		null
	);
}

/**
 * Reads looks out of a project file, dropping anything malformed.
 *
 * A project that throws on load is unopenable, and a look is decoration — the
 * edit survives without it. So every failure here is a silent drop rather than
 * an exception, the same rule `parseComments` follows.
 */
export function parseLooks(value: unknown): LookModel[] {
	if (!Array.isArray(value)) return [];
	const out: LookModel[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Partial<LookModel>;
		if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
		if (!entry.grade || typeof entry.grade !== "object") continue;
		// A grade whose numbers are strings would apply as NaN and render black.
		const grade = entry.grade as unknown as Record<string, unknown>;
		const numeric = ["exposure", "contrast", "saturation"] as const;
		if (numeric.some((key) => key in grade && typeof grade[key] !== "number")) continue;
		// Ids are unique by construction; a file with duplicates loses the later
		// one rather than shadowing lookups.
		if (out.some((look) => look.id === entry.id)) continue;
		out.push({
			id: entry.id,
			name: entry.name,
			grade: entry.grade as ColorGrade,
			createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
			...(typeof entry.sourceClip === "string" ? { sourceClip: entry.sourceClip } : {}),
		});
	}
	return out;
}

/** Newest first, which is the order a "which look was that" question wants. */
export function sortLooks(looks: readonly LookModel[]): LookModel[] {
	return [...looks].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
