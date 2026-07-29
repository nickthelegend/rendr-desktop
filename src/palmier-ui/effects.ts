// Non-colour effects: blur, sharpen, stylize, detail.
//
// Every effect resolves to a CSS filter string, because that is the one
// representation both renderers share — the preview applies it to a DOM node,
// and the canvas exporter assigns it to `context.filter`. An effect that only
// worked in one of them would make the export disagree with playback.

import { hasBalance, hasCurves } from "./curves";
import { type ColorGrade, isGraded } from "./model";

export interface EffectParam {
	key: string;
	min: number;
	max: number;
	defaultValue: number;
	unit: string;
}

export interface EffectDefinition {
	id: string;
	displayName: string;
	params: EffectParam[];
	/** Builds the CSS filter fragment for this effect's values. */
	toFilter: (params: Record<string, number>) => string;
}

export interface AppliedEffect {
	type: string;
	params: Record<string, number>;
	enabled?: boolean;
}

const param = (
	key: string,
	min: number,
	max: number,
	defaultValue: number,
	unit = "",
): EffectParam => ({ key, min, max, defaultValue, unit });

/**
 * The catalog. `apply_effect` reports this verbatim when called with no
 * arguments, so an agent can discover the real parameter ranges.
 */
export const EFFECTS: EffectDefinition[] = [
	{
		id: "blur.gaussian",
		displayName: "Gaussian Blur",
		params: [param("radius", 0, 40, 6, "px")],
		toFilter: (p) => (p.radius > 0 ? `blur(${p.radius}px)` : ""),
	},
	{
		id: "detail.sharpen",
		displayName: "Sharpen",
		params: [param("amount", 0, 2, 0.6)],
		// There is no CSS sharpen; contrast plus saturation is the honest
		// approximation that both renderers can actually apply.
		toFilter: (p) =>
			p.amount > 0
				? `contrast(${(1 + p.amount * 0.35).toFixed(3)}) saturate(${(1 + p.amount * 0.15).toFixed(3)})`
				: "",
	},
	{
		id: "stylize.glow",
		displayName: "Glow",
		params: [param("amount", 0, 1, 0.4)],
		toFilter: (p) =>
			p.amount > 0
				? `brightness(${(1 + p.amount * 0.25).toFixed(3)}) drop-shadow(0 0 ${(p.amount * 24).toFixed(1)}px rgba(255,255,255,${(p.amount * 0.5).toFixed(2)}))`
				: "",
	},
	{
		id: "stylize.monochrome",
		displayName: "Monochrome",
		params: [param("amount", 0, 1, 1)],
		toFilter: (p) => (p.amount > 0 ? `grayscale(${clamp(p.amount, 0, 1)})` : ""),
	},
	{
		id: "stylize.sepia",
		displayName: "Sepia",
		params: [param("amount", 0, 1, 1)],
		toFilter: (p) => (p.amount > 0 ? `sepia(${clamp(p.amount, 0, 1)})` : ""),
	},
	{
		id: "stylize.invert",
		displayName: "Invert",
		params: [param("amount", 0, 1, 1)],
		toFilter: (p) => (p.amount > 0 ? `invert(${clamp(p.amount, 0, 1)})` : ""),
	},
	{
		id: "detail.fade",
		displayName: "Fade",
		params: [param("amount", 0, 1, 0.3)],
		// A faded film look: lift the blacks by cutting contrast and saturation.
		toFilter: (p) =>
			p.amount > 0
				? `contrast(${(1 - p.amount * 0.3).toFixed(3)}) saturate(${(1 - p.amount * 0.35).toFixed(3)}) brightness(${(1 + p.amount * 0.08).toFixed(3)})`
				: "",
	},
];

const BY_ID = new Map(EFFECTS.map((effect) => [effect.id, effect]));

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

export function effectDefinition(id: string): EffectDefinition | undefined {
	return BY_ID.get(id);
}

/** Fills in defaults and clamps out-of-range values, as the contract promises. */
export function normalizeEffect(effect: AppliedEffect): AppliedEffect | null {
	const definition = BY_ID.get(effect.type);
	if (!definition) return null;
	const params: Record<string, number> = {};
	for (const spec of definition.params) {
		const given = effect.params?.[spec.key];
		params[spec.key] =
			typeof given === "number" ? clamp(given, spec.min, spec.max) : spec.defaultValue;
	}
	return { type: effect.type, params, enabled: effect.enabled !== false };
}

/**
 * Merges effects onto a clip's stack by type, as `apply_effect` promises:
 * what you pass is added or updated, what you don't is left alone.
 */
export function mergeEffects(
	current: readonly AppliedEffect[],
	incoming: readonly AppliedEffect[],
	remove: readonly string[] = [],
): AppliedEffect[] {
	const byType = new Map(current.map((effect) => [effect.type, effect]));
	for (const effect of incoming) {
		const normalized = normalizeEffect(effect);
		if (normalized) byType.set(normalized.type, normalized);
	}
	for (const type of remove) byType.delete(type);

	// Render order is canonical, not call order, so the look is reproducible.
	return EFFECTS.filter((definition) => byType.has(definition.id)).map(
		(definition) => byType.get(definition.id) as AppliedEffect,
	);
}

/** The CSS filter for a whole effect stack. Disabled effects are skipped. */
export function effectsToFilter(effects: readonly AppliedEffect[] | undefined): string {
	if (!effects?.length) return "";
	return effects
		.filter((effect) => effect.enabled !== false)
		.map((effect) => BY_ID.get(effect.type)?.toFilter(effect.params) ?? "")
		.filter(Boolean)
		.join(" ");
}

/** CSS filter chain approximating apply_color's knobs. */
function gradeFilter(color: ColorGrade): string {
	if (!isGraded(color)) return "";
	const parts = [
		`brightness(${(2 ** color.exposure).toFixed(3)})`,
		`contrast(${color.contrast.toFixed(3)})`,
		`saturate(${Math.max(0, color.saturation + color.vibrance * 0.4).toFixed(3)})`,
	];
	const warmth = (color.temperature - 6500) / 4500;
	if (warmth !== 0) parts.push(`sepia(${Math.min(1, Math.abs(warmth) * 0.5).toFixed(3)})`);
	if (color.tint !== 0) parts.push(`hue-rotate(${(color.tint * 0.6).toFixed(1)}deg)`);
	const lift = color.shadows * 0.25 + color.blacks * 0.15;
	if (lift !== 0) parts.push(`brightness(${(1 + lift).toFixed(3)})`);
	return parts.join(" ");
}

/**
 * The full filter for a clip: grade first, then the effect stack.
 *
 * The preview and the encoder both call this rather than each building their
 * own chain, which is the only way a look on screen is the look in the file.
 * Returns "none" so it can be assigned straight to `style.filter` or
 * `context.filter`, both of which take that literal.
 */
export function clipFilter(
	clip: { id?: string; color: ColorGrade; effects?: readonly AppliedEffect[] },
	/** True in the DOM preview, where curves are an SVG filter reference. */
	withCurveFilter = false,
): string {
	// Curves come first: they shape the source, and the grade and effects then
	// act on the shaped image — the same order buildChannelLuts assumes.
	const curves =
		withCurveFilter &&
		clip.id &&
		(hasCurves(clip.color.curves) || hasBalance(clip.color.balance))
			? `url(#${curveFilterId(clip.id)})`
			: "";
	const chain = [curves, gradeFilter(clip.color), effectsToFilter(clip.effects)]
		.filter(Boolean)
		.join(" ");
	return chain || "none";
}

/** One filter id per clip, so each clip's curve is its own. */
export function curveFilterId(clipId: string): string {
	return `pmr-curve-${clipId.replace(/[^\w-]/g, "")}`;
}

/** One line per effect, for the tool description's catalog. */
export function effectCatalog(): string {
	return EFFECTS.map((definition) => {
		const params = definition.params
			.map((p) => `${p.key} (${p.min}…${p.max}${p.unit}, default ${p.defaultValue})`)
			.join(", ");
		return `• ${definition.id} — ${definition.displayName}: ${params || "no params"}`;
	}).join("\n");
}
