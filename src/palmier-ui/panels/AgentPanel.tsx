// AgentPanelView — the chat column that sits beside the preset layout as a
// sibling split item. Tool calls appear as receipts rather than being hidden,
// so a human can see exactly what an agent changed.
//
// The log starts empty. What fills it is a real MCP client connecting to the
// server in the main process; nothing here fabricates a conversation.

import { useEffect, useRef, useState } from "react";
import { SendIcon, SparkleIcon } from "../icons";
import { MCP_PORT } from "../mcpStatus";
import { PanelHeader } from "../Panel";
import type { EditorApi } from "../state";
import { Status } from "../theme";
import { useClaude } from "../useClaude";

const STATUS_COLOR: Record<string, string> = {
	ok: Status.success,
	error: Status.error,
	pending: Status.warning,
};

const SUGGESTIONS = [
	"Record my screen, then punch in wherever I click",
	"Tighten the pacing and drop the filler words",
	"Add a title card and warm the grade",
];

export function AgentPanel({ api }: { api: EditorApi }) {
	const { state, toast } = api;
	const { status, thinking, send: askClaude, cancel } = useClaude(api);
	const [draft, setDraft] = useState("");
	const logRef = useRef<HTMLDivElement>(null);

	// Keep the newest message in view as the log grows. The log is the trigger,
	// not an input — the effect reads the node, so the linter can't see why it
	// belongs here, but dropping it would stop the panel scrolling.
	// biome-ignore lint/correctness/useExhaustiveDependencies: agentLog is the trigger
	useEffect(() => {
		const node = logRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [state.agentLog]);

	const send = (text: string) => {
		if (!text.trim()) return;
		setDraft("");
		askClaude(text);
	};

	return (
		<>
			<PanelHeader title="Agent">
				<span
					title={
						status.available
							? `Claude Code ${status.version ?? ""} — driving Rendr over MCP`
							: (status.reason ?? `Listening on 127.0.0.1:${MCP_PORT}`)
					}
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 5,
						fontSize: 10,
						color: "var(--pmr-text-muted)",
					}}
				>
					<span
						style={{
							width: 5,
							height: 5,
							borderRadius: "50%",
							background: thinking
								? Status.warning
								: status.available || state.agentConnected
									? Status.success
									: "rgba(255,255,255,0.28)",
						}}
					/>
					{thinking
						? "thinking"
						: status.available
							? "Claude"
							: state.agentConnected
								? "connected"
								: "waiting"}
				</span>
			</PanelHeader>

			<div className="pmr-agent">
				{state.agentLog.length === 0 ? (
					<div className="pmr-blank" style={{ justifyContent: "center" }}>
						<span className="pmr-blank__icon">
							<SparkleIcon size={22} />
						</span>
						<span className="pmr-blank__title">Drive Rendr by asking</span>
						<span className="pmr-blank__body">
							{status.available
								? "Claude Code answers here and edits the timeline through Rendr's own tools. Every call it makes shows up as a receipt."
								: (status.reason ??
									"Rendr exposes recording, zoom, and editing as MCP tools. Connect a client and every call shows up here as a receipt.")}
						</span>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: 5,
								width: "100%",
								marginTop: 4,
							}}
						>
							{SUGGESTIONS.map((suggestion) => (
								<button
									key={suggestion}
									type="button"
									className="pmr-suggestion"
									onClick={() => send(suggestion)}
								>
									{suggestion}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="pmr-agent__log" ref={logRef}>
						{state.agentLog.map((entry) => {
							if (entry.kind === "tool") {
								return (
									<div className="pmr-tool" key={entry.id}>
										<span
											className="pmr-tool__dot"
											style={{ background: STATUS_COLOR[entry.status] }}
										/>
										{entry.tool}
										<span
											style={{
												marginLeft: "auto",
												color: "var(--pmr-text-muted)",
											}}
										>
											{entry.detail}
										</span>
									</div>
								);
							}
							return (
								<div className={`pmr-msg pmr-msg--${entry.kind}`} key={entry.id}>
									<span className="pmr-msg__role">
										{entry.kind === "user" ? "You" : "Rendr"}
									</span>
									<span className="pmr-msg__body">{entry.text}</span>
								</div>
							);
						})}
					</div>
				)}

				{thinking ? (
					<div className="pmr-thinking">
						<span className="pmr-thinking__dots">
							<i />
							<i />
							<i />
						</span>
						Claude is working
						<button type="button" className="pmr-thinking__stop" onClick={cancel}>
							Stop
						</button>
					</div>
				) : null}

				<div className="pmr-agent__input">
					<textarea
						className="pmr-agent__field"
						placeholder={
							status.available
								? "Ask Claude to record, cut, or zoom…"
								: "Ask Rendr to record, cut, or zoom…"
						}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								send(draft);
							}
						}}
					/>
					<div className="pmr-agent__actions">
						<button
							type="button"
							className="pmr-agent__endpoint"
							title="Copy the MCP endpoint"
							onClick={() => {
								void navigator.clipboard
									?.writeText(`http://127.0.0.1:${MCP_PORT}/mcp`)
									.then(() => toast("MCP endpoint copied"))
									.catch(() => toast("Couldn't copy to the clipboard", "error"));
							}}
						>
							MCP · 127.0.0.1:{MCP_PORT}
						</button>
						<button
							type="button"
							className="pmr-send"
							onClick={() => send(draft)}
							disabled={!draft.trim()}
							aria-label="Send"
						>
							<SendIcon />
						</button>
					</div>
				</div>
			</div>
		</>
	);
}
