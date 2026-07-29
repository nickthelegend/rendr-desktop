// Grades that need to see a whole pixel.
//
// curves.ts covers everything expressible as a per-channel transfer: a red
// value maps to a red value regardless of the green beside it, which is what
// lets the preview run it as an SVG feComponentTransfer and the encoder run it
// as a lookup table, with both agreeing exactly.
//
// Hue curves and 3D LUTs are not that. "Make the reds less saturated" needs the
// pixel's hue, which depends on all three channels at once, and a .cube samples
// an RGB *cube* rather than three independent lines. Both are done here, on raw
// RGBA bytes, and the preview runs this same function over a canvas at display
// size — so what is on screen is what lands in the file.

/**
 * One qualified hue region, as `apply_color` declares it.
 *
 * A colourist doesn't think in curve control points; they think "the skin is
 * too orange" and "lift the sky". Each target names a source hue and what to do
 * to it, and the falloff around that hue is handled here — so two targets that
 * overlap blend rather than fight.
 */
export interface HueTarget {
	/** Source hue to act on, 0–360°. */
	targetHue: number;
	/** Rotate that hue, −30…30°. */
	hueShift?: number;
	/** Saturation multiplier, 0–2. 1 leaves it alone. */
	satScale?: number;
	/** Lightness shift, −0.5…0.5. */
	lumShift?: number;
}

export interface HueCurves {
	targets: HueTarget[];
}

/** How wide a target's influence reaches, in degrees either side. */
const HUE_SELECTIVITY_DEGREES = 22;

export interface CubeLut {
	name: string;
	/** Edge length of the cube — 2 to 64. A 33 is the common size. */
	size: number;
	/** size³ RGB triples, red varying fastest, as .cube stores them. */
	table: number[];
	/** Domain the cube is defined over. Almost always 0–1. */
	domainMin?: [number, number, number];
	domainMax?: [number, number, number];
}

/** How strongly each is mixed in, so a LUT can be dialled back. */
export interface PixelGrade {
	hueCurves?: HueCurves;
	lut?: CubeLut;
	/** 0–1 dry/wet for the LUT. Hue curves carry their own strength in y. */
	lutAmount?: number;
}

/** The largest cube accepted. 64³ is 786k entries — past useful, into abusive. */
const MAX_LUT_SIZE = 64;

export class LutParseError extends Error {}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Reads an Adobe .cube file.
 *
 * Rejects rather than guesses: a file whose row count disagrees with its
 * declared LUT_3D_SIZE is corrupt, and applying it would grade every frame of
 * an export with garbage nobody would notice until the file was watched.
 */
export function parseCubeLut(text: string, name = "LUT"): CubeLut {
	let size = 0;
	let domainMin: [number, number, number] | undefined;
	let domainMax: [number, number, number] | undefined;
	const table: number[] = [];

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;

		if (/^TITLE\b/i.test(line)) continue;
		if (/^LUT_1D_SIZE\b/i.test(line)) {
			throw new LutParseError(
				"That's a 1D LUT. Rendr applies 3D cubes; a 1D curve is what the tone curves already do.",
			);
		}
		const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
		if (sizeMatch) {
			size = Number(sizeMatch[1]);
			continue;
		}
		const minMatch = line.match(/^DOMAIN_MIN\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i);
		if (minMatch) {
			domainMin = [Number(minMatch[1]), Number(minMatch[2]), Number(minMatch[3])];
			continue;
		}
		const maxMatch = line.match(/^DOMAIN_MAX\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i);
		if (maxMatch) {
			domainMax = [Number(maxMatch[1]), Number(maxMatch[2]), Number(maxMatch[3])];
			continue;
		}

		const parts = line.split(/\s+/);
		if (parts.length !== 3) continue;
		const r = Number(parts[0]);
		const g = Number(parts[1]);
		const b = Number(parts[2]);
		if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
			throw new LutParseError(`Not a number: "${line}".`);
		}
		table.push(r, g, b);
	}

	if (size < 2) {
		throw new LutParseError("No LUT_3D_SIZE in that file — it isn't a 3D cube.");
	}
	if (size > MAX_LUT_SIZE) {
		throw new LutParseError(`LUT_3D_SIZE ${size} is beyond the ${MAX_LUT_SIZE} Rendr accepts.`);
	}
	const wanted = size * size * size * 3;
	if (table.length !== wanted) {
		throw new LutParseError(
			`LUT_3D_SIZE ${size} needs ${wanted / 3} rows, but the file has ${table.length / 3}.`,
		);
	}

	return {
		name,
		size,
		table,
		...(domainMin ? { domainMin } : {}),
		...(domainMax ? { domainMax } : {}),
	};
}

/** True when a grade has anything for this module to do. */
export function needsPixelGrade(grade: PixelGrade | undefined): boolean {
	if (!grade) return false;
	if (grade.lut && (grade.lutAmount ?? 1) > 0) return true;
	// A target that shifts nothing is not a grade — it is a row in a panel.
	return (grade.hueCurves?.targets ?? []).some(
		(target) =>
			(target.hueShift ?? 0) !== 0 ||
			(target.satScale ?? 1) !== 1 ||
			(target.lumShift ?? 0) !== 0,
	);
}

/**
 * Bakes the targets into 256-entry tables over the hue wheel.
 *
 * Done once per frame rather than per pixel: a 1080p frame is two million
 * pixels, and evaluating every target's falloff at each would cost more than
 * the rest of the render. The weight is a raised cosine over ±selectivity, and
 * it wraps — otherwise a target on red would have a hard seam at 0°.
 */
function bakeTargets(targets: readonly HueTarget[]): {
	shift: Float32Array;
	sat: Float32Array;
	lum: Float32Array;
} {
	const shift = new Float32Array(256);
	const sat = new Float32Array(256).fill(1);
	const lum = new Float32Array(256);

	for (const target of targets) {
		const centre = (((target.targetHue % 360) + 360) % 360) / 360;
		const hueShift = (target.hueShift ?? 0) / 360;
		const satScale = target.satScale ?? 1;
		const lumShift = target.lumShift ?? 0;
		const reach = HUE_SELECTIVITY_DEGREES / 360;

		for (let index = 0; index < 256; index++) {
			const hue = index / 255;
			// Shortest way round the wheel, so 355° and 5° are 10° apart.
			let distance = Math.abs(hue - centre);
			if (distance > 0.5) distance = 1 - distance;
			if (distance > reach) continue;
			// Raised cosine: full strength at the centre, zero at the edge, with
			// no corner in between for a gradient to catch on.
			const weight = 0.5 * (1 + Math.cos((distance / reach) * Math.PI));

			shift[index] += hueShift * weight;
			sat[index] *= 1 + (satScale - 1) * weight;
			lum[index] += lumShift * weight;
		}
	}
	return { shift, sat, lum };
}

/** RGB (0–1) to HSL (h 0–1, s 0–1, l 0–1). */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const delta = max - min;
	if (delta === 0) return [0, 0, l];

	const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
	let h: number;
	if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
	else if (max === g) h = ((b - r) / delta + 2) / 6;
	else h = ((r - g) / delta + 4) / 6;
	return [h, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
	let value = t;
	if (value < 0) value += 1;
	if (value > 1) value -= 1;
	if (value < 1 / 6) return p + (q - p) * 6 * value;
	if (value < 1 / 2) return q;
	if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
	return p;
}

/** HSL back to RGB (0–1). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	if (s === 0) return [l, l, l];
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

/**
 * Samples a cube with trilinear interpolation.
 *
 * Nearest-neighbour would band visibly on a 17-cube — skies are exactly the
 * gradient that shows it — so the eight surrounding entries are blended.
 */
export function sampleCube(
	lut: CubeLut,
	r: number,
	g: number,
	b: number,
): [number, number, number] {
	const { size, table } = lut;
	const min = lut.domainMin ?? [0, 0, 0];
	const max = lut.domainMax ?? [1, 1, 1];

	const norm = (value: number, index: number) => {
		const span = max[index] - min[index];
		return span === 0 ? 0 : clamp01((value - min[index]) / span);
	};

	const last = size - 1;
	const x = norm(r, 0) * last;
	const y = norm(g, 1) * last;
	const z = norm(b, 2) * last;

	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const z0 = Math.floor(z);
	const x1 = Math.min(last, x0 + 1);
	const y1 = Math.min(last, y0 + 1);
	const z1 = Math.min(last, z0 + 1);
	const fx = x - x0;
	const fy = y - y0;
	const fz = z - z0;

	// Red varies fastest, then green, then blue — the .cube row order.
	const at = (ix: number, iy: number, iz: number) => (ix + iy * size + iz * size * size) * 3;

	const out: [number, number, number] = [0, 0, 0];
	for (let channel = 0; channel < 3; channel++) {
		const c000 = table[at(x0, y0, z0) + channel];
		const c100 = table[at(x1, y0, z0) + channel];
		const c010 = table[at(x0, y1, z0) + channel];
		const c110 = table[at(x1, y1, z0) + channel];
		const c001 = table[at(x0, y0, z1) + channel];
		const c101 = table[at(x1, y0, z1) + channel];
		const c011 = table[at(x0, y1, z1) + channel];
		const c111 = table[at(x1, y1, z1) + channel];

		const c00 = c000 + (c100 - c000) * fx;
		const c10 = c010 + (c110 - c010) * fx;
		const c01 = c001 + (c101 - c001) * fx;
		const c11 = c011 + (c111 - c011) * fx;
		const c0 = c00 + (c10 - c00) * fy;
		const c1 = c01 + (c11 - c01) * fy;
		out[channel] = c0 + (c1 - c0) * fz;
	}
	return out;
}

/**
 * Applies the hue curves and the LUT to a block of RGBA bytes, in place.
 *
 * Hue curves run first: they are a creative adjustment on the source, and a LUT
 * is a look applied over the top — the order every grading application uses.
 */
export function applyPixelGrade(pixels: Uint8ClampedArray, grade: PixelGrade): void {
	const targets = grade.hueCurves?.targets ?? [];
	const wantsHue = targets.some(
		(target) =>
			(target.hueShift ?? 0) !== 0 ||
			(target.satScale ?? 1) !== 1 ||
			(target.lumShift ?? 0) !== 0,
	);
	const lut = grade.lut;
	const amount = lut ? clamp01(grade.lutAmount ?? 1) : 0;
	if (!wantsHue && amount === 0) return;

	const baked = wantsHue ? bakeTargets(targets) : null;

	for (let index = 0; index < pixels.length; index += 4) {
		let r = pixels[index] / 255;
		let g = pixels[index + 1] / 255;
		let b = pixels[index + 2] / 255;

		if (baked) {
			let [h, s, l] = rgbToHsl(r, g, b);
			const key = Math.min(255, Math.max(0, Math.round(h * 255)));
			h = (h + baked.shift[key] + 1) % 1;
			s = clamp01(s * baked.sat[key]);
			l = clamp01(l + baked.lum[key]);
			[r, g, b] = hslToRgb(h, s, l);
		}

		if (lut && amount > 0) {
			const [lr, lg, lb] = sampleCube(lut, r, g, b);
			r += (clamp01(lr) - r) * amount;
			g += (clamp01(lg) - g) * amount;
			b += (clamp01(lb) - b) * amount;
		}

		pixels[index] = Math.round(clamp01(r) * 255);
		pixels[index + 1] = Math.round(clamp01(g) * 255);
		pixels[index + 2] = Math.round(clamp01(b) * 255);
	}
}
