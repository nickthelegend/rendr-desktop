import { describe, expect, it } from "vitest";

import { toFcpxml, toXmeml } from "./interchange";
import type { AssetModel } from "./media";
import { withDefaults } from "./model";
import type { TimelineModel } from "./reducers";

const assets: AssetModel[] = [
	{
		id: "a1",
		name: "Screen.mp4",
		type: "video",
		durationSeconds: 10,
		width: 1920,
		height: 1080,
		hasAudio: true,
		url: "file:///Users/me/Movies/Screen.mp4",
	},
	{
		id: "a2",
		name: "Music.mp3",
		type: "audio",
		durationSeconds: 30,
		width: 0,
		height: 0,
		hasAudio: true,
		url: "file:///Users/me/Music/Music.mp3",
	},
];

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
				clips: [
					withDefaults({
						id: "c1",
						name: "Take one",
						mediaType: "video",
						assetId: "a1",
						startFrame: 30,
						endFrame: 150,
						trimStartFrame: 60,
					}),
				],
			},
			{
				id: "a1t",
				name: "A1",
				kind: "audio",
				muted: false,
				hidden: false,
				clips: [
					withDefaults({
						id: "c2",
						name: "Bed",
						mediaType: "audio",
						assetId: "a2",
						startFrame: 0,
						endFrame: 200,
						volumeDb: -6,
					}),
				],
			},
		],
		...overrides,
	};
}

describe("toXmeml", () => {
	it("declares itself as XMEML 5 with the project's frame rate", () => {
		const { xml } = toXmeml(timeline(), assets, "My Project");
		expect(xml).toContain("<!DOCTYPE xmeml>");
		expect(xml).toContain('<xmeml version="5">');
		expect(xml).toContain("<timebase>30</timebase>");
	});

	it("writes timeline position and source in/out as frames", () => {
		const { xml } = toXmeml(timeline(), assets, "My Project");
		expect(xml).toContain("<start>30</start>");
		expect(xml).toContain("<end>150</end>");
		// The clip starts 60 frames into its source and runs 120 frames.
		expect(xml).toContain("<in>60</in>");
		expect(xml).toContain("<out>180</out>");
	});

	it("references media by path so the import can relink", () => {
		const { xml } = toXmeml(timeline(), assets, "My Project");
		expect(xml).toContain("<pathurl>file:///Users/me/Movies/Screen.mp4</pathurl>");
	});

	it("emits each file once and reuses the id", () => {
		const twice = timeline();
		twice.tracks[0].clips.push(
			withDefaults({
				id: "c3",
				name: "Take two",
				mediaType: "video",
				assetId: "a1",
				startFrame: 150,
				endFrame: 200,
			}),
		);
		const { xml } = toXmeml(twice, assets, "My Project");
		expect(xml.match(/<pathurl>/g)?.length).toBe(2);
		// The second reference is the short form.
		expect(xml).toMatch(/<file id="file-1"\/>/);
	});

	it("escapes characters that would break the XML", () => {
		const risky = timeline();
		risky.tracks[0].clips[0].name = 'Take <1> & "best"';
		const { xml } = toXmeml(risky, assets, "My Project");
		expect(xml).toContain("Take &lt;1&gt; &amp; &quot;best&quot;");
		expect(xml).not.toContain("Take <1>");
	});

	it("carries speed as a time-remap filter", () => {
		const fast = timeline();
		fast.tracks[0].clips[0].speed = 2;
		expect(toXmeml(fast, assets, "P").xml).toContain("<value>200.00</value>");
	});

	it("says what it had to leave behind", () => {
		const rich = timeline();
		rich.tracks[0].clips[0].zoomRegions = [
			{
				id: "z",
				startMs: 0,
				endMs: 1000,
				depth: 2,
				focus: { cx: 0.5, cy: 0.5 },
				mode: "auto",
			},
		];
		rich.tracks[0].clips[0].effects = [{ type: "blur.gaussian", params: { radius: 4 } }];
		const { warnings } = toXmeml(rich, assets, "P");
		expect(warnings.join(" ")).toContain("Zoom regions");
		expect(warnings.join(" ")).toContain("effect stack");
	});

	it("warns when media has no path any other app could follow", () => {
		const sessionOnly = assets.map((asset) =>
			asset.id === "a1" ? { ...asset, url: "blob:http://localhost/abc" } : asset,
		);
		const { xml, warnings } = toXmeml(timeline(), sessionOnly, "P");
		expect(xml).not.toContain("blob:");
		expect(warnings.join(" ")).toContain("Screen.mp4");
	});
});

describe("toFcpxml", () => {
	it("declares FCPXML with a rational frame duration", () => {
		const { xml } = toFcpxml(timeline(), assets, "My Project");
		expect(xml).toContain("<!DOCTYPE fcpxml>");
		expect(xml).toContain('frameDuration="1/30s"');
	});

	it("writes offsets as exact rational seconds, never decimals", () => {
		const { xml } = toFcpxml(timeline(), assets, "My Project");
		expect(xml).toContain('offset="30/30s"');
		expect(xml).toContain('duration="120/30s"');
		expect(xml).not.toMatch(/offset="\d+\.\d+s"/);
	});

	it("starts the clip at its source trim", () => {
		expect(toFcpxml(timeline(), assets, "P").xml).toContain('start="60/30s"');
	});

	it("puts audio on a negative lane and video above on positive ones", () => {
		const stacked = timeline();
		stacked.tracks.unshift({
			id: "v2",
			name: "V2",
			kind: "video",
			muted: false,
			hidden: false,
			clips: [
				withDefaults({
					id: "c4",
					name: "Inset",
					mediaType: "video",
					assetId: "a1",
					startFrame: 0,
					endFrame: 60,
				}),
			],
		});
		const { xml } = toFcpxml(stacked, assets, "P");
		expect(xml).toContain('lane="1"');
		expect(xml).toContain('lane="-1"');
	});

	it("carries text clips as titles, which XMEML cannot", () => {
		const titled = timeline();
		titled.tracks[0].clips.push(
			withDefaults({
				id: "t1",
				name: "Title",
				mediaType: "text",
				startFrame: 0,
				endFrame: 30,
				content: "Hello",
			}),
		);
		expect(toFcpxml(titled, assets, "P").xml).toContain("<title");
		expect(toXmeml(titled, assets, "P").warnings.join(" ")).toContain("text clips");
	});

	it("converts a hex text colour to FCPXML's 0–1 RGBA", () => {
		const titled = timeline();
		titled.tracks[0].clips.push(
			withDefaults({
				id: "t1",
				name: "Title",
				mediaType: "text",
				startFrame: 0,
				endFrame: 30,
				content: "Hello",
				textStyle: {
					fontFamily: "Inter",
					fontSize: 48,
					tracking: 0,
					color: "#FF0000",
					bold: true,
					italic: false,
					uppercase: false,
					alignment: "center",
					animation: "off",
					highlightColor: "#FFFFFF",
				},
			}),
		);
		expect(toFcpxml(titled, assets, "P").xml).toContain('fontColor="1.0000 0.0000 0.0000 1"');
	});

	it("writes position in pixels for Resolve and fractions for Final Cut", () => {
		const moved = timeline();
		moved.tracks[0].clips[0].transform = {
			...moved.tracks[0].clips[0].transform,
			centerX: 0.75,
		};
		// 0.25 of a 1920-wide frame is 480px.
		expect(toFcpxml(moved, assets, "P", "resolve").xml).toContain('position="480.0000');
		expect(toFcpxml(moved, assets, "P", "fcp").xml).toContain('position="0.2500');
	});

	it("carries clip volume in dB", () => {
		expect(toFcpxml(timeline(), assets, "P").xml).toContain('amount="-6.00dB"');
	});

	it("names which app it was written for", () => {
		expect(toFcpxml(timeline(), assets, "P", "resolve").warnings.join(" ")).toContain(
			"DaVinci Resolve",
		);
		expect(toFcpxml(timeline(), assets, "P", "fcp").warnings.join(" ")).not.toContain(
			"Written for DaVinci",
		);
	});
});
