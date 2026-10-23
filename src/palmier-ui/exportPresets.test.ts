// Export sizes and platform presets.
//
// "1080p" has to mean the same thing for a vertical video as for a landscape
// one, or every Short exports at 608×1080 — the size a phone shows as a soft,
// upscaled smear. And a preset has to refuse the wrong shape, because the
// platform will accept it and letterbox it without saying a word.

import { describe, expect, it } from "vitest";

import { DEFAULT_EXPORT_SETTINGS, exportDimensions } from "./export";
import { resolveExportPreset } from "./exportPresets";
import type { TimelineModel } from "./reducers";

const canvas = (width: number, height: number, fps = 30): TimelineModel => ({
	id: "t",
	name: "Main",
	fps,
	width,
	height,
	tracks: [],
});

const at = (resolution: "source" | "2160p" | "1080p" | "720p") => ({
	...DEFAULT_EXPORT_SETTINGS,
	resolution,
});

describe("exportDimensions", () => {
	it("reads presets as the short edge, so vertical 1080p is 1080×1920", () => {
		expect(exportDimensions(canvas(1080, 1920), at("1080p"))).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(exportDimensions(canvas(1080, 1920), at("720p"))).toEqual({
			width: 720,
			height: 1280,
		});
	});

	it("leaves landscape exports exactly as they were", () => {
		expect(exportDimensions(canvas(1920, 1080), at("1080p"))).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(exportDimensions(canvas(3840, 2160), at("720p"))).toEqual({
			width: 1280,
			height: 720,
		});
	});

	it("scales square and 4:5 by their short edge too", () => {
		expect(exportDimensions(canvas(2160, 2160), at("1080p"))).toEqual({
			width: 1080,
			height: 1080,
		});
		expect(exportDimensions(canvas(1080, 1350), at("720p"))).toEqual({
			width: 720,
			height: 900,
		});
	});

	it("keeps both axes even, which encoders require", () => {
		const { width, height } = exportDimensions(canvas(1080, 1918), at("720p"));
		expect(width % 2).toBe(0);
		expect(height % 2).toBe(0);
	});

	it("keeps the timeline's own size for source", () => {
		expect(exportDimensions(canvas(1080, 1920), at("source"))).toEqual({
			width: 1080,
			height: 1920,
		});
	});
});

describe("resolveExportPreset", () => {
	it("refuses a vertical preset on a landscape timeline, naming the fix", () => {
		for (const name of ["shorts", "reels", "tiktok"]) {
			const preset = resolveExportPreset(name, canvas(1920, 1080));
			expect(preset.ok).toBe(false);
			if (preset.ok) continue;
			expect(preset.code).toBe("aspect_mismatch");
			expect(preset.message).toMatch(/reframe_timeline/);
			expect(preset.detail?.fix).toEqual({
				tool: "reframe_timeline",
				args: { aspect: "9:16" },
			});
		}
	});

	it("sets 1080×1920 and a platform bitrate for a vertical timeline", () => {
		const preset = resolveExportPreset("shorts", canvas(1080, 1920));
		expect(preset.ok).toBe(true);
		if (!preset.ok) return;
		expect(preset.settings).toEqual({ resolution: "1080p", bitrate: 8_000_000 });
		const size = exportDimensions(canvas(1080, 1920), {
			...DEFAULT_EXPORT_SETTINGS,
			...preset.settings,
		});
		expect(size).toEqual({ width: 1080, height: 1920 });
	});

	it("raises the bitrate for high frame rates", () => {
		const preset = resolveExportPreset("reels", canvas(1080, 1920, 60));
		expect(preset.ok && preset.settings.bitrate).toBe(12_000_000);
	});

	it("gives YouTube 4K only when the timeline has the pixels", () => {
		const hd = resolveExportPreset("youtube", canvas(1920, 1080));
		const uhd = resolveExportPreset("youtube", canvas(3840, 2160));
		expect(hd.ok && hd.settings.resolution).toBe("1080p");
		expect(uhd.ok && uhd.settings.resolution).toBe("2160p");
		expect(uhd.ok && uhd.settings.bitrate).toBe(40_000_000);
	});

	it("refuses YouTube on a vertical timeline and square on anything but square", () => {
		const youtube = resolveExportPreset("youtube", canvas(1080, 1920));
		expect(youtube.ok).toBe(false);
		if (!youtube.ok) expect(youtube.detail?.requiredAspect).toBe("16:9");
		expect(resolveExportPreset("square", canvas(1920, 1080)).ok).toBe(false);
		expect(resolveExportPreset("square", canvas(1080, 1080)).ok).toBe(true);
	});

	it("tolerates the rounding an even-sized canvas brings", () => {
		// 1080×1918 is 9:16 to within a pixel; refusing it would be pedantry.
		expect(resolveExportPreset("tiktok", canvas(1080, 1918)).ok).toBe(true);
	});

	it("names the presets it has when given one it doesn't", () => {
		const preset = resolveExportPreset("vimeo", canvas(1920, 1080));
		expect(preset.ok).toBe(false);
		if (!preset.ok) expect(preset.message).toMatch(/youtube, shorts, reels, tiktok, square/);
	});
});
