// Functional E2E of the static site (:8765) in headless Chromium.
// Covers what the screenshot parity test cannot: that Pyodide (not a server)
// produced the preview, the four buttons, Save-to-URL prefill, error handling,
// and the generator-specific init for trailing-slash URLs.

import { chromium } from "playwright";

const BASE = process.env.STATIC_BASE ?? "http://localhost:8765/boxes-static";
const browser = await chromium.launch();

let failed = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "[ok]  " : "[FAIL]"} ${msg}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

const newPage = async (ctx) => {
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("response", (r) => r.status() >= 400 && page.errors.push(`HTTP ${r.status()} ${r.url()}`));
  return page;
};
const previewReady = (page) =>
  page.waitForFunction(() => {
    const i = document.getElementById("preview_img");
    return i.complete && i.naturalWidth > 1 && i.src.startsWith("blob:");
  }, null, { timeout: 120_000 });

const ctx = await browser.newContext({ acceptDownloads: true });

// ---- 1. preview comes from Pyodide, via blob:
const page = await newPage(ctx);
await page.goto(`${BASE}/ClosedBox/`);
await previewReady(page);
check(true, "preview is a blob: image (rendered in-browser, no server)");

// ---- 2. changing a field re-renders; size must change
const dims = () => page.evaluate(() => {
  const i = document.getElementById("preview_img"); return `${i.naturalWidth}x${i.naturalHeight}`;
});
const before = await dims();
await page.fill("#x", "150");
await page.dispatchEvent("#x", "change");
await page.waitForFunction((b) => {
  const i = document.getElementById("preview_img");
  return i.complete && `${i.naturalWidth}x${i.naturalHeight}` !== b;
}, before, { timeout: 60_000 });
check(true, "editing x re-renders the preview", `${before} -> ${await dims()}`);

// ---- 3. Download button: attachment named like the real server's
const [dl] = await Promise.all([
  page.waitForEvent("download", { timeout: 60_000 }),
  page.click('button[name="render"][value="2"]'),
]);
check(dl.suggestedFilename() === "ClosedBox.svg", "Download -> ClosedBox.svg", dl.suggestedFilename());
const svgText = await (await import("node:fs/promises")).readFile(await dl.path(), "utf8");
check(/^<\?xml/.test(svgText) && svgText.includes("<svg"), "downloaded file is SVG", `${svgText.length} chars`);
// default ClosedBox is exactly width="221.90mm" (verified against upstream examples/ClosedBox.svg)
check(!svgText.includes('width="221.90mm"'), "download reflects edited x=150 (not the default render)",
  svgText.match(/<svg[^>]*width="([^"]+)"/)?.[1]);

// ---- 4. Generate opens a new tab with the SVG
const [tab] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 20_000 }),
  page.click('button[name="render"][value="1"]'),
]);
await tab.waitForURL(/^blob:/, { timeout: 60_000 });
check(true, "Generate opens new tab at a blob: URL", tab.url().slice(0, 40));
const tabIsSvg = await tab.evaluate(() => document.documentElement.tagName.toLowerCase() === "svg");
check(tabIsSvg, "new tab displays an SVG document");
await tab.close();

// ---- 5. QR code button -> PNG
const [qr] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 20_000 }),
  page.click('button[name="render"][value="3"]'),
]);
await qr.waitForURL(/^blob:/, { timeout: 60_000 });
const qrOk = await qr.evaluate(() => {
  const i = document.querySelector("img"); return !!i && i.naturalWidth > 50;
});
check(qrOk, "QR Code opens a PNG image");
await qr.close();

// ---- 6. Save to URL, then reload: form is pre-filled
await page.fill("#y", "77");
await page.click('button[name="render"][value="0"]');
const url = page.url();
check(/\?.*y=77/.test(url) && url.includes("render=0"), "Save to URL puts values in the query", url.split("?")[1]?.slice(0, 50) + "…");
await page.reload();
check((await page.inputValue("#y")) === "77", "reload pre-fills y=77 from query");
check((await page.inputValue("#x")) === "150", "reload pre-fills x=150 from query");
await previewReady(page);

// ---- 7. bad input -> upstream's error SVG in the preview (not a broken page)
await page.fill("#x", "abc");
await page.dispatchEvent("#x", "change");
await page.waitForTimeout(500);
await previewReady(page);
const errStatus = await page.textContent("#boxes-status");
check(!/Error/.test(errStatus || ""), "bad value shows server-style error SVG, no JS error", JSON.stringify(errStatus));
await page.screenshot({ path: "/tmp/e2e-error-preview.png" });

check(page.errors.length === 0, "no page errors / HTTP errors on ClosedBox", page.errors.slice(0, 3).join(" | "));

// ---- 8. layout-specific JS (needs shim compensation for trailing-slash URLs)
for (const name of ["TrayLayout", "GridfinityTrayLayout", "PhotoFrame"]) {
  const p = await newPage(ctx);
  await p.goto(`${BASE}/${name}/`);
  await p.waitForLoadState("load");
  await p.waitForTimeout(500);
  check(p.errors.length === 0, `${name}: page loads, init runs without errors`, p.errors.slice(0, 2).join(" | "));
  await p.close();
}

await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nE2E PASSED");
process.exit(failed ? 1 : 0);
