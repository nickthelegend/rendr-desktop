// Named grades, and the rule that a bad one cannot make a project unopenable.

import { describe, expect, it } from "vitest";

import { findLook, type LookModel, parseLooks, sameName, sortLooks } from "./looks";

const grade = { exposure: 0, contrast: 1, saturation: 1 } as LookModel["grade"];
const look = (over: Partial<LookModel> = {}): LookModel => ({
	id: "l1",
	name: "Warm",
	grade,
	createdAt: "2026-01-01T00:00:00Z",
	...over,
});

describe("parseLooks", () => {
	it("keeps a well-formed look", () => {
		expect(parseLooks([look()])).toHaveLength(1);
	});

	it("drops anything that isn't a look instead of throwing", () => {
		// A project that fails to open is a worse outcome than one that opens
		// without its presets, so every rejection here is silent.
		expect(parseLooks([null, 7, "no", {}, { id: "x" }])).toEqual([]);
		expect(parseLooks("not an array")).toEqual([]);
	});

	it("drops a grade whose numbers are strings", () => {
		// These would reach the renderer as NaN and grade the clip to black.
		expect(parseLooks([look({ grade: { exposure: "1" } as never })])).toEqual([]);
	});

	it("keeps the first of two looks sharing an id", () => {
		const parsed = parseLooks([look({ name: "First" }), look({ name: "Second" })]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe("First");
	});

	it("survives a missing timestamp", () => {
		expect(parseLooks([look({ createdAt: undefined as never })])[0].createdAt).toBe("");
	});
});

describe("finding a look", () => {
	it("matches an id exactly and a name loosely", () => {
		const looks = [look({ id: "l1", name: "Warm Film" })];
		expect(findLook(looks, "l1")?.id).toBe("l1");
		expect(findLook(looks, "  warm film ")?.id).toBe("l1");
		expect(findLook(looks, "cold")).toBeNull();
	});

	it("prefers an id over a name, so an id is never ambiguous", () => {
		const looks = [look({ id: "Warm", name: "Other" }), look({ id: "l2", name: "Warm" })];
		expect(findLook(looks, "Warm")?.name).toBe("Other");
	});

	it("treats case and surrounding space as the same name", () => {
		expect(sameName("Warm Film", " warm FILM ")).toBe(true);
		expect(sameName("Warm", "Warmer")).toBe(false);
	});
});

describe("sortLooks", () => {
	it("puts the newest first", () => {
		const sorted = sortLooks([
			look({ id: "a", createdAt: "2026-01-01T00:00:00Z" }),
			look({ id: "b", createdAt: "2026-06-01T00:00:00Z" }),
		]);
		expect(sorted.map((entry) => entry.id)).toEqual(["b", "a"]);
	});

	it("does not throw on a look with no timestamp", () => {
		expect(sortLooks([look({ id: "a", createdAt: "" }), look({ id: "b" })])).toHaveLength(2);
	});
});
