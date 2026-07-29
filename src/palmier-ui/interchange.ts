// Timeline interchange: XMEML for Premiere Pro, FCPXML for Resolve and Final Cut.
//
// These are the formats every NLE agrees on, and writing them is the difference
// between an editor you can start in and an editor you're stuck in. Both are
// plain XML over the same model, so the two writers sit together.
//
// Neither format carries Rendr's zoom regions, effect stack, or edge treatment —
// there is nowhere in the schema to put them. The writers report that rather
// than dropping it silently, and `.rendr` remains the lossless format.

import type { AssetModel } from "./media";
import type { ClipModel } from "./model";
import type { TimelineModel } from "./reducers";

const escapeXml = (value: string): string =>
	value.replace(
		/[<>&'"]/g,
		(char) =>
			({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char] ??
			char,
	);

/** file:// URL for a local path, which both formats reference media by. */
function fileUrl(asset: AssetModel): string {
	// A blob: URL means the browser holds the bytes and no other app can reach
	// them. Emitting it anyway would produce a file that silently relinks to
	// nothing, so the name is emitted and the caller is warned instead.
	if (!asset.url || asset.url.startsWith("blob:")) return "";
	return asset.url;
}

export interface InterchangeResult {
	xml: string;
	/** What the format could not carry. Empty when the edit round-trips whole. */
	warnings: string[];
}

function surveyLosses(timeline: TimelineModel, format: "xmeml" | "fcpxml"): string[] {
	const clips = timeline.tracks.flatMap((track) => track.clips);
	const warnings: string[] = [];

	if (clips.some((clip) => clip.zoomRegions?.length)) {
		warnings.push(
			"Zoom regions aren't part of either interchange format — the clips come across at their full frame. Export video or .rendr to keep them.",
		);
	}
	if (clips.some((clip) => clip.effects?.length)) {
		warnings.push("The effect stack has no equivalent in this format and was left out.");
	}
	if (clips.some((clip) => clip.edgeRounding > 0 || clip.edgeSoftness > 0)) {
		warnings.push("Edge rounding and softness were left out.");
	}
	if (clips.some((clip) => clip.keyframes)) {
		warnings.push(
			format === "fcpxml"
				? "Keyframes were flattened to each clip's value at its first frame."
				: "XMEML carries no keyframes; animated values were flattened to their first frame.",
		);
	}
	if (format === "xmeml" && clips.some((clip) => clip.mediaType === "text")) {
		warnings.push(
			"XMEML has no portable title format, so text clips were left out. Use fcpxml, which carries them.",
		);
	}
	return warnings;
}

/**
 * XMEML (Final Cut Pro 7 XML) — what Premiere Pro imports.
 *
 * Frames are the unit throughout, which matches the model exactly, so cut
 * points survive without rounding.
 */
export function toXmeml(
	timeline: TimelineModel,
	assets: readonly AssetModel[],
	projectName: string,
): InterchangeResult {
	const fps = Math.round(timeline.fps);
	const ntsc = Math.abs(timeline.fps - Math.round(timeline.fps)) > 0.001;

	const rate = `<rate><timebase>${fps}</timebase><ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
	const missing = new Set<string>();
	let fileId = 0;
	const fileIds = new Map<string, string>();

	const fileElement = (asset: AssetModel, durationFrames: number): string => {
		const known = fileIds.get(asset.id);
		if (known) return `<file id="${known}"/>`;
		const id = `file-${++fileId}`;
		fileIds.set(asset.id, id);
		const url = fileUrl(asset);
		if (!url) missing.add(asset.name);
		return [
			`<file id="${id}">`,
			`<name>${escapeXml(asset.name)}</name>`,
			url ? `<pathurl>${escapeXml(url)}</pathurl>` : "",
			rate,
			`<duration>${durationFrames}</duration>`,
			"<media>",
			asset.type !== "audio"
				? `<video><samplecharacteristics>${rate}<width>${asset.width || timeline.width}</width><height>${asset.height || timeline.height}</height></samplecharacteristics></video>`
				: "",
			asset.hasAudio ? "<audio><channelcount>2</channelcount></audio>" : "",
			"</media>",
			"</file>",
		]
			.filter(Boolean)
			.join("");
	};

	const clipItem = (clip: ClipModel, index: number): string => {
		const asset = assets.find((entry) => entry.id === clip.assetId);
		if (!asset) return "";
		const duration = clip.endFrame - clip.startFrame;
		// `in`/`out` are source frames; `start`/`end` are timeline frames.
		const inFrame = Math.round(clip.trimStartFrame);
		return [
			`<clipitem id="clipitem-${index}">`,
			`<name>${escapeXml(clip.name)}</name>`,
			`<enabled>TRUE</enabled>`,
			`<duration>${duration}</duration>`,
			rate,
			`<start>${clip.startFrame}</start>`,
			`<end>${clip.endFrame}</end>`,
			`<in>${inFrame}</in>`,
			`<out>${inFrame + Math.round(duration * clip.speed)}</out>`,
			clip.speed !== 1
				? `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>speed</parameterid><name>speed</name><value>${(clip.speed * 100).toFixed(2)}</value></parameter></effect></filter>`
				: "",
			fileElement(asset, Math.round((asset.durationSeconds || 1) * fps)),
			"</clipitem>",
		]
			.filter(Boolean)
			.join("");
	};

	let index = 0;
	const videoTracks = timeline.tracks
		.filter((track) => track.kind === "video")
		// XMEML stacks V1 at the bottom; the model's index 0 is the top.
		.reverse()
		.map(
			(track) =>
				`<track>${track.clips
					.filter((clip) => clip.mediaType !== "text" && clip.assetId)
					.map((clip) => clipItem(clip, ++index))
					.join(
						"",
					)}<enabled>${track.hidden ? "FALSE" : "TRUE"}</enabled><locked>FALSE</locked></track>`,
		)
		.join("");

	const audioTracks = timeline.tracks
		.filter((track) => track.kind === "audio")
		.map(
			(track) =>
				`<track>${track.clips
					.filter((clip) => clip.assetId)
					.map((clip) => clipItem(clip, ++index))
					.join(
						"",
					)}<enabled>${track.muted ? "FALSE" : "TRUE"}</enabled><locked>FALSE</locked></track>`,
		)
		.join("");

	const total = timeline.tracks.reduce(
		(max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endFrame), max),
		0,
	);

	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		"<!DOCTYPE xmeml>",
		'<xmeml version="5">',
		"<sequence>",
		`<name>${escapeXml(projectName)}</name>`,
		`<duration>${total}</duration>`,
		rate,
		"<media>",
		`<video><format><samplecharacteristics>${rate}<width>${timeline.width}</width><height>${timeline.height}</height></samplecharacteristics></format>${videoTracks}</video>`,
		`<audio>${audioTracks}</audio>`,
		"</media>",
		"</sequence>",
		"</xmeml>",
	].join("\n");

	const warnings = surveyLosses(timeline, "xmeml");
	if (missing.size > 0) {
		warnings.push(
			`These assets have no file path Premiere can follow, so they'll import offline: ${[...missing].join(", ")}. Media imported by path keeps its path; recordings and generated mattes live only in this session.`,
		);
	}
	return { xml, warnings };
}

/**
 * FCPXML — what DaVinci Resolve and Final Cut Pro import.
 *
 * Times are rational seconds (`<n>/<d>s`), which is why the frame duration is
 * written as `1/fps s` and every offset is a multiple of it: expressing frames
 * as decimals is what makes an imported cut land a frame early.
 */
export function toFcpxml(
	timeline: TimelineModel,
	assets: readonly AssetModel[],
	projectName: string,
	target: "resolve" | "fcp" = "resolve",
): InterchangeResult {
	const fps = timeline.fps;
	const timebase = Number.isInteger(fps) ? `1/${fps}s` : `1001/${Math.round(fps * 1001)}s`;
	const t = (frames: number) => `${Math.round(frames)}/${Math.round(fps)}s`;

	const missing = new Set<string>();
	const used = assets.filter((asset) =>
		timeline.tracks.some((track) => track.clips.some((clip) => clip.assetId === asset.id)),
	);

	const resources = [
		`<format id="r0" name="FFVideoFormat" frameDuration="${timebase}" width="${timeline.width}" height="${timeline.height}"/>`,
		...used.map((asset, index) => {
			const url = fileUrl(asset);
			if (!url) missing.add(asset.name);
			return [
				`<asset id="a${index}" name="${escapeXml(asset.name)}"`,
				` start="0s" duration="${t(Math.round((asset.durationSeconds || 1) * fps))}"`,
				` hasVideo="${asset.type === "audio" ? 0 : 1}" hasAudio="${asset.hasAudio ? 1 : 0}"`,
				` format="r0">`,
				url ? `<media-rep kind="original-media" src="${escapeXml(url)}"/>` : "",
				"</asset>",
			].join("");
		}),
	].join("\n");

	const assetIndex = new Map(used.map((asset, index) => [asset.id, `a${index}`]));

	const clipElement = (clip: ClipModel, lane: number): string => {
		const duration = clip.endFrame - clip.startFrame;
		const common =
			` offset="${t(clip.startFrame)}" duration="${t(duration)}"` +
			` name="${escapeXml(clip.name)}"` +
			(lane !== 0 ? ` lane="${lane}"` : "");

		// Resolve reads position in pixels from centre; Final Cut reads the same
		// field as a fraction of the frame. Same edit, two numbers.
		const offsetX = (clip.transform.centerX - 0.5) * (target === "fcp" ? 1 : timeline.width);
		const offsetY = (0.5 - clip.transform.centerY) * (target === "fcp" ? 1 : timeline.height);
		const scaleX = clip.transform.width;
		const scaleY = clip.transform.height;

		const adjust = [
			offsetX !== 0 ||
			offsetY !== 0 ||
			scaleX !== 1 ||
			scaleY !== 1 ||
			clip.transform.rotation
				? `<adjust-transform position="${offsetX.toFixed(4)} ${offsetY.toFixed(4)}" scale="${scaleX.toFixed(4)} ${scaleY.toFixed(4)}" rotation="${(-clip.transform.rotation).toFixed(3)}"/>`
				: "",
			clip.crop.top || clip.crop.right || clip.crop.bottom || clip.crop.left
				? `<adjust-crop mode="trim"><trim-rect left="${(clip.crop.left * 100).toFixed(3)}" top="${(clip.crop.top * 100).toFixed(3)}" right="${(clip.crop.right * 100).toFixed(3)}" bottom="${(clip.crop.bottom * 100).toFixed(3)}"/></adjust-crop>`
				: "",
			clip.opacity !== 1 ? `<adjust-blend amount="${clip.opacity.toFixed(4)}"/>` : "",
		]
			.filter(Boolean)
			.join("");

		if (clip.mediaType === "text") {
			const style = clip.textStyle;
			return [
				`<title${common} ref="r0" role="titles">`,
				adjust,
				`<text><text-style ref="ts${lane}">${escapeXml(clip.content ?? "")}</text-style></text>`,
				`<text-style-def id="ts${lane}"><text-style font="${escapeXml(style?.fontFamily ?? "Helvetica")}" fontSize="${style?.fontSize ?? 48}" fontColor="${hexToFcp(style?.color ?? "#FFFFFF")}" alignment="${style?.alignment ?? "center"}" bold="${style?.bold ? 1 : 0}" italic="${style?.italic ? 1 : 0}"/></text-style-def>`,
				"</title>",
			].join("");
		}

		const ref = assetIndex.get(clip.assetId ?? "");
		if (!ref) return "";
		const start = t(Math.round(clip.trimStartFrame));
		return [
			`<asset-clip${common} ref="${ref}" start="${start}"`,
			clip.speed !== 1 ? ` tcFormat="NDF"` : "",
			">",
			adjust,
			clip.volumeDb !== 0 ? `<adjust-volume amount="${clip.volumeDb.toFixed(2)}dB"/>` : "",
			"</asset-clip>",
		].join("");
	};

	// FCPXML nests everything under one spine: the bottom video track is the
	// spine itself and everything above it is a connected clip on a lane.
	const videoTracks = timeline.tracks.filter((track) => track.kind === "video");
	const base = videoTracks[videoTracks.length - 1];
	const above = videoTracks.slice(0, -1).reverse();
	const audio = timeline.tracks.filter((track) => track.kind === "audio");

	const spine = [
		...(base?.clips ?? []).map((clip) => clipElement(clip, 0)),
		...above.flatMap((track, index) => track.clips.map((clip) => clipElement(clip, index + 1))),
		...audio.flatMap((track, index) =>
			track.clips.map((clip) => clipElement(clip, -(index + 1))),
		),
	]
		.filter(Boolean)
		.join("\n");

	const total = timeline.tracks.reduce(
		(max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endFrame), max),
		0,
	);

	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		"<!DOCTYPE fcpxml>",
		'<fcpxml version="1.9">',
		`<resources>\n${resources}\n</resources>`,
		`<library>`,
		`<event name="${escapeXml(projectName)}">`,
		`<project name="${escapeXml(timeline.name)}">`,
		`<sequence format="r0" duration="${t(total)}" tcStart="0s" tcFormat="NDF">`,
		`<spine>\n${spine}\n</spine>`,
		"</sequence>",
		"</project>",
		"</event>",
		"</library>",
		"</fcpxml>",
	].join("\n");

	const warnings = surveyLosses(timeline, "fcpxml");
	if (missing.size > 0) {
		warnings.push(
			`These assets have no file path to reference, so they'll import offline: ${[...missing].join(", ")}.`,
		);
	}
	if (target === "resolve") {
		warnings.push(
			"Written for DaVinci Resolve. Final Cut reads position as a fraction of the frame rather than pixels — pass fcpxmlTarget:'fcp' for that.",
		);
	}
	return { xml, warnings };
}

/** #RRGGBB to FCPXML's space-separated 0–1 RGBA. */
function hexToFcp(hex: string): string {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return "1 1 1 1";
	const value = Number.parseInt(match[1], 16);
	const channel = (shift: number) => (((value >> shift) & 0xff) / 255).toFixed(4);
	return `${channel(16)} ${channel(8)} ${channel(0)} 1`;
}
