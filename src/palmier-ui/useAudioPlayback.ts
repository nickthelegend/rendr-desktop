// Drives the audio engine from the timeline, and reports the real output level
// for the meter. Mute, solo and per-clip gain all take effect here because the
// engine reads them straight off the model.

import { useEffect, useRef, useState } from "react";

import { AudioEngine } from "./audio";
import type { EditorApi } from "./state";

export function useAudioPlayback(api: EditorApi): number {
	const { state, timeline } = api;
	const engineRef = useRef<AudioEngine | null>(null);
	const [level, setLevel] = useState(0);

	// The context is created lazily: constructing one before a user gesture
	// leaves it suspended and logs a warning in every browser.
	useEffect(() => {
		if (!state.playing || engineRef.current) return;
		const engine = new AudioEngine();
		engineRef.current = engine;
		void engine.resume();
	}, [state.playing]);

	useEffect(() => {
		const engine = engineRef.current;
		if (!engine) return;
		engine.sync(timeline, state.assets, state.playhead, state.playing, state.playbackRate ?? 1);
	}, [state.assets, state.playbackRate, state.playhead, state.playing, timeline]);

	// The meter follows the real mix while playing, and falls to rest after.
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !state.playing) {
			setLevel(0);
			return;
		}
		let raf = 0;
		const tick = () => {
			setLevel(engine.level());
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [state.playing]);

	useEffect(() => () => engineRef.current?.stop(), []);

	return level;
}
