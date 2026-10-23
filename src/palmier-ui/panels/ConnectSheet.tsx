// Rendr Connect — every way to pair Rendr with an agent, in one sheet.
//
// Two directions. "Agent" chooses the brain behind Rendr's own panel: a
// subscription CLI, any ACP agent, or an API key. The other tabs go the other
// way, making Rendr a connector: one-click setup for MCP apps on this machine,
// a tunnel for cloud agents, and REST / OpenAPI / CLI for everything else.

import { useCallback, useEffect, useState } from "react";

import type {
	AcpPreset,
	AgentCatalog,
	AgentSettingsPatch,
	AgentSettingsView,
	ConnectClient,
	ConnectStateView,
	ProviderId,
	StdioCommand,
} from "../agentTypes";
import { Segmented, Select } from "../controls";
import { CloseIcon } from "../icons";
import { Status } from "../theme";
import type { AgentStatus } from "../useAgent";

export type ConnectTab = "agent" | "apps" | "cloud" | "developers";

const TABS: ReadonlyArray<{ value: ConnectTab; label: string; title: string }> = [
	{ value: "agent", label: "Agent", title: "Which agent answers in Rendr's panel" },
	{ value: "apps", label: "Apps", title: "Connect MCP apps on this computer to Rendr" },
	{
		value: "cloud",
		label: "Cloud",
		title: "Let cloud agents like claude.ai and ChatGPT reach Rendr",
	},
	{
		value: "developers",
		label: "Developers",
		title: "REST, OpenAPI, tool schemas and the rendr command",
	},
];

interface AgentControls {
	status: AgentStatus;
	settings: AgentSettingsView | null;
	catalog: AgentCatalog | null;
	updateSettings: (patch: AgentSettingsPatch) => Promise<void>;
	setApiKey: (key: string) => Promise<void>;
	refresh: () => void;
	reset: () => void;
}

function useCopy(toast: (message: string, tone?: "error") => void) {
	return useCallback(
		(text: string, what = "Copied") => {
			void navigator.clipboard
				?.writeText(text)
				.then(() => toast(what))
				.catch(() => toast("Couldn't copy to the clipboard", "error"));
		},
		[toast],
	);
}

function stdioLine(stdio: StdioCommand): string {
	const quote = (value: string) =>
		/^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
	const env = Object.entries(stdio.env).map(([key, value]) => `${key}=${quote(value)}`);
	return [...env, quote(stdio.command), ...stdio.args.map(quote)].join(" ");
}

function CopyField({
	label,
	value,
	onCopy,
	secret,
}: {
	label: string;
	value: string;
	onCopy: (text: string) => void;
	secret?: boolean;
}) {
	const [revealed, setRevealed] = useState(!secret);
	return (
		<div className="pmr-connect__field">
			<span className="pmr-connect__field-label">{label}</span>
			<code className="pmr-connect__code" title={revealed ? value : undefined}>
				{revealed ? value : value.replace(/\/t\/[^/]+/, "/t/••••••••")}
			</code>
			{secret ? (
				<button
					type="button"
					className="pmr-action"
					onClick={() => setRevealed((shown) => !shown)}
				>
					{revealed ? "Hide" : "Show"}
				</button>
			) : null}
			<button type="button" className="pmr-action" onClick={() => onCopy(value)}>
				Copy
			</button>
		</div>
	);
}

function Dot({ tone }: { tone: "ok" | "warn" | "off" | "error" }) {
	const color =
		tone === "ok"
			? Status.success
			: tone === "warn"
				? Status.warning
				: tone === "error"
					? Status.error
					: "rgba(255,255,255,0.28)";
	return <span className="pmr-connect__dot" style={{ background: color }} />;
}

// ── Agent tab ────────────────────────────────────────────────────────────

function AgentTab({ agent }: { agent: AgentControls }) {
	const { settings, catalog, status } = agent;
	const [keyDraft, setKeyDraft] = useState("");
	const [modelDraft, setModelDraft] = useState("");
	const [commandDraft, setCommandDraft] = useState("");
	const [baseUrlDraft, setBaseUrlDraft] = useState("");

	const provider = settings?.provider ?? "claude-code";
	useEffect(() => {
		if (!settings) return;
		setModelDraft(provider === "api" ? settings.api.model : (settings.models[provider] ?? ""));
		setCommandDraft(settings.acp.command);
		setBaseUrlDraft(settings.api.baseUrl);
	}, [settings, provider]);

	if (!settings || !catalog) {
		return (
			<p className="pmr-sheet__note">Agent settings are only available in the desktop app.</p>
		);
	}

	const apiPreset = catalog.apiPresets.find((preset) => preset.baseUrl === settings.api.baseUrl);
	const acpPreset = catalog.acpPresets.find((preset) => preset.id === settings.acp.preset);

	const saveModel = () => {
		if (provider === "api") void agent.updateSettings({ api: { model: modelDraft.trim() } });
		else void agent.updateSettings({ models: { [provider]: modelDraft.trim() } });
	};

	return (
		<>
			<p className="pmr-sheet__note">
				Rendr has no model of its own. Choose the agent that answers in the panel. It uses
				your own subscription or key, and edits through the same tools every other agent
				gets.
			</p>
			<div className="pmr-connect__choices" role="radiogroup" aria-label="Agent">
				{catalog.providers.map((entry) => (
					<button
						key={entry.id}
						type="button"
						role="radio"
						aria-checked={provider === entry.id}
						className="pmr-connect__choice"
						data-active={provider === entry.id}
						onClick={() =>
							void agent.updateSettings({ provider: entry.id as ProviderId })
						}
					>
						<span className="pmr-connect__choice-title">{entry.label}</span>
						<span className="pmr-connect__choice-detail">{entry.detail}</span>
					</button>
				))}
			</div>

			{provider === "acp" ? (
				<>
					<div className="pmr-row">
						<span className="pmr-row__label">Agent</span>
						<div className="pmr-row__control">
							<Select
								ariaLabel="ACP agent"
								value={settings.acp.preset}
								options={catalog.acpPresets.map((preset) => ({
									value: preset.id,
									label: preset.label,
								}))}
								onChange={(preset: AcpPreset) =>
									void agent.updateSettings({ acp: { preset, command: "" } })
								}
							/>
						</div>
					</div>
					<div className="pmr-row">
						<span className="pmr-row__label">Command</span>
						<div className="pmr-row__control">
							<input
								className="pmr-textinput"
								placeholder={acpPreset?.command || "my-agent --acp"}
								value={commandDraft}
								onChange={(event) => setCommandDraft(event.target.value)}
								onBlur={() =>
									void agent.updateSettings({ acp: { command: commandDraft } })
								}
							/>
						</div>
					</div>
				</>
			) : null}

			{provider === "api" ? (
				<>
					<div className="pmr-row">
						<span className="pmr-row__label">Provider</span>
						<div className="pmr-row__control">
							<Select
								ariaLabel="API provider"
								value={apiPreset?.id ?? "custom"}
								options={[
									...catalog.apiPresets.map((preset) => ({
										value: preset.id,
										label: preset.label,
									})),
									{ value: "custom", label: "Custom (OpenAI-compatible)" },
								]}
								onChange={(id: string) => {
									const preset = catalog.apiPresets.find(
										(entry) => entry.id === id,
									);
									if (preset) {
										void agent.updateSettings({
											api: {
												flavor: preset.flavor,
												baseUrl: preset.baseUrl,
												model: preset.model,
											},
										});
									} else {
										void agent.updateSettings({
											api: { flavor: "openai", baseUrl: "" },
										});
									}
								}}
							/>
						</div>
					</div>
					<div className="pmr-row">
						<span className="pmr-row__label">Base URL</span>
						<div className="pmr-row__control">
							<input
								className="pmr-textinput"
								placeholder="https://…/v1"
								value={baseUrlDraft}
								onChange={(event) => setBaseUrlDraft(event.target.value)}
								onBlur={() =>
									void agent.updateSettings({
										api: { baseUrl: baseUrlDraft.trim() },
									})
								}
							/>
						</div>
					</div>
					<div className="pmr-row">
						<span className="pmr-row__label">API key</span>
						<div className="pmr-row__control">
							<input
								className="pmr-textinput"
								type="password"
								autoComplete="off"
								placeholder={
									settings.apiKeySet
										? "Saved — type to replace"
										: apiPreset?.needsKey === false
											? "Not needed"
											: "Paste your key"
								}
								value={keyDraft}
								onChange={(event) => setKeyDraft(event.target.value)}
							/>
							<button
								type="button"
								className="pmr-action"
								disabled={!keyDraft.trim()}
								onClick={() => {
									void agent.setApiKey(keyDraft);
									setKeyDraft("");
								}}
							>
								Save
							</button>
							{settings.apiKeySet ? (
								<button
									type="button"
									className="pmr-action"
									onClick={() => void agent.setApiKey("")}
								>
									Clear
								</button>
							) : null}
						</div>
					</div>
					<p className="pmr-sheet__note">
						The key is encrypted with your system keychain and never leaves this
						computer except to call {apiPreset?.label ?? "the provider"}.
						{apiPreset?.keyUrl ? ` Get one at ${apiPreset.keyUrl}` : ""}
					</p>
				</>
			) : null}

			<div className="pmr-row">
				<span className="pmr-row__label">Model</span>
				<div className="pmr-row__control">
					<input
						className="pmr-textinput"
						placeholder={provider === "api" ? "model id" : "Agent default"}
						value={modelDraft}
						onChange={(event) => setModelDraft(event.target.value)}
						onBlur={saveModel}
						onKeyDown={(event) => {
							if (event.key === "Enter") saveModel();
						}}
					/>
				</div>
			</div>

			<div className="pmr-connect__status">
				<Dot tone={!status.checked ? "warn" : status.available ? "ok" : "error"} />
				<span>
					{!status.checked
						? "Checking…"
						: status.available
							? `${status.label ?? "Agent"} is ready${status.version ? ` · ${status.version}` : ""}`
							: (status.reason ?? "Not available")}
				</span>
				<span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
					<button type="button" className="pmr-action" onClick={agent.refresh}>
						Check again
					</button>
					<button type="button" className="pmr-action" onClick={agent.reset}>
						New conversation
					</button>
				</span>
			</div>
		</>
	);
}

// ── Apps tab ─────────────────────────────────────────────────────────────

function ClientRow({
	client,
	onInstall,
	onCopy,
	busy,
}: {
	client: ConnectClient;
	onInstall: (id: string) => void;
	onCopy: (text: string, what?: string) => void;
	busy: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="pmr-connect__client" data-detected={client.detected}>
			<div className="pmr-connect__client-row">
				<Dot tone={client.connected ? "ok" : "off"} />
				<span className="pmr-connect__client-name">{client.label}</span>
				<span className="pmr-connect__client-meta">
					{client.connected
						? "Connected"
						: client.id === "stdio"
							? "One command, any client"
							: client.detected
								? "Found on this computer"
								: "Not found"}
				</span>
				<button
					type="button"
					className="pmr-action"
					onClick={() => setOpen((shown) => !shown)}
				>
					{open ? "Hide" : "Manual"}
				</button>
				{client.canInstall ? (
					<button
						type="button"
						className={`pmr-action${client.connected ? "" : " pmr-action--primary"}`}
						disabled={busy}
						onClick={() => onInstall(client.id)}
					>
						{client.connected ? "Reconnect" : "Connect"}
					</button>
				) : (
					<button
						type="button"
						className="pmr-action pmr-action--primary"
						onClick={() => onCopy(client.snippet, `${client.label} setup copied`)}
					>
						Copy
					</button>
				)}
			</div>
			{open ? (
				<div className="pmr-connect__client-detail">
					{client.configPath ? (
						<span className="pmr-connect__path">{client.configPath}</span>
					) : null}
					<pre className="pmr-connect__snippet">{client.snippet}</pre>
					{client.note ? <span className="pmr-sheet__note">{client.note}</span> : null}
				</div>
			) : client.note && client.connected ? (
				<span className="pmr-sheet__note pmr-connect__client-note">{client.note}</span>
			) : null}
		</div>
	);
}

function AppsTab({
	state,
	onInstall,
	onInstallCli,
	onCopy,
	busy,
}: {
	state: ConnectStateView;
	onInstall: (id: string) => void;
	onInstallCli: () => void;
	onCopy: (text: string, what?: string) => void;
	busy: string | null;
}) {
	const clients = [...state.clients].sort((a, b) => Number(b.detected) - Number(a.detected));
	return (
		<>
			<p className="pmr-sheet__note">
				Rendr runs an MCP server at <code>{state.local.mcpUrl}</code>. Connect an app once,
				and its agent can record, cut, caption and export in Rendr whenever Rendr is open.
				Rendr adds itself to the app's config and leaves everything else in it alone.
			</p>
			<div className="pmr-connect__clients">
				{clients.map((client) => (
					<ClientRow
						key={client.id}
						client={client}
						onInstall={onInstall}
						onCopy={onCopy}
						busy={busy === client.id}
					/>
				))}
				<div className="pmr-connect__client">
					<div className="pmr-connect__client-row">
						<Dot tone={state.cli.installed ? "ok" : "off"} />
						<span className="pmr-connect__client-name">The rendr command</span>
						<span className="pmr-connect__client-meta">
							{state.cli.installed
								? state.cli.path
								: "For agents that only have a shell"}
						</span>
						<button
							type="button"
							className={`pmr-action${state.cli.installed ? "" : " pmr-action--primary"}`}
							disabled={busy === "cli"}
							onClick={onInstallCli}
						>
							{state.cli.installed ? "Reinstall" : "Install"}
						</button>
					</div>
				</div>
			</div>
		</>
	);
}

// ── Cloud tab ────────────────────────────────────────────────────────────

function CloudTab({
	state,
	onCopy,
	onStart,
	onStop,
	onRotate,
}: {
	state: ConnectStateView;
	onCopy: (text: string, what?: string) => void;
	onStart: (mode: "cloudflared" | "manual", origin?: string) => void;
	onStop: () => void;
	onRotate: () => void;
}) {
	const remote = state.remote;
	const [origin, setOrigin] = useState(remote?.manualOrigin ?? "");
	if (!remote) return null;
	const on = remote.status === "on";

	return (
		<>
			<p className="pmr-sheet__note">
				Cloud agents can't reach 127.0.0.1. Remote access opens a second, token-protected
				endpoint and gives you one URL to paste into claude.ai, ChatGPT or any agent
				platform. Anyone with the URL can control Rendr, so share it like a password. It
				turns off when Rendr quits.
			</p>

			<div className="pmr-connect__status">
				<Dot
					tone={
						on
							? "ok"
							: remote.status === "starting"
								? "warn"
								: remote.status === "error"
									? "error"
									: "off"
					}
				/>
				<span>
					{on
						? `On · ${remote.mode === "manual" ? "your tunnel" : "Cloudflare tunnel"}`
						: remote.status === "starting"
							? "Opening a tunnel…"
							: remote.status === "error"
								? remote.error
								: "Off"}
				</span>
				<span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
					{on || remote.status === "starting" ? (
						<button type="button" className="pmr-action" onClick={onStop}>
							Turn off
						</button>
					) : (
						<button
							type="button"
							className="pmr-action pmr-action--primary"
							disabled={!remote.cloudflaredInstalled}
							title={
								remote.cloudflaredInstalled
									? undefined
									: "Install cloudflared first: brew install cloudflared"
							}
							onClick={() => onStart("cloudflared")}
						>
							Turn on
						</button>
					)}
				</span>
			</div>

			{!remote.cloudflaredInstalled && !on ? (
				<p className="pmr-sheet__note">
					One-click remote access uses Cloudflare's free quick tunnels. Install them with{" "}
					<code>brew install cloudflared</code>, or use your own tunnel below.
				</p>
			) : null}

			{on && remote.connectorUrl ? (
				<>
					<CopyField
						label="Connector URL"
						value={remote.connectorUrl}
						onCopy={(text) => onCopy(text, "Connector URL copied")}
						secret
					/>
					{remote.openApiUrl ? (
						<CopyField
							label="OpenAPI"
							value={remote.openApiUrl}
							onCopy={(text) => onCopy(text, "OpenAPI URL copied")}
							secret
						/>
					) : null}
					<div className="pmr-connect__status">
						<span className="pmr-sheet__note" style={{ flex: 1 }}>
							New token: every URL you've shared stops working right away.
						</span>
						<button type="button" className="pmr-action" onClick={onRotate}>
							New token
						</button>
					</div>
				</>
			) : null}

			<div className="pmr-connect__group">
				<span className="pmr-connect__group-title">Where to paste it</span>
				{state.cloudClients.map((client) => (
					<div key={client.id} className="pmr-connect__step">
						<span className="pmr-connect__client-name">{client.label}</span>
						<span className="pmr-sheet__note">{client.steps}</span>
					</div>
				))}
			</div>

			<div className="pmr-connect__group">
				<span className="pmr-connect__group-title">Your own tunnel</span>
				<span className="pmr-sheet__note">
					With ngrok, Tailscale Funnel or a reverse proxy, forward HTTPS to 127.0.0.1:
					{remote.localPort} and paste its public address here.
				</span>
				<div className="pmr-row">
					<div className="pmr-row__control">
						<input
							className="pmr-textinput"
							placeholder="https://my-tunnel.example.com"
							value={origin}
							onChange={(event) => setOrigin(event.target.value)}
						/>
						<button
							type="button"
							className="pmr-action"
							disabled={!origin.trim()}
							onClick={() => onStart("manual", origin)}
						>
							Use
						</button>
					</div>
				</div>
			</div>
		</>
	);
}

// ── Developers tab ───────────────────────────────────────────────────────

function DevelopersTab({
	state,
	onCopy,
}: {
	state: ConnectStateView;
	onCopy: (text: string, what?: string) => void;
}) {
	const base = state.local.restBase;
	const curl = `curl -s ${base}/v1/call -H 'content-type: application/json' \\\n  -d '{"name":"get_timeline","arguments":{}}'`;
	const python = `import json, requests
from openai import OpenAI

RENDR = "${base}"
tools = requests.get(f"{RENDR}/v1/tools?format=openai").json()
client = OpenAI()
messages = [{"role": "user", "content": "Add a title card that says Hello"}]
while True:
    reply = client.chat.completions.create(model="gpt-5-mini", messages=messages, tools=tools).choices[0].message
    messages.append(reply)
    if not reply.tool_calls:
        print(reply.content); break
    for call in reply.tool_calls:
        result = requests.post(f"{RENDR}/v1/call", json={"name": call.function.name,
                               "arguments": json.loads(call.function.arguments or "{}")}).json()
        messages.append({"role": "tool", "tool_call_id": call.id,
                         "content": "\\n".join(b.get("text", "") for b in result["content"])})`;
	return (
		<>
			<p className="pmr-sheet__note">
				Every tool is also plain HTTP, so it works with any model and framework: OpenAI or
				Anthropic function calling, Gemini, LangChain, LlamaIndex, the Vercel AI SDK, n8n,
				Zapier, or curl.
			</p>
			<CopyField label="MCP" value={state.local.mcpUrl} onCopy={onCopy} />
			<CopyField label="Call a tool" value={`${base}/v1/call`} onCopy={onCopy} />
			<CopyField label="OpenAPI" value={state.local.openApiUrl} onCopy={onCopy} />
			<CopyField label="Manual" value={state.local.llmsUrl} onCopy={onCopy} />
			<div className="pmr-connect__group">
				<span className="pmr-connect__group-title">Tool schemas</span>
				<div className="pmr-connect__chips">
					{(["openai", "openai-responses", "anthropic", "gemini", "mcp"] as const).map(
						(format) => (
							<button
								key={format}
								type="button"
								className="pmr-action"
								onClick={() =>
									onCopy(
										`${state.local.toolsUrl}?format=${format}`,
										`${format} schema URL copied`,
									)
								}
							>
								{format}
							</button>
						),
					)}
				</div>
			</div>
			<div className="pmr-connect__group">
				<span className="pmr-connect__group-title">stdio MCP command</span>
				<pre className="pmr-connect__snippet">{stdioLine(state.local.stdio)}</pre>
			</div>
			<div className="pmr-connect__group">
				<span className="pmr-connect__group-title">curl</span>
				<pre className="pmr-connect__snippet">{curl}</pre>
			</div>
			<div className="pmr-connect__group">
				<span className="pmr-connect__group-title">
					Any OpenAI-compatible model, in 15 lines
				</span>
				<pre className="pmr-connect__snippet">{python}</pre>
				<button
					type="button"
					className="pmr-action"
					style={{ alignSelf: "flex-start" }}
					onClick={() => onCopy(python, "Example copied")}
				>
					Copy example
				</button>
			</div>
			<div className="pmr-connect__group">
				<span className="pmr-connect__group-title">The rendr command</span>
				<pre className="pmr-connect__snippet">{`rendr status
rendr tools --format openai
rendr call add_title '{"text":"Hello"}'
RENDR_URL=<remote base> RENDR_TOKEN=<token> rendr call get_timeline`}</pre>
			</div>
		</>
	);
}

// ── Sheet ────────────────────────────────────────────────────────────────

export function ConnectSheet({
	initialTab = "agent",
	agent,
	toast,
	onClose,
}: {
	initialTab?: ConnectTab;
	agent: AgentControls;
	toast: (message: string, tone?: "error") => void;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<ConnectTab>(initialTab);
	const [state, setState] = useState<ConnectStateView | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const copy = useCopy(toast);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		const bridge = window.electronAPI;
		if (!bridge?.connectState) return;
		void bridge
			.connectState()
			.then(setState)
			.catch(() => undefined);
		return bridge.onConnectChanged?.((next) => setState(next as ConnectStateView));
	}, []);

	const install = async (id: string) => {
		const bridge = window.electronAPI;
		if (!bridge?.connectInstall) return;
		setBusy(id);
		try {
			const result = await bridge.connectInstall(id);
			setState(result.state);
			const label = result.state.clients.find((client) => client.id === id)?.label ?? id;
			if (result.ok) toast(`${label} is connected to Rendr`);
			else toast(result.error ?? `Couldn't connect ${label}`, "error");
		} finally {
			setBusy(null);
		}
	};

	const installCli = async () => {
		const bridge = window.electronAPI;
		if (!bridge?.connectInstallCli) return;
		setBusy("cli");
		try {
			const result = await bridge.connectInstallCli();
			setState(result.state);
			if (result.ok) toast(`Installed rendr at ${result.state.cli.path}`);
			else toast(result.error ?? "Couldn't install the rendr command", "error");
		} finally {
			setBusy(null);
		}
	};

	const desktop = Boolean(window.electronAPI?.connectState);

	return (
		<div
			className="pmr-sheet__scrim"
			role="dialog"
			aria-modal="true"
			aria-label="Rendr Connect"
		>
			<div className="pmr-sheet pmr-sheet--wide pmr-connect">
				<div className="pmr-sheet__head">
					<span className="pmr-sheet__title">Rendr Connect</span>
					<button type="button" className="pmr-btn" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</div>
				<div className="pmr-connect__tabs">
					<Segmented ariaLabel="Section" options={TABS} value={tab} onChange={setTab} />
				</div>
				<div className="pmr-sheet__body">
					{!desktop ? (
						<p className="pmr-sheet__note">Rendr Connect runs in the desktop app.</p>
					) : tab === "agent" ? (
						<AgentTab agent={agent} />
					) : !state ? (
						<p className="pmr-sheet__note">Loading…</p>
					) : tab === "apps" ? (
						<AppsTab
							state={state}
							onInstall={(id) => void install(id)}
							onInstallCli={() => void installCli()}
							onCopy={copy}
							busy={busy}
						/>
					) : tab === "cloud" ? (
						<CloudTab
							state={state}
							onCopy={copy}
							onStart={(mode, origin) =>
								void window.electronAPI
									?.connectRemoteStart({ mode, origin })
									.then(setState)
							}
							onStop={() =>
								void window.electronAPI?.connectRemoteStop().then(setState)
							}
							onRotate={() =>
								void window.electronAPI?.connectRotateToken().then(setState)
							}
						/>
					) : (
						<DevelopersTab state={state} onCopy={copy} />
					)}
				</div>
			</div>
		</div>
	);
}
