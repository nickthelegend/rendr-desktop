// Turn a headless recording into a finished, narrated, subtitled video.
//
// Takes what record-demo.mjs produced and drives Rendr's own MCP server the
// way a person would drive the app: import the take, hand over the pointer
// path, cut zooms from it, pin the script to the timeline, speak it, export.
//
// Every step here is a public MCP tool. Nothing reaches inside the app, which
// is the point — if this can do it, so can any agent.
//
//   node scripts/build-demo.mjs demo-out [--export]

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MCP = process.env.RENDR_MCP ?? "http://127.0.0.1:19790/mcp";

let id = 0;
async function call(name, args = {}) {
	const response = await fetch(MCP, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++id,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	const payload = await response.json();
	const content = payload.result?.content ?? [];
	const text = content.find((part) => part.type === "text")?.text ?? "{}";
	const parsed = JSON.parse(text);
	if (payload.result?.isError) {
		throw new Error(`${name}: ${parsed.error ?? "failed"} — ${parsed.message ?? ""}`);
	}
	return parsed;
}

const say = (message) => console.log(message);

async function main() {
	const dir = resolve(process.argv[2] ?? "demo-out");
	const wantExport = process.argv.includes("--export");
	const script = JSON.parse(await readFile(join(dir, "script.json"), "utf-8"));
	const telemetry = JSON.parse(await readFile(join(dir, "telemetry.json"), "utf-8"));
	const fps = script.fps ?? 30;

	// A timeline of its own, so a rebuild never lands on top of earlier work.
	const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
	const timeline = await call("create_timeline", { name: `Demo ${stamp}` });
	say(`timeline   ${timeline.name}`);

	const asset = await call("import_media", { source: { path: join(dir, "demo.webm") } });
	say(`imported   ${asset.name} (${asset.durationSeconds}s)`);

	await call("add_clips", { entries: [{ mediaRef: asset.mediaRef, startFrame: 0 }] });
	const placed = await call("get_timeline", {});
	const clipId = placed.tracks.flatMap((track) => track.clips ?? []).find(Boolean)?.id;
	if (!clipId) throw new Error("The take did not land on the timeline.");

	// The wallet is its own recording, so it goes on as an inset over the take
	// rather than being cut to. Placed only around the approvals: an inset that
	// is on screen the whole time stops reading as "the wallet just opened".
	const marks = script.marks ?? [];
	if (script.wallet && marks.length) {
		const wallet = await call("import_media", { source: { path: join(dir, "wallet.webm") } });
		const insetTrack = await call("manage_tracks", { add: "video" });
		const index = (insetTrack.tracks ?? []).findIndex((t) => t.name === (insetTrack.added ?? ""));
		const trackIndex = index >= 0 ? index : 0;
		const placed = [];
		// Marks are on the shared clock; the wallet file began later than the
		// dApp file, so its own start has to come off before the mark means
		// anything as a position inside it.
		const walletOffsetMs = script.videoStartMs?.wallet ?? 0;
		const demoOffsetMs = script.videoStartMs?.demo ?? 0;
		for (const mark of marks) {
			// Where the inset sits on the timeline, and where to cut it from.
			// Starts at the mark, not before it: the mark is the moment the
			// wallet came to the front and began rendering the request, so
			// anything earlier is the frame it was frozen on.
			const onTimeline = Math.max(0, (mark.atMs - demoOffsetMs) / 1000 - 0.2);
			const inWallet = Math.max(0, (mark.atMs - walletOffsetMs) / 1000 - 0.2);
			const window = 5.6;
			const from = onTimeline;
			const to = onTimeline + window;
			// endFrame rather than `source`: source was silently ignored here and
			// the whole 54-second wallet recording landed as one clip playing
			// from its lock screen. Trim is set explicitly afterwards, which is
			// what actually moves the in-point.
			const startFrame = Math.round(from * fps);
			const entry = await call("add_clips", {
				entries: [
					{
						mediaRef: wallet.mediaRef,
						trackIndex,
						startFrame,
						endFrame: Math.round(to * fps),
					},
				],
			});
			if (entry.error) continue;
			const now = await call("get_timeline", {});
			const justAdded = (now.tracks[trackIndex]?.clips ?? []).find(
				(c) => c.frames?.[0] === startFrame,
			);
			if (justAdded) {
				await call("set_clip_properties", {
					clipIds: [justAdded.id],
					trimStartFrame: Math.round(inWallet * fps),
					durationFrames: Math.round(window * fps),
				});
			}
			placed.push({ kind: mark.kind, atSeconds: Number(from.toFixed(1)) });
		}
		// Inset on the right, where the pointer was steered before approving.
		const after = await call("get_timeline", {});
		const insetIds = (after.tracks[trackIndex]?.clips ?? []).map((c) => c.id);
		if (insetIds.length) {
			await call("set_clip_properties", {
				clipIds: insetIds,
				transform: { centerX: 0.775, centerY: 0.5, width: 0.4, height: 0.86 },
				edgeRounding: 0.06,
				fadeInFrames: 6,
				fadeOutFrames: 6,
			});
		}
		say(`wallet     ${placed.length} inset(s): ${placed.map((p) => `${p.kind}@${p.atSeconds}s`).join(", ")}`);
	}

	const imported = await call("import_telemetry", { points: telemetry });
	say(`pointer    ${imported.points} samples, ${imported.clicks} clicks`);
	for (const warning of imported.warnings ?? []) say(`  ! ${warning}`);

	// Zooms come from the path, exactly as they would from a native capture.
	const suggested = await call("suggest_zooms", {});
	const regions = (suggested.proposals ?? []).map(({ reason, ...region }) => region);
	if (regions.length) {
		await call("add_zoom_regions", { clipId, regions });
		const kinds = (suggested.proposals ?? []).map((p) => p.reason).join(", ");
		say(`zooms      ${regions.length} (${kinds})`);
	} else {
		say("zooms      none — the pointer never rested long enough");
	}

	// Comments live on the project, not the timeline, so an earlier demo's
	// script is still here and narrate_timeline would happily speak it over
	// this one. Clearing first is what keeps a rebuild reproducible.
	const existing = await call("manage_comments", { action: "list" });
	for (const comment of existing.comments ?? []) {
		await call("manage_comments", { action: "remove", commentId: comment.commentId });
	}
	if ((existing.comments ?? []).length) {
		say(`cleared    ${existing.comments.length} note(s) from an earlier run`);
	}

	// The narration script is the storyboard's own words, pinned to the frame
	// where that beat actually began during the run.
	const spoken = (script.beats ?? []).filter((beat) => beat.say?.trim());
	for (const beat of spoken) {
		await call("manage_comments", {
			action: "add",
			frame: Math.max(0, Math.round((beat.startMs / 1000) * fps)),
			text: beat.say.trim(),
		});
	}
	say(`script     ${spoken.length} lines pinned`);

	const voice = await call("setup_voice", {});
	if (!voice.installed) {
		say("voice      installing Kokoro (~92 MB, once)…");
		await call("setup_voice", { install: true });
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 5000));
			if ((await call("setup_voice", {})).installed) break;
		}
	}

	const narration = await call("narrate_timeline", {
		voice: process.env.RENDR_VOICE ?? "af_heart",
	});

	// Captions default to white, which is invisible over a light page — and a
	// light page is exactly what a docs site or a GitHub repo is. So measure the
	// footage and pick the colour that will actually be readable, rather than
	// hoping the demo happens to be dark.
	const measured = await call("inspect_color", { clipId });
	const luma = measured.scopes?.meanLuma ?? 0;
	const onLight = luma > 0.55;
	// A plate by default: white text on a dark scrim, with the spoken word lit.
	// Picking a caption colour from the footage's average brightness is a guess
	// that fails on any shot that is light in one half and dark in the other,
	// and it was already failing outright between preview and export. A plate
	// removes the question — the caption sits on its own background and does
	// not care what is behind it. RENDR_CAPTIONS picks another look.
	const styled = await call("style_captions", {
		preset: process.env.RENDR_CAPTIONS ?? "plate",
	});
	say(`captions   ${styled.preset ?? "custom"} (footage reads ${luma.toFixed(2)} luma)`);
	for (const warning of styled.warnings ?? []) say(`  ! ${warning}`);
	say(`narration  ${narration.spoken} lines, subtitles on the CC track`);
	for (const over of narration.overruns ?? []) {
		say(
			`  ! "${(over.text ?? "").slice(0, 48)}…" runs ${over.overrunSeconds}s past the next line`,
		);
	}

	const check = await call("check_timeline", { severity: "problems" });
	if (check.problems) {
		say(`review     ${check.problems} problem(s):`);
		for (const finding of check.findings.slice(0, 5)) say(`  - ${finding.message}`);
	} else {
		say("review     nothing that would spoil an export");
	}

	if (wantExport) {
		const job = await call("export_project", { mode: "video", resolution: "1080p" });
		say(`export     started — ${job.destination ?? job.status}`);
		say("           poll manage_exports for the file");
	} else {
		say("\nNot exported. Re-run with --export, or open Rendr and press Export.");
	}
}

main().catch((error) => {
	console.error(`\n${error.message}`);
	process.exit(1);
});
