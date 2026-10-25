// @vitest-environment jsdom
//
// Reopened projects relink their own media from where the files were. The
// behaviour worth pinning is restraint: each offline file is read once, under
// the name the project knows it by, one at a time — and nothing happens for
// assets that never had a path or are already online.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssetModel } from "./media";
import type { EditorApi } from "./state";
import { useAutoRelink } from "./useAutoRelink";

const asset = (over: Partial<AssetModel>): AssetModel => ({
	id: "a",
	name: "take.mov",
	type: "video",
	durationSeconds: 10,
	width: 1920,
	height: 1080,
	hasAudio: true,
	url: "",
	offline: true,
	...over,
});

function fakeApi(assets: AssetModel[]) {
	const importMedia = vi.fn(async (files: File[]) =>
		files.map((file) => asset({ name: file.name, offline: false })),
	);
	const toast = vi.fn();
	return {
		api: { state: { assets }, importMedia, toast } as unknown as EditorApi,
		importMedia,
		toast,
	};
}

afterEach(() => {
	(window as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("useAutoRelink", () => {
	it("reads each offline file from its saved path once, under the project's name for it", async () => {
		const readLocalFile = vi.fn(async () => ({
			success: true,
			data: new Uint8Array([1, 2, 3]),
		}));
		(window as { electronAPI?: unknown }).electronAPI = { readLocalFile };
		const { api, importMedia, toast } = fakeApi([
			asset({ id: "a", name: "take.mov", sourcePath: "/Users/me/take.mov" }),
			asset({ id: "b", name: "no-path.mov" }),
			asset({
				id: "c",
				name: "online.mov",
				sourcePath: "/x.mov",
				offline: false,
				url: "blob:c",
			}),
			asset({ id: "m", name: "matte.mp4", sourcePath: "/m.mp4", isMatte: true }),
		]);
		const { rerender } = renderHook(() => useAutoRelink(api));
		await waitFor(() => expect(importMedia).toHaveBeenCalledTimes(1));
		expect(readLocalFile).toHaveBeenCalledTimes(1);
		expect(readLocalFile).toHaveBeenCalledWith("/Users/me/take.mov");
		const [file] = importMedia.mock.calls[0][0] as File[];
		expect(file.name).toBe("take.mov");
		expect((file as File & { rendrSourcePath?: string }).rendrSourcePath).toBe(
			"/Users/me/take.mov",
		);
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(expect.stringContaining("Relinked 1 file")),
		);

		// A re-render with the same state must not read the file again.
		rerender();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(readLocalFile).toHaveBeenCalledTimes(1);
	});

	it("gives up quietly on a file that's no longer there", async () => {
		const readLocalFile = vi.fn(async () => ({ success: false, error: "ENOENT" }));
		(window as { electronAPI?: unknown }).electronAPI = { readLocalFile };
		const { api, importMedia, toast } = fakeApi([asset({ sourcePath: "/gone.mov" })]);
		renderHook(() => useAutoRelink(api));
		await waitFor(() => expect(readLocalFile).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(importMedia).not.toHaveBeenCalled();
		expect(toast).not.toHaveBeenCalled();
	});
});
