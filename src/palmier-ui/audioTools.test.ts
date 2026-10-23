// @vitest-environment jsdom
//
// normalize_audio, measure_audio and duck_audio, driven the way an MCP call
// drives them.
//
// Decoding is stubbed with synthetic buffers whose loudness is known, so the
// receipts can be checked against real numbers: a stereo 1 kHz sine at -23
// dBFS is -23 LUFS, so reaching -14 takes exactly +9 dB. The editor is the
// same slice useAgentBridge.test.ts fakes, plus a commit that records what the
// tool would have done to the timeline.

import { afterEach, describe, expect, it, vi } from "vitest";

const buffers = new Map<string, FakeBuffer>();

vi.mock("./audio", async (importOriginal) => {
	const original = await importOriginal<typeof import("./audio")>();
	return {
		...original,
		decodeAudio: vi.fn(async (asset: { id: string }) => buffers.get(asset.id) ?? null),
	};
});

let mixBuffer: FakeBuffer | null = null;
vi.mock("./mixdown", async (importOriginal) => {
	const original = await importOriginal<typeof import("./mixdown")>();
	return { ...original, renderTimelineAudio: vi.fn(async () => mixBuffer) };
});

import { createAgentTools } from "./agentTools";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";
import type { EditorApi } from "./state";

const RATE = 16000;
const FPS = 30;

interface FakeBuffer {
	numberOfChannels: number;
	sampleRate: number;
	length: number;
	duration: number;
	getChannelData: (index: number) => Float32Array;
}

function fakeBuffer(channels: Float32Array[]): FakeBuffer {
	return {
		numberOfChannels: channels.length,
		sampleRate: RATE,
		length: channels[0].length,
		duration: channels[0].length / RATE,
		getChannelData: (index) => channels[index],
	};
}

function sine(dbfs: number, seconds: number, frequency = 1000): Float32Array {
	const amplitude = 10 ** (dbfs / 20);
	const out = new Float32Array(Math.round(seconds * RATE));
	for (let i = 0; i < out.length; i++) {
		out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE);
	}
	return out;
}

/** Room tone with a voice-like buzz between `from` and `to` seconds. */
function talking(seconds: number, from: number, to: number): Float32Array {
	const out = new Float32Array(Math.round(seconds * RATE));
	let seed = 3;
	for (let i = 0; i < out.length; i++) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		const t = i / RATE;
		let value = 0.001 * (seed / 2 ** 32 - 0.5);
		if (t >= from && t < to) {
			for (let harmonic = 1; harmonic * 150 < 3000; harmonic++) {
				value += (0.1 * Math.sin(2 * Math.PI * 150 * harmonic * t)) / harmonic;
			}
		}
		out[i] = value;
	}
	return out;
}

const asset = (id: string, type: "video" | "audio" = "audio") => ({
	id,
	name: `${id}.wav`,
	type,
	durationSeconds: 10,
	width: 0,
	height: 0,
	hasAudio: true,
	url: `blob:${id}`,
});

const clip = (id: string, assetId: string, over: Record<string, unknown> = {}) =>
	withDefaults({
		id,
		name: id,
		mediaType: "audio",
		assetId,
		startFrame: 0,
		endFrame: 300,
		...over,
	});

function editor(tracks: TimelineModel["tracks"], assets: ReturnType<typeof asset>[]) {
	const timeline: TimelineModel = {
		id: "tl",
		name: "M",
		fps: FPS,
		width: 1920,
		height: 1080,
		tracks,
	};
	const committed: Array<{ label: string; next: TimelineModel }> = [];
	const api = {
		state: { agentConnected: true, assets, timelines: [], cursorTelemetry: [] },
		timeline,
		logAgent: vi.fn(),
		patch: vi.fn(),
		commit: vi.fn((label: string, update: (current: TimelineModel) => TimelineModel) => {
			committed.push({ label, next: update(timeline) });
		}),
	} as unknown as EditorApi;
	return { tools: createAgentTools(api), committed };
}

const track = (
	id: string,
	kind: "video" | "audio",
	name: string,
	clips: ReturnType<typeof clip>[],
) => ({ id, kind, name, muted: false, hidden: false, clips });

function payload(result: unknown): Record<string, unknown> {
	const text = (result as { content: Array<{ text: string }> }).content[0].text;
	return JSON.parse(text) as Record<string, unknown>;
}

const allClips = (timeline: TimelineModel) => timeline.tracks.flatMap((entry) => entry.clips);

afterEach(() => {
	buffers.clear();
	mixBuffer = null;
});

describe("normalize_audio", () => {
	it("sets the level that brings a clip to -14 LUFS by default", async () => {
		const tone = sine(-23, 10);
		buffers.set("a1", fakeBuffer([tone, tone]));
		const { tools, committed } = editor(
			[track("t1", "audio", "Voice", [clip("c1", "a1")])],
			[asset("a1")],
		);

		const receipt = payload(await tools.normalize_audio({}));

		expect(receipt.targetLufs).toBe(-14);
		const [entry] = receipt.clips as Array<Record<string, number>>;
		expect(entry.integratedLufs).toBeCloseTo(-23, 0);
		expect(entry.volumeDb).toBeCloseTo(9, 0);
		expect(committed[0].label).toBe("Normalize audio");
		expect(allClips(committed[0].next)[0].volumeDb).toBeCloseTo(9, 0);
	});

	it("is a no-op the second time, because the level is absolute", async () => {
		const tone = sine(-23, 10);
		buffers.set("a1", fakeBuffer([tone, tone]));
		// Already at the level the first run would have set.
		const { tools } = editor(
			[track("t1", "audio", "Voice", [clip("c1", "a1", { volumeDb: 9 })])],
			[asset("a1")],
		);
		const receipt = payload(await tools.normalize_audio({}));
		const [entry] = receipt.clips as Array<Record<string, number>>;
		expect(entry.volumeDb).toBeCloseTo(9, 0);
	});

	it("gives every cut of one take the same level", async () => {
		// The take gets louder halfway; measured apart, the two cuts would get
		// different gains and the edit would step in volume at the cut.
		const quiet = sine(-30, 5);
		const loud = sine(-20, 5);
		const take = new Float32Array(quiet.length + loud.length);
		take.set(quiet);
		take.set(loud, quiet.length);
		buffers.set("a1", fakeBuffer([take]));
		const { tools } = editor(
			[
				track("t1", "audio", "Voice", [
					clip("c1", "a1", { startFrame: 0, endFrame: 150 }),
					clip("c2", "a1", { startFrame: 150, endFrame: 300, trimStartFrame: 150 }),
				]),
			],
			[asset("a1")],
		);
		const receipt = payload(await tools.normalize_audio({ measureOnly: true }));
		const levels = (receipt.clips as Array<Record<string, number>>).map(
			(entry) => entry.volumeDb,
		);
		expect(levels[0]).toBe(levels[1]);
		expect((receipt.clips as Array<Record<string, number>>)[0].measuredWith).toBe(2);
	});

	it("stops at the true-peak ceiling and says how far short it landed", async () => {
		// Quiet speech-level tone with one sharp plosive near full scale.
		const tone = sine(-35, 10);
		tone[RATE * 5] = 0.8;
		buffers.set("a1", fakeBuffer([tone]));
		const { tools, committed } = editor(
			[track("t1", "audio", "Voice", [clip("c1", "a1")])],
			[asset("a1")],
		);
		const receipt = payload(await tools.normalize_audio({ targetLufs: -14, ceilingDb: -1 }));
		const [entry] = receipt.clips as Array<Record<string, unknown>>;
		expect(entry.limitedBy).toBe("truePeak");
		expect(entry.shortfallDb as number).toBeGreaterThan(10);
		expect(receipt.warning).toMatch(/no limiter/);
		const level = allClips(committed[0].next)[0].volumeDb;
		// The plosive, after the gain, sits at or under -1 dBTP.
		expect((entry.truePeakDb as number) + level).toBeLessThanOrEqual(-1 + 0.01);
	});

	it("moves a duck's keyframes with the level instead of leaving them overriding it", async () => {
		const tone = sine(-23, 10);
		buffers.set("a1", fakeBuffer([tone, tone]));
		const ducked = clip("c1", "a1", {
			keyframes: {
				volumeDb: [
					{ frame: 0, values: [0], interp: "linear" },
					{ frame: 30, values: [-12], interp: "linear" },
				],
			},
		});
		const { tools, committed } = editor(
			[track("t1", "audio", "Music", [ducked])],
			[asset("a1")],
		);
		await tools.normalize_audio({});
		const values = allClips(committed[0].next)[0].keyframes?.volumeDb?.map(
			(keyframe) => keyframe.values[0],
		);
		expect(values?.[0]).toBeCloseTo(9, 0);
		expect(values?.[1]).toBeCloseTo(-3, 0);
	});

	it("refuses a target no platform uses", async () => {
		const { tools } = editor([], []);
		const result = await tools.normalize_audio({ targetLufs: 0 });
		expect((result as { isError?: boolean }).isError).toBe(true);
	});
});

describe("measure_audio", () => {
	it("reports integrated LUFS per clip and for the whole mix", async () => {
		const tone = sine(-23, 10);
		buffers.set("a1", fakeBuffer([tone, tone]));
		const mixTone = sine(-17, 10);
		mixBuffer = fakeBuffer([mixTone, mixTone]);
		const { tools, committed } = editor(
			[track("t1", "audio", "Voice", [clip("c1", "a1")])],
			[asset("a1")],
		);

		const receipt = payload(await tools.measure_audio({}));
		const [row] = receipt.clips as Array<Record<string, number>>;
		expect(row.integratedLufs).toBeCloseTo(-23, 0);
		expect(row.suggestedGainDb).toBeCloseTo(9, 0);
		expect(row.truePeakDbtp).toBeCloseTo(-23, 0);
		const mix = receipt.mix as Record<string, number>;
		expect(mix.integratedLufs).toBeCloseTo(-17, 0);
		expect(mix.offTargetLu).toBeCloseTo(-3, 0);
		expect(committed).toHaveLength(0);
	});
});

describe("duck_audio under the creator's voice", () => {
	it("ducks the music under the speech found in the camera audio", async () => {
		// Talking from 2 s to 5 s of a 10 s take; music under all of it.
		buffers.set("cam", fakeBuffer([talking(10, 2, 5)]));
		buffers.set("song", fakeBuffer([sine(-20, 10, 220)]));
		const { tools, committed } = editor(
			[
				track("v1", "video", "Video 1", [clip("camera", "cam", { mediaType: "video" })]),
				track("a1", "audio", "Music", [clip("music", "song")]),
			],
			[asset("cam", "video"), asset("song")],
		);

		const receipt = payload(await tools.duck_audio({}));

		expect(receipt.under).toBe("speech");
		expect(receipt.listenedTo).toEqual(["camera"]);
		const music = allClips(committed[0].next).find((entry) => entry.id === "music");
		const rows = music?.keyframes?.volumeDb?.map((keyframe) => [
			keyframe.frame,
			keyframe.values[0],
		]);
		// Down by frame 60 (2 s), back up after frame 150 (5 s) plus the release.
		expect(rows).toHaveLength(4);
		expect(rows?.[1][0]).toBeGreaterThanOrEqual(58);
		expect(rows?.[1][0]).toBeLessThanOrEqual(62);
		expect(rows?.[1][1]).toBe(-12);
		expect(rows?.[2][0]).toBeGreaterThanOrEqual(148);
		expect(rows?.[2][0]).toBeLessThanOrEqual(152);
		// Release (0.6 s = 18 frames) is longer than the attack (0.15 s ≈ 5).
		expect((rows?.[3][0] ?? 0) - (rows?.[2][0] ?? 0)).toBe(18);
		expect((rows?.[1][0] ?? 0) - (rows?.[0][0] ?? 0)).toBe(5);
		// The voice itself is never ducked.
		const camera = allClips(committed[0].next).find((entry) => entry.id === "camera");
		expect(camera?.keyframes?.volumeDb).toBeUndefined();
	});

	it("still ducks under the Narration track when there is one", async () => {
		const { tools, committed } = editor(
			[
				track("n", "audio", "Narration", [
					clip("line", "tts", { startFrame: 60, endFrame: 150 }),
				]),
				track("a1", "audio", "Music", [clip("music", "song")]),
			],
			[asset("tts"), asset("song")],
		);
		const receipt = payload(await tools.duck_audio({}));
		expect(receipt.under).toBe("narration");
		expect(committed).toHaveLength(1);
	});

	it("says so when the footage has no speech in it", async () => {
		buffers.set("cam", fakeBuffer([new Float32Array(RATE * 10)]));
		const { tools } = editor(
			[
				track("v1", "video", "Video 1", [clip("camera", "cam", { mediaType: "video" })]),
				track("a1", "audio", "Music", [clip("music", "song")]),
			],
			[asset("cam", "video"), asset("song")],
		);
		const result = await tools.duck_audio({ under: "speech" });
		expect(payload(result).error).toBe("no_speech_found");
	});
});
