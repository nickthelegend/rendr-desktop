import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const userData = mkdtempSync(path.join(os.tmpdir(), "rendr-settings-"));
vi.mock("electron", () => ({
	app: { getPath: () => userData },
	safeStorage: { isEncryptionAvailable: () => false },
}));

const { keyOrigin, readApiKey, writeApiKey } = await import("./settings");
const { sendsKeySafely } = await import("./apiAgent");

describe("API keys", () => {
	it("are only read back for the provider they were saved for", () => {
		writeApiKey("sk-openai", "https://api.openai.com/v1");
		expect(readApiKey("https://api.openai.com/v1")).toBe("sk-openai");
		// Switching provider — or typing a custom URL — must not carry the key across.
		expect(readApiKey("https://api.anthropic.com")).toBeNull();
		expect(readApiKey("https://evil.example/v1")).toBeNull();
		writeApiKey("sk-ant", "https://api.anthropic.com");
		expect(readApiKey("https://api.openai.com/v1")).toBe("sk-openai");
		writeApiKey("", "https://api.openai.com/v1");
		expect(readApiKey("https://api.openai.com/v1")).toBeNull();
		expect(readApiKey("https://api.anthropic.com")).toBe("sk-ant");
	});

	it("are keyed by origin, so a path change on one provider keeps its key", () => {
		expect(keyOrigin("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai");
		expect(keyOrigin("not a url")).toBeNull();
		expect(() => writeApiKey("x", "")).toThrow(/base URL/);
	});

	it("never go in the clear to another machine", () => {
		expect(sendsKeySafely("https://api.groq.com/openai/v1")).toBe(true);
		expect(sendsKeySafely("http://127.0.0.1:11434/v1")).toBe(true);
		expect(sendsKeySafely("http://localhost:1234/v1")).toBe(true);
		expect(sendsKeySafely("http://192.168.1.20:8000/v1")).toBe(false);
		expect(sendsKeySafely("http://api.example.com/v1")).toBe(false);
	});
});
