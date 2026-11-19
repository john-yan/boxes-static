// FR-9: direct render URLs (?...&render=1/2/3/4) must behave like the original
// server: the page renders, downloads or shows the QR on load. Each mode is
// checked against the original server's response for the same query.
//
// Note on parity checks: the displayed blob: URL cannot be re-fetched from the
// blob document (blob URLs are revoked when their creating document is
// destroyed by the navigation), so the page content is compared as
// documentElement.outerHTML against the original server's response parsed
// through the same browser parser (DOMParser) - identical serialization on
// both sides.

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const BASE = process.env.STATIC_BASE ?? "http://localhost:8765/boxes-static";
const ORIG = process.env.ORIG_BASE ?? "http://localhost:8001";

// same volatile-field normalization as test-sweep-pages.mjs: wall-clock creation
// date and the request origin embedded in the metadata Url lines
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripMeta = (s) =>
  s.replace(/Creation date: [\d-]+ [\d:]+/g, "Creation date: <T>")
   .replace(/<dc:date>[^<]*<\/dc:date>/g, "<dc:date><T></dc:date>")
   .replace(new RegExp(esc(BASE), "g"), "<BASE>")
   .replace(new RegExp(esc(ORIG), "g"), "<BASE>");

let failed = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "[ok]  " : "[FAIL]"} ${msg}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });

// a plain page for parsing the original server's responses browser-side
const refPage = await ctx.newPage();
await refPage.goto(`${BASE}/Menu/`);
const parseRef = (text, mime) =>
  refPage.evaluate(([t, m]) => new DOMParser().parseFromString(t, m).documentElement.outerHTML, [text, mime]);

// load a render URL and wait for the shim to navigate the page to the result
const loadRender = async (query) => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ClosedBox/?${query}`);
  await page.waitForURL(/^blob:/, { timeout: 120_000 });
  return page;
};
const docHTML = (page) => page.evaluate(() => document.documentElement.outerHTML);

const parity = async (page, query, mime, label) => {
  const mine = await docHTML(page);
  // no trailing slash: the original server routes /ClosedBox, while /ClosedBox/
  // is an unknown page name and falls through to the menu
  const orig = await (await fetch(`${ORIG}/ClosedBox?${query}`)).text();
  const ref = await parseRef(orig, mime);
  const a = stripMeta(mine), b = stripMeta(ref);
  let extra = `${mine.length} vs ${ref.length} chars`;
  if (a !== b) {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    extra += `; first diff at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`;
  }
  check(a === b, `${label}: identical to the original server`, extra);
};

// ---- 1. render=1: displays the SVG, identical to the original server
{
  const page = await loadRender("x=150&render=1");
  check((await page.evaluate(() => document.documentElement.tagName.toLowerCase())) === "svg",
    "render=1: displays an SVG document");
  await parity(page, "x=150&render=1", "image/svg+xml", "render=1");
  await page.close();
}

// ---- 2. render=1 with no other params: default render
{
  const page = await loadRender("render=1");
  check((await page.evaluate(() => document.documentElement.tagName.toLowerCase())) === "svg",
    "render=1 (defaults): displays an SVG document");
  await page.close();
}

// ---- 3. render=2: download with the server's filename, page stays a form
{
  const page = await ctx.newPage();
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.goto(`${BASE}/ClosedBox/?render=2`),
  ]);
  check(dl.suggestedFilename() === "ClosedBox.svg", "render=2: downloads ClosedBox.svg", dl.suggestedFilename());
  const text = await readFile(await dl.path(), "utf8");
  check(text.startsWith("<?xml"), "render=2: downloaded file is SVG", `${text.length} chars`);
  await page.waitForTimeout(500); // give a wrong navigation time to happen
  check(!page.url().startsWith("blob:") && (await page.locator("#arguments").count()) === 1,
    "render=2: stays on the form page (attachment responses do not navigate)");
  await page.close();
}

// ---- 4. render=3: shows the QR as an image (the QR encodes url_short, which
//      is origin-dependent, so no comparison against the original here)
{
  const page = await loadRender("x=150&render=3");
  const img = await page.evaluate(() => {
    const i = document.querySelector("img");
    return i ? { complete: i.complete, w: i.naturalWidth } : null;
  });
  check(!!img && img.complete && img.w > 50, "render=3: displays a PNG image (QR code)", JSON.stringify(img));
  await page.close();
}

// ---- 5. render=4: displays the raw SVG (faithful to the original server)
{
  const page = await loadRender("x=150&render=4");
  check((await page.evaluate(() => document.documentElement.tagName.toLowerCase())) === "svg",
    "render=4: displays an SVG document");
  await parity(page, "x=150&render=4", "image/svg+xml", "render=4");
  await page.close();
}

// ---- 6. bad input + render=1: the original returns an HTML error page (200)
{
  const page = await loadRender("x=abc&render=1");
  const mine = await docHTML(page);
  check(/An error occurred!/.test(mine) && /<html/i.test(mine),
    "render=1 + bad input: displays the HTML error page");
  await parity(page, "x=abc&render=1", "text/html", "render=1 + bad input");
  await page.close();
}

// ---- 7. bad input + render=4: the original returns the error as an SVG (200)
{
  const page = await loadRender("x=abc&render=4");
  check((await page.evaluate(() => document.documentElement.tagName.toLowerCase())) === "svg",
    "render=4 + bad input: displays an SVG document (upstream's error SVG)");
  check(/An error occurred!/.test(await docHTML(page)), "render=4 + bad input: error text is in the SVG");
  await parity(page, "x=abc&render=4", "image/svg+xml", "render=4 + bad input");
  await page.close();
}

// ---- 8. render=0: stays a form page with the values pre-filled
{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ClosedBox/?x=123&render=0`);
  await page.waitForSelector("#arguments");
  await page.waitForTimeout(500);
  check(!page.url().startsWith("blob:"), "render=0: stays on the form page");
  check((await page.inputValue("#x")) === "123", "render=0: form pre-filled from the query");
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nFR-9 RENDER URL TESTS PASSED");
process.exit(failed ? 1 : 0);
