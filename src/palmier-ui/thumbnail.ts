// YouTube-style thumbnails from the footage itself.
//
// The formula every creator thumbnail follows: the speaker, cut out, big, with
// a white sticker outline; a bold backdrop; three or four huge words with a
// thick stroke, one or two of them in an accent colour. Rendr already has the
// pieces — the person matte, the face track — so the thumbnail is built from
// the video rather than designed from scratch elsewhere.

import { drawMatted } from "./matte";
import { type FaceTrack, primaryFace } from "./vision";

export interface ThumbnailSpec {
	width: number;
	height: number;
	title: string;
	/** Words in the title to paint in the accent colour. */
	highlight?: string[];
	/** Solid colour, or two colours for a diagonal gradient. */
	background: string | [string, string];
	textColor: string;
	accent: string;
	strokeColor: string;
	/** Which side the speaker stands on; the title takes the other. */
	side: "left" | "right";
	/** White outline around the cut-out speaker, in pixels at 720p. 0 turns it off. */
	outline: number;
	fontFamily: string;
}

export const DEFAULT_THUMBNAIL: Omit<ThumbnailSpec, "title"> = {
	width: 1280,
	height: 720,
	background: ["#0B4F3C", "#062A20"],
	textColor: "#FFFFFF",
	accent: "#F5D90A",
	strokeColor: "#000000",
	side: "right",
	outline: 10,
	fontFamily: "Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif",
};

/**
 * The moment to take the speaker from: the confident sample where their face
 * is largest, i.e. closest to camera — leaning in reads as energy. Ties go to
 * the face nearest the frame's centre line.
 */
export function bestFaceMoment(
	track: FaceTrack,
	from = 0,
	to = Number.POSITIVE_INFINITY,
): number | null {
	let best: { t: number; score: number } | null = null;
	for (const sample of track.samples) {
		if (sample.t < from || sample.t > to) continue;
		const face = primaryFace(sample.faces);
		if (!face) continue;
		const centred = 1 - Math.abs(face.x + face.w / 2 - 0.5);
		const score = face.h * 10 + centred;
		if (!best || score > best.score) best = { t: sample.t, score };
	}
	return best?.t ?? null;
}

/**
 * Breaks a title into at most `maxLines` lines with roughly even length —
 * thumbnails read as blocks, not as a sentence that wraps where it runs out.
 */
export function balanceLines(title: string, maxLines = 3, exact = false): string[] {
	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const lines = Math.min(
		maxLines,
		words.length,
		exact ? maxLines : Math.max(1, Math.round(title.length / 10)),
	);
	const target = title.length / lines;
	const out: string[] = [];
	let current: string[] = [];
	for (const word of words) {
		const length = [...current, word].join(" ").length;
		if (current.length > 0 && length > target * 1.15 && out.length < lines - 1) {
			out.push(current.join(" "));
			current = [word];
		} else {
			current.push(word);
		}
	}
	if (current.length > 0) out.push(current.join(" "));
	return out;
}

type Context = CanvasRenderingContext2D;

function canvas(width: number, height: number): { canvas: HTMLCanvasElement; context: Context } {
	const element = document.createElement("canvas");
	element.width = width;
	element.height = height;
	const context = element.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("Couldn't create a canvas.");
	return { canvas: element, context };
}

export interface ThumbnailPerson {
	/** The footage frame and its matte frame, at the same moment. */
	frame: CanvasImageSource;
	matte: CanvasImageSource;
	frameWidth: number;
	frameHeight: number;
	/** The face in that frame, normalized. */
	face: { x: number; y: number; w: number; h: number };
}

export function renderThumbnail(
	spec: ThumbnailSpec,
	person: ThumbnailPerson | null,
): HTMLCanvasElement {
	const { canvas: out, context } = canvas(spec.width, spec.height);
	const W = spec.width;
	const H = spec.height;
	const unit = H / 720;

	// Backdrop, with a soft glow where the speaker stands so they lift off it.
	if (Array.isArray(spec.background)) {
		const gradient = context.createLinearGradient(0, 0, W, H);
		gradient.addColorStop(0, spec.background[0]);
		gradient.addColorStop(1, spec.background[1]);
		context.fillStyle = gradient;
	} else {
		context.fillStyle = spec.background;
	}
	context.fillRect(0, 0, W, H);
	// A portrait cover (Shorts, Reels) stacks: title on top, speaker below.
	const stacked = H > W;
	const personX = stacked ? W / 2 : spec.side === "right" ? W * 0.72 : W * 0.28;
	const faceY = stacked ? H * 0.6 : H * 0.4;
	const glow = context.createRadialGradient(personX, faceY, 0, personX, faceY, H * 0.7);
	glow.addColorStop(0, "rgba(255,255,255,0.22)");
	glow.addColorStop(1, "rgba(255,255,255,0)");
	context.fillStyle = glow;
	context.fillRect(0, 0, W, H);

	if (person) {
		// Cut out at the frame's own size, then scaled so the face is big.
		const cut = canvas(person.frameWidth, person.frameHeight);
		drawMatted(cut.context, {
			source: person.frame,
			matte: person.matte,
			crop: { top: 0, right: 0, bottom: 0, left: 0 },
			dest: { x: 0, y: 0, width: person.frameWidth, height: person.frameHeight },
			boxWidth: person.frameWidth,
			boxHeight: person.frameHeight,
			background: { mode: "remove", feather: 1 },
			pixelScale: person.frameHeight / 1080,
		});
		// A thumbnail wants a crisp sticker, not the matte's soft doubt: faint
		// pixels (a crossfade, motion blur, a reflection) would each get a white
		// outline of their own. So low alpha goes, the rest is firmed up.
		const pixels = cut.context.getImageData(0, 0, person.frameWidth, person.frameHeight);
		for (let index = 3; index < pixels.data.length; index += 4) {
			const alpha = pixels.data[index];
			pixels.data[index] = alpha < 90 ? 0 : Math.min(255, (alpha - 90) * 1.6 + 110);
		}
		cut.context.putImageData(pixels, 0, 0);
		// Face height ≈ 30% of the thumbnail (18% of a tall cover), on the speaker's side, eyes high.
		const scale =
			(H * (stacked ? 0.18 : 0.3)) / Math.max(1, person.face.h * person.frameHeight);
		const faceCx = (person.face.x + person.face.w / 2) * person.frameWidth * scale;
		const faceCy = (person.face.y + person.face.h / 2) * person.frameHeight * scale;
		const drawW = person.frameWidth * scale;
		const drawH = person.frameHeight * scale;
		const x = personX - faceCx;
		const y = faceY - faceCy;

		if (spec.outline > 0) {
			// The sticker outline: a white silhouette drawn around the person.
			const silhouette = canvas(person.frameWidth, person.frameHeight);
			silhouette.context.drawImage(cut.canvas, 0, 0);
			silhouette.context.globalCompositeOperation = "source-in";
			silhouette.context.fillStyle = "#FFFFFF";
			silhouette.context.fillRect(0, 0, person.frameWidth, person.frameHeight);
			const radius = spec.outline * unit;
			for (let step = 0; step < 16; step++) {
				const angle = (step / 16) * Math.PI * 2;
				context.drawImage(
					silhouette.canvas,
					x + Math.cos(angle) * radius,
					y + Math.sin(angle) * radius,
					drawW,
					drawH,
				);
			}
		}
		context.save();
		context.shadowColor = "rgba(0,0,0,0.35)";
		context.shadowBlur = 30 * unit;
		context.drawImage(cut.canvas, x, y, drawW, drawH);
		context.restore();
	}

	// The title, fitted into the half the speaker isn't standing in. Every line
	// count from one to three is tried and the one that allows the biggest type
	// wins — a thumbnail is read at the size of a stamp, so size is everything.
	const areaX = stacked ? W * 0.06 : spec.side === "right" ? W * 0.05 : W * 0.5;
	const areaW = stacked ? W * 0.88 : W * 0.47;
	const areaH = stacked ? H * 0.34 : H * 0.8;
	const areaCenterY = stacked ? H * 0.21 : H / 2;
	const highlight = new Set(
		(spec.highlight ?? []).map((word) => word.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "")),
	);
	const fontAt = (px: number) => `900 ${px.toFixed(1)}px ${spec.fontFamily}`;
	const fit = (candidate: string[]): number => {
		let px = 180 * unit;
		for (; px > 24 * unit; px -= 4 * unit) {
			context.font = fontAt(px);
			const widest = Math.max(...candidate.map((line) => context.measureText(line).width));
			if (widest <= areaW && candidate.length * px * 1.02 <= areaH) break;
		}
		return px;
	};
	let lines: string[] = [];
	let size = 0;
	for (let count = 1; count <= 3; count++) {
		const candidate = balanceLines(spec.title.toUpperCase(), count, true);
		const px = fit(candidate);
		if (px > size) {
			size = px;
			lines = candidate;
		}
	}
	context.font = fontAt(size);
	context.textBaseline = "middle";
	context.lineJoin = "round";
	const lineHeight = size * 1.02;
	const top = areaCenterY - ((lines.length - 1) * lineHeight) / 2;
	lines.forEach((line, row) => {
		const y = top + row * lineHeight;
		let x = areaX + (areaW - context.measureText(line).width) / 2;
		for (const word of line.split(" ")) {
			const key = word.replace(/[^\p{L}\p{N}]/gu, "");
			context.lineWidth = size * 0.16;
			context.strokeStyle = spec.strokeColor;
			context.strokeText(word, x, y);
			context.fillStyle = highlight.has(key) ? spec.accent : spec.textColor;
			context.fillText(word, x, y);
			x += context.measureText(`${word} `).width;
		}
	});

	return out;
}
