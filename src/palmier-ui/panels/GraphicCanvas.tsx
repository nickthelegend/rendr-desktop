// A graphic clip in the preview: one canvas over the whole frame, painted by
// drawGraphic — the function the export calls — at the playhead's moment.
//
// It sits in the clip stack (so a mind map can go behind the speaker) but
// undoes the zoom camera's transform, because the export draws graphics in
// frame space: a punch-in moves the person, not the cards around them.

import { useEffect, useRef } from "react";

import { drawGraphic, type GraphicSpec } from "../graphics";

export function GraphicCanvas({
	spec,
	seconds,
	clipSeconds,
	opacity,
	camera,
}: {
	spec: GraphicSpec;
	seconds: number;
	clipSeconds: number;
	opacity: number;
	camera: { x: number; y: number; scale: number };
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const specKey = JSON.stringify(spec);

	// specKey stands in for spec, which is a fresh object on every render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const box = canvas.getBoundingClientRect();
		// Painted at device resolution so card text stays crisp in the preview.
		const ratio = window.devicePixelRatio || 1;
		const width = Math.max(2, Math.round((box.width / camera.scale) * ratio));
		const height = Math.max(2, Math.round((box.height / camera.scale) * ratio));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
		const context = canvas.getContext("2d");
		if (!context) return;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, width, height);
		drawGraphic(context, spec, seconds, clipSeconds, width, height);
	}, [specKey, seconds, clipSeconds, camera.scale]);

	return (
		<canvas
			ref={canvasRef}
			style={{
				position: "absolute",
				inset: 0,
				width: "100%",
				height: "100%",
				opacity,
				pointerEvents: "none",
				transformOrigin: "0 0",
				// The exact inverse of the camera's translate-then-scale.
				transform: `scale(${1 / camera.scale}) translate(${-camera.x}px, ${-camera.y}px)`,
			}}
		/>
	);
}
