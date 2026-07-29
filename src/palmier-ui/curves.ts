// Tone curves and the three-way colour balance.
//
// Both reduce to the same thing: one 256-entry lookup per channel. That matters
// because a per-channel lookup is the one colour operation both renderers can
// apply — the DOM preview through an SVG `feComponentTransfer`, and the canvas
// encoder through a direct pixel map. Anything needing a pixel's *other*
// channels (hue curves, a 3D LUT) cannot be expressed this way, which is why
// apply_color refuses those instead of quietly dropping them.
//
// The balance follows lift / gamma / gain, the model colourists actually use:
// lift moves the shadows, gamma bends the midtones, gain scales the highlights.

/** A curve is control points in 0–1, sorted by x. Empty means identity. */
export interface CurvePoint {
	x: number;
	y: number;
}

export interface ToneCurves {
	master?: CurvePoint[];
	red?: CurvePoint[];
	green?: CurvePoint[];
	blue?: CurvePoint[];
}

/** Hue is degrees; amount is 0–1. The rest are the classic lift/gamma/gain. */
export interface ColorBalance {
	shadowsHue?: number;
	shadowsAmount?: number;
	/** Lifts or crushes the black point, −1…1. */
	shadowsLum?: number;
	midsHue?: number;
	midsAmount?: number;
	/** Midtone gamma, 0.1…4. 1 is neutral. */
	midsGamma?: number;
	highsHue?: number;
	highsAmount?: number;
	/** Highlight gain, 0…4. 1 is neutral. */
	highsGain?: number;
}

export interface ChannelLuts {
	r: Uint8Array;
	g: Uint8Array;
	b: Uint8Array;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Parses the wire format — a flat `[x0, y0, x1, y1, …]` list, or objects.
 *
 * Returns a message rather than throwing: the caller is an agent that needs to
 * be told which point was wrong.
 */
export function parseCurve(
	name: string,
	value: unknown,
): { ok: true; points: CurvePoint[] } | { ok: false; reason: string } {
	if (value === undefined || value === null) return { ok: true, points: [] };
	if (!Array.isArray(value)) {
		return { ok: false, reason: `${name} must be an array of points.` };
	}
	if (value.length === 0) return { ok: true, points: [] };

	const points: CurvePoint[] = [];
	if (typeof value[0] === "number") {
		if (value.length % 2 !== 0) {
			return { ok: false, reason: `${name} needs an even number of values — x, y pairs.` };
		}
		for (let index = 0; index < value.length; index += 2) {
			const x = value[index];
			const y = value[index + 1];
			if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x + y)) {
				return {
					ok: false,
					reason: `${name} has a non-finite value at pair ${index / 2}.`,
				};
			}
			points.push({ x: clamp01(x), y: clamp01(y) });
		}
	} else {
		for (let index = 0; index < value.length; index++) {
			const point = value[index] as { x?: unknown; y?: unknown };
			if (typeof point?.x !== "number" || typeof point?.y !== "number") {
				return { ok: false, reason: `${name}[${index}] needs numeric x and y.` };
			}
			points.push({ x: clamp01(point.x), y: clamp01(point.y) });
		}
	}

	points.sort((a, b) => a.x - b.x);
	if (points.length < 2) {
		return {
			ok: false,
			reason: `${name} needs at least two points; one point describes no curve.`,
		};
	}
	return { ok: true, points };
}

/**
 * Samples a curve at x using monotone cubic interpolation.
 *
 * Plain cubic overshoots between close control points, which shows up as a
 * bright halo where a curve was meant to roll off. Monotone interpolation
 * cannot overshoot, so the curve does what its shape says.
 */
export function sampleCurve(points: readonly CurvePoint[], x: number): number {
	if (points.length === 0) return clamp01(x);
	if (points.length === 1) return clamp01(points[0].y);
	if (x <= points[0].x) return clamp01(points[0].y);
	const last = points[points.length - 1];
	if (x >= last.x) return clamp01(last.y);

	let index = 0;
	while (index < points.length - 2 && x > points[index + 1].x) index++;
	const p0 = points[index];
	const p1 = points[index + 1];
	const span = p1.x - p0.x;
	if (span <= 0) return clamp01(p1.y);

	const t = (x - p0.x) / span;
	// Fritsch–Carlson tangents, clamped so no segment can overshoot its ends.
	const secant = (p1.y - p0.y) / span;
	const before = points[index - 1];
	const after = points[index + 2];
	const m0 = before
		? limit((secant + (p0.y - before.y) / (p0.x - before.x)) / 2, secant)
		: secant;
	const m1 = after ? limit((secant + (after.y - p1.y) / (after.x - p1.x)) / 2, secant) : secant;

	const t2 = t * t;
	const t3 = t2 * t;
	const value =
		(2 * t3 - 3 * t2 + 1) * p0.y +
		(t3 - 2 * t2 + t) * span * m0 +
		(-2 * t3 + 3 * t2) * p1.y +
		(t3 - t2) * span * m1;
	return clamp01(value);
}

function limit(tangent: number, secant: number): number {
	if (secant === 0) return 0;
	// Same sign as the segment, and no steeper than three times it.
	if (tangent * secant <= 0) return 0;
	return Math.sign(secant) * Math.min(Math.abs(tangent), 3 * Math.abs(secant));
}

/** Hue in degrees to the RGB direction it pushes, normalised so no channel clips first. */
function hueDirection(degrees: number): [number, number, number] {
	const hue = (((degrees % 360) + 360) % 360) / 60;
	const sector = Math.floor(hue) % 6;
	const f = hue - Math.floor(hue);
	const table: Array<[number, number, number]> = [
		[1, f, 0],
		[1 - f, 1, 0],
		[0, 1, f],
		[0, 1 - f, 1],
		[f, 0, 1],
		[1, 0, 1 - f],
	];
	const [r, g, b] = table[sector];
	// Centre on grey so a balance tints without also changing exposure.
	const mean = (r + g + b) / 3;
	return [r - mean, g - mean, b - mean];
}

export function hasBalance(balance: ColorBalance | undefined): boolean {
	if (!balance) return false;
	return (
		(balance.shadowsAmount ?? 0) !== 0 ||
		(balance.shadowsLum ?? 0) !== 0 ||
		(balance.midsAmount ?? 0) !== 0 ||
		(balance.midsGamma ?? 1) !== 1 ||
		(balance.highsAmount ?? 0) !== 0 ||
		(balance.highsGain ?? 1) !== 1
	);
}

export function hasCurves(curves: ToneCurves | undefined): boolean {
	if (!curves) return false;
	return Object.values(curves).some((points) => (points?.length ?? 0) >= 2);
}

/**
 * The lookup table each channel gets: balance first, then the master curve,
 * then that channel's own curve.
 *
 * Order matters and is the standard one — grading before the curve means the
 * curve shapes the result you are looking at, not the untouched source.
 */
export function buildChannelLuts(
	curves: ToneCurves | undefined,
	balance: ColorBalance | undefined,
): ChannelLuts | null {
	if (!hasCurves(curves) && !hasBalance(balance)) return null;

	const shadows = hueDirection(balance?.shadowsHue ?? 0);
	const mids = hueDirection(balance?.midsHue ?? 0);
	const highs = hueDirection(balance?.highsHue ?? 0);

	const shadowsAmount = balance?.shadowsAmount ?? 0;
	const shadowsLum = balance?.shadowsLum ?? 0;
	const midsAmount = balance?.midsAmount ?? 0;
	const midsGamma = Math.max(0.1, Math.min(4, balance?.midsGamma ?? 1));
	const highsAmount = balance?.highsAmount ?? 0;
	const highsGain = Math.max(0, Math.min(4, balance?.highsGain ?? 1));

	const perChannel = [curves?.red ?? [], curves?.green ?? [], curves?.blue ?? []];
	const master = curves?.master ?? [];
	const luts: Uint8Array[] = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];

	for (let channel = 0; channel < 3; channel++) {
		const lift = shadowsLum + shadowsAmount * shadows[channel];
		const gain = highsGain + highsAmount * highs[channel];
		// A midtone tint is a gamma nudge: pushing a channel's gamma down
		// brightens it in the mids without touching black or white.
		const gamma = Math.max(0.1, midsGamma - midsAmount * mids[channel]);

		for (let value = 0; value < 256; value++) {
			let level = value / 255;
			// Lift raises the floor and compresses toward white, which is what
			// keeps a lifted black from also blowing the highlights out.
			level = lift + level * (1 - lift);
			level = clamp01(level) ** (1 / gamma);
			level = clamp01(level * gain);
			if (master.length >= 2) level = sampleCurve(master, level);
			if (perChannel[channel].length >= 2) level = sampleCurve(perChannel[channel], level);
			luts[channel][value] = Math.round(clamp01(level) * 255);
		}
	}

	return { r: luts[0], g: luts[1], b: luts[2] };
}

/** `tableValues` for an SVG feFuncR/G/B — the DOM preview's half of the pair. */
export function lutToTableValues(lut: Uint8Array, samples = 32): string {
	const values: string[] = [];
	for (let index = 0; index < samples; index++) {
		const at = Math.round((index / (samples - 1)) * 255);
		values.push((lut[at] / 255).toFixed(4));
	}
	return values.join(" ");
}

/** Applies the tables to raw RGBA pixels — the encoder's half of the pair. */
export function applyLuts(pixels: Uint8ClampedArray, luts: ChannelLuts): void {
	for (let index = 0; index < pixels.length; index += 4) {
		pixels[index] = luts.r[pixels[index]];
		pixels[index + 1] = luts.g[pixels[index + 1]];
		pixels[index + 2] = luts.b[pixels[index + 2]];
	}
}
