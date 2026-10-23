// A clip with its background removed or replaced, in the preview.
//
// The footage and its person matte are two <video>s held outside React and
// seeked to the same source time; once both have landed, the frame is painted
// with drawMatted — the function the export calls — so what plays here is what
// the file will contain. Like ClipGradedCanvas, the canvas is sized to what is
// on screen, which keeps the per-pixel mask pass cheap enough to scrub.

import { useEffect, useRef, useState } from "react";

import { type ClipBackground, drawMatted } from "../matte";

function loadVideo(url: string): HTMLVideoElement {
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	video.src = url;
	return video;
}

/** Seeks a video and resolves once that frame is ready (or it can't get there). */
function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
	return new Promise((resolve) => {
		if (Math.abs(video.currentTime - seconds) < 0.02 && video.readyState >= 2) return resolve();
		const done = () => {
			video.removeEventListener("seeked", done);
			resolve();
		};
		video.addEventListener("seeked", done);
		try {
			video.currentTime = Math.max(0, seconds);
		} catch {
			done();
		}
		// A seek that never lands must not freeze the preview.
		setTimeout(done, 300);
	});
}

export function ClipMattedCanvas({
	url,
	matteUrl,
	sourceSeconds,
	background,
	backgroundImageUrl,
	gradeFilter,
}: {
	url: string;
	matteUrl: string;
	sourceSeconds: number;
	background: ClipBackground;
	backgroundImageUrl?: string;
	/** The clip's colour filter. Applied here rather than on the wrapper, as in the export. */
	gradeFilter: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const footageRef = useRef<HTMLVideoElement | null>(null);
	const matteRef = useRef<HTMLVideoElement | null>(null);
	const imageRef = useRef<HTMLImageElement | null>(null);
	const [ready, setReady] = useState(0);

	useEffect(() => {
		const footage = loadVideo(url);
		const matte = loadVideo(matteUrl);
		let loaded = 0;
		const onLoaded = () => {
			loaded += 1;
			if (loaded === 2) setReady((count) => count + 1);
		};
		footage.addEventListener("loadeddata", onLoaded, { once: true });
		matte.addEventListener("loadeddata", onLoaded, { once: true });
		// A matte that won't load leaves the footage as shot — what the export
		// does too — rather than a clip that never paints.
		matte.addEventListener(
			"error",
			() => {
				matteRef.current = null;
				onLoaded();
			},
			{ once: true },
		);
		footageRef.current = footage;
		matteRef.current = matte;
		return () => {
			footage.removeAttribute("src");
			matte.removeAttribute("src");
			footageRef.current = null;
			matteRef.current = null;
		};
	}, [url, matteUrl]);

	useEffect(() => {
		if (!backgroundImageUrl) {
			imageRef.current = null;
			return;
		}
		const image = new Image();
		image.onload = () => {
			imageRef.current = image;
			setReady((count) => count + 1);
		};
		image.src = backgroundImageUrl;
	}, [backgroundImageUrl]);

	// The background is read through a ref: it is a fresh object every render,
	// and depending on it would repaint on renders that changed nothing.
	const backgroundRef = useRef(background);
	backgroundRef.current = background;
	const backgroundKey = JSON.stringify(background);

	// backgroundKey and gradeFilter are listed so a restyle repaints a paused frame.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const canvas = canvasRef.current;
		const footage = footageRef.current;
		const matte = matteRef.current;
		if (!canvas || !footage || ready === 0) return;
		let cancelled = false;

		void Promise.all([
			seekTo(footage, sourceSeconds),
			matte ? seekTo(matte, sourceSeconds) : Promise.resolve(),
		]).then(() => {
			if (cancelled) return;
			const box = canvas.getBoundingClientRect();
			const width = Math.max(2, Math.round(box.width));
			const height = Math.max(2, Math.round(box.height));
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}
			const context = canvas.getContext("2d");
			if (!context || footage.videoWidth === 0) return;
			// Cover-fit, matching object-fit: cover on the plain path; the
			// wrapper's clip-path still does the cropping.
			const scale = Math.max(width / footage.videoWidth, height / footage.videoHeight);
			const drawW = footage.videoWidth * scale;
			const drawH = footage.videoHeight * scale;
			context.clearRect(0, 0, width, height);
			drawMatted(context, {
				source: footage,
				matte,
				crop: { top: 0, right: 0, bottom: 0, left: 0 },
				dest: {
					x: (width - drawW) / 2,
					y: (height - drawH) / 2,
					width: drawW,
					height: drawH,
				},
				boxWidth: width,
				boxHeight: height,
				background: backgroundRef.current,
				backgroundImage: imageRef.current,
				// Blur and feather are authored at 1080p; scale them to this canvas.
				pixelScale: height / 1080,
				gradeFilter,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [sourceSeconds, ready, backgroundKey, gradeFilter]);

	return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}
