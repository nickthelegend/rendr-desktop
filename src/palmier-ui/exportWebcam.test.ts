// The camera inset, as the encoder actually draws it.
//
// webcam.ts is tested for its geometry, but geometry that nothing calls puts no
// camera in the file — which is exactly the bug this suite exists to catch. It
// drives `renderFrame` against a recording canvas context and asserts the
// bubble was drawn, from the right source, in the right place.

import { describe, expect, it } from "vitest";

import { renderFrame } from "./export";
import type { AssetModel } from "./media";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";
import { DEFAULT_WEBCAM } from "./webcam";

interface DrawCall {
	source: unknown;
	args: number[];
}

/**
 * Enough of a 2D context for `renderFrame`, recording what it was asked to
 * draw. A real canvas isn't available under jsdom, and a real one would tell us
 * the pixels changed without telling us which rectangle they came from.
 */
function recordingContext(width: number, height: number) {
	const draws: DrawCall[] = [];
	const clips: number[][] = [];
	let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
	const stack: Array<typeof matrix> = [];

	const context = {
		canvas: { width, height },
		filter: "none",
		globalAlpha: 1,
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		font: "",
		textAlign: "left",
		textBaseline: "alphabetic",
		save() {
			stack.push({ ...matrix });
		},
		restore() {
			matrix = stack.pop() ?? matrix;
		},
		setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
			matrix = { a, b, c, d, e, f };
		},
		getTransform: () => ({ ...matrix }),
		translate(x: number, y: number) {
			matrix.e += x * matrix.a;
			matrix.f += y * matrix.d;
		},
		scale(x: number, y: number) {
			matrix.a *= x;
			matrix.d *= y;
		},
		rotate() {},
		clearRect() {},
		fillRect() {},
		strokeRect() {},
		beginPath() {},
		rect(...args: number[]) {
			clips.push(args);
		},
		roundRect(...args: number[]) {
			clips.push(args);
		},
		clip() {},
		stroke() {},
		fill() {},
		fillText() {},
		measureText: () => ({ width: 10 }),
		drawImage(source: unknown, ...args: number[]) {
			draws.push({ source, args });
		},
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		putImageData() {},
	};

	return { context: context as unknown as CanvasRenderingContext2D, draws, clips };
}

/**
 * A decoded <video>, as the encoder sees one.
 *
 * renderFrame branches on `instanceof HTMLVideoElement` to decide whether to
 * seek, so the class is installed as that global for the run. The tests are in
 * the node environment — the project has no DOM one — and this keeps it that
 * way rather than pulling in jsdom to own five elements.
 */
class StubVideo {
	private handlers: Array<() => void> = [];
	private time = 0;

	constructor(
		readonly videoWidth: number,
		readonly videoHeight: number,
	) {}

	addEventListener(_type: string, handler: () => void) {
		this.handlers.push(handler);
	}

	removeEventListener(_type: string, handler: () => void) {
		this.handlers = this.handlers.filter((entry) => entry !== handler);
	}

	get currentTime() {
		return this.time;
	}

	/**
	 * The seek is a plain assignment in export.ts, so it is acknowledged from
	 * the setter — at once, so no test waits on the 250 ms give-up timer.
	 */
	set currentTime(next: number) {
		this.time = next;
		for (const handler of [...this.handlers]) handler();
	}
}

(globalThis as { HTMLVideoElement?: unknown }).HTMLVideoElement = StubVideo;

function fakeVideo(videoWidth: number, videoHeight: number): HTMLVideoElement {
	return new StubVideo(videoWidth, videoHeight) as unknown as HTMLVideoElement;
}

const asset = (over: Partial<AssetModel> = {}): AssetModel => ({
	id: "screen",
	name: "Take.webm",
	type: "video",
	durationSeconds: 4,
	width: 1920,
	height: 1080,
	hasAudio: false,
	url: "blob:screen",
	...over,
});

const timeline = (): TimelineModel => ({
	id: "tl",
	name: "Main",
	fps: 30,
	width: 1920,
	height: 1080,
	tracks: [
		{
			id: "v1",
			name: "V1",
			kind: "video",
			muted: false,
			hidden: false,
			clips: [
				withDefaults({
					id: "c1",
					name: "Take.webm",
					mediaType: "video",
					assetId: "screen",
					startFrame: 0,
					endFrame: 120,
				}),
			],
		},
	],
});

function sourcesWith(screen: HTMLVideoElement, camera?: HTMLVideoElement) {
	const video = new Map<string, HTMLVideoElement>([["screen", screen]]);
	if (camera) video.set("camera", camera);
	return { video, image: new Map<string, HTMLImageElement>() };
}

describe("the camera inset in the encoder", () => {
	it("draws the camera take over the screen take", async () => {
		const { context, draws } = recordingContext(1920, 1080);
		const screen = fakeVideo(1920, 1080);
		const camera = fakeVideo(1280, 720);

		await renderFrame(
			context,
			timeline(),
			30,
			sourcesWith(screen, camera),
			1920,
			1080,
			undefined,
			{
				settings: { ...DEFAULT_WEBCAM, show: true },
				assets: [
					asset({ webcamAssetId: "camera" }),
					asset({ id: "camera", isWebcam: true }),
				],
			},
		);

		// The screen first, the bubble on top of it.
		expect(draws.map((call) => call.source)).toEqual([screen, camera]);

		const bubble = draws[1].args;
		// drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
		expect(bubble).toHaveLength(8);
		const [, , sw, sh, dx, dy, dw, dh] = bubble;
		// The bubble is square before cropping — `size` is against the frame's
		// short edge — so a 16:9 camera gives up its sides, not its height.
		expect(sh).toBeCloseTo(720, 5);
		expect(sw).toBeCloseTo(720, 5);
		expect(dw).toBeCloseTo(dh, 5);
		// Default is bottom-right with a 0.03 margin, sized off the short edge.
		expect(dx + dw).toBeCloseTo(1920 * (1 - 0.03), 1);
		expect(dy + dh).toBeCloseTo(1080 * (1 - 0.03), 1);
	});

	it("draws nothing when the inset is off", async () => {
		const { context, draws } = recordingContext(1920, 1080);
		const screen = fakeVideo(1920, 1080);
		const camera = fakeVideo(1280, 720);

		await renderFrame(
			context,
			timeline(),
			30,
			sourcesWith(screen, camera),
			1920,
			1080,
			undefined,
			{
				settings: { ...DEFAULT_WEBCAM, show: false },
				assets: [asset({ webcamAssetId: "camera" })],
			},
		);

		expect(draws.map((call) => call.source)).toEqual([screen]);
	});

	it("draws nothing when the take was recorded without a camera", async () => {
		const { context, draws } = recordingContext(1920, 1080);
		const screen = fakeVideo(1920, 1080);

		// The inset is on, but this take has no camera file behind it — the
		// setting must not conjure one from the live preview.
		await renderFrame(context, timeline(), 30, sourcesWith(screen), 1920, 1080, undefined, {
			settings: { ...DEFAULT_WEBCAM, show: true },
			assets: [asset()],
		});

		expect(draws.map((call) => call.source)).toEqual([screen]);
	});

	it("seeks the camera to the screen clip's own source time", async () => {
		const { context } = recordingContext(1920, 1080);
		const screen = fakeVideo(1920, 1080);
		const camera = fakeVideo(1280, 720);

		const model = timeline();
		// Trim 60 frames off the head: frame 30 of the timeline is source
		// second 3, and the camera has to follow the screen there.
		model.tracks[0].clips[0] = {
			...model.tracks[0].clips[0],
			trimStartFrame: 60,
		};

		await renderFrame(context, model, 30, sourcesWith(screen, camera), 1920, 1080, undefined, {
			settings: { ...DEFAULT_WEBCAM, show: true },
			assets: [asset({ webcamAssetId: "camera" })],
		});

		expect(camera.currentTime).toBeCloseTo(3, 3);
		expect(screen.currentTime).toBeCloseTo(3, 3);
	});

	it("centre-crops a 4:3 camera into a 16:9 bubble rather than squashing it", async () => {
		const { context, draws } = recordingContext(1920, 1080);
		const camera = fakeVideo(640, 480);

		await renderFrame(
			context,
			timeline(),
			0,
			sourcesWith(fakeVideo(1920, 1080), camera),
			1920,
			1080,
			undefined,
			{
				settings: { ...DEFAULT_WEBCAM, show: true, shape: "square" },
				assets: [asset({ webcamAssetId: "camera" })],
			},
		);

		const [sx, sy, sw, sh] = draws[1].args;
		// The bubble is 16:9, so the 4:3 source keeps its full height and gives
		// up the sides — never the other way round.
		expect(sh).toBeCloseTo(480, 5);
		expect(sw).toBeLessThan(640);
		expect(sy).toBeCloseTo(0, 5);
		expect(sx).toBeGreaterThan(0);
	});
});
