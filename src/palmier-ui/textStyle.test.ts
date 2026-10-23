import { describe, expect, it } from "vitest";

import { TEXT_ANIMATIONS as SCHEMA_ANIMATIONS } from "../../electron/mcp/toolDefinitions";
import { TEXT_ANIMATIONS } from "./model";
import { ignoredStyleReceipt, parseTextStyle } from "./textStyle";

describe("parseTextStyle", () => {
	it("maps the schema's names onto the model's", () => {
		const { patch, ignored, errors } = parseTextStyle({
			fontName: "Inter",
			fontCase: "uppercase",
			outline: { color: "#000", width: 6 },
			shadow: { color: "#000000", opacity: 0.5, blur: 12, offset: { x: 1, y: 3 } },
			background: { color: "#112233", opacity: 0.7, padding: 0.4, radius: 0.5 },
		});
		expect(errors).toEqual([]);
		expect(ignored).toEqual([]);
		expect(patch).toEqual({
			fontFamily: "Inter",
			uppercase: true,
			strokeColor: "#000000",
			strokeWidth: 6,
			shadowColor: "#00000080",
			shadowBlur: 12,
			shadowOffsetX: 1,
			shadowOffsetY: 3,
			backgroundColor: "#112233",
			backgroundOpacity: 0.7,
			backgroundPadding: 0.4,
			backgroundRadius: 0.5,
		});
	});

	it("accepts the model's own names, so a style read off get_timeline pastes back", () => {
		const { patch, errors } = parseTextStyle({
			fontFamily: "Inter",
			fontWeight: 870,
			strokeColor: "#ffffff",
			strokeWidth: 3,
			activeWordScale: 1.15,
			activeWordBackground: "#7C3AED",
			spokenColor: "#22c55e",
			upcomingOpacity: 1,
			lineSpacing: 8,
			maxWidth: 0.7,
			wrap: false,
			animation: "bounce",
		});
		expect(errors).toEqual([]);
		expect(patch).toMatchObject({
			fontWeight: 900,
			strokeColor: "#FFFFFF",
			spokenColor: "#22C55E",
			activeWordScale: 1.15,
			wrap: false,
			animation: "bounce",
		});
	});

	it("names keys it cannot draw instead of storing them", () => {
		const { patch, ignored } = parseTextStyle({
			color: "#FFFFFF",
			widthScale: 1.2,
			underline: true,
			outline: { color: "#000000", dash: 3 },
		});
		expect(ignored).toEqual(["widthScale", "underline", "outline.dash"]);
		expect(patch).not.toHaveProperty("widthScale");
		expect(patch).not.toHaveProperty("underline");
	});

	it("clears a feature when it is switched off", () => {
		const { patch } = parseTextStyle({
			outline: { enabled: false },
			shadow: "none",
			background: { enabled: false },
			activeWordBackground: "none",
		});
		expect(Object.keys(patch).sort()).toEqual(
			[
				"activeWordBackground",
				"backgroundColor",
				"shadowBlur",
				"shadowColor",
				"shadowOffsetX",
				"shadowOffsetY",
				"strokeColor",
				"strokeWidth",
			].sort(),
		);
		expect(Object.values(patch).every((value) => value === undefined)).toBe(true);
	});

	it("rejects invalid values with a reason", () => {
		const { errors } = parseTextStyle({
			color: "red",
			fontSize: 900,
			animation: "wobble",
			alignment: "justify",
		});
		expect(errors).toHaveLength(4);
		expect(errors.join(" ")).toMatch(/wobble/);
	});

	it("gives an outline or a shadow switched on with no detail something visible", () => {
		expect(parseTextStyle({ outline: { enabled: true } }).patch).toEqual({
			strokeColor: "#000000",
			strokeWidth: 4,
		});
		expect(parseTextStyle({ shadow: { enabled: true } }).patch).toMatchObject({
			shadowColor: "#00000099",
			shadowBlur: 8,
			shadowOffsetY: 4,
		});
	});
});

describe("ignoredStyleReceipt", () => {
	it("is empty when everything was understood", () => {
		expect(ignoredStyleReceipt([])).toEqual({});
	});

	it("lists the keys and says nothing was stored", () => {
		const receipt = ignoredStyleReceipt(["underline"]);
		expect(receipt.ignoredStyleKeys).toEqual(["underline"]);
		expect(String((receipt.warnings as string[])[0])).toMatch(/'underline'/);
	});
});

describe("animation presets", () => {
	it("are the same list in the tool schema as in the renderer", () => {
		// The schema once advertised a 'bounce' the renderer never drew.
		expect([...SCHEMA_ANIMATIONS]).toEqual([...TEXT_ANIMATIONS]);
	});
});
