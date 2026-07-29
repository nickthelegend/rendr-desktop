// A clip's waveform, drawn from the asset's decoded peaks and clipped to the
// span the clip actually shows. Decoding happens once per asset and is cached,
// so scrubbing and re-rendering are free.

import { useEffect, useRef, useState } from "react";

import { cachedWaveform, drawWaveform, loadWaveform, type Waveform } from "./audio";
import type { AssetModel } from "./media";
import type { ClipModel } from "./model";

export function ClipWaveform({
	clip,
	asset,
	width,
	height,
	fps,
}: {
	clip: ClipModel;
	asset: AssetModel | undefined;
	width: number;
	height: number;
	fps: number;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [waveform, setWaveform] = useState<Waveform | null>(() =>
		asset ? cachedWaveform(asset.id) : null,
	);

	useEffect(() => {
		if (!asset || waveform) return;
		let cancelled = false;
		void loadWaveform(asset).then((result) => {
			if (!cancelled) setWaveform(result);
		});
		return () => {
			cancelled = true;
		};
	}, [asset, waveform]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !waveform || !asset || asset.durationSeconds <= 0) return;

		canvas.width = Math.max(1, Math.round(width));
		canvas.height = Math.max(1, Math.round(height));

		// The clip shows a window of the source; the waveform must match it.
		const startSeconds = clip.trimStartFrame / fps;
		const visibleSeconds = ((clip.endFrame - clip.startFrame) * clip.speed) / fps;
		drawWaveform(canvas, waveform, {
			startRatio: Math.max(0, startSeconds / asset.durationSeconds),
			endRatio: Math.min(1, (startSeconds + visibleSeconds) / asset.durationSeconds),
			color: "rgba(255, 255, 255, 0.42)",
		});
	}, [
		asset,
		clip.endFrame,
		clip.startFrame,
		clip.speed,
		clip.trimStartFrame,
		fps,
		height,
		waveform,
		width,
	]);

	if (!waveform) return null;
	return <canvas ref={canvasRef} className="pmr-clip__wave" aria-hidden="true" />;
}
