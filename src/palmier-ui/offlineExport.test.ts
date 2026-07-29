// Whether the offline encoder will take a job, and what it says when it won't.
//
// The encode itself needs WebCodecs and a real canvas, so it is verified in a
// browser rather than here. What is testable in isolation is the decision that
// runs before it — and that decision picks the container the user gets, so it
// must never quietly report "supported" for something that isn't.

import { afterEach, describe, expect, it, vi } from "vitest";

import { offlineExportSupport } from "./offlineExport";

type Probe = (config: { codec: string; width: number; height: number }) => Promise<{
	supported: boolean;
}>;

/** Installs a stand-in VideoEncoder with the given isConfigSupported. */
function withEncoder(probe: Probe | null): void {
	const target = globalThis as { VideoEncoder?: unknown };
	if (probe === null) {
		target.VideoEncoder = undefined;
		return;
	}
	target.VideoEncoder = { isConfigSupported: probe };
}

afterEach(() => {
	(globalThis as { VideoEncoder?: unknown }).VideoEncoder = undefined;
	vi.restoreAllMocks();
});

describe("offlineExportSupport", () => {
	it("reports unsupported, with a reason, when there is no encoder at all", async () => {
		withEncoder(null);
		const result = await offlineExportSupport(1920, 1080, 30);
		expect(result.supported).toBe(false);
		// The reason is shown to the user, so it has to say something.
		expect(result.reason).toMatch(/WebCodecs/);
	});

	it("picks the first codec the encoder accepts", async () => {
		withEncoder(async ({ codec }) => ({ supported: codec === "avc1.4d0028" }));
		const result = await offlineExportSupport(1280, 720, 30);
		expect(result.supported).toBe(true);
		expect(result.codec).toBe("avc1.4d0028");
	});

	it("prefers high profile when everything is accepted", async () => {
		withEncoder(async () => ({ supported: true }));
		expect((await offlineExportSupport(1920, 1080, 30)).codec).toBe("avc1.640028");
	});

	it("offers the real dimensions, not a token config", async () => {
		const seen: Array<{ width: number; height: number }> = [];
		withEncoder(async ({ width, height }) => {
			seen.push({ width, height });
			return { supported: false };
		});
		await offlineExportSupport(3840, 2160, 60);
		// An encoder that refuses 4K must be asked about 4K, or the dialog would
		// promise MP4 and the export would fail after the user pressed Export.
		expect(seen.every((entry) => entry.width === 3840 && entry.height === 2160)).toBe(true);
	});

	it("names the size it couldn't encode", async () => {
		withEncoder(async () => ({ supported: false }));
		const result = await offlineExportSupport(3840, 2160, 30);
		expect(result.supported).toBe(false);
		expect(result.reason).toContain("3840×2160");
	});

	it("treats a throwing probe as a refusal rather than failing the export", async () => {
		// Chromium throws on a malformed codec string instead of reporting false.
		withEncoder(async ({ codec }) => {
			if (codec !== "avc1.42001f") throw new TypeError("unsupported codec");
			return { supported: true };
		});
		const result = await offlineExportSupport(1280, 720, 30);
		expect(result.supported).toBe(true);
		expect(result.codec).toBe("avc1.42001f");
	});

	it("does not report a codec when nothing is supported", async () => {
		withEncoder(async () => ({ supported: false }));
		expect((await offlineExportSupport(1280, 720, 30)).codec).toBeUndefined();
	});
});
