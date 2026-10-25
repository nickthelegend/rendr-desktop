// Finding agent CLIs from a GUI app.
//
// An app launched from the Dock or Finder does not inherit the user's shell
// PATH, so `claude`, `codex` or `opencode` installed under ~/.local/bin or
// Homebrew are invisible to a bare spawn. Every provider resolves its binary
// here and spawns with the widened PATH, so `npx`-based adapters can find node.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

/** Where agent CLIs usually land, in the order a shell would usually find them. */
const EXTRA_DIRS = [
	path.join(HOME, ".local/bin"),
	path.join(HOME, ".claude/local"),
	path.join(HOME, ".opencode/bin"),
	path.join(HOME, ".bun/bin"),
	path.join(HOME, ".npm-global/bin"),
	path.join(HOME, ".volta/bin"),
	path.join(HOME, ".cargo/bin"),
	path.join(HOME, "go/bin"),
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
];

export function widenedPath(): string {
	const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const merged = [...current];
	for (const dir of EXTRA_DIRS) if (!merged.includes(dir)) merged.push(dir);
	return merged.join(path.delimiter);
}

/** The environment every agent child process gets. */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...process.env, PATH: widenedPath(), ...extra };
}

/**
 * Resolves a command name to an absolute path when it can be found, otherwise
 * returns the name unchanged so spawn reports ENOENT in its own words.
 */
export function resolveBinary(name: string): string {
	if (path.isAbsolute(name)) return name;
	const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
	for (const dir of widenedPath().split(path.delimiter)) {
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext);
			if (existsSync(candidate)) return candidate;
		}
	}
	return name;
}

/** Whether a command resolves to a file on disk. */
export function hasBinary(name: string): boolean {
	return path.isAbsolute(resolveBinary(name));
}

/**
 * Splits a command line typed by a person into argv. Handles single and double
 * quotes, which is all a "custom agent command" field needs.
 */
export function splitCommandLine(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let started = false;
	for (const char of line.trim()) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) out.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started) out.push(current);
	return out;
}
