// Relinks a reopened project's media by itself.
//
// Projects reference media rather than embedding it, so they open with every
// asset offline until the files are dropped back in. When an asset remembers
// where its file was on disk and the file is still there, there's nothing to
// ask the user: read it and relink. Files are taken one at a time, so a
// project of 4K takes doesn't try to load them all at once.

import { useEffect, useRef } from "react";

import type { PathedFile } from "./media";
import type { EditorApi } from "./state";

export function useAutoRelink(api: EditorApi): void {
	const attempted = useRef(new Set<string>());
	const running = useRef(false);
	const apiRef = useRef(api);
	apiRef.current = api;

	const pending = api.state.assets.filter(
		(asset) =>
			asset.offline && asset.sourcePath && !asset.isMatte && !attempted.current.has(asset.id),
	);
	const pendingKey = pending.map((asset) => asset.id).join("|");

	// pendingKey is the trigger; the assets are re-read through apiRef as each lands.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const bridge = typeof window === "undefined" ? undefined : window.electronAPI;
		if (!bridge?.readLocalFile || running.current || pending.length === 0) return;
		running.current = true;
		void (async () => {
			let restored = 0;
			for (const asset of pending) {
				attempted.current.add(asset.id);
				// Re-check against the project as it is now: it may have been
				// relinked by hand, or a different project opened, since the list
				// was taken — importing then would duplicate or cross projects.
				const now = apiRef.current.state.assets.find((entry) => entry.id === asset.id);
				if (!now?.offline || now.sourcePath !== asset.sourcePath) continue;
				const path = asset.sourcePath as string;
				const read = await bridge.readLocalFile(path).catch(() => null);
				if (!read?.success || !read.data) continue;
				const still = apiRef.current.state.assets.find((entry) => entry.id === asset.id);
				if (!still?.offline) continue;
				// Named as the project knows it, and relinked to this asset by id.
				const file = new File([new Uint8Array(read.data)], asset.name) as PathedFile;
				file.rendrSourcePath = path;
				const landed = await apiRef.current.importMedia([file], { relinkTo: asset.id });
				if (landed.length > 0) restored += 1;
			}
			running.current = false;
			if (restored > 0) {
				apiRef.current.toast(
					`Relinked ${restored} ${restored === 1 ? "file" : "files"} from where they were`,
				);
			}
		})();
	}, [pendingKey]);
}
