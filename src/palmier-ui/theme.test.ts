// Layout constants and the preset list.
//
// These are plain data, but they are data the shell divides its window by. A
// preset the View menu offers but the shell doesn't handle renders a menu item
// that does nothing, and a minimum wider than a default collapses a panel the
// moment it opens — neither shows up in a type check.

import { describe, expect, it } from "vitest";

import { LAYOUT_PRESETS, Layout } from "./theme";

describe("LAYOUT_PRESETS", () => {
	it("offers a unique id per preset", () => {
		const ids = LAYOUT_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("gives every preset a label to put in the menu", () => {
		for (const preset of LAYOUT_PRESETS) {
			expect(preset.label.trim().length).toBeGreaterThan(0);
		}
	});

	it("includes the default the editor falls back to", () => {
		expect(LAYOUT_PRESETS.some((preset) => preset.id === "default")).toBe(true);
	});
});

describe("Layout", () => {
	it("never sets a minimum wider than its own default", () => {
		// A panel whose minimum exceeds its default collapses the instant it
		// opens, which reads as the panel being broken.
		expect(Layout.inspectorMin).toBeLessThanOrEqual(Layout.inspectorDefault);
	});

	it("keeps the agent panel's range the right way round", () => {
		expect(Layout.agentPanelMin).toBeLessThan(Layout.agentPanelMax);
	});

	it("uses positive sizes throughout", () => {
		for (const [key, value] of Object.entries(Layout)) {
			expect(typeof value, key).toBe("number");
			expect(value, key).toBeGreaterThan(0);
		}
	});

	it("leaves room for a track inside the timeline's minimum height", () => {
		// A timeline shorter than one track plus its header can never show a
		// clip, however much media is on it.
		expect(Layout.timelineMinHeight).toBeGreaterThan(Layout.trackHeight);
	});
});
