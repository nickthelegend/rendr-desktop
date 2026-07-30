// Reading a .cube LUT off disk.
//
// A deliberately narrow bridge rather than a general file-read channel: the
// renderer is the least trusted process here, and an agent-driven renderer can
// be asked to read a path by a tool call whose arguments came from a model. So
// this refuses anything that is not a .cube file, and caps the size — a 33³ LUT
// is about 250 KB of text and a 64³ is under 2 MB, so the cap is generous for
// real files and small enough that it cannot be used to haul a database into
// the renderer a line at a time.

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

import { ipcMain } from "electron";

/** 8 MB. A 64-cube is ~2 MB; anything larger is not a LUT. */
const MAX_BYTES = 8 * 1024 * 1024;

export type LutReadResult = { ok: true; text: string } | { ok: false; reason: string };

export async function readLutFile(path: unknown): Promise<LutReadResult> {
	if (typeof path !== "string" || path.trim() === "")
		return { ok: false, reason: "No path given." };
	if (!isAbsolute(path)) return { ok: false, reason: `'${path}' is not an absolute path.` };
	if (extname(path).toLowerCase() !== ".cube")
		return {
			ok: false,
			reason: `Only .cube files can be read here, and '${path}' is not one. Convert the LUT, or pass its text as lutText.`,
		};
	try {
		const info = await stat(path);
		if (!info.isFile()) return { ok: false, reason: `'${path}' is not a file.` };
		if (info.size > MAX_BYTES)
			return {
				ok: false,
				reason: `That file is ${(info.size / 1024 / 1024).toFixed(1)} MB. A .cube LUT is under 8 MB even at 64³, so this is not one.`,
			};
		return { ok: true, text: await readFile(path, "utf-8") };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: false, reason: `No file at '${path}'.` };
		if (code === "EACCES") return { ok: false, reason: `No permission to read '${path}'.` };
		return { ok: false, reason: `Couldn't read '${path}': ${String(error)}` };
	}
}

export function registerLutIpc(): void {
	ipcMain.handle("rendr-lut:read", (_event, path: unknown) => readLutFile(path));
}
