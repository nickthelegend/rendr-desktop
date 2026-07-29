// The camera half of a take, at the wiring level.
//
// This machine has no camera, so the one thing that cannot be checked here is
// whether a real device produces frames. Everything *around* that can be: that
// a second recorder is created at all, that both start together on `begin`,
// that `finish` returns the camera take linked to the screen take, and that
// `abort` tears down the screen stream without touching the preview's.
//
// That wiring is where the bug would be. The compositing side is covered by
// exportWebcam.test.ts, which drives the real `renderFrame`.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRecorder } from "./Recording";

/** A MediaRecorder that records what it was asked to do. */
class StubRecorder {
	static instances: StubRecorder[] = [];
	static isTypeSupported = () => true;

	state: "inactive" | "recording" = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	readonly mimeType = "video/webm;codecs=vp9";
	timeslice: number | undefined;

	constructor(readonly stream: FakeStream) {
		StubRecorder.instances.push(this);
	}

	start(timeslice?: number) {
		this.state = "recording";
		this.timeslice = timeslice;
		// One chunk, so `finish` has something to build a Blob from.
		this.ondataavailable?.({ data: new Blob(["x"]) });
	}

	stop() {
		this.state = "inactive";
		this.onstop?.();
	}
}

class FakeTrack {
	stopped = false;
	listeners: Array<() => void> = [];
	stop() {
		this.stopped = true;
	}
	addEventListener(_type: string, handler: () => void) {
		this.listeners.push(handler);
	}
	getSettings() {
		return { width: 1920, height: 1080 };
	}
}

class FakeStream {
	readonly video = new FakeTrack();
	readonly audio: FakeTrack[];
	constructor(withAudio = false) {
		this.audio = withAudio ? [new FakeTrack()] : [];
	}
	getVideoTracks() {
		return [this.video];
	}
	getAudioTracks() {
		return this.audio;
	}
	getTracks() {
		return [this.video, ...this.audio];
	}
}

const asStream = (stream: FakeStream) => stream as unknown as MediaStream;

beforeEach(() => {
	StubRecorder.instances = [];
	(globalThis as { MediaRecorder?: unknown }).MediaRecorder = StubRecorder;
	(globalThis as { Blob?: unknown }).Blob ??= class {
		constructor(readonly parts: unknown[]) {}
		readonly size = 1;
	};
	(globalThis as { URL?: { createObjectURL?: unknown } }).URL ??= {} as never;
	(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:stub";
});

describe("recording the camera alongside the screen", () => {
	it("opens a second recorder only when a camera stream is given", () => {
		createRecorder(asStream(new FakeStream()));
		expect(StubRecorder.instances).toHaveLength(1);

		StubRecorder.instances = [];
		createRecorder(asStream(new FakeStream()), asStream(new FakeStream()));
		expect(StubRecorder.instances).toHaveLength(2);
	});

	it("starts both only when the countdown ends", () => {
		const recorder = createRecorder(asStream(new FakeStream()), asStream(new FakeStream()));
		// Nothing captures during "3… 2… 1…", or the countdown lands at the head
		// of every take.
		expect(StubRecorder.instances.every((entry) => entry.state === "inactive")).toBe(true);

		recorder.begin();
		expect(StubRecorder.instances.every((entry) => entry.state === "recording")).toBe(true);
	});

	it("returns the camera take linked to the screen take", async () => {
		const recorder = createRecorder(asStream(new FakeStream()), asStream(new FakeStream()));
		recorder.begin();
		const { asset, webcam } = await recorder.finish("Take", 4, true);

		expect(webcam).not.toBeNull();
		expect(webcam?.isWebcam).toBe(true);
		// The pairing is what lets the encoder find the camera for a screen clip.
		expect(asset.webcamAssetId).toBe(webcam?.id);
		expect(asset.isWebcam).toBeUndefined();
	});

	it("carries no camera id when nothing was recorded from a camera", async () => {
		const recorder = createRecorder(asStream(new FakeStream()));
		recorder.begin();
		const { asset, webcam } = await recorder.finish("Take", 4, false);

		expect(webcam).toBeNull();
		// Left unset rather than pointing at nothing, so every readback can trust
		// that a present id means a present file.
		expect(asset.webcamAssetId).toBeUndefined();
	});

	it("releases the screen stream but not the camera's", () => {
		const screen = new FakeStream();
		const camera = new FakeStream();
		const recorder = createRecorder(asStream(screen), asStream(camera));
		recorder.begin();
		recorder.abort();

		expect(screen.video.stopped).toBe(true);
		// The camera stream belongs to the preview. Stopping it here would kill
		// the corner bubble and leave the user with no way to get it back short
		// of toggling the setting.
		expect(camera.video.stopped).toBe(false);
	});

	it("reads hasAudio from the stream rather than guessing", async () => {
		const withAudio = createRecorder(asStream(new FakeStream(true)));
		withAudio.begin();
		expect((await withAudio.finish("A", 1, false)).asset.hasAudio).toBe(true);

		StubRecorder.instances = [];
		const silent = createRecorder(asStream(new FakeStream(false)));
		silent.begin();
		expect((await silent.finish("B", 1, false)).asset.hasAudio).toBe(false);
	});

	it("still releases the devices when stopped during the countdown", async () => {
		const screen = new FakeStream();
		const recorder = createRecorder(asStream(screen));
		// No begin() — stopped while counting down. There is no take, but the
		// devices must not be left held open.
		await recorder.finish("Abandoned", 0, false);
		expect(screen.video.stopped).toBe(true);
	});

	it("hands an external stop back to the caller", () => {
		const screen = new FakeStream();
		const recorder = createRecorder(asStream(screen));
		const onStop = vi.fn();
		recorder.onExternalStop(onStop);

		// Ending capture from the OS chrome has to end it here too, or the app
		// sits showing "recording" over a dead stream.
		for (const handler of screen.video.listeners) handler();
		expect(onStop).toHaveBeenCalledOnce();
	});
});
