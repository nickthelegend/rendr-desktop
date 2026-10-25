// Brings person mattes back after a project is reopened.
//
// Projects reference media rather than embedding it, so a reopened project's
// footage is relinked by filename — but a matte is a file Rendr made, which
// the user never had to keep, so nothing relinks it. When footage that a clip
// shows with its background removed is back online and its matte isn't, this
// asks for the analysis again. The main process cached it by content hash, so
// that is a file read and an import, not minutes of Vision.

import { useEffect, useRef } from "react";

import { ensureAnalysis } from "./creatorTools";
import type { EditorApi } from "./state";

export function useMatteRecovery(api: EditorApi): void {
	const attempted = useRef(new Set<string>());
	const apiRef = useRef(api);
	apiRef.current = api;

	const { assets } = api.state;
	const needed = new Set<string>();
	for (const timeline of api.state.timelines ?? []) {
		for (const track of timeline.tracks) {
			for (const clip of track.clips) {
				if (clip.background && clip.assetId) needed.add(clip.assetId);
			}
		}
	}
	const stale = assets.filter((asset) => {
		if (!needed.has(asset.id) || asset.offline || !asset.url || !asset.matteAssetId)
			return false;
		const matte = assets.find((entry) => entry.id === asset.matteAssetId);
		return !matte || matte.offline || !matte.url;
	});
	const staleKey = stale.map((asset) => `${asset.id}:${asset.url}`).join("|");

	// staleKey is the trigger; the assets themselves are read through apiRef.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (typeof window === "undefined" || !window.electronAPI?.analyzeFootage) return;
		for (const asset of stale) {
			// One try per footage file per session: a matte that can't be rebuilt
			// shouldn't be retried on every render.
			const key = `${asset.id}:${asset.url}`;
			if (attempted.current.has(key)) continue;
			attempted.current.add(key);
			void ensureAnalysis(apiRef.current, asset, { waitMs: 0 });
		}
	}, [staleKey]);
}
