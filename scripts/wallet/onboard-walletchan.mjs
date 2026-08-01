import { chromium } from "playwright";
const EXT = "/private/tmp/claude-501/-Volumes-Extreme-SSD-Projects-rendr-claude/7f4e24d8-5734-4fec-bad4-fdc3ddc85911/scratchpad/walletchan";
const S = "/private/tmp/claude-501/-Volumes-Extreme-SSD-Projects-rendr-claude/7f4e24d8-5734-4fec-bad4-fdc3ddc85911/scratchpad";
const PASS = "DemoOnly!Sepolia7";

const ctx = await chromium.launchPersistentContext("./.wallet-profile", {
  headless: false, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const id = new URL(sw.url()).host;
console.log("EXT_ID=" + id);
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/onboarding.html`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

const dump = async (tag) => {
  const t = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n").slice(0, 500));
  const c = await page.evaluate(() =>
    [...document.querySelectorAll("button,[role=button],input,textarea")]
      .map((n, i) => `${i} ${n.tagName.toLowerCase()}${n.type ? "[" + n.type + "]" : ""}: ${(n.innerText || n.placeholder || n.getAttribute("aria-label") || "").trim().replace(/\n/g, " | ").slice(0, 60)}`)
      .filter((s) => s.split(": ")[1]).slice(0, 20));
  console.log(`\n===== ${tag} =====\n${t}\n--- controls ---\n${c.join("\n")}`);
  await page.screenshot({ path: `${S}/ob_${tag.replace(/\W/g, "")}.png` });
};

// Consent boxes gate every Continue in this wizard. Ticking them is the
// caller acknowledging a throwaway key it generated itself — there is nothing
// to save, because the profile is disposable and testnet-only.
const tickAll = async () => {
	const boxes = page.locator('input[type=checkbox]');
	for (let i = 0; i < (await boxes.count()); i++) {
		await boxes.nth(i).check({ force: true }).catch(() => {});
	}
	// Chakra renders a real input behind a styled span, so a label click is the
	// reliable path when the input itself is not hittable.
	const labels = page.locator('label:has(input[type=checkbox])');
	for (let i = 0; i < (await labels.count()); i++) {
		const input = labels.nth(i).locator('input[type=checkbox]');
		if (!(await input.isChecked().catch(() => true)))
			await labels.nth(i).click({ force: true }).catch(() => {});
	}
	await page.waitForTimeout(400);
};

const clickText = async (re) => {
  const n = page.locator("button, [role=button]").filter({ hasText: re }).first();
  await n.waitFor({ state: "visible", timeout: 15000 });
  await n.click();
  await page.waitForTimeout(1400);
};

await clickText(/Private key/i);
await clickText(/^Continue$/i);
await dump("step2");

// "Generate new" is a tab beside "Import existing". Generating means no key
// is ever typed, pasted, or stored anywhere outside this throwaway profile.
await clickText(/^Generate new$/i);
await page.waitForTimeout(2000);
const name = page.locator('input[placeholder*="Trading" i], input[placeholder*="name" i]').first();
if (await name.count()) await name.fill("Demo account");
await dump("generated");

await tickAll();
await clickText(/^Continue$/i);
await page.waitForTimeout(2200);
await dump("step3");

// Password step: fill every password field with the same value.
const pw = page.locator('input[type=password]');
const n = await pw.count();
console.log("password fields:", n);
for (let i = 0; i < n; i++) await pw.nth(i).fill(PASS);
if (n) {
	await page.waitForTimeout(700);
	// Any "I understand" style checkbox has to be ticked before Continue enables.
	await tickAll();
	await dump("filled");
	const done = page.locator("button, [role=button]")
		.filter({ hasText: /create wallet|^continue$|^finish$|^done$|get started/i }).first();
	if ((await done.count()) && (await done.isEnabled())) {
		await done.click();
		await page.waitForTimeout(3000);
		await dump("done");
	}
}
await ctx.close();
