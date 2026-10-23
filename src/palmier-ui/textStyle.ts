// The one door an agent's text style comes in through.
//
// add_texts, update_text, add_captions and style_captions all take a style,
// and each used to read it differently: update_text spread the raw object into
// the model, so a schema field the renderer had never heard of (fontName,
// outline, shadow, a nested background) was stored, echoed back as if it had
// worked, and drawn as nothing. This maps the schema's vocabulary onto
// TextStyle's, validates every value, and names whatever it could not use, so
// a caller is told rather than quietly ignored.

import { CLIP_LIMITS, TEXT_ANIMATIONS, type TextAnimation, type TextStyle } from "./model";

/** A style patch. `undefined` on a key means "clear it". */
export type TextStylePatch = { [K in keyof TextStyle]?: TextStyle[K] | undefined };

export interface ParsedTextStyle {
	patch: TextStylePatch;
	/** Keys that were not understood, as the caller spelled them. Nothing was stored for them. */
	ignored: string[];
	/** Values that were understood but invalid. A caller should fail on any. */
	errors: string[];
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** #RGB grows to #RRGGBB so every stored colour has one spelling. */
function normalizeHex(value: string): string {
	const upper = value.toUpperCase();
	if (upper.length !== 4) return upper;
	return `#${upper[1]}${upper[1]}${upper[2]}${upper[2]}${upper[3]}${upper[3]}`;
}

/** Folds an opacity into a colour as its alpha byte, replacing any it had. */
function withAlpha(hex: string, opacity: number): string {
	const base = normalizeHex(hex).slice(0, 7);
	const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255)
		.toString(16)
		.padStart(2, "0")
		.toUpperCase();
	return `${base}${alpha}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** "none", "off", false or null all mean "remove this". */
const isClear = (value: unknown) =>
	value === null || value === false || value === "none" || value === "off";

/**
 * Parses a style object in the tool schema's vocabulary, or the model's own.
 *
 * Both spellings are accepted because both are in circulation: the schema
 * says fontName and outline, get_timeline reports fontFamily and strokeColor,
 * and an agent copying a style from one clip to another should not have to
 * translate it.
 */
export function parseTextStyle(input: unknown): ParsedTextStyle {
	const patch: TextStylePatch = {};
	const ignored: string[] = [];
	const errors: string[] = [];
	if (input === undefined || input === null) return { patch, ignored, errors };
	if (!isRecord(input)) {
		return { patch, ignored, errors: ["style must be an object."] };
	}

	const color = (key: string, value: unknown, allowClear = false): string | null | undefined => {
		if (allowClear && isClear(value)) return undefined;
		if (typeof value === "string" && HEX.test(value)) return normalizeHex(value);
		errors.push(
			`${key} must be a hex colour like '#FFE14D'${allowClear ? " or 'none'" : ""}, not ${JSON.stringify(value)}.`,
		);
		return null;
	};
	const number = (key: string, value: unknown, min: number, max: number): number | null => {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			errors.push(`${key} must be a number.`);
			return null;
		}
		if (value < min || value > max) {
			errors.push(`${key} must be between ${min} and ${max}, not ${value}.`);
			return null;
		}
		return value;
	};
	const boolean = (key: string, value: unknown): boolean | null => {
		if (typeof value === "boolean") return value;
		errors.push(`${key} must be true or false.`);
		return null;
	};
	/** Sets a parsed value, skipping the ones that failed (null). */
	const set = <K extends keyof TextStyle>(key: K, value: TextStyle[K] | null | undefined) => {
		if (value !== null) patch[key] = value;
	};

	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		switch (key) {
			case "fontName":
			case "fontFamily":
				if (typeof value === "string" && value.trim()) set("fontFamily", value.trim());
				else errors.push(`${key} must be a font name.`);
				break;
			case "fontSize": {
				const size = number(key, value, CLIP_LIMITS.fontSize.min, CLIP_LIMITS.fontSize.max);
				set("fontSize", size === null ? null : Math.round(size));
				break;
			}
			case "fontWeight": {
				const weight = number(key, value, 100, 900);
				// CSS weights are hundreds; 850 would round differently per engine.
				set("fontWeight", weight === null ? null : Math.round(weight / 100) * 100);
				break;
			}
			case "bold":
			case "italic":
			case "uppercase":
			case "wrap":
				set(key, boolean(key, value));
				break;
			case "fontCase":
				if (value === "uppercase") set("uppercase", true);
				else if (value === "mixed") set("uppercase", false);
				else
					errors.push(
						`fontCase must be 'mixed' or 'uppercase', not ${JSON.stringify(value)}.`,
					);
				break;
			case "tracking":
				set(
					"tracking",
					number(key, value, CLIP_LIMITS.tracking.min, CLIP_LIMITS.tracking.max),
				);
				break;
			case "lineSpacing":
				set("lineSpacing", number(key, value, -100, 300));
				break;
			case "maxWidth":
				set("maxWidth", number(key, value, 0.1, 1));
				break;
			case "alignment":
				if (value === "left" || value === "center" || value === "right")
					set("alignment", value);
				else
					errors.push(
						`alignment must be left, center or right, not ${JSON.stringify(value)}.`,
					);
				break;
			case "animation":
				if (
					typeof value === "string" &&
					(TEXT_ANIMATIONS as readonly string[]).includes(value)
				)
					set("animation", value as TextAnimation);
				else
					errors.push(
						`Unknown animation ${JSON.stringify(value)}. One of ${TEXT_ANIMATIONS.join(", ")}.`,
					);
				break;
			case "color":
			case "highlightColor":
				set(key, color(key, value));
				break;
			case "spokenColor":
			case "activeWordBackground":
			case "strokeColor":
			case "shadowColor":
			case "backgroundColor":
				set(key, color(key, value, true));
				break;
			case "activeWordScale":
				set("activeWordScale", number(key, value, 0.5, 2));
				break;
			case "upcomingOpacity":
			case "backgroundOpacity":
			case "backgroundPadding":
			case "backgroundRadius":
				set(key, number(key, value, 0, 1));
				break;
			case "strokeWidth":
				set("strokeWidth", number(key, value, 0, 40));
				break;
			case "shadowBlur":
				set("shadowBlur", number(key, value, 0, 100));
				break;
			case "shadowOffsetX":
			case "shadowOffsetY":
				set(key, number(key, value, -200, 200));
				break;
			case "outline":
				parseOutline(value);
				break;
			case "shadow":
				parseShadow(value);
				break;
			case "background":
				parseBackground(value);
				break;
			default:
				ignored.push(key);
		}
	}

	// The nested objects, in the schema's shape.
	function parseOutline(value: unknown) {
		if (isClear(value) || (isRecord(value) && value.enabled === false)) {
			patch.strokeColor = undefined;
			patch.strokeWidth = undefined;
			return;
		}
		if (!isRecord(value)) {
			errors.push("outline must be an object like {color, width}.");
			return;
		}
		for (const key of Object.keys(value))
			if (!["enabled", "color", "width"].includes(key)) ignored.push(`outline.${key}`);
		set(
			"strokeColor",
			value.color === undefined ? "#000000" : color("outline.color", value.color),
		);
		// An outline switched on with no width still has to show.
		set(
			"strokeWidth",
			value.width === undefined ? 4 : number("outline.width", value.width, 0, 40),
		);
	}

	function parseShadow(value: unknown) {
		if (isClear(value) || (isRecord(value) && value.enabled === false)) {
			patch.shadowColor = undefined;
			patch.shadowBlur = undefined;
			patch.shadowOffsetX = undefined;
			patch.shadowOffsetY = undefined;
			return;
		}
		if (!isRecord(value)) {
			errors.push("shadow must be an object like {color, opacity, blur, offset: {x, y}}.");
			return;
		}
		for (const key of Object.keys(value))
			if (!["enabled", "color", "opacity", "blur", "offset"].includes(key))
				ignored.push(`shadow.${key}`);
		const base = value.color === undefined ? "#000000" : color("shadow.color", value.color);
		const opacity =
			value.opacity === undefined ? 0.6 : number("shadow.opacity", value.opacity, 0, 1);
		if (base !== null && base !== undefined && opacity !== null)
			set("shadowColor", withAlpha(base, opacity));
		set("shadowBlur", value.blur === undefined ? 8 : number("shadow.blur", value.blur, 0, 100));
		const offset = isRecord(value.offset) ? value.offset : {};
		if (value.offset !== undefined && !isRecord(value.offset))
			errors.push("shadow.offset must be {x, y}.");
		set(
			"shadowOffsetX",
			offset.x === undefined ? 0 : number("shadow.offset.x", offset.x, -200, 200),
		);
		set(
			"shadowOffsetY",
			offset.y === undefined ? 4 : number("shadow.offset.y", offset.y, -200, 200),
		);
	}

	function parseBackground(value: unknown) {
		if (isClear(value) || (isRecord(value) && value.enabled === false)) {
			patch.backgroundColor = undefined;
			return;
		}
		if (!isRecord(value)) {
			errors.push("background must be an object like {color, opacity, padding, radius}.");
			return;
		}
		for (const key of Object.keys(value))
			if (!["enabled", "color", "opacity", "padding", "radius"].includes(key))
				ignored.push(`background.${key}`);
		set(
			"backgroundColor",
			value.color === undefined ? "#000000" : color("background.color", value.color),
		);
		if (value.opacity !== undefined)
			set("backgroundOpacity", number("background.opacity", value.opacity, 0, 1));
		if (value.padding !== undefined)
			set("backgroundPadding", number("background.padding", value.padding, 0, 1));
		if (value.radius !== undefined)
			set("backgroundRadius", number("background.radius", value.radius, 0, 1));
	}

	return { patch, ignored, errors };
}

/**
 * The receipt fields a tool adds when a style had keys it could not use.
 *
 * Empty when everything was understood, so a clean call's result is unchanged.
 */
export function ignoredStyleReceipt(ignored: readonly string[]): Record<string, unknown> {
	if (ignored.length === 0) return {};
	return {
		ignoredStyleKeys: [...ignored],
		warnings: [
			`Ignored style key${ignored.length === 1 ? "" : "s"} ${ignored.map((key) => `'${key}'`).join(", ")}: Rendr's text has no such property, so nothing was stored for ${ignored.length === 1 ? "it" : "them"}.`,
		],
	};
}
