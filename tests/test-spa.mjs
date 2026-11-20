// In-page navigation: switching pages must NOT reload the document (so the Python worker survives).
// A marker on `window` proves no full page load happened; a marker that vanished => a reload.

import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.STATIC_BASE ?? "http://localhost:8765/boxes-static";
// subpath prefix ("" when served at the root): path() strips it so the assertions
// below can keep comparing bare paths like "/ClosedBox/"
const PREFIX = new URL(BASE).pathname.replace(/\/$/, "");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

let failed = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "[ok]  " : "[FAIL]"} ${msg}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
// Expected 404s only: the deliberate unknown-page test, and sample images that upstream itself does not
// ship (the generator page's own onerror handler shows "There is no image yet"). Anything else is an error.
const sampleDir = new URL("../site/static/samples/", import.meta.url);
const expected404 = (url) => {
  const u = new URL(url);
  if (u.pathname === `${PREFIX}/Nope` || u.pathname === `${PREFIX}/Nope/index.html`) return true;
  const m = new RegExp(`^${PREFIX}/static/samples/([^/]+\\.jpg)$`).exec(u.pathname);
  return !!m && !existsSync(new URL(m[1], sampleDir));
};
page.on("response", (r) => r.status() >= 400 && !(r.status() === 404 && expected404(r.url())) && errors.push(`HTTP ${r.status()} ${r.url()}`));

const path = () => {
  const p = new URL(page.url()).pathname;
  return p.startsWith(PREFIX) ? p.slice(PREFIX.length) : p;
};
const sameDoc = () => page.evaluate(() => window.__marker === "same-document");
const previewBlob = () => page.waitForFunction(() => {
  const i = document.getElementById("preview_img");
  return i && i.complete && i.naturalWidth > 1 && i.src.startsWith("blob:");
}, null, { timeout: 120_000 });
const previewText = () => page.evaluate(() => fetch(document.getElementById("preview_img").src).then((r) => r.text()));
const click = (name) => page.click(`#search_id_${name} a`);   // gallery link

// ---- 1. Gallery -> generator, same document, cold start
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "same-document"; });
let t = Date.now();
await click("ClosedBox");
await page.waitForSelector("#arguments");
check(path() === "/ClosedBox/" && (await sameDoc()), "Gallery -> ClosedBox: URL changed, document NOT reloaded", path());
check((await page.title()) === "ClosedBox - Boxes", "document title updated", await page.title());
await previewBlob();
console.log(`       (cold: ${((Date.now() - t) / 1000).toFixed(1)} s from click to first preview, includes Python boot)`);

// ---- 2. back to the gallery
await page.goBack();
await page.waitForSelector("#search_id_ClosedBox");
check(path() === "/" && (await sameDoc()) && (await page.locator("#arguments").count()) === 0, "Back: gallery restored, still same document");

// ---- 3. THE POINT: switching generator with a warm worker
t = Date.now();
await click("BasedBox");
await page.waitForSelector("#arguments");
await previewBlob();
const warm = (Date.now() - t) / 1000;
check(warm < 1.5, `switching generator is fast with a warm worker`, `${warm.toFixed(2)} s click -> preview (was 3.6 s with a page reload)`);
check(/boxes BasedBox/.test(await previewText()), "preview shows the NEW generator (BasedBox), not a stale one");
check(await sameDoc(), "still the same document");

// ---- 4. back + forward
await page.goBack();
await page.waitForSelector("#search_id_ClosedBox");
await page.goForward();
await page.waitForSelector("#arguments");
await previewBlob();
check(path() === "/BasedBox/" && /boxes BasedBox/.test(await previewText()) && (await sameDoc()), "Forward: BasedBox restored and re-rendered");

// ---- 5. logo link on a generator page -> gallery
await page.click('a[href="./"]');
await page.waitForSelector("#search_id_ClosedBox");
check(path() === "/" && (await sameDoc()), "logo link goes back to the gallery in-page");

// ---- 6. gallery -> menu, upstream's init re-ran (collapsible sections work)
await page.click('a[href="Menu"] .modebutton');
await page.waitForSelector(".menu");
check(path() === "/Menu/" && (await sameDoc()), "Gallery -> Menu in-page", path());
const h3 = page.locator("h3.toggle").first();
const before = await h3.getAttribute("aria-expanded");
await h3.click();
const after = await h3.getAttribute("aria-expanded");
check(before !== after, "Menu: collapsible section reacts (upstream initPage re-ran after the swap)", `${before} -> ${after}`);

// ---- 7. layout pages reached via in-page navigation (self.js's DOMContentLoaded hook never runs for them)
await page.click('a[href="Gallery"] .modebutton');
await page.waitForSelector("#search_id_TrayLayout");
check(path() === "/Gallery/" && (await sameDoc()), "Menu -> Gallery in-page", path());
for (const name of ["TrayLayout", "GridfinityTrayLayout"]) {
  await click(name);
  await page.waitForSelector("#layout");
  const got = await page.evaluate(() => ({ rows: document.getElementById("layout").rows, cols: document.getElementById("layout").cols }));
  check(got.rows === 20 && got.cols === 24, `${name} via in-page nav: layout init ran`, JSON.stringify(got));
  await page.goBack();
  await page.waitForSelector("#search_id_TrayLayout");
}
await click("PhotoFrame");
await page.waitForSelector("#matting_w");
check(await page.evaluate(() => "photoFrameUserMattingW" in window), "PhotoFrame via in-page nav: PhotoFrameInit ran");
await page.goBack();
await page.waitForSelector("#search_id_TrayLayout");
check(await sameDoc(), "document survived all of the above (never reloaded)");

// ---- 8. race: leave a page while its preview is still rendering -> that preview must not land on the next page
await click("Planetary2");                       // one of the slowest generators
await page.waitForSelector("#arguments");        // swapped; its preview request is now in flight
await page.goBack();
await page.waitForSelector("#search_id_AngledBox");
await click("AngledBox");
await page.waitForSelector("#arguments");
await previewBlob();
await page.waitForTimeout(3000);                 // give a stale Planetary2 result time to (wrongly) arrive
const txt = await previewText();
check(/boxes AngledBox/.test(txt) && !/boxes Planetary2/.test(txt), "stale preview from the page we left never replaces the current one");

// ---- 9. Save to URL + in-page navigation: prefill works on a swapped-in page
await page.fill("#x", "123");
await page.click('button[name="render"][value="0"]');
check(path() === "/AngledBox/" && page.url().includes("x=123"), "Save to URL on a swapped-in page", page.url().split("?")[1]?.slice(0, 40));
await page.goBack();
await page.waitForSelector("#search_id_AngledBox");
await page.goForward();            // history entry for /AngledBox/ (after replaceState it carries the query)
await page.waitForSelector("#arguments");
check((await page.inputValue("#x")) === "123", "history entry with query pre-fills the form (x=123)");

// ---- 10. things that must NOT be intercepted
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "same-document"; });
await page.click("#search_id_ClosedBox a", { modifiers: ["Control"] }).catch(() => {});
await page.waitForTimeout(500);
check(path() === "/" && (await page.locator("#arguments").count()) === 0 && (await sameDoc()), "Ctrl+click is left to the browser (current page unchanged)");
// a window-level listener runs after the shim's document-level one (bubbling), so it can see
// whether the shim called preventDefault(); it then cancels the click so we do not leave the site
const extPrevented = await page.evaluate(() => new Promise((resolve) => {
  window.addEventListener("click", (ev) => { resolve(ev.defaultPrevented); ev.preventDefault(); }, { once: true });
  document.querySelector('a[href^="https://"]').click();
}));
check(extPrevented === false, "external link click is not intercepted by the shim");

// ---- 11. fallback: a link to a page that does not exist -> normal navigation (browser's own 404)
await page.evaluate(() => {
  const a = document.createElement("a"); a.href = "Nope"; a.id = "nope"; a.textContent = "nope"; document.body.prepend(a);
});
await page.click("#nope");
await page.waitForURL(/\/Nope/, { timeout: 10_000 });
check(true, "unknown page falls back to a normal page load", path());

// ---- 12. back restores the scroll position, like the original server
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "same-document"; });
await page.waitForFunction(() => [...document.images].every((i) => i.complete)); // full page height
const targetY = await page.evaluate(() => Math.floor(document.body.scrollHeight * 0.7));
await page.evaluate((y) => window.scrollTo(0, y), targetY);
// evaluate-click: a Playwright click would auto-scroll the link into view first
await page.evaluate(() => document.querySelector("#search_id_ClosedBox a").click());
await page.waitForSelector("#arguments");
await page.goBack();
await page.waitForSelector("#search_id_ClosedBox");
// the restore retries while the swapped-in (cached) images settle the page height
const restored = await page.waitForFunction(
  (y) => Math.abs(window.scrollY - y) <= 50,
  targetY,
  { timeout: 5000 },
).then(() => true, () => false);
const backY = await page.evaluate(() => window.scrollY);
check(restored, "Back returns to the gallery at the previous scroll position", `scrolled to ${targetY}px, back at ${backY}px`);
check(await sameDoc(), "still the same document");

check(errors.length === 0, "no page errors or unexpected HTTP errors", errors.slice(0, 3).join(" | "));

await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nSPA TESTS PASSED");
process.exit(failed ? 1 : 0);
