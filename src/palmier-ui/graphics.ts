// Animated graphics: the boxes, lines, labels and QR codes creators put around
// themselves — mind maps behind a talking head, key points, lower thirds,
// callouts, a QR code in the corner.
//
// A graphic is a clip whose picture is drawn, not decoded: a list of elements
// in frame coordinates, each with its own entrance time. drawGraphic paints one
// moment of it, and both the preview and the export call it, so what plays is
// what the file contains. Everything is a pure function of time — no state
// carried between frames — so scrubbing and exporting agree exactly.

import { encode } from "uqr";

/** Normalized 0–1 frame coordinates of an element's centre. */
interface Placed {
	x: number;
	y: number;
	/** Seconds after the graphic's start that this element appears. */
	at?: number;
}

export interface BoxElement extends Placed {
	type: "box";
	/** So lines can connect to it. */
	id?: string;
	label: string;
	/** Font size in pixels at 1080p. */
	size?: number;
	fill?: string;
	color?: string;
}

export interface LineElement {
	type: "line";
	/** A box id, or a point in frame coordinates. */
	from: string | [number, number];
	to: string | [number, number];
	at?: number;
	color?: string;
	/** Pixels at 1080p. */
	width?: number;
	arrow?: boolean;
}

export interface TextElement extends Placed {
	type: "text";
	text: string;
	size?: number;
	color?: string;
	weight?: number;
	align?: "left" | "center" | "right";
}

export interface RectElement extends Placed {
	type: "rect";
	/** Size as a share of the frame. */
	w: number;
	h: number;
	fill?: string;
	/** Pixels at 1080p. */
	radius?: number;
}

export interface QrElement extends Placed {
	type: "qr";
	data: string;
	/** Width as a share of the frame's short edge. */
	size?: number;
	label?: string;
}

export type GraphicElement = BoxElement | LineElement | TextElement | RectElement | QrElement;

export interface GraphicStyle {
	/** Lines and highlights. */
	accent: string;
	boxFill: string;
	boxText: string;
	textColor: string;
	fontFamily: string;
	fontWeight: number;
	/** Box corner radius, pixels at 1080p. */
	radius: number;
	/** Line width, pixels at 1080p. */
	lineWidth: number;
	shadow: boolean;
	uppercase: boolean;
}

export interface GraphicSpec {
	/** Which template made it, for the agent's benefit when reading it back. */
	template?: string;
	elements: GraphicElement[];
	style: GraphicStyle;
	/** A flat colour filling the frame behind the elements — the creator-green backdrop. */
	background?: string;
}

/** The look from the reference: cream cards, dark type, bright yellow lines. */
export const DEFAULT_GRAPHIC_STYLE: GraphicStyle = {
	accent: "#F5D90A",
	boxFill: "#FBF3D5",
	boxText: "#1F2A24",
	textColor: "#FFFFFF",
	fontFamily: "Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif",
	fontWeight: 700,
	radius: 10,
	lineWidth: 6,
	shadow: true,
	uppercase: true,
};

// ── Timing ───────────────────────────────────────────────────────────────

const POP_SECONDS = 0.35;
const DRAW_SECONDS = 0.5;
const FADE_SECONDS = 0.3;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Overshoots a little and settles: the "pop" of a card landing. */
export function easeOutBack(t: number): number {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

export function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}

/** How far into its entrance an element is, 0 (not yet) to 1 (settled). */
export function entrance(at: number | undefined, seconds: number, duration: number): number {
	return clamp01((seconds - (at ?? 0)) / duration);
}

/** The whole graphic fades out over its last moments, unless it's too short to bother. */
export function exitAlpha(seconds: number, clipSeconds: number): number {
	if (clipSeconds < 1.2) return 1;
	return clamp01((clipSeconds - seconds) / FADE_SECONDS);
}

// ── Geometry ─────────────────────────────────────────────────────────────

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Where a segment from a rectangle's centre toward `toward` leaves the
 * rectangle — so a connecting line starts at a card's edge, not under it.
 */
export function edgePoint(rect: Rect, toward: [number, number]): [number, number] {
	const cx = rect.x + rect.w / 2;
	const cy = rect.y + rect.h / 2;
	const dx = toward[0] - cx;
	const dy = toward[1] - cy;
	if (dx === 0 && dy === 0) return [cx, cy];
	const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : rect.w / 2 / Math.abs(dx);
	const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : rect.h / 2 / Math.abs(dy);
	const scale = Math.min(scaleX, scaleY, 1);
	return [cx + dx * scale, cy + dy * scale];
}

// ── QR ───────────────────────────────────────────────────────────────────

const qrCache = new Map<string, boolean[][]>();

export function qrModules(data: string): boolean[][] {
	let modules = qrCache.get(data);
	if (!modules) {
		modules = encode(data, { ecc: "M", border: 0 }).data;
		qrCache.set(data, modules);
	}
	return modules;
}

// ── Drawing ──────────────────────────────────────────────────────────────

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function roundedRect(
	context: Context,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	const radius = Math.max(0, Math.min(r, w / 2, h / 2));
	context.beginPath();
	context.moveTo(x + radius, y);
	context.arcTo(x + w, y, x + w, y + h, radius);
	context.arcTo(x + w, y + h, x, y + h, radius);
	context.arcTo(x, y + h, x, y, radius);
	context.arcTo(x, y, x + w, y, radius);
	context.closePath();
}

function font(style: GraphicStyle, sizePx: number, weight?: number): string {
	return `${weight ?? style.fontWeight} ${Math.max(1, sizePx).toFixed(1)}px ${style.fontFamily}`;
}

/** The settled rectangle of a box, in canvas pixels — lines need it before the box has popped. */
export function boxRect(
	context: Context,
	box: BoxElement,
	style: GraphicStyle,
	width: number,
	height: number,
): Rect {
	// Sizes are authored at 1080 on the short edge, so a vertical Short keeps them.
	const unit = Math.min(width, height) / 1080;
	const size = (box.size ?? 34) * unit;
	context.font = font(style, size);
	const label = style.uppercase ? box.label.toUpperCase() : box.label;
	const textWidth = context.measureText(label).width;
	const w = textWidth + size * 1.4;
	const h = size * 2;
	return { x: box.x * width - w / 2, y: box.y * height - h / 2, w, h };
}

/**
 * Paints a graphic at `seconds` into its start, on a canvas of `width`×`height`.
 * The context is expected in frame space (origin top-left of the frame).
 */
export function drawGraphic(
	context: Context,
	spec: GraphicSpec,
	seconds: number,
	clipSeconds: number,
	width: number,
	height: number,
): void {
	const style = { ...DEFAULT_GRAPHIC_STYLE, ...spec.style };
	// Sizes are authored at 1080 on the short edge, so a vertical Short keeps them.
	const unit = Math.min(width, height) / 1080;
	const fade = exitAlpha(seconds, clipSeconds);
	if (fade <= 0) return;

	context.save();
	context.globalAlpha *= fade;

	if (spec.background) {
		context.fillStyle = spec.background;
		context.fillRect(0, 0, width, height);
	}

	// Boxes are measured up front: lines attach to their edges, and a line can
	// start drawing before the box it points at has popped in.
	const boxes = new Map<string, Rect>();
	for (const element of spec.elements) {
		if (element.type === "box" && element.id) {
			boxes.set(element.id, boxRect(context, element, style, width, height));
		}
	}
	const resolve = (
		end: string | [number, number],
	): { point: [number, number]; rect?: Rect } | null => {
		if (typeof end === "string") {
			const rect = boxes.get(end);
			return rect ? { point: [rect.x + rect.w / 2, rect.y + rect.h / 2], rect } : null;
		}
		return { point: [end[0] * width, end[1] * height] };
	};

	// Lines first, so cards sit on top of the strokes that join them.
	for (const element of spec.elements) {
		if (element.type !== "line") continue;
		const progress = easeOutCubic(entrance(element.at, seconds, DRAW_SECONDS));
		if (progress <= 0) continue;
		const from = resolve(element.from);
		const to = resolve(element.to);
		if (!from || !to) continue;
		const start = from.rect ? edgePoint(from.rect, to.point) : from.point;
		const end = to.rect ? edgePoint(to.rect, from.point) : to.point;
		const x = start[0] + (end[0] - start[0]) * progress;
		const y = start[1] + (end[1] - start[1]) * progress;
		context.strokeStyle = element.color ?? style.accent;
		context.lineWidth = (element.width ?? style.lineWidth) * unit;
		context.lineCap = "round";
		context.beginPath();
		context.moveTo(start[0], start[1]);
		context.lineTo(x, y);
		context.stroke();
		if (element.arrow && progress >= 1) {
			const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
			const head = context.lineWidth * 3.2;
			context.fillStyle = context.strokeStyle;
			context.beginPath();
			context.moveTo(end[0], end[1]);
			context.lineTo(
				end[0] - head * Math.cos(angle - 0.45),
				end[1] - head * Math.sin(angle - 0.45),
			);
			context.lineTo(
				end[0] - head * Math.cos(angle + 0.45),
				end[1] - head * Math.sin(angle + 0.45),
			);
			context.closePath();
			context.fill();
		}
	}

	for (const element of spec.elements) {
		switch (element.type) {
			case "rect": {
				const progress = easeOutCubic(entrance(element.at, seconds, POP_SECONDS));
				if (progress <= 0) break;
				const w = element.w * width;
				const h = element.h * height;
				const x = element.x * width - w / 2;
				const y = element.y * height - h / 2;
				// A plate wipes in from its left edge, the way lower thirds do.
				context.save();
				context.beginPath();
				context.rect(x, y, w * progress, h);
				context.clip();
				context.fillStyle = element.fill ?? style.accent;
				roundedRect(context, x, y, w, h, (element.radius ?? style.radius) * unit);
				context.fill();
				context.restore();
				break;
			}
			case "box": {
				const progress = entrance(element.at, seconds, POP_SECONDS);
				if (progress <= 0) break;
				const rect = element.id
					? (boxes.get(element.id) ?? boxRect(context, element, style, width, height))
					: boxRect(context, element, style, width, height);
				const scale = 0.6 + 0.4 * easeOutBack(progress);
				const cx = rect.x + rect.w / 2;
				const cy = rect.y + rect.h / 2;
				context.save();
				context.globalAlpha *= clamp01(progress * 2);
				context.translate(cx, cy);
				context.scale(scale, scale);
				if (style.shadow) {
					context.shadowColor = "rgba(0,0,0,0.28)";
					context.shadowBlur = 18 * unit;
					context.shadowOffsetY = 6 * unit;
				}
				context.fillStyle = element.fill ?? style.boxFill;
				roundedRect(context, -rect.w / 2, -rect.h / 2, rect.w, rect.h, style.radius * unit);
				context.fill();
				context.shadowColor = "transparent";
				context.fillStyle = element.color ?? style.boxText;
				context.font = font(style, (element.size ?? 34) * unit);
				context.textAlign = "center";
				context.textBaseline = "middle";
				context.fillText(
					style.uppercase ? element.label.toUpperCase() : element.label,
					0,
					size(element) * unit * 0.04,
				);
				context.restore();
				break;
			}
			case "text": {
				const progress = easeOutCubic(entrance(element.at, seconds, POP_SECONDS));
				if (progress <= 0) break;
				context.save();
				context.globalAlpha *= progress;
				context.fillStyle = element.color ?? style.textColor;
				context.font = font(style, (element.size ?? 40) * unit, element.weight);
				context.textAlign = element.align ?? "center";
				context.textBaseline = "middle";
				// Rises into place as it fades in.
				context.fillText(
					element.text,
					element.x * width,
					element.y * height + (1 - progress) * 14 * unit,
				);
				context.restore();
				break;
			}
			case "qr": {
				const progress = entrance(element.at, seconds, POP_SECONDS);
				if (progress <= 0) break;
				const modules = qrModules(element.data);
				const count = modules.length;
				const side = (element.size ?? 0.22) * Math.min(width, height);
				const quiet = side * 0.08;
				const total = side + quiet * 2;
				const scale = 0.6 + 0.4 * easeOutBack(progress);
				context.save();
				context.globalAlpha *= clamp01(progress * 2);
				context.translate(element.x * width, element.y * height);
				context.scale(scale, scale);
				context.fillStyle = "#FFFFFF";
				roundedRect(context, -total / 2, -total / 2, total, total, style.radius * unit);
				context.fill();
				context.fillStyle = "#000000";
				const cell = side / count;
				for (let row = 0; row < count; row++) {
					for (let col = 0; col < count; col++) {
						if (!modules[row][col]) continue;
						// A hair of overlap so antialiasing never leaves seams between modules.
						context.fillRect(
							-side / 2 + col * cell,
							-side / 2 + row * cell,
							cell + 0.5,
							cell + 0.5,
						);
					}
				}
				if (element.label) {
					context.fillStyle = style.textColor;
					context.font = font(style, 28 * unit);
					context.textAlign = "center";
					context.textBaseline = "top";
					context.fillText(element.label, 0, total / 2 + 12 * unit);
				}
				context.restore();
				break;
			}
			default:
				break;
		}
	}
	context.restore();
}

function size(box: BoxElement): number {
	return box.size ?? 34;
}

// ── Templates ────────────────────────────────────────────────────────────

/** Where the speaker is, so a layout can keep out of their face. */
export interface KeepOut {
	cx: number;
	cy: number;
	/** Half-width and half-height of the region to avoid, normalized. */
	rx: number;
	ry: number;
}

const DEFAULT_KEEP_OUT: KeepOut = { cx: 0.5, cy: 0.55, rx: 0.2, ry: 0.45 };

/**
 * Lays nodes out around the speaker: on an ellipse round the frame, skipping
 * the angles that would land on them, and spread evenly through what's left.
 * Positions a caller gave are kept.
 */
export function layoutAround(
	count: number,
	keepOut: KeepOut | readonly KeepOut[] = DEFAULT_KEEP_OUT,
): Array<[number, number]> {
	if (count <= 0) return [];
	const regions = Array.isArray(keepOut) ? keepOut : [keepOut as KeepOut];
	// A card is about this big; its centre has to stay this far from a region.
	const margin = { x: 0.08, y: 0.05 };
	const blocked = (x: number, y: number) =>
		regions.some(
			(region) =>
				Math.abs(x - region.cx) < region.rx + margin.x &&
				Math.abs(y - region.cy) < region.ry + margin.y,
		);
	const candidates: Array<[number, number]> = [];
	const steps = 72;
	for (let index = 0; index < steps; index++) {
		// Start at the top-left and go clockwise, which is how a mind map reads.
		const angle = Math.PI * 1.15 + (index / steps) * Math.PI * 2;
		const x = Math.min(0.88, Math.max(0.12, 0.5 + Math.cos(angle) * 0.38));
		const y = Math.min(0.9, Math.max(0.1, 0.5 + Math.sin(angle) * 0.36));
		if (!blocked(x, y)) candidates.push([x, y]);
	}
	const pool = candidates.length >= count ? candidates : layoutGrid(count);
	if (pool === candidates) {
		return Array.from(
			{ length: count },
			(_, index) => pool[Math.floor(((index + 0.5) / count) * pool.length)],
		);
	}
	return pool;
}

function layoutGrid(count: number): Array<[number, number]> {
	const columns = Math.ceil(Math.sqrt(count));
	const rows = Math.ceil(count / columns);
	return Array.from({ length: count }, (_, index) => [
		((index % columns) + 0.5) / columns,
		(Math.floor(index / columns) + 0.5) / rows,
	]);
}

export interface TemplateInput {
	template: string;
	/** mind_map: nodes; key_points: items. */
	nodes?: Array<{ label: string; x?: number; y?: number }>;
	/** mind_map: pairs of node indexes (or labels) to connect. Omitted: a chain in order. */
	links?: Array<[number | string, number | string]>;
	items?: string[];
	title?: string;
	subtitle?: string;
	data?: string;
	label?: string;
	corner?: "top_left" | "top_right" | "bottom_left" | "bottom_right";
	x?: number;
	y?: number;
	pointTo?: [number, number];
	/** Seconds between one element's entrance and the next. */
	stagger?: number;
	/** Regions to keep clear: the speaker, and anything else already on screen. */
	keepOut?: KeepOut | KeepOut[];
}

/** Builds a template's elements. Returns a reason when the input can't make one. */
export function buildTemplate(
	input: TemplateInput,
): { elements: GraphicElement[] } | { error: string } {
	const stagger = input.stagger ?? 0.45;
	switch (input.template) {
		case "mind_map": {
			const nodes = input.nodes ?? [];
			if (nodes.length === 0) return { error: "mind_map needs nodes: [{label}, …]." };
			const auto = layoutAround(nodes.length, input.keepOut);
			const elements: GraphicElement[] = nodes.map((node, index) => ({
				type: "box",
				id: `n${index}`,
				label: node.label,
				x: node.x ?? auto[index][0],
				y: node.y ?? auto[index][1],
				at: index * stagger,
			}));
			const indexOf = (ref: number | string) =>
				typeof ref === "number"
					? ref
					: nodes.findIndex((node) => node.label.toLowerCase() === ref.toLowerCase());
			const pairs =
				input.links ??
				nodes.slice(1).map((_, index) => [index, index + 1] as [number, number]);
			for (const [a, b] of pairs) {
				const from = indexOf(a);
				const to = indexOf(b);
				if (
					from < 0 ||
					to < 0 ||
					from >= nodes.length ||
					to >= nodes.length ||
					from === to
				) {
					return { error: `links: [${a}, ${b}] doesn't name two different nodes.` };
				}
				// A line draws once both of its cards are on screen.
				elements.push({
					type: "line",
					from: `n${from}`,
					to: `n${to}`,
					at: Math.max(from, to) * stagger + 0.2,
				});
			}
			return { elements };
		}
		case "key_points": {
			const items = input.items ?? input.nodes?.map((node) => node.label) ?? [];
			if (items.length === 0) return { error: "key_points needs items: ['…', …]." };
			const x = input.x ?? 0.2;
			const top = 0.5 - ((items.length - 1) * 0.13) / 2;
			return {
				elements: items.map((label, index) => ({
					type: "box",
					id: `k${index}`,
					label,
					x,
					y: top + index * 0.13,
					at: index * stagger,
				})),
			};
		}
		case "lower_third": {
			if (!input.title) return { error: "lower_third needs a title." };
			const elements: GraphicElement[] = [
				{
					type: "rect",
					x: 0.24,
					y: 0.82,
					w: 0.36,
					h: input.subtitle ? 0.13 : 0.09,
					at: 0,
					radius: 6,
				},
				{
					type: "text",
					text: input.title,
					x: 0.075,
					y: input.subtitle ? 0.8 : 0.82,
					size: 44,
					align: "left",
					color: "#1F2A24",
					at: 0.15,
				},
			];
			if (input.subtitle) {
				elements.push({
					type: "text",
					text: input.subtitle,
					x: 0.075,
					y: 0.855,
					size: 28,
					weight: 500,
					align: "left",
					color: "#1F2A24",
					at: 0.3,
				});
			}
			return { elements };
		}
		case "qr": {
			if (!input.data) return { error: "qr needs data — the URL or text to encode." };
			const corner = input.corner ?? "top_right";
			const x = corner.endsWith("left") ? 0.13 : 0.87;
			const y = corner.startsWith("top") ? 0.2 : 0.74;
			return {
				elements: [
					{
						type: "qr",
						data: input.data,
						x: input.x ?? x,
						y: input.y ?? y,
						size: 0.22,
						label: input.label,
						at: 0,
					},
				],
			};
		}
		case "callout": {
			if (!input.label) return { error: "callout needs a label." };
			const x = input.x ?? 0.75;
			const y = input.y ?? 0.25;
			const elements: GraphicElement[] = [
				{ type: "box", id: "c", label: input.label, x, y, at: 0 },
			];
			if (input.pointTo)
				elements.push({
					type: "line",
					from: "c",
					to: input.pointTo,
					at: 0.25,
					arrow: true,
				});
			return { elements };
		}
		default:
			return {
				error: `Unknown template '${input.template}'. Use mind_map, key_points, lower_third, qr, callout, or pass elements.`,
			};
	}
}

/**
 * Roughly where a graphic's elements sit, as keep-out regions, so a new layout
 * can stay off an existing QR code or card. Approximate on purpose: it only
 * has to stop two things landing on each other.
 */
export function graphicRegions(spec: GraphicSpec, aspect = 16 / 9): KeepOut[] {
	const regions: KeepOut[] = [];
	for (const element of spec.elements) {
		switch (element.type) {
			case "qr": {
				const side = (element.size ?? 0.22) * 1.16;
				regions.push({
					cx: element.x,
					cy: element.y,
					rx: side / aspect / 2 + 0.01,
					ry: side / 2 + 0.03,
				});
				break;
			}
			case "box":
				regions.push({
					cx: element.x,
					cy: element.y,
					rx: (element.label.length * 0.011 + 0.03) * ((element.size ?? 34) / 34),
					ry: 0.035 * ((element.size ?? 34) / 34),
				});
				break;
			case "rect":
				regions.push({
					cx: element.x,
					cy: element.y,
					rx: element.w / 2,
					ry: element.h / 2,
				});
				break;
			case "text":
				regions.push({
					cx: element.x,
					cy: element.y,
					rx: element.text.length * 0.012,
					ry: 0.035,
				});
				break;
			default:
				break;
		}
	}
	return regions;
}

/** The time the last element finishes entering — a sensible minimum length for the clip. */
export function settleSeconds(elements: readonly GraphicElement[]): number {
	let latest = 0;
	for (const element of elements) {
		const duration = element.type === "line" ? DRAW_SECONDS : POP_SECONDS;
		latest = Math.max(latest, (element.at ?? 0) + duration);
	}
	return latest;
}
