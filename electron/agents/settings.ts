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
	return path.join(app.getPath("userData"), "agent-key.bin");
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

export function readApiKey(): string | null {
	try {
		if (!existsSync(keyFile())) return null;
		const bytes = readFileSync(keyFile());
		if (bytes.length === 0) return null;
		return safeStorage.isEncryptionAvailable()
			? safeStorage.decryptString(bytes)
			: bytes.toString("utf8");
	} catch {
		return null;
	}
}

/** Stores the key, or clears it when given an empty string. */
export function writeApiKey(key: string): void {
	const trimmed = key.trim();
	if (!trimmed) {
		writeFileSync(keyFile(), Buffer.alloc(0), { mode: 0o600 });
		return;
	}
	const bytes = safeStorage.isEncryptionAvailable()
		? safeStorage.encryptString(trimmed)
		: Buffer.from(trimmed, "utf8");
	writeFileSync(keyFile(), bytes, { mode: 0o600 });
}

export function publicSettings(): PublicAgentSettings {
	return { ...loadSettings(), apiKeySet: readApiKey() !== null };
}
