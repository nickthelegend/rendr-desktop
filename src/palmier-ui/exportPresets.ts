// Export presets: one word for "what this platform wants".
//
// A creator posting the same talk to YouTube and to Shorts should not have to
// know that one wants 16:9 at 1080 or 2160 and the other 1080×1920, or what
// bitrate survives each platform's re-encode. A preset answers that, and —
// just as importantly — refuses when the timeline is the wrong shape. Encoding
// a landscape cut as a "Short" doesn't fail anywhere: the platform letterboxes
// it, and the creator finds out after posting. So a mismatch is an error that
// names the call that fixes it, never a file.

import type { ExportSettings } from "./export";
import type { TimelineModel } from "./reducers";

export const EXPORT_PRESET_NAMES = ["youtube", "shorts", "reels", "tiktok", "square"] as const;
export type ExportPresetName = (typeof EXPORT_PRESET_NAMES)[number];

interface PresetSpec {
	platform: string;
	/** As reframe_timeline spells it, so the error can hand it straight over. */
	aspect: "16:9" | "9:16" | "1:1";
	ratio: number;
	/**
	 * Video bitrates in bits per second at up to 30 and above 30 fps. Taken from
	 * what the platforms publish for uploads, which sits above what they stream:
	 * a file that arrives starved loses detail twice, once here and once again
	 * in their encoder.
	 */
	bitrate: { standard: number; high: number };
	/** A 4K rate, for the one platform that keeps 4K. */
	bitrate2160?: { standard: number; high: number };
}

const PRESETS: Record<ExportPresetName, PresetSpec> = {
	youtube: {
		platform: "YouTube",
		aspect: "16:9",
		ratio: 16 / 9,
		bitrate: { standard: 8_000_000, high: 12_000_000 },
		bitrate2160: { standard: 40_000_000, high: 60_000_000 },
	},
	shorts: {
		platform: "YouTube Shorts",
		aspect: "9:16",
		ratio: 9 / 16,
		bitrate: { standard: 8_000_000, high: 12_000_000 },
	},
	reels: {
		platform: "Instagram Reels",
		aspect: "9:16",
		ratio: 9 / 16,
		bitrate: { standard: 8_000_000, high: 12_000_000 },
	},
	tiktok: {
		platform: "TikTok",
		aspect: "9:16",
		ratio: 9 / 16,
		bitrate: { standard: 8_000_000, high: 12_000_000 },
	},
	square: {
		platform: "Square feed post",
		aspect: "1:1",
		ratio: 1,
		// Just over half the pixels of 1080p, so a little over half the rate.
		bitrate: { standard: 6_000_000, high: 9_000_000 },
	},
};

/** How far off the preset's shape a timeline may be before it counts as wrong. */
const ASPECT_TOLERANCE = 0.01;

export type ResolvedPreset =
	| {
			ok: true;
			settings: Partial<ExportSettings>;
			/** What the receipt reports, so the caller can see what was chosen. */
			receipt: Record<string, unknown>;
	  }
	| { ok: false; code: string; message: string; detail?: Record<string, unknown> };

export function resolveExportPreset(name: string, timeline: TimelineModel): ResolvedPreset {
	const spec = PRESETS[name as ExportPresetName];
	if (!spec) {
		return {
			ok: false,
			code: "invalid_argument",
			message: `No preset '${name}'. Use one of: ${EXPORT_PRESET_NAMES.join(", ")}.`,
		};
	}

	const actual = timeline.width / timeline.height;
	if (Math.abs(actual - spec.ratio) / spec.ratio > ASPECT_TOLERANCE) {
		const shape = actual > 1 ? "landscape" : actual < 1 ? "vertical" : "square";
		return {
			ok: false,
			code: "aspect_mismatch",
			message: `The ${spec.platform} preset is ${spec.aspect}, but this timeline is ${timeline.width}×${timeline.height} (${shape}). Exported as it is, the platform would letterbox or crop it. Call reframe_timeline with aspect '${spec.aspect}' first, then export again.`,
			detail: {
				preset: name,
				requiredAspect: spec.aspect,
				timelineResolution: [timeline.width, timeline.height],
				fix: { tool: "reframe_timeline", args: { aspect: spec.aspect } },
			},
		};
	}

	// 4K only when the timeline has the pixels for it: scaling 1080 up to 2160
	// makes a bigger file of the same picture.
	const shortEdge = Math.min(timeline.width, timeline.height);
	const uhd = spec.bitrate2160 !== undefined && shortEdge >= 2160;
	const rates = uhd && spec.bitrate2160 ? spec.bitrate2160 : spec.bitrate;
	const bitrate = timeline.fps > 30 ? rates.high : rates.standard;
	const resolution: ExportSettings["resolution"] = uhd ? "2160p" : "1080p";

	return {
		ok: true,
		settings: { resolution, bitrate },
		receipt: {
			name,
			platform: spec.platform,
			aspect: spec.aspect,
			shortEdge: uhd ? 2160 : 1080,
			bitrateMbps: bitrate / 1_000_000,
		},
	};
}
