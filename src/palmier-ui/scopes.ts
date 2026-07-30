// Colour scopes: measuring a rendered frame instead of eyeballing it.
//
// `inspect_color` renders the clip through its own grade and effects, then
// reads the pixels back. That is the only way the numbers can be trusted —
// measuring the source would describe footage nobody is looking at.

export interface Scopes {
	/** Darkest and brightest luma actually present, 0-1. */
	blackPoint: number;
	whitePoint: number;
	/** Percentage of pixels crushed to black or blown to white. */
	clippedShadows: number;
	clippedHighlights: number;
	meanLuma: number;
	mean: { r: number; g: number; b: number };
	/** Mean luma of the darkest, middle and brightest thirds. */
	shadows: number;
	midtones: number;
	highlights: number;
	saturation: number;
	/** Positive is warm, negative is cool. */
	warmCool: number;
	/** Positive is green, negative is magenta. */
	greenMagenta: number;
	/** 12 bins of 30°, saturation-weighted, starting at red. */
	hueHistogram: number[];
}

const HUE_BINS = 12;
const CLIP_LOW = 0.02;
const CLIP_HIGH = 0.98;

function luma(r: number, g: number, b: number): number {
	// Rec. 709, which is what the footage this edits is graded against.
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Measures an already-rendered frame.
 *
 * Sampling every Nth pixel keeps a 4K frame from stalling the UI; the
 * statistics are indistinguishable at these bin counts.
 */
export function measureScopes(pixels: Uint8ClampedArray, step = 4): Scopes {
	let count = 0;
	let sumR = 0;
	let sumG = 0;
	let sumB = 0;
	let sumLuma = 0;
	let sumSaturation = 0;
	let blackPoint = 1;
	let whitePoint = 0;
	let clippedLow = 0;
	let clippedHigh = 0;

	const hueHistogram = new Array<number>(HUE_BINS).fill(0);
	const thirds = [
		{ sum: 0, count: 0 },
		{ sum: 0, count: 0 },
		{ sum: 0, count: 0 },
	];

	const stride = Math.max(1, Math.floor(step)) * 4;
	for (let index = 0; index < pixels.length; index += stride) {
		const r = pixels[index];
		const g = pixels[index + 1];
		const b = pixels[index + 2];
		const alpha = pixels[index + 3];
		// Fully transparent pixels aren't part of the picture.
		if (alpha === 0) continue;

		count += 1;
		sumR += r;
		sumG += g;
		sumB += b;

		const y = luma(r, g, b);
		sumLuma += y;
		if (y < blackPoint) blackPoint = y;
		if (y > whitePoint) whitePoint = y;
		if (y <= CLIP_LOW) clippedLow += 1;
		if (y >= CLIP_HIGH) clippedHigh += 1;

		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const delta = max - min;
		const saturation = max === 0 ? 0 : delta / max;
		sumSaturation += saturation;

		const band = y < 1 / 3 ? 0 : y < 2 / 3 ? 1 : 2;
		thirds[band].sum += y;
		thirds[band].count += 1;

		// Only pixels with real colour vote on hue; grey has no meaningful one.
		if (delta > 8) {
			let hue: number;
			if (max === r) hue = ((g - b) / delta) % 6;
			else if (max === g) hue = (b - r) / delta + 2;
			else hue = (r - g) / delta + 4;
			hue = (hue * 60 + 360) % 360;
			hueHistogram[Math.floor(hue / (360 / HUE_BINS)) % HUE_BINS] += saturation;
		}
	}

	if (count === 0) {
		return {
			blackPoint: 0,
			whitePoint: 0,
			clippedShadows: 0,
			clippedHighlights: 0,
			meanLuma: 0,
			mean: { r: 0, g: 0, b: 0 },
			shadows: 0,
			midtones: 0,
			highlights: 0,
			saturation: 0,
			warmCool: 0,
			greenMagenta: 0,
			hueHistogram,
		};
	}

	const meanR = sumR / count;
	const meanG = sumG / count;
	const meanB = sumB / count;
	const peak = Math.max(...hueHistogram, 1);

	return {
		blackPoint: round(blackPoint),
		whitePoint: round(whitePoint),
		clippedShadows: round((clippedLow / count) * 100, 2),
		clippedHighlights: round((clippedHigh / count) * 100, 2),
		meanLuma: round(sumLuma / count),
		mean: { r: round(meanR, 1), g: round(meanG, 1), b: round(meanB, 1) },
		shadows: round(thirds[0].count ? thirds[0].sum / thirds[0].count : 0),
		midtones: round(thirds[1].count ? thirds[1].sum / thirds[1].count : 0),
		highlights: round(thirds[2].count ? thirds[2].sum / thirds[2].count : 0),
		saturation: round(sumSaturation / count),
		// Red against blue is the warm/cool axis; green against the other two
		// is the tint axis, which is how the grading controls are laid out.
		warmCool: round((meanR - meanB) / 255, 4),
		greenMagenta: round((meanG - (meanR + meanB) / 2) / 255, 4),
		hueHistogram: hueHistogram.map((value) => round(value / peak, 3)),
	};
}

function round(value: number, places = 3): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

/** The difference between a subject and a reference, in grading vocabulary. */
export interface ScopeGap {
	exposure: number;
	contrast: number;
	saturation: number;
	warmCool: number;
	greenMagenta: number;
	hints: string[];
}

/**
 * Compares two measurements and says which knob to turn.
 *
 * The numbers are deltas in each scope's own units; the hints translate them
 * into the vocabulary `apply_color` takes, so the loop closes.
 */
export function compareScopes(subject: Scopes, reference: Scopes): ScopeGap {
	const exposure = round(reference.meanLuma - subject.meanLuma, 4);
	const subjectRange = subject.whitePoint - subject.blackPoint;
	const referenceRange = reference.whitePoint - reference.blackPoint;
	const contrast = round(referenceRange - subjectRange, 4);
	const saturation = round(reference.saturation - subject.saturation, 4);
	const warmCool = round(reference.warmCool - subject.warmCool, 4);
	const greenMagenta = round(reference.greenMagenta - subject.greenMagenta, 4);

	const hints: string[] = [];
	if (Math.abs(exposure) > 0.03) {
		hints.push(
			`exposure ${exposure > 0 ? "+" : ""}${round(exposure * 3, 2)} — the subject is ${exposure > 0 ? "darker" : "brighter"} than the reference`,
		);
	}
	if (Math.abs(contrast) > 0.03) {
		hints.push(
			`contrast ${contrast > 0 ? "raise" : "lower"} by about ${round(Math.abs(contrast), 2)}`,
		);
	}
	if (Math.abs(saturation) > 0.03) {
		hints.push(
			`saturation ${saturation > 0 ? "raise" : "lower"} by about ${round(Math.abs(saturation) * 2, 2)}`,
		);
	}
	if (Math.abs(warmCool) > 0.02) {
		hints.push(
			`temperature ${warmCool > 0 ? "warmer" : "cooler"} — about ${Math.round(Math.abs(warmCool) * 6000)}K`,
		);
	}
	if (Math.abs(greenMagenta) > 0.02) {
		hints.push(`tint ${greenMagenta > 0 ? "toward green" : "toward magenta"}`);
	}
	if (hints.length === 0) hints.push("The subject already matches the reference closely.");

	return { exposure, contrast, saturation, warmCool, greenMagenta, hints };
}

/** Names the 12 hue bins so a histogram reads without counting. */
export const HUE_BIN_NAMES = [
	"red",
	"orange",
	"yellow",
	"yellow-green",
	"green",
	"spring-green",
	"cyan",
	"azure",
	"blue",
	"violet",
	"magenta",
	"rose",
];

export interface GradeCorrection {
	exposure: number;
	contrast: number;
	saturation: number;
	temperature: number;
	tint: number;
}

/**
 * Turns a measured gap into grade values that close it.
 *
 * `compareScopes` says which knob to turn and by roughly how much; this is the
 * arithmetic that actually turns them, in the grade model's own units. The
 * scale factors are the same ones the hints quote, so the numbers a caller is
 * told and the numbers applied cannot drift apart.
 *
 * Applied on top of whatever the clip already carries rather than replacing it,
 * because a match is a correction, not a reset — throwing away a look somebody
 * chose in order to match exposure would be the wrong trade.
 *
 * Deliberately only the five global controls. Matching shadows and highlights
 * separately needs a per-band solve that a single mean-luma comparison cannot
 * honestly support, and guessing at it would produce a grade that measures
 * closer while looking worse.
 */
export function correctionFor(gap: ScopeGap, current: GradeCorrection): GradeCorrection {
	return {
		// The hint quotes exposure * 3, so the correction uses the same factor.
		exposure: round(current.exposure + gap.exposure * 3, 3),
		// Multiplicative: a contrast of 1 is neutral, so a delta scales it.
		contrast: round(Math.max(0.2, current.contrast + gap.contrast), 3),
		saturation: round(Math.max(0, current.saturation + gap.saturation * 2), 3),
		// Warmer means a lower colour temperature in Kelvin, hence the negation.
		temperature: Math.round(current.temperature - gap.warmCool * 6000),
		tint: round(current.tint + gap.greenMagenta, 3),
	};
}

/**
 * Whether a gap is worth correcting at all.
 *
 * Below these the difference is under what anyone can see, and applying a
 * correction anyway would dirty a clip's grade for no visible gain — and make
 * a receipt claim work that had no effect.
 */
export function worthCorrecting(gap: ScopeGap): boolean {
	return (
		Math.abs(gap.exposure) > 0.01 ||
		Math.abs(gap.contrast) > 0.01 ||
		Math.abs(gap.saturation) > 0.01 ||
		Math.abs(gap.warmCool) > 0.008 ||
		Math.abs(gap.greenMagenta) > 0.008
	);
}
