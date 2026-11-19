// Sweep ALL generator pages: form defaults -> query -> (a) Pyodide worker, (b) original server.
// Compares the two responses (after stripping the volatile <metadata> block).
// Exercises the real page markup (textareas, selects, checkboxes, edge pickers, ints...) end to end.

import { chromium } from "playwright";
import { readdir, writeFile } from "node:fs/promises";

const STATIC = process.env.STATIC_BASE ?? "http://localhost:8765/boxes-static";
const ORIG = process.env.ORIG_BASE ?? "http://localhost:8001";
// subpath the site is served under ("" at the root): passed to the worker as url_prefix
// and stripped from SVG metadata before comparison
const sURL = new URL(STATIC);
const PREFIX = sURL.pathname.replace(/\/$/, "");

const names = [];
for (const e of await readdir(new URL("../site/", import.meta.url), { withFileTypes: true })) {
  if (e.isDirectory() && !["Gallery", "Menu", "static", "shim", "py"].includes(e.name)) names.push(e.name);
}
names.sort();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${STATIC}/Menu/`); // a page WITHOUT the shim: we drive the worker ourselves

await page.evaluate(({ base, scheme, host, prefix }) => {
  window.__w = new Worker(`${base}/shim/py-worker.js`, { type: "module" });
  let id = 0;
  const pending = new Map();
  window.__w.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") return;
    const p = pending.get(m.id); pending.delete(m.id);
    m.ok ? p.resolve(m) : p.reject(new Error(m.error));
  };
  window.__req = (path, query) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    window.__w.postMessage({ id: i, path, query, scheme, host, prefix });
  });
  // build the query exactly like the preview does, from the page's own default form values
  window.__query = async (name) => {
    const html = await (await fetch(`${base}/${name}/index.html`)).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const data = new FormData(doc.getElementById("arguments"));
    data.set("format", "svg");
    return new URLSearchParams(data).toString() + "&render=4";
  };
}, { base: STATIC, scheme: sURL.protocol.replace(":", ""), host: sURL.host, prefix: PREFIX });

// Normalize ONLY the fields that legitimately differ between the two runs:
// wall-clock creation time (it appears twice: "Creation date:" text and <dc:date>),
// and the request origin embedded in the "Url:"/"Url short:" metadata lines
// (getURL = scheme://host + url_prefix + path): the worker renders for
// STATIC's origin, the original server for ORIG's. Verified: the ORIGINAL
// server differs from itself on exactly these when the same request is
// repeated a second later.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripMeta = (s) =>
  s.replace(/Creation date: [\d-]+ [\d:]+/g, "Creation date: <T>")
   .replace(/<dc:date>[^<]*<\/dc:date>/g, "<dc:date><T></dc:date>")
   .replace(new RegExp(esc(STATIC), "g"), "<BASE>")
   .replace(new RegExp(esc(ORIG), "g"), "<BASE>");
const isErr = (s) => /An error occurred!/.test(s);
const results = {};
const t0 = Date.now();

for (const [i, name] of names.entries()) {
  const r = { };
  try {
    const query = await page.evaluate((n) => window.__query(n), name);
    const dec = new TextDecoder();
    const w = await page.evaluate(async ([n, q]) => {
      const m = await window.__req(`/${n}`, q);
      return { status: m.status, ct: (m.headers.find(([k]) => k.toLowerCase() === "content-type") || [])[1], body: Array.from(m.body.slice(0, 0)).length, text: new TextDecoder().decode(m.body) };
    }, [name, query]);
    r.worker = { status: w.status, err: isErr(w.text), len: w.text.length };
    let o;
    try {
      const res = await fetch(`${ORIG}/${name}?${query}`);
      o = { status: `${res.status}`, text: await res.text() };
    } catch (e) { o = { status: "fetch-failed", text: "" }; }
    r.orig = { status: o.status, err: isErr(o.text), len: o.text.length };
    if (w.status.startsWith("200") && o.status === "200") {
      r.verdict = stripMeta(w.text) === stripMeta(o.text) ? "identical" : "differs";
    } else if (!w.status.startsWith("200") && o.status !== "200") {
      r.verdict = "both-failed";
    } else r.verdict = "status-mismatch";
    if (r.verdict === "differs") r.diffAt = [...stripMeta(w.text)].findIndex((c, k) => c !== stripMeta(o.text)[k]);
  } catch (e) {
    r.verdict = "harness-error"; r.error = String(e.message).slice(0, 160);
  }
  results[name] = r;
  if ((i + 1) % 30 === 0) console.log(`  ${i + 1}/${names.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

await browser.close();
await writeFile("/tmp/sweep-pages.json", JSON.stringify(results, null, 2));

const tally = {};
for (const r of Object.values(results)) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log("\nSUMMARY", JSON.stringify(tally), `in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const errBoth = Object.entries(results).filter(([, r]) => r.verdict === "identical" && r.worker.err);
console.log(`identical responses that are upstream error SVGs (expected for generators needing input): ${errBoth.map(([n]) => n).join(", ") || "none"}`);
for (const [n, r] of Object.entries(results)) {
  if (!["identical"].includes(r.verdict)) console.log(" ", r.verdict.padEnd(16), n.padEnd(26), JSON.stringify(r.worker ?? {}), JSON.stringify(r.orig ?? {}), r.error ?? "", r.diffAt ?? "");
}

// "both-failed" is acceptable parity (same failure on both sides, e.g.
// TrayLayout without a layout). Anything else is a failure.
const bad = Object.values(results).filter((r) => !["identical", "both-failed"].includes(r.verdict));
if (bad.length) {
  console.log(`\n${bad.length} GENERATOR(S) NOT PARITY-IDENTICAL`);
  process.exit(1);
}
console.log("\nSWEEP PASSED");
