// Record a demo in a headless browser, with no physical mouse involved.
//
// The problem this solves: Rendr cuts its zooms from cursor telemetry, and
// telemetry normally only exists because a native capture watched the OS
// pointer. Driving a real pointer means taking over the machine, which is
// exactly what somebody recording a hackathon demo at 2am does not want.
//
// But a script that drives a browser knows something a screen recorder never
// does: where it is about to click, before it clicks. So the pointer path is
// *authored* rather than observed — eased between targets, sampled densely
// enough for the dwell detector, and handed to Rendr through import_telemetry.
// Rendr then draws its own cursor over the video. The result is better than a
// real recording: the movement is smooth by construction, nothing shakes, and
// no personal desktop is in frame.
//
//   node scripts/record-demo.mjs storyboard.json outdir
//
// Writes outdir/demo.webm, outdir/telemetry.json and outdir/script.json.

import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "playwright";

/** Sampling interval for the pointer path, in ms. */
const SAMPLE_MS = 40;

/**
 * Rendr only treats a rest as a zoom candidate when it lasts between 450 and
 * 2600 ms (MIN/MAX_DWELL_DURATION_MS). Longer than that is not "a longer zoom",
 * it is *no zoom at all* — the run is discarded. So a long pause is broken into
 * several rests, separated by a nudge big enough to end the run
 * (DWELL_MOVE_THRESHOLD is 0.02 of the frame). Two zooms beat none, and this is
 * the whole reason the first headless take came back with zero punch-ins.
 */
const MAX_REST_MS = 2200;
const NUDGE_FRACTION = 0.035;

/**
 * How long a line takes to say, so a beat can be held for at least that long.
 *
 * Without this the picture cuts to the next beat while the previous line is
 * still being spoken. Rendr pins each line to the frame its beat began, so the
 * lines then overlap: the narration track stacks, and the caption clips stack
 * with it, and the lower one of each pair never renders. Measured against
 * Kokoro at speed 1 across the lines in this repo's demos — 15 words came back
 * at 5.6 s, 17 at 6.1 s — which is a shade under 2.7 words per second. The
 * rate is deliberately conservative, and the tail is breathing room so two
 * lines never butt up against each other exactly.
 */
const WORDS_PER_SECOND = 2.5;
const LINE_TAIL_MS = 700;

function speechMs(text) {
	const words = String(text ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;
	return words === 0 ? 0 : (words / WORDS_PER_SECOND) * 1000 + LINE_TAIL_MS;
}

/**
 * Ease-in-out. A linear glide reads as mechanical, and — more importantly —
 * the dwell detector keys on the pointer slowing down, so a move that stops
 * abruptly is less likely to register as arriving somewhere.
 */
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

class Recorder {
	constructor(page, size) {
		this.page = page;
		this.size = size;
		this.points = [];
		this.beats = [];
		/** When each wallet approval happened, for timing the inset. */
		this.marks = [];
		this.wallet = null;
		// Upper-middle of the content. The old default was the bottom edge,
		// which put every telemetry sample at cy ~0.95 — so every zoom focused
		// on the bottom of the frame and read as "it only zooms to the centre".
		this.at = { x: size.width * 0.5, y: size.height * 0.42 };
		this.t0 = Date.now();
	}

	get now() {
		return Date.now() - this.t0;
	}

	/** One telemetry sample, normalized to the frame. */
	mark(x, y, interactionType = "move") {
		this.points.push({
			timeMs: this.now,
			cx: Math.min(1, Math.max(0, x / this.size.width)),
			cy: Math.min(1, Math.max(0, y / this.size.height)),
			interactionType,
		});
	}

	/**
	 * Holds still, still sampling.
	 *
	 * The samples matter: a rest is only detectable as a rest if there are
	 * points during it. A gap in the path reads as a teleport instead, and
	 * teleports produce no zooms.
	 */
	async dwell(ms) {
		let left = ms;
		let flip = 1;
		while (left > 0) {
			const chunk = Math.min(left, MAX_REST_MS);
			const until = Date.now() + chunk;
			while (Date.now() < until) {
				this.mark(this.at.x, this.at.y);
				await this.page.waitForTimeout(SAMPLE_MS);
			}
			left -= chunk;
			if (left <= 0) break;
			// End the run so the next stretch counts as its own rest. The nudge
			// has to clear DWELL_MOVE_THRESHOLD or the detector sees one long
			// rest and throws all of it away.
			const step = this.size.width * NUDGE_FRACTION * flip;
			const nx = Math.min(this.size.width - 4, Math.max(4, this.at.x + step));
			this.mark(nx, this.at.y);
			await this.page.mouse.move(nx, this.at.y);
			await this.page.waitForTimeout(SAMPLE_MS);
			this.at = { x: nx, y: this.at.y };
			flip *= -1;
		}
	}

	/** Glides to a point, sampling the whole way. */
	async glideTo(x, y, ms = 700) {
		const from = { ...this.at };
		const steps = Math.max(2, Math.round(ms / SAMPLE_MS));
		for (let i = 1; i <= steps; i++) {
			const k = ease(i / steps);
			const nx = from.x + (x - from.x) * k;
			const ny = from.y + (y - from.y) * k;
			this.mark(nx, ny);
			// The real Playwright pointer follows the same path, so hover states
			// and anything watching mousemove behave as they would for a person.
			await this.page.mouse.move(nx, ny);
			await this.page.waitForTimeout(SAMPLE_MS);
		}
		this.at = { x, y };
	}

	/** Centre of a selector, or null when it isn't on screen. */
	async centreOf(selector) {
		const handle = this.page.locator(selector).first();
		try {
			await handle.waitFor({ state: "visible", timeout: 8000 });
		} catch {
			return null;
		}
		const box = await handle.boundingBox();
		if (!box) return null;
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}
}

/**
 * Something worth pointing at, near the middle of what is currently on screen.
 *
 * This is what makes a zoom land somewhere meaningful without the storyboard
 * having to name a selector for every beat. A demo that scrolls and talks has
 * no click to key on, so without this the pointer never moves, every dwell
 * shares one focus point, and all the punch-ins land on the same spot.
 *
 * Headings and links are preferred because they are what a viewer's eye goes to
 * anyway, and the one closest to the centre of the viewport is the one the
 * scroll just brought into view.
 */
async function somethingToLookAt(rec, avoid) {
	const found = await rec.page.evaluate(
		({ avoidX, avoidY }) => {
			const wanted = "h1, h2, h3, article a, main a, [role=heading], button, td a, li a";
			const midY = window.innerHeight / 2;
			const seen = [];
			for (const node of document.querySelectorAll(wanted)) {
				const box = node.getBoundingClientRect();
				if (box.width < 40 || box.height < 12) continue;
				if (box.top < 60 || box.bottom > window.innerHeight - 40) continue;
				const x = box.left + box.width / 2;
				const y = box.top + box.height / 2;
				// Not the thing we are already on, or the zoom does not move.
				if (Math.abs(x - avoidX) < 60 && Math.abs(y - avoidY) < 40) continue;
				seen.push({ x, y, score: Math.abs(y - midY) });
			}
			seen.sort((a, b) => a.score - b.score);
			return seen[0] ? { x: seen[0].x, y: seen[0].y } : null;
		},
		{ avoidX: avoid.x, avoidY: avoid.y },
	);
	return found;
}

async function runStep(rec, step) {
	const page = rec.page;

	if (step.goto) {
		await page.goto(step.goto, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(step.settle ?? 1200);
		return;
	}
	if (step.wait) {
		await rec.dwell(step.wait);
		return;
	}
	if (step.scroll) {
		// Scrolled in small steps so the page moves smoothly rather than
		// jumping — a jump cut in the middle of a shot reads as a glitch.
		const total = step.scroll;
		const steps = Math.max(1, Math.round(Math.abs(total) / 40));
		for (let i = 0; i < steps; i++) {
			await page.mouse.wheel(0, total / steps);
			rec.mark(rec.at.x, rec.at.y);
			await page.waitForTimeout(SAMPLE_MS);
		}
		// Follow the content that just arrived, so the rest after a scroll has
		// somewhere real to be rather than wherever the last beat abandoned it.
		if (step.follow !== false) {
			const target = await somethingToLookAt(rec, rec.at);
			if (target) await rec.glideTo(target.x, target.y, 520);
		}
		return;
	}
	if (step.type) {
		// Per-character delay so typing is legible on screen; instant text
		// appears as a single frame change and reads as a cut.
		await page.keyboard.type(step.type, { delay: step.delay ?? 55 });
		const until = Date.now() + 200;
		while (Date.now() < until) {
			rec.mark(rec.at.x, rec.at.y);
			await page.waitForTimeout(SAMPLE_MS);
		}
		return;
	}
	if (step.press) {
		await page.keyboard.press(step.press);
		await rec.dwell(step.settle ?? 900);
		return;
	}

	if (step.approve) {
		if (!rec.wallet) {
			console.warn("  ! approve step but no wallet configured, skipped");
			return;
		}
		// Walk the pointer toward where the inset will sit before approving, so
		// the finished cut reads as one continuous movement into the wallet
		// rather than a cut to a panel that appeared from nowhere.
		await rec.glideTo(rec.size.width * 0.78, rec.size.height * 0.46, 700);
		await rec.dwell(900);
		rec.marks.push({ kind: step.approve, atMs: rec.now });
		const clicked = await approve(
			rec.wallet,
			step.pattern ? new RegExp(step.pattern, "i") : undefined,
		);
		if (clicked) console.log(`  approved ${step.approve} — clicked "${clicked}"`);
		await rec.page.bringToFront();
		await rec.dwell(step.after ?? 1500);
		return;
	}

	const selector = step.move ?? step.click;
	if (!selector) return;
	const target = await rec.centreOf(selector);
	if (!target) {
		console.warn(`  ! not visible, skipped: ${selector}`);
		return;
	}
	await rec.glideTo(target.x, target.y, step.travel ?? 700);
	// A beat of stillness before the click. This is what makes the zoom land
	// on the thing rather than on the pointer sweeping past it.
	await rec.dwell(step.settle ?? 600);
	if (step.click) {
		rec.mark(target.x, target.y, "click");
		await rec.page.mouse.click(target.x, target.y);
		await rec.dwell(step.after ?? 1400);
	} else {
		await rec.dwell(step.hold ?? 1200);
	}
}

/**
 * The wallet's own UI, opened as an ordinary page.
 *
 * WalletChan declares side_panel.default_path as index.html, so the panel is a
 * normal extension page rather than browser chrome — which means Playwright can
 * drive it, and, because recordVideo writes one file per page, it records to
 * its own track. That track becomes a picture-in-picture inset at build time,
 * which is a better shot than a screen capture of a real side panel could be.
 */
async function openWallet(ctx, id, password) {
	const page = await ctx.newPage();
	await page.goto(`chrome-extension://${id}/index.html`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2500);
	const field = page.locator("input[type=password]").first();
	if (password && (await field.count())) {
		await field.fill(password);
		const go = page.locator("button").filter({ hasText: /unlock|continue|open/i }).first();
		if (await go.count()) await go.click();
		await page.waitForTimeout(2500);
	}
	return page;
}

/**
 * Approves whatever the wallet is currently asking about.
 *
 * Matched against the button's whole text and anchored, so "Sign" is found and
 * "Signing with" is not — an unanchored substring match picks up labels around
 * the control and clicks the wrong thing. Reject is excluded explicitly rather
 * than relying on the pattern to miss it, because clicking it is the one
 * outcome that silently ruins a take.
 */
async function approve(wallet, pattern) {
	await wallet.bringToFront();
	await wallet.waitForTimeout(900);
	const want = pattern ?? /^(connect|approve|confirm|sign)$/i;
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const buttons = wallet.locator("button");
		const count = await buttons.count();
		for (let i = 0; i < count; i++) {
			const button = buttons.nth(i);
			const label = ((await button.innerText().catch(() => "")) || "").trim();
			if (!label || /reject|cancel|deny|close/i.test(label)) continue;
			if (!want.test(label)) continue;
			if (!(await button.isVisible().catch(() => false))) continue;
			if (!(await button.isEnabled().catch(() => false))) continue;
			await button.scrollIntoViewIfNeeded().catch(() => {});
			await button.click();
			await wallet.waitForTimeout(1600);
			return label;
		}
		await wallet.waitForTimeout(500);
	}
	// Say what was actually on screen; a silent miss here is the difference
	// between a demo that signs and one that just sits there.
	const seen = await wallet
		.evaluate(() =>
			[...document.querySelectorAll("button")]
				.map((n) => n.innerText.trim().replace(/\s+/g, " "))
				.filter(Boolean)
				.slice(0, 10),
		)
		.catch(() => []);
	console.warn(`  ! no approve button matched ${want}. On screen: ${seen.join(" / ") || "nothing"}`);
	return null;
}

async function main() {
	const [storyboardPath, outDir = "demo-out"] = process.argv.slice(2);
	if (!storyboardPath) {
		console.error("usage: node scripts/record-demo.mjs <storyboard.json> [outdir]");
		process.exit(1);
	}
	const board = JSON.parse(await readFile(storyboardPath, "utf-8"));
	const size = { width: board.width ?? 1280, height: board.height ?? 720 };
	await mkdir(outDir, { recursive: true });

	const wallet = board.wallet ?? null;
	let runProfile = null;
	let browser = null;
	let context;
	let extensionId = null;

	if (wallet) {
		// Each run starts from a pristine copy of the onboarded profile. Reusing
		// the profile in place means the dApp is already an approved site by the
		// second run, so the connect prompt never appears and the demo silently
		// loses the step it exists to show — and any request left pending from a
		// previous take is still sitting there waiting to be mis-clicked.
		const template = wallet.profile ?? "./.wallet-profile";
		runProfile = join(outDir, "profile");
		await rm(runProfile, { recursive: true, force: true });
		await cp(template, runProfile, { recursive: true });
	}

	if (wallet) {
		// Extensions need a persistent context and a real browser window; the
		// window is Playwright's own, not the user's screen, so this still does
		// not take over the machine.
		context = await chromium.launchPersistentContext(runProfile, {
			headless: false,
			viewport: size,
			deviceScaleFactor: board.deviceScaleFactor ?? 2,
			recordVideo: { dir: outDir, size },
			colorScheme: board.colorScheme ?? "dark",
			args: [
				`--disable-extensions-except=${wallet.extension}`,
				`--load-extension=${wallet.extension}`,
			],
		});
		const worker =
			context.serviceWorkers()[0] ??
			(await context.waitForEvent("serviceworker", { timeout: 20000 }));
		// No manifest key, so the unpacked id is derived from the path and has
		// to be read at runtime rather than written down.
		extensionId = new URL(worker.url()).host;
		console.log(`wallet extension ${extensionId}`);
	} else {
		browser = await chromium.launch({ headless: board.headless !== false });
		context = await browser.newContext({
		viewport: size,
		deviceScaleFactor: board.deviceScaleFactor ?? 2,
		recordVideo: { dir: outDir, size },
		// Dark by default. Captions are white, and a light page is exactly what a
		// repo or a docs site is — the first headless take came back with
		// subtitles that were technically present and completely unreadable.
		// build-demo.mjs also picks a caption colour from the footage, but
		// starting dark means the two never have to disagree.
		colorScheme: board.colorScheme ?? "dark",
		// A fresh context every run: no profile, no history, no autocomplete —
		// so nothing personal can end up in frame.
		storageState: undefined,
		});
	}

	const page = await context.newPage();
	const walletPage = wallet
		? await openWallet(context, extensionId, process.env[wallet.passwordEnv ?? "WALLETCHAN_PASSWORD"])
		: null;
	if (walletPage) await page.bringToFront();

	// Video encoding begins with the context, so the clock starts here and the
	// first beat is deliberately given a moment to settle.
	const rec = new Recorder(page, size);
	rec.wallet = walletPage;

	if (board.url) {
		await page.goto(board.url, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(board.settle ?? 1800);
	}

	for (const [index, beat] of (board.beats ?? []).entries()) {
		const startMs = rec.now;
		const needed = speechMs(beat.say);
		console.log(
			`beat ${index + 1}/${board.beats.length}  (${(needed / 1000).toFixed(1)}s)  ${beat.say ?? ""}`,
		);
		for (const step of beat.do ?? []) await runStep(rec, step);

		// The beat has to last at least as long as its line takes to say. If the
		// actions finished sooner, hold — otherwise the next beat starts while
		// this line is still speaking, and both the narration and the captions
		// end up stacked on top of each other.
		//
		// The hold is spent looking at things rather than sitting still. A beat
		// that only pauses would otherwise leave the pointer exactly where the
		// last one left it, and every zoom in the video would share one focus
		// point — which is precisely how "it only zooms to the centre" happens.
		let short = needed - (rec.now - startMs);
		while (short > 0) {
			const target = beat.stay === true ? null : await somethingToLookAt(rec, rec.at);
			if (!target) {
				await rec.dwell(short);
				break;
			}
			const before = rec.now;
			await rec.glideTo(target.x, target.y, 600);
			// Rest long enough to register, but inside the 2600 ms ceiling.
			await rec.dwell(Math.min(1900, Math.max(600, short - (rec.now - before))));
			short = needed - (rec.now - startMs);
		}
		rec.beats.push({
			index,
			startMs,
			endMs: rec.now,
			say: beat.say ?? "",
			heldForSpeech: short > 0 ? Math.round(short) : 0,
		});
	}

	await rec.dwell(board.tail ?? 1200);
	const totalMs = rec.now;

	// Grab the handles before closing: the files are only finalised on close,
	// but the handle has to be taken while the page still exists.
	const pageVideo = page.video();
	const walletVideo = walletPage?.video() ?? null;
	await context.close();
	if (browser) await browser.close();

	// Playwright names the video after the page's guid, so find and rename it.
	// Ask each Page for its own video rather than guessing from the directory:
	// a persistent context has other pages in it (about:blank, the profile's
	// initial tab) and every one of them writes a .webm.
	const take = async (video, to) => {
		if (!video) return false;
		try {
			const from = await video.path();
			await rename(from, join(outDir, to));
			return true;
		} catch (error) {
			console.warn(`  ! could not save ${to}: ${error.message}`);
			return false;
		}
	};
	await take(pageVideo, "demo.webm");
	const hasWallet = await take(walletVideo, "wallet.webm");

	await writeFile(join(outDir, "telemetry.json"), JSON.stringify(rec.points));
	await writeFile(
		join(outDir, "script.json"),
		JSON.stringify(
			{ fps: board.fps ?? 30, totalMs, beats: rec.beats, marks: rec.marks, wallet: Boolean(wallet) },
			null,
			2,
		),
	);

	console.log(`\nvideo      ${join(outDir, "demo.webm")}${hasWallet ? " + wallet.webm" : ""}`);
	console.log(`telemetry  ${rec.points.length} points over ${(totalMs / 1000).toFixed(1)}s`);
	console.log(`clicks     ${rec.points.filter((p) => p.interactionType === "click").length}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
