// Which agent answers in the panel, and how it is configured.
//
// Stored as JSON in userData. The API key is the one secret, and it is kept
// apart: encrypted with the OS keychain through safeStorage, written to its own
// file, and never sent to the renderer — the panel only learns whether one is set.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app, safeStorage } from "electron";

import type { AgentSettings, PublicAgentSettings } from "./types";

export const DEFAULT_SETTINGS: AgentSettings = {
	provider: "claude-code",
	models: {},
	acp: { preset: "opencode", command: "" },
	api: { flavor: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" },
};

function settingsFile(): string {
	return path.join(app.getPath("userData"), "agent-settings.json");
}

function keyFile(): string {
	return path.join(app.getPath("userData"), "agent-keys.json");
}

/**
 * Which provider a key belongs to: the origin of its base URL. A key is only
 * ever read back for the origin it was saved under, so switching from OpenAI to
 * a typed-in custom endpoint can't send the OpenAI key to it.
 */
export function keyOrigin(baseUrl: string): string | null {
	try {
		return new URL(baseUrl.trim()).origin;
	} catch {
		return null;
	}
}

let cached: AgentSettings | null = null;

/** Fills anything a stored file is missing, so an old file never breaks a new build. */
export function normalizeSettings(raw: unknown): AgentSettings {
	const input = (raw && typeof raw === "object" ? raw : {}) as Partial<AgentSettings>;
	const providers = ["claude-code", "codex", "acp", "api"] as const;
	return {
		provider: providers.includes(input.provider as (typeof providers)[number])
			? (input.provider as AgentSettings["provider"])
			: DEFAULT_SETTINGS.provider,
		models: { ...(input.models ?? {}) },
		acp: { ...DEFAULT_SETTINGS.acp, ...(input.acp ?? {}) },
		api: { ...DEFAULT_SETTINGS.api, ...(input.api ?? {}) },
	};
}

export function loadSettings(): AgentSettings {
	if (cached) return cached;
	try {
		cached = normalizeSettings(
			existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), "utf8")) : {},
		);
	} catch {
		cached = normalizeSettings({});
	}
	return cached;
}

export function saveSettings(patch: Partial<AgentSettings>): AgentSettings {
	const current = loadSettings();
	const next = normalizeSettings({
		...current,
		...patch,
		models: { ...current.models, ...(patch.models ?? {}) },
		acp: { ...current.acp, ...(patch.acp ?? {}) },
		api: { ...current.api, ...(patch.api ?? {}) },
	});
	cached = next;
	writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
	return next;
}

function readKeys(): Record<string, string> {
	try {
		if (!existsSync(keyFile())) return {};
		const parsed = JSON.parse(readFileSync(keyFile(), "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** The key saved for this base URL's origin, or null. */
export function readApiKey(baseUrl: string): string | null {
	const origin = keyOrigin(baseUrl);
	const stored = origin ? readKeys()[origin] : undefined;
	if (!stored) return null;
	try {
		const bytes = Buffer.from(stored, "base64");
		return safeStorage.isEncryptionAvailable()
			? safeStorage.decryptString(bytes)
			: bytes.toString("utf8");
	} catch {
		return null;
	}
}

/** Stores the key for this base URL's origin, or clears it when given an empty string. */
export function writeApiKey(key: string, baseUrl: string): void {
	const origin = keyOrigin(baseUrl);
	if (!origin) throw new Error("Set the provider's base URL before its API key.");
	const keys = readKeys();
	const trimmed = key.trim();
	if (trimmed) {
		const bytes = safeStorage.isEncryptionAvailable()
			? safeStorage.encryptString(trimmed)
			: Buffer.from(trimmed, "utf8");
		keys[origin] = bytes.toString("base64");
	} else {
		delete keys[origin];
	}
	writeFileSync(keyFile(), JSON.stringify(keys, null, 2), { mode: 0o600 });
}

export function publicSettings(): PublicAgentSettings {
	const settings = loadSettings();
	return { ...settings, apiKeySet: readApiKey(settings.api.baseUrl) !== null };
}
