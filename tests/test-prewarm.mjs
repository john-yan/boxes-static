// FR-13: Gallery/Menu pages start booting the Python worker in the background,
// so the first generator click gets a warm runtime instead of a ~10 s cold boot.
// The zip fetch is the last network step of the worker's init, so seeing it
// proves the boot started; waiting a bit past it means the boot is done.

import { chromium } from "playwright";

const BASE = process.env.STATIC_BASE ?? "http://localhost:8765/boxes-static";

let failed = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "[ok]  " : "[FAIL]"} ${msg}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

const browser = await chromium.launch();
const page = await browser.newPage();

// ---- 1. the Gallery load starts the Python boot, invisibly
// 60 s: on a live CDN the boot's downloads (Pyodide, wheels, PyPI) compete with
// the gallery's own 34 MB of sample images, so the zip request - the LAST
// network step of init - can arrive well after 15 s.
const zipSeen = page.waitForRequest((r) => r.url().includes("/py/boxes-src.zip"), { timeout: 60_000 });
await page.goto(`${BASE}/`);
let booted = true;
try {
  await zipSeen;
} catch {
  booted = false;
}
check(booted, "gallery load starts the Python worker boot (boxes-src.zip requested)");
if (!booted) {
  await browser.close();
  console.log("\n1 CHECK(S) FAILED");
  process.exit(1);
}
check((await page.locator("#boxes-status").count()) === 0,
  "pre-warm is invisible on the gallery (no status element added)");

// ---- 2. the first generator click is warm
// the zip fetch is the last network step; unpack + import of the boxes package
// follows. Cold boot is 10-14 s click-to-preview; warm must be well under that.
await page.waitForTimeout(5000);
const t = Date.now();
await page.click("#search_id_ClosedBox a");
await page.waitForSelector("#arguments");
await page.waitForFunction(() => {
  const i = document.getElementById("preview_img");
  return i && i.complete && i.naturalWidth > 1 && i.src.startsWith("blob:");
}, null, { timeout: 60_000 });
const warm = (Date.now() - t) / 1000;
check(warm < 6, "first generator click after pre-warm is fast", `${warm.toFixed(2)} s click -> preview (cold: 10-14 s)`);

await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nFR-13 PRE-WARM TESTS PASSED");
process.exit(failed ? 1 : 0);
