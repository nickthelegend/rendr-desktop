// The backdrop a screen recording sits on.
//
// A raw screen capture fills the frame edge to edge, which reads as a document
// rather than as a shot. Recordly insets the footage, rounds its corners, drops
// a shadow under it and puts something behind — and that one move is most of
// what makes a screen recording look deliberate.
//
// Everything here is pure geometry and paint description, so the preview (CSS)
// and the encoder (canvas) place the same rectangle and fill the same backdrop.

export type BackgroundKind = "none" | "color" | "gradient" | "image";

export interface GradientStop {
	from: string;
	to: string;
	/** Degrees clockwise from "up", as CSS `linear-gradient` reads them. */
	angle: number;
}

export interface BackgroundSettings {
	kind: BackgroundKind;
	color: string;
	gradient: GradientStop;
	/** Object URL or data URI for a custom image. */
	imageUrl?: string;
	/** Blurs whatever is behind the footage, in px at 1080p. */
	blur: number;
	/** Inset of the footage from the frame edge, 0–0.35 of the short edge. */
	padding: number;
	/** Corner radius of the footage, 0–1 of an eighth of the short edge. */
	radius: number;
	/** Drop shadow under the footage, 0–1. */
	shadow: number;
}

export const DEFAULT_BACKGROUND: BackgroundSettings = {
	kind: "none",
	color: "#101014",
	gradient: { from: "#3B5BFD", to: "#B14CF0", angle: 135 },
	blur: 0,
	padding: 0.06,
	radius: 0.35,
	shadow: 0.55,
};

export const BACKGROUND_LIMITS = {
	blur: { min: 0, max: 60, step: 1 },
	padding: { min: 0, max: 0.35, step: 0.005 },
	radius: { min: 0, max: 1, step: 0.01 },
	shadow: { min: 0, max: 1, step: 0.01 },
} as const;

/**
 * The gradient swatches the panel offers.
 *
 * Chosen to be dark enough that white UI in a screen recording stays readable
 * against them — a bright backdrop behind a bright app is unusable, however
 * nice the swatch looks on its own.
 */
export const GRADIENT_PRESETS: Array<{ id: string; label: string; gradient: GradientStop }> = [
	{ id: "dusk", label: "Dusk", gradient: { from: "#3B5BFD", to: "#B14CF0", angle: 135 } },
	{ id: "ember", label: "Ember", gradient: { from: "#FF5F6D", to: "#FFC371", angle: 120 } },
	{ id: "forest", label: "Forest", gradient: { from: "#0B3D2E", to: "#3CA55C", angle: 150 } },
	{ id: "ocean", label: "Ocean", gradient: { from: "#0F2027", to: "#2C5364", angle: 160 } },
	{ id: "grape", label: "Grape", gradient: { from: "#41295A", to: "#2F0743", angle: 135 } },
	{ id: "slate", label: "Slate", gradient: { from: "#232526", to: "#414345", angle: 135 } },
	{ id: "rose", label: "Rose", gradient: { from: "#642B73", to: "#C6426E", angle: 140 } },
	{ id: "mint", label: "Mint", gradient: { from: "#134E5E", to: "#71B280", angle: 130 } },
	{ id: "ink", label: "Ink", gradient: { from: "#000428", to: "#004E92", angle: 145 } },
	{ id: "clay", label: "Clay", gradient: { from: "#3E2A20", to: "#8D6E5A", angle: 130 } },
];

export const COLOR_PRESETS = [
	"#101014",
	"#1C1C22",
	"#25282E",
	"#0E1726",
	"#1B1030",
	"#221417",
	"#F5F5F7",
	"#E3E6EC",
];

/** True when the backdrop changes what the frame looks like at all. */
export function hasBackground(settings: BackgroundSettings | undefined): boolean {
	if (!settings) return false;
	// Padding alone is a real change: it insets the footage even over black.
	return settings.kind !== "none" || settings.padding > 0 || settings.shadow > 0;
}

/** Where the footage sits inside the frame, in 0–1 of the canvas. */
export interface FootageBox {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Corner radius in canvas pixels, given the canvas' size. */
	radiusPx: number;
}

/**
 * Places the footage inside the backdrop.
 *
 * The inset is taken off the *short* edge and applied equally on all four
 * sides, so a 16:9 project and a 9:16 one get the same visual margin rather
 * than the wide one getting a thin band top and bottom.
 */
export function footageBox(
	settings: BackgroundSettings,
	canvasWidth: number,
	canvasHeight: number,
): FootageBox {
	const shortEdge = Math.min(canvasWidth, canvasHeight);
	const inset = Math.max(0, Math.min(0.35, settings.padding)) * shortEdge;

	const width = Math.max(1, canvasWidth - inset * 2);
	const height = Math.max(1, canvasHeight - inset * 2);

	// An eighth of the inset footage's short edge at full radius — enough to
	// read as rounded, never so much that the picture becomes a lozenge.
	const radiusPx = Math.max(0, Math.min(1, settings.radius)) * (Math.min(width, height) / 8);

	return {
		x: inset / canvasWidth,
		y: inset / canvasHeight,
		width: width / canvasWidth,
		height: height / canvasHeight,
		radiusPx,
	};
}

/** The shadow under the footage, scaled to the canvas so it holds at any size. */
export function shadowFor(
	settings: BackgroundSettings,
	canvasHeight: number,
): { blur: number; offsetY: number; alpha: number } | null {
	const amount = Math.max(0, Math.min(1, settings.shadow));
	if (amount <= 0) return null;
	// Referenced to 1080 so a 720p export and a 4K one look the same, rather
	// than the shadow getting tighter as the canvas grows.
	const scale = canvasHeight / 1080;
	return {
		blur: 60 * amount * scale,
		offsetY: 24 * amount * scale,
		alpha: 0.55 * amount,
	};
}

/** The backdrop as a CSS `background` value, for the preview. */
export function backgroundCss(settings: BackgroundSettings): string {
	switch (settings.kind) {
		case "color":
			return settings.color;
		case "gradient":
			return `linear-gradient(${settings.gradient.angle}deg, ${settings.gradient.from}, ${settings.gradient.to})`;
		case "image":
			return settings.imageUrl
				? `center / cover no-repeat url("${settings.imageUrl}")`
				: settings.color;
		default:
			return "#000";
	}
}

/**
 * Paints the backdrop onto a canvas — the encoder's half of `backgroundCss`.
 *
 * An image backdrop needs its bitmap passed in, because decoding is the
 * caller's job: the encoder decodes once for the whole export rather than once
 * per frame.
 */
export function paintBackground(
	context: CanvasRenderingContext2D,
	settings: BackgroundSettings,
	width: number,
	height: number,
	image?: CanvasImageSource | null,
): void {
	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.filter = "none";
	context.globalAlpha = 1;

	if (settings.kind === "image" && image) {
		const naturalWidth =
			image instanceof HTMLImageElement
				? image.naturalWidth
				: ((image as HTMLCanvasElement).width ?? 0);
		const naturalHeight =
			image instanceof HTMLImageElement
				? image.naturalHeight
				: ((image as HTMLCanvasElement).height ?? 0);
		if (naturalWidth > 0 && naturalHeight > 0) {
			// Cover, matching the CSS the preview uses.
			const scale = Math.max(width / naturalWidth, height / naturalHeight);
			const drawW = naturalWidth * scale;
			const drawH = naturalHeight * scale;
			context.drawImage(image, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
			context.restore();
			return;
		}
	}

	if (settings.kind === "gradient") {
		// CSS angles run clockwise from "up"; canvas gradients are two points,
		// so the angle is turned into a line across the frame's centre.
		const radians = ((settings.gradient.angle - 90) * Math.PI) / 180;
		const half = Math.max(width, height) / 2;
		const cx = width / 2;
		const cy = height / 2;
		const gradient = context.createLinearGradient(
			cx - Math.cos(radians) * half,
			cy - Math.sin(radians) * half,
			cx + Math.cos(radians) * half,
			cy + Math.sin(radians) * half,
		);
		gradient.addColorStop(0, settings.gradient.from);
		gradient.addColorStop(1, settings.gradient.to);
		context.fillStyle = gradient;
	} else {
		context.fillStyle = settings.kind === "color" ? settings.color : "#000";
	}

	context.fillRect(0, 0, width, height);
	context.restore();
}
