// Stricter follow-up to test-e2e.mjs: assertions that fail if the feature is NOT working.
//  A. bad input must yield upstream's error SVG in the preview (inspect the blob content)
//  B. layout-specific init must really run (observable DOM/window effects), with a no-JS control

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const BASE = process.env.STATIC_BASE ?? "http://localhost:8765/boxes-static";
const browser = await chromium.launch();
let failed = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "[ok]  " : "[FAIL]"} ${msg}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- A. error preview
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/ClosedBox/`);
  await page.waitForFunction(() => document.getElementById("preview_img").src.startsWith("blob:"), null, { timeout: 120_000 });
  const oldSrc = await page.evaluate(() => document.getElementById("preview_img").src);

  await page.fill("#x", "abc");
  await page.dispatchEvent("#x", "change");
  // a NEW blob must replace the old one (otherwise we'd be looking at a stale image)
  await page.waitForFunction((o) => {
    const s = document.getElementById("preview_img").src;
    return s.startsWith("blob:") && s !== o;
  }, oldSrc, { timeout: 60_000 });
  const newSrc = await page.evaluate(() => document.getElementById("preview_img").src);
  const text = await page.evaluate((u) => fetch(u).then((r) => r.text()), newSrc);
  check(text.includes("<svg") && /An error occurred!/.test(text), "bad x -> preview blob is upstream's error SVG",
    JSON.stringify((text.match(/invalid[^<]*/i) || [""])[0].slice(0, 70)));

  // and recovery: a valid value renders the box again
  await page.fill("#x", "100");
  await page.dispatchEvent("#x", "change");
  await page.waitForFunction((o) => {
    const s = document.getElementById("preview_img").src;
    return s.startsWith("blob:") && s !== o;
  }, newSrc, { timeout: 60_000 });
  const ok = await page.evaluate((u) => fetch(u).then((r) => r.text()), await page.evaluate(() => document.getElementById("preview_img").src));
  check(!/An error occurred!/.test(ok) && ok.includes("<path"), "valid value afterwards renders the box again");
  await page.close();
}

// ---------------------------------------------------------------- B. layout inits
// control: markup as emitted by upstream (before any JS) - rows/cols must NOT already be 20/24,
// otherwise the DOM assertion below would prove nothing.
for (const name of ["TrayLayout", "GridfinityTrayLayout"]) {
  const html = await readFile(new URL(`../site/${name}/index.html`, import.meta.url), "utf8");
  const tag = html.match(/<textarea[^>]*id="layout"[^>]*>/)?.[0] ?? "";
  const rows = +(tag.match(/rows="(\d+)"/)?.[1] ?? 0), cols = +(tag.match(/cols="(\d+)"/)?.[1] ?? 0);
  check(!(rows === 20 && cols === 24), `${name}: control - served markup is rows=${rows} cols=${cols} (not 20/24)`);

  const page = await browser.newPage();
  await page.goto(`${BASE}/${name}/`);
  await page.waitForLoadState("load");
  await page.waitForTimeout(500);
  const got = await page.evaluate(() => {
    const l = document.getElementById("layout");
    return { rows: l.rows, cols: l.cols, len: l.value.length, layoutUpdated: window.layoutUpdated };
  });
  // Note: TrayLayoutInit (upstream) restores the server-provided, empty layout, so len==0 is
  // expected there (verified identical on the original server); Gridfinity guards against that.
  check(got.rows === 20 && got.cols === 24 && got.layoutUpdated !== undefined, `${name}: init ran (rows/cols 20/24, window.layoutUpdated set)`, JSON.stringify(got));
  await page.close();
}

{
  const page = await browser.newPage();
  await page.goto(`${BASE}/PhotoFrame/`);
  await page.waitForLoadState("load");
  await page.waitForTimeout(500);
  const ran = await page.evaluate(() => "photoFrameUserMattingW" in window);
  check(ran, "PhotoFrame: PhotoFrameInit ran (window.photoFrameUserMattingW defined)");
  await page.close();
}

// ---------------------------------------------------------------- C. TrayLayout reacts to input
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/TrayLayout/`);
  await page.waitForLoadState("load");
  // upstream asks "You have manually updated the Layout. Regenerate?" (layoutUpdated is true after init)
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message().slice(0, 30)); d.accept(); });
  const before = await page.inputValue("#layout");
  await page.fill("#sx", "30*5");
  await page.dispatchEvent("#sx", "input");
  const after = await page.inputValue("#layout");
  check(dialogs.length > 0, "TrayLayout: editing sx shows upstream's confirm() dialog", JSON.stringify(dialogs[0]));
  check(before !== after && (after.match(/,> /g) || []).length === 5, "TrayLayout: accepting it regenerates the layout text (5 columns)",
    `${(before.match(/,> /g) || []).length} -> ${(after.match(/,> /g) || []).length} columns`);
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nSTRICT E2E PASSED");
process.exit(failed ? 1 : 0);
