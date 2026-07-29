// The floating record bar.
//
// It runs in its own always-on-top, content-protected window rather than as a
// corner of the editor — a bar drawn inside the editor is part of the screen,
// so recording the screen would record the bar. See createRendrBarWindow.
//
// The window has no state of its own: the editor pushes what to display and
// this sends back what the user pressed.

import { useEffect, useState } from "react";

import "./palmier.css";

import { CloseIcon, PauseIcon, PlayIcon } from "./icons";
import { formatClock } from "./state";

export interface RecordBarState {
	phase: "idle" | "countdown" | "recording" | "paused" | "finalizing";
	elapsed: number;
	countdown: number;
	sourceName: string | null;
}

export type RecordBarCommand = "stop" | "pause" | "resume" | "cancel";

const INITIAL: RecordBarState = {
	phase: "recording",
	elapsed: 0,
	countdown: 0,
	sourceName: null,
};

export function RecordBar() {
	const [state, setState] = useState<RecordBarState>(INITIAL);

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.onRecordBarState) return;
		return bridge.onRecordBarState((next) => setState(next as RecordBarState));
	}, []);

	const send = (command: RecordBarCommand) => window.electronAPI?.sendRecordBarCommand?.(command);

	if (state.phase === "countdown") {
		return (
			<div className="pmr-bar" data-phase="countdown">
				<span className="pmr-bar__count">{state.countdown}</span>
				<span className="pmr-bar__label">Starting…</span>
				<button
					type="button"
					className="pmr-bar__btn"
					title="Cancel"
					aria-label="Cancel"
					onClick={() => send("cancel")}
				>
					<CloseIcon size={11} />
				</button>
			</div>
		);
	}

	const paused = state.phase === "paused";

	return (
		<div className="pmr-bar" data-phase={state.phase}>
			<span className="pmr-bar__dot" data-paused={paused || undefined} />
			<span className="pmr-bar__time">{formatClock(state.elapsed)}</span>
			{state.sourceName ? <span className="pmr-bar__label">{state.sourceName}</span> : null}

			<span className="pmr-bar__spacer" />

			<button
				type="button"
				className="pmr-bar__btn"
				title={paused ? "Resume" : "Pause"}
				aria-label={paused ? "Resume recording" : "Pause recording"}
				disabled={state.phase === "finalizing"}
				onClick={() => send(paused ? "resume" : "pause")}
			>
				{paused ? <PlayIcon size={11} /> : <PauseIcon size={11} />}
			</button>

			<button
				type="button"
				className="pmr-bar__stop"
				title="Stop and add to the library"
				aria-label="Stop recording"
				disabled={state.phase === "finalizing"}
				onClick={() => send("stop")}
			>
				<span className="pmr-bar__square" />
				{state.phase === "finalizing" ? "Saving…" : "Stop"}
			</button>

			<button
				type="button"
				className="pmr-bar__btn"
				title="Discard this take"
				aria-label="Discard this take"
				disabled={state.phase === "finalizing"}
				onClick={() => send("cancel")}
			>
				<CloseIcon size={11} />
			</button>
		</div>
	);
}
