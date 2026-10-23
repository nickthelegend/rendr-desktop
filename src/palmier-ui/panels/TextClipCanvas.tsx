// Text clips in the preview: a canvas painted by drawTextClip, the function
// the export calls, at the playhead's frame.
//
// Text used to be a styled <div>, and CSS and the encoder disagreed about
// wrapping, tracking and per-word layout — so a caption that read fine on
// screen ran off the edges of the file. Painting it here with the encoder's
// own code is what makes the preview a promise about the export rather than
// an approximation of it (the same reasoning as GraphicCanvas).

import { type CSSProperties, useEffect, useRef, useState } from "react";

import type { ClipModel } from "../model";
import { drawTextClip } from "../textLayout";

/** The largest backing store worth paying for; a 4K canvas is already sharp. */
const MAX_CANVAS_EDGE = 4096;

export interface TextCanvasItem {
	/** Resolved at this frame (clipAtFrame), as the export draws it. */
	clip: ClipModel;
	/** The clip's opacity at this frame, fades included. */
	opacity: number;
}

export function TextClipCanvas({
	items,
	frame,
	fps,
	timelineHeight,
	sharpness = 1,
	style,
}: {
	/** Painted in order, so the first is underneath. */
	items: readonly TextCanvasItem[];
	frame: number;
	fps: number;
	timelineHeight: number;
	/**
	 * Extra resolution, for a canvas a CSS transform will magnify — the zoom
	 * camera scales the stack it sits in, and without this a punch-in shows
	 * the caption's pixels rather than its letters.
	 */
	sharpness?: number;
	style?: CSSProperties;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	// Bumped when a web font finishes loading. Canvas text drawn before then
	// used the fallback face and nothing would ever repaint it.
	const [, setFontEpoch] = useState(0);

	useEffect(() => {
		const fonts = typeof document !== "undefined" ? document.fonts : undefined;
		if (!fonts?.addEventListener) return;
		const bump = () => setFontEpoch((value) => value + 1);
		fonts.addEventListener("loadingdone", bump);
		return () => fonts.removeEventListener("loadingdone", bump);
	}, []);

	// Repainted on every render: the playhead moving is a render, and drawing a
	// line of text costs less than working out whether it changed.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		// Layout size, not the bounding box: the camera's CSS transform scales
		// the box, and the export draws in untransformed frame pixels.
		const cssWidth = canvas.clientWidth;
		const cssHeight = canvas.clientHeight;
		if (cssWidth <= 0 || cssHeight <= 0) return;
		const wanted = (window.devicePixelRatio || 1) * Math.max(1, sharpness);
		const ratio = Math.min(wanted, MAX_CANVAS_EDGE / Math.max(cssWidth, cssHeight));
		const width = Math.max(2, Math.round(cssWidth * ratio));
		const height = Math.max(2, Math.round(cssHeight * ratio));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
		const context = canvas.getContext("2d");
		if (!context) return;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, width, height);
		for (const item of items) {
			drawTextClip(context, item.clip, {
				width,
				height,
				timelineHeight,
				frame,
				fps,
				opacity: item.opacity,
			});
		}
	});

	return (
		<canvas
			ref={canvasRef}
			aria-hidden="true"
			style={{
				position: "absolute",
				inset: 0,
				width: "100%",
				height: "100%",
				pointerEvents: "none",
				...style,
			}}
		/>
	);
}
