import { describe, expect, it } from "vitest";

import { audibleClips, buildGainAutomation, encodeWavBytes } from "./mixdown";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";

const clip = (extra: Partial<ReturnType<typeof withDefaults>> = {}) =>
	withDefaults({
		id: "c1",
		name: "Clip",
		mediaType: "video",
		startFrame: 0,
		endFrame: 30,
		...extra,
	});

describe("buildGainAutomation", () => {
	it("is a single point for a clip with no fades and no keyframes", () => {
		const points = buildGainAutomation(clip(), 30);
		expect(points).toHaveLength(1);
		expect(points[0]).toEqual({ time: 0, gain: 1 });
	});

	it("reflects the clip's level", () => {
		const points = buildGainAutomation(clip({ volumeDb: -6 }), 30);
		expect(points[0].gain).toBeCloseTo(0.501, 3);
	});

	it("mutes at the dB floor rather than leaving a trickle", () => {
		expect(buildGainAutomation(clip({ volumeDb: -60 }), 30)[0].gain).toBe(0);
	});

	it("ramps a fade-in from silence to full", () => {
		const points = buildGainAutomation(clip({ fadeInFrames: 10 }), 30);
		expect(points[0].gain).toBe(0);
		expect(points[points.length - 1].gain).toBe(1);
		expect(points.length).toBeGreaterThan(2);
	});

	it("reaches actual silence on the last frame of a fade-out", () => {
		const points = buildGainAutomation(clip({ fadeOutFrames: 10 }), 30);
		const last = points[points.length - 1];
		expect(last.gain).toBe(0);
		// The final point sits on the clip's last frame, not past its end.
		expect(last.time).toBeCloseTo(29 / 30, 5);
	});

	it("shapes the ramp when asked", () => {
		const linear = buildGainAutomation(clip({ fadeInFrames: 10 }), 30);
		const smooth = buildGainAutomation(
			clip({ fadeInFrames: 10, fadeInInterpolation: "smooth" }),
			30,
		);
		// Both start silent and end at full; the eased one climbs later.
		expect(smooth[0].gain).toBe(0);
		expect(smooth[1].gain).toBeLessThan(linear[1].gain);
	});

	it("follows volume keyframes", () => {
		const points = buildGainAutomation(
			clip({
				keyframes: {
					volumeDb: [
						{ frame: 0, values: [-60], interp: "linear" },
						{ frame: 29, values: [0], interp: "linear" },
					],
				},
			}),
			30,
		);
		expect(points[0].gain).toBe(0);
		expect(points[points.length - 1].gain).toBeCloseTo(1, 3);
	});

	it("uses times relative to the timeline, not the clip", () => {
		const points = buildGainAutomation(clip({ startFrame: 60, endFrame: 90 }), 30);
		expect(points[0].time).toBeCloseTo(2, 5);
	});
});

describe("audibleClips", () => {
	function timeline(overrides: Partial<TimelineModel> = {}): TimelineModel {
		return {
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
					clips: [clip({ id: "vid", assetId: "a-video" })],
				},
				{
					id: "a1",
					name: "A1",
					kind: "audio",
					muted: false,
					hidden: false,
					clips: [clip({ id: "aud", mediaType: "audio", assetId: "a-audio" })],
				},
			],
			...overrides,
		};
	}

	const assets = [
		{
			id: "a-video",
			name: "Screen.mp4",
			type: "video" as const,
			durationSeconds: 10,
			width: 1920,
			height: 1080,
			hasAudio: true,
			url: "blob:video",
		},
		{
			id: "a-audio",
			name: "Music.mp3",
			type: "audio" as const,
			durationSeconds: 10,
			width: 0,
			height: 0,
			hasAudio: true,
			url: "blob:audio",
		},
	];

	it("includes a video clip's own audio, not just the audio track", () => {
		const found = audibleClips(timeline(), assets);
		expect(found.map((entry) => entry.clip.id).sort()).toEqual(["aud", "vid"]);
	});

	it("skips a muted track", () => {
		const source = timeline();
		source.tracks[0].muted = true;
		expect(audibleClips(source, assets).map((entry) => entry.clip.id)).toEqual(["aud"]);
	});

	it("hidden hides the picture but does not silence the sound", () => {
		const source = timeline();
		source.tracks[0].hidden = true;
		expect(audibleClips(source, assets).map((entry) => entry.clip.id)).toContain("vid");
	});

	it("honours solo", () => {
		const source = timeline();
		source.tracks[1].solo = true;
		expect(audibleClips(source, assets).map((entry) => entry.clip.id)).toEqual(["aud"]);
	});

	it("skips a silent video and an offline asset", () => {
		const silent = assets.map((asset) =>
			asset.id === "a-video" ? { ...asset, hasAudio: false } : asset,
		);
		expect(audibleClips(timeline(), silent).map((entry) => entry.clip.id)).toEqual(["aud"]);

		const offline = assets.map((asset) =>
			asset.id === "a-audio" ? { ...asset, offline: true } : asset,
		);
		expect(audibleClips(timeline(), offline).map((entry) => entry.clip.id)).toEqual(["vid"]);
	});

	it("skips text clips, which have no source at all", () => {
		const source = timeline();
		source.tracks[0].clips = [clip({ id: "title", mediaType: "text" })];
		expect(audibleClips(source, assets).map((entry) => entry.clip.id)).toEqual(["aud"]);
	});
});

describe("encodeWavBytes", () => {
	it("writes a RIFF/WAVE header of the right size", () => {
		const bytes = encodeWavBytes([new Float32Array(100)], 48_000);
		const text = String.fromCharCode(...bytes.slice(0, 4));
		expect(text).toBe("RIFF");
		expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
		expect(bytes.length).toBe(44 + 100 * 2);
	});

	it("records the sample rate and channel count it was given", () => {
		const bytes = encodeWavBytes([new Float32Array(4), new Float32Array(4)], 44_100);
		const view = new DataView(bytes.buffer);
		expect(view.getUint16(22, true)).toBe(2);
		expect(view.getUint32(24, true)).toBe(44_100);
		// Byte rate = rate × channels × 2 bytes.
		expect(view.getUint32(28, true)).toBe(44_100 * 2 * 2);
	});

	it("interleaves channels frame by frame", () => {
		const left = Float32Array.from([1, 0]);
		const right = Float32Array.from([-1, 0]);
		const view = new DataView(encodeWavBytes([left, right], 48_000).buffer);
		expect(view.getInt16(44, true)).toBe(32767);
		expect(view.getInt16(46, true)).toBe(-32768);
	});

	it("clamps rather than wrapping a sample past full scale", () => {
		const view = new DataView(encodeWavBytes([Float32Array.from([2, -2])], 48_000).buffer);
		expect(view.getInt16(44, true)).toBe(32767);
		expect(view.getInt16(46, true)).toBe(-32768);
	});

	it("produces a valid empty file rather than throwing", () => {
		expect(encodeWavBytes([], 48_000).length).toBe(44);
	});
});
