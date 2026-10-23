import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../mcp/index", () => ({
	attachMcpServer: vi.fn(),
	detachMcpServer: vi.fn(),
	dispatchTool: vi.fn(),
}));

const { remotePolicy } = await import("./remote");

describe("remote access policy", () => {
	it("refuses anything that names a file on this computer, however deep", () => {
		expect(remotePolicy("import_media", { source: { path: "/Users/me/.ssh/id_rsa" } })).toMatch(
			/file on the user's computer/,
		);
		expect(remotePolicy("export_project", { outputPath: "/Users/me/.zshrc" })).toMatch(
			/outputPath/,
		);
		expect(remotePolicy("apply_lut", { lut: { filePath: "/etc/passwd" } })).toMatch(/filePath/);
	});

	it("keeps screen capture with the person at the keyboard", () => {
		expect(remotePolicy("start_recording", { sourceId: "screen:1" })).toMatch(
			/only be started from this computer/,
		);
	});

	it("allows ordinary editing and importing by URL", () => {
		expect(
			remotePolicy("import_media", { source: { url: "https://example.com/a.mp4" } }),
		).toBeNull();
		expect(remotePolicy("add_graphic", { template: "qr", data: "https://x.y" })).toBeNull();
		expect(remotePolicy("get_timeline", {})).toBeNull();
		expect(remotePolicy("export_project", { outputPath: "" })).toBeNull();
	});
});
