import { describe, expect, it } from "vitest";

import { assetFromRecording, formatDuration, kindOf, SUPPORTED_SUMMARY } from "./media";

function file(name: string, type = ""): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe("kindOf", () => {
	it("recognises video by MIME type and by extension", () => {
		expect(kindOf(file("a.bin", "video/mp4"))).toBe("video");
		expect(kindOf(file("a.mov"))).toBe("video");
		expect(kindOf(file("a.webm"))).toBe("video");
	});

	it("recognises audio and images", () => {
		expect(kindOf(file("a.wav"))).toBe("audio");
		expect(kindOf(file("a.m4a"))).toBe("audio");
		expect(kindOf(file("a.png"))).toBe("image");
		expect(kindOf(file("a.HEIC"))).toBe("image");
	});

	it("rejects anything it can't decode rather than guessing", () => {
		expect(kindOf(file("notes.txt", "text/plain"))).toBeNull();
		expect(kindOf(file("archive.zip"))).toBeNull();
	});

	it("names the supported formats for the empty state", () => {
		expect(SUPPORTED_SUMMARY).toContain("MP4");
		expect(SUPPORTED_SUMMARY).toContain("WAV");
	});
});

describe("asset ids", () => {
	it("never repeats, so a restored project can't collide with a new import", () => {
		const blob = new Blob([new Uint8Array([0])], { type: "video/webm" });
		const ids = new Set<string>();
		for (let index = 0; index < 200; index++) {
			ids.add(assetFromRecording(blob, "take", 1, 1920, 1080, false).id);
		}
		expect(ids.size).toBe(200);
	});
});

describe("formatDuration", () => {
	it("calls a zero-length asset a still", () => {
		expect(formatDuration(0)).toBe("still");
	});

	it("shows seconds under a minute and mm:ss above", () => {
		expect(formatDuration(4.25)).toBe("4.3s");
		expect(formatDuration(75)).toBe("1:15");
		expect(formatDuration(600)).toBe("10:00");
	});
});
