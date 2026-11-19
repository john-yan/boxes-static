// Visual parity: original server (:8001) vs static site (:8765), same browser + viewport.
// Screenshots go to /tmp/parity-<page>-{orig,static}.png; identical bytes => pixel-identical.

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const ORIG = process.env.ORIG_BASE ?? "http://localhost:8001";
const STATIC = process.env.STATIC_BASE ?? "http://localhost:8765/boxes-static";
const PAGES = [
  { name: "gallery", orig: "/", stat: "/" },
  { name: "menu", orig: "/Menu", stat: "/Menu/" },
  { name: "closedbox", orig: "/ClosedBox", stat: "/ClosedBox/", preview: true },
];

const browser = await chromium.launch();

let failures = 0;

for (const p of PAGES) {
  const shots = {};
  for (const [label, base, path] of [["orig", ORIG, p.orig], ["static", STATIC, p.stat]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
    page.on("response", (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));

    await page.goto(base + path, { waitUntil: "load" });
    if (p.preview) {
      // wait for the live preview to be a real image (original: ...render=4 URL, static: blob:)
      await page.waitForFunction(() => {
        const i = document.getElementById("preview_img");
        return i && i.complete && i.naturalWidth > 1 && /render=4|^blob:/.test(i.src);
      }, null, { timeout: 120_000 });
    } else {
      await page.waitForLoadState("networkidle");
    }
    shots[label] = await page.screenshot({ path: `/tmp/parity-${p.name}-${label}.png`, fullPage: true });
    if (errors.length) {
      console.log(`  [${label}] ${p.name}: ${errors.length} error(s):`);
      for (const e of [...new Set(errors)].slice(0, 5)) console.log("     ", e);
    }
    await page.close();
  }
  const same = Buffer.compare(shots.orig, shots.static) === 0;
  console.log(`${same ? "[IDENTICAL]" : "[DIFFERS]  "} ${p.name}  (orig ${shots.orig.length} B, static ${shots.static.length} B)`);
  if (!same) failures++;
}

await browser.close();
process.exit(failures ? 1 : 0);
