import { describe, expect, it } from "vitest";

import {
	clipFilter,
	EFFECTS,
	effectCatalog,
	effectsToFilter,
	mergeEffects,
	normalizeEffect,
} from "./effects";
import { NEUTRAL_GRADE } from "./model";

describe("normalizeEffect", () => {
	it("fills in every declared default", () => {
		const glow = normalizeEffect({ type: "stylize.glow", params: {} });
		expect(glow?.params.amount).toBe(0.4);
	});

	it("clamps out-of-range values instead of rejecting them", () => {
		const blur = normalizeEffect({ type: "blur.gaussian", params: { radius: 999 } });
		expect(blur?.params.radius).toBe(40);
		const negative = normalizeEffect({ type: "blur.gaussian", params: { radius: -5 } });
		expect(negative?.params.radius).toBe(0);
	});

	it("drops params the effect doesn't declare", () => {
		const effect = normalizeEffect({
			type: "stylize.sepia",
			params: { amount: 0.5, nonsense: 3 },
		});
		expect(Object.keys(effect?.params ?? {})).toEqual(["amount"]);
	});

	it("returns null for an unknown type rather than inventing one", () => {
		expect(normalizeEffect({ type: "stylize.nope", params: {} })).toBeNull();
	});
});

describe("mergeEffects", () => {
	it("updates by type and leaves untouched effects in place", () => {
		const current = mergeEffects([], [{ type: "blur.gaussian", params: { radius: 4 } }]);
		const next = mergeEffects(current, [{ type: "stylize.sepia", params: { amount: 0.5 } }]);

		expect(next.map((effect) => effect.type)).toContain("blur.gaussian");
		expect(next.find((effect) => effect.type === "blur.gaussian")?.params.radius).toBe(4);
		expect(next).toHaveLength(2);
	});

	it("replaces rather than duplicates when the same type is applied twice", () => {
		const once = mergeEffects([], [{ type: "blur.gaussian", params: { radius: 4 } }]);
		const twice = mergeEffects(once, [{ type: "blur.gaussian", params: { radius: 9 } }]);
		expect(twice).toHaveLength(1);
		expect(twice[0].params.radius).toBe(9);
	});

	it("removes by type", () => {
		const current = mergeEffects(
			[],
			[
				{ type: "blur.gaussian", params: {} },
				{ type: "stylize.sepia", params: {} },
			],
		);
		expect(mergeEffects(current, [], ["blur.gaussian"]).map((e) => e.type)).toEqual([
			"stylize.sepia",
		]);
	});

	it("orders effects canonically, not by call order", () => {
		const a = mergeEffects(
			[],
			[
				{ type: "stylize.sepia", params: {} },
				{ type: "blur.gaussian", params: {} },
			],
		);
		const b = mergeEffects(
			[],
			[
				{ type: "blur.gaussian", params: {} },
				{ type: "stylize.sepia", params: {} },
			],
		);
		expect(a.map((e) => e.type)).toEqual(b.map((e) => e.type));
	});
});

describe("effectsToFilter", () => {
	it("is empty for no effects", () => {
		expect(effectsToFilter(undefined)).toBe("");
		expect(effectsToFilter([])).toBe("");
	});

	it("skips a bypassed effect but keeps it in the stack", () => {
		const stack = mergeEffects(
			[],
			[{ type: "blur.gaussian", params: { radius: 6 }, enabled: false }],
		);
		expect(stack).toHaveLength(1);
		expect(effectsToFilter(stack)).toBe("");
	});

	it("emits nothing for a zeroed effect", () => {
		const stack = mergeEffects([], [{ type: "blur.gaussian", params: { radius: 0 } }]);
		expect(effectsToFilter(stack)).toBe("");
	});

	it("produces a filter fragment for every catalog entry at its default", () => {
		for (const definition of EFFECTS) {
			const stack = mergeEffects([], [{ type: definition.id, params: {} }]);
			expect(effectsToFilter(stack), definition.id).not.toBe("");
		}
	});
});

describe("clipFilter", () => {
	it("is 'none' for a neutral clip, which is what CSS and canvas both take", () => {
		expect(clipFilter({ color: NEUTRAL_GRADE })).toBe("none");
	});

	it("puts the grade before the effect stack", () => {
		const filter = clipFilter({
			color: { ...NEUTRAL_GRADE, exposure: 1 },
			effects: mergeEffects([], [{ type: "blur.gaussian", params: { radius: 5 } }]),
		});
		expect(filter.indexOf("brightness")).toBeLessThan(filter.indexOf("blur"));
	});

	it("returns just the effects when the grade is neutral", () => {
		const filter = clipFilter({
			color: NEUTRAL_GRADE,
			effects: mergeEffects([], [{ type: "stylize.monochrome", params: { amount: 1 } }]),
		});
		expect(filter).toBe("grayscale(1)");
	});
});

describe("effectCatalog", () => {
	it("lists every effect with its real ranges", () => {
		const catalog = effectCatalog();
		for (const definition of EFFECTS) expect(catalog).toContain(definition.id);
		expect(catalog).toContain("0…40px");
	});
});
