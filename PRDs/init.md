# PRD: boxes-static — Boxes.py as a static, in-browser site

| | |
|---|---|
| **Status** | v0.2 — M0–M2 implemented (2026-11-19); site live |
| **Date** | 2026-11-19 |
| **Owner** | john-yan |
| **Repository** | `john-yan/boxes-static` (public, to be created) |
| **Target URL** | `https://john-yan.github.io/boxes-static/` |
| **Upstream** | [florianfesti/boxes](https://github.com/florianfesti/boxes), pinned at `707c1d6` |
| **License** | GPL-3.0-or-later (inherited from upstream) |

---

## 1. Summary

Boxes.py is an open-source generator of laser-cut box and part designs. It runs today as a Python
WSGI web server that renders an SVG on every request. **boxes-static** delivers the same website,
with the same pages, look and generators, as plain static files on GitHub Pages. There is no
server process. The unmodified upstream Python code runs inside the visitor's browser through
Pyodide (CPython compiled to WebAssembly).

A working prototype exists (`~/boxes.py/pyodide-prototype`). It shows the approach is viable, and
its measurements are quoted throughout this document (§5).

## 2. Background

* Upstream Boxes.py is about 42.6k lines of Python: about 10k in the core library (turtle-style
  drawing API, joint/edge library, SVG/PS/LightBurn surfaces) and about 30k in 191 generator modules.
* The public instance (boxes.hackerspace-bamberg.de) and self-hosted copies, such as the Docker
  image in `~/boxes.py`, run `scripts/boxesserver`. That is a stateless WSGI app. Every request is
  a pure function of the URL query string, with no database, sessions or auth.
* Because rendering is stateless, the server mainly exists to run Python. If the browser can run
  the Python, the server is no longer needed.

## 3. Problem statement

Running Boxes.py today means operating a server: a Python environment, `gunicorn`, `pstoedit`, a
container, updates and uptime. People who want their own instance, or a fork with custom
generators, carry that cost for a workload that has no shared state. The software is a candidate
for free static hosting, but no static distribution of it exists.

## 4. Goals and non-goals

### 4.1 Goals

* **G1 — No server.** The whole site is static files deployable to GitHub Pages, or any static host.
* **G2 — Fidelity.** Pages look and behave like the original server's. Generated files are
  identical to what the original server produces for the same input.
* **G3 — Upstream-tracking.** Reuse upstream code and assets unmodified. Updating to a new upstream
  release is a pin bump plus a rebuild, not a porting effort.
* **G4 — Usable performance.** After the first load, switching generators and re-rendering feel
  interactive.

### 4.2 Non-goals (v1)

* Rewriting Boxes.py in JavaScript.
* Modifying upstream code, HTML templates, CSS or JS. Changes upstream would want belong in
  upstream PRs, not in this project.
* Fully offline or self-contained hosting. v1 loads the Pyodide runtime from the jsdelivr CDN and
  pure-Python packages from PyPI via `micropip` at runtime (see D5).
* Formats that need external binaries: DXF, G-code, HPGL/PLT (`pstoedit`) and PDF (`ps2pdf`).
* Inkscape plug-in and CLI distribution. Those are unaffected and stay upstream.

## 5. Prototype findings (evidence)

All figures are from the prototype on 2026-11-19, using headless Chromium and Node on one Linux
machine, upstream at `707c1d6`.

| Area | Result |
|---|---|
| Upstream code changes needed | **None** |
| Python dependencies in the browser | `shapely` 2.1.2, `pillow`, `typing-extensions` from the Pyodide distribution. `affine>=3.0.1`, `qrcode` and `markdown` from PyPI via `micropip`. (Pyodide ships `affine` 2.4.0, but upstream needs the v3 API, so the pin is required.) |
| Generator output vs upstream reference files | **181 of 181** default-tested generators byte-for-byte identical to `examples/*.svg` |
| All 183 web-UI generator pages vs the original server (default form values) | **182 identical**. 1 (`TrayLayout`) fails identically on both, because it needs a layout input. |
| Page appearance | Gallery, Menu, ClosedBox: screenshots **pixel-identical** to the original server |
| Functional E2E | Live preview, Generate, Download, Save to URL with reload prefill, QR Code, upstream error SVG on bad input, and `TrayLayout`/`GridfinityTrayLayout`/`PhotoFrame` page scripts: all pass |
| Cold start (first generator page of a visit) | 9.9–10.8 s to first preview (about 5 s of it is `micropip` fetching from PyPI) |
| Full page load, warm browser cache | about 3.6 s (the Python runtime re-initialises) |
| Switching generator with in-page navigation | **about 0.15 s** |
| Render speed vs native CPython | about **1.9× slower** in aggregate. Median 57 ms, p90 209 ms, max 597 ms per generator at defaults |
| Site size | about 39 MB, of which 34.6 MB is upstream sample photos. Python source zip: 490 KB. |

## 6. Users and use cases

| User | Need |
|---|---|
| Maker / laser-cutter owner | Open the site, pick a generator, adjust parameters, download an SVG or LightBurn file |
| Self-hoster / makerspace | Run their own copy without operating a server, by forking and enabling Pages |
| Generator author | Fork, add a generator to a custom upstream branch, rebuild, publish |

## 7. Architecture

```
build time (CPython, local)                     run time (visitor's browser)
──────────────────────────────                  ─────────────────────────────────────────
upstream/ (pinned submodule)                    pre-rendered HTML page  (instant paint)
  └─ scripts/boxesserver ── BServer.serve() ──▶   + upstream static/ (CSS, JS, images)
       called as WSGI once per page               + shim (boxes-browser.js)
                                                     │  replaces only server-dependent parts
  └─ boxes/ + boxesserver ── zipped ──────────▶      ▼
                                                  Web Worker: Pyodide
                                                     └─ same BServer.serve(), in-browser
```

1. **Pre-rendered pages.** The build calls upstream's own `BServer.serve()` as a WSGI app for the
   Gallery, the Menu and each generator page, and writes the HTML to disk. The only edits are an
   added `<base>` tag and one `<script>` tag. The HTML is never re-implemented.
2. **Static assets.** Upstream `static/` is copied unchanged.
3. **Shim.** A script loaded after upstream's `self.js`. It replaces only what needed a server:
   * preview rendering
   * the four form buttons
   * pre-filling the form from the query string
   * page-specific init for directory-style URLs
   * in-page navigation that keeps the Python worker alive
4. **Python worker.** A Web Worker loads Pyodide, unpacks the zipped upstream source, and answers
   each request by calling the same `BServer.serve()` the real server runs. Error SVGs, download
   file names and QR codes are therefore upstream's own behaviour.

## 8. Requirements

Priority: **P0** = required for v1 launch, **P1** = soon after, **P2** = later or optional.

### 8.1 Functional

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-1 | P0 | Gallery, Menu and every web-UI generator page are served as pre-rendered static HTML generated by upstream code | Page set matches the original server's (183 generators at `707c1d6`); screenshots of Gallery, Menu and a sample generator page are pixel-identical to the original |
| FR-2 | P0 | Generators render in the browser with output identical to the original server | Page sweep: every generator's default-form output identical to the original server, apart from creation timestamp and host |
| FR-3 | P0 | Live preview updates when form values change | Editing a field re-renders the preview; a result from an abandoned page never replaces the current page's preview |
| FR-4 | P0 | Generate, Download, Save to URL and QR Code buttons work | Generate opens the file in a new tab; Download saves `<Generator>.<ext>`; Save to URL puts values in the address bar and a reload restores them; QR Code shows a PNG |
| FR-5 | P0 | Upstream page scripts work (`TrayLayout`, `GridfinityTrayLayout`, `PhotoFrame`) | Same observable behaviour as on the original server, on direct load and after in-page navigation |
| FR-6 | P0 | Moving between pages keeps the Python runtime alive | Gallery/Menu/generator links and back/forward swap content without a document reload; modified clicks, external links and `target=_blank` are left to the browser; any failure falls back to a normal page load |
| FR-7 | P0 | Works when hosted under a subpath (`/boxes-static/`) | All tests pass against the deployed GitHub Pages URL |
| FR-8 | P0 | Invalid input shows upstream's error rendering, not a broken page | Bad value shows upstream's error SVG in the preview; a later valid value recovers |
| FR-9 | P1 | Direct render URLs (`?...&render=1/2/3/4`) behave like the original: the page renders, downloads or shows the QR on load | Each `render` mode reproduces the original server's outcome. **Done 2026-11-19**, verified locally and against the live URL (`test-render-urls`) |
| FR-10 | P1 | Translations: all 6 upstream locales (de, en, es, fr, pt_BR, zh_CN) with a language selector | Each locale's pages match the original server with that language selected |
| FR-11 | P1 | Optional "Legal" link, configurable at build time (upstream's `legal_url`) | Link appears when configured |
| FR-12 | P2 | DXF / G-code / PLT export without `pstoedit` | Each format opens in a reference tool. Needs a separate design: it means writing new exporters |
| FR-13 | P2 | Start loading Python on Gallery/Menu before the first generator click | Opt-in or decided per §12, Q1 |

### 8.2 Non-functional

| ID | Pri | Requirement | Target |
|---|---|---|---|
| NFR-1 | P0 | No server-side code at runtime | Static files only |
| NFR-2 | P0 | Upstream unmodified | Zero diffs to upstream files in the build |
| NFR-3 | P0 | Generator switch latency (warm) | ≤ 0.5 s click-to-preview for a median generator (prototype: about 0.15 s) |
| NFR-4 | P0 | Cold start | ≤ 15 s to first preview on a typical desktop connection (prototype: about 10 s); progress shown meanwhile |
| NFR-5 | P0 | Responsiveness during render | Rendering runs off the main thread (Web Worker) |
| NFR-6 | P0 | Reproducible builds | Pinned upstream commit, pinned build-time Python dependencies, pinned Pyodide version |
| NFR-7 | P1 | Browser support | Current Chrome, Firefox, Safari (desktop); mobile is best effort. Needs module workers and `FormData(form, submitter)` |
| NFR-8 | P1 | Accessibility | In-page navigation moves focus and announces the new page |
| NFR-9 | P1 | Site size within GitHub Pages limits | Published site well under GitHub's published Pages size limit (prototype: 39 MB; limit to be re-verified at launch) |

## 9. Decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | **Run unmodified upstream Python via Pyodide**, not a JS rewrite | A rewrite is about 40k lines and permanently forks upstream. The prototype shows byte-identical output with zero changes. |
| D2 | **Pre-render pages with upstream's `BServer` at build time** | The look, markup and page scripts come from upstream, so the site stays faithful and paints instantly |
| D3 | **Public repo, GPL-3.0-or-later** | The site redistributes upstream GPL code and assets, so it is a derived work. Public also enables free GitHub Pages. |
| D4 | **Upstream as a pinned git submodule** | Reproducible builds; an upstream update is an explicit, reviewable commit |
| D5 | **Keep `micropip`** for pure-Python dependencies | Owner decision. Accepted cost: about 5 s of cold start and a runtime dependency on PyPI. |
| D6 | **Deploy by committing the built site to a `gh-pages` branch** | Owner decision; no CI needed. Accepted cost: build output in git history. Git stores identical files once, so each rebuild adds only the files that changed. |
| D7 | **Directory-style URLs** (`/ClosedBox/`) | Works on any static host without rewrite rules; relies on the host redirecting `/ClosedBox` to `/ClosedBox/` |

## 10. Gaps vs the original server

| Gap | v1 handling |
|---|---|
| Languages: English only | FR-10 (P1) |
| Formats: no DXF/G-code/PLT/PDF | Non-goal for v1; FR-12 (P2) |
| Direct `?render=N` URLs do not render | Resolved 2026-11-19 (FR-9): all render modes act on page load. The result displays at a `blob:` URL, so the address bar changes (blob: limitation above still applies) |
| "Generate" tab is a `blob:` URL: cannot be shared or bookmarked | Accepted for v1; partly addressed by FR-9 |
| No rendering without JavaScript | Accepted (inherent to the approach) |
| Response headers (`X-Frame-Options`, `nosniff`, `Referrer-Policy`, `X-Robots-Tag`) | GitHub Pages cannot set custom headers; accepted, documented |
| Cold start and full-page-load cost | Mitigated by FR-6; FR-13 under discussion |
| About 1.9× slower rendering | Accepted (worst prototype case 0.6 s) |
| Upstream changes need a rebuild and redeploy | By design (D4) |
| Unpinned runtime package versions (`micropip` installs latest `markdown`, `qrcode`) | Open question Q2 |

## 11. Milestones

| Milestone | Scope | Exit criteria | Status |
|---|---|---|---|
| **M0 — Repo setup** | Create public repo, add upstream submodule, LICENSE, README, this PRD | Repo public; PRD reviewed | ✅ Done |
| **M1 — v1 build** | Port prototype build, shim and tests into the repo; pin build dependencies; make tests portable | All P0 tests pass locally against a local subpath simulation | ✅ Done 2026-11-19 — all suites green against `http://localhost:8765/boxes-static/` (`33b9c0e`) |
| **M2 — Pages launch** | `gh-pages` deploy procedure; enable Pages; run the test suite against the live URL | FR-1–FR-8 verified on `https://john-yan.github.io/boxes-static/` | ✅ Done 2026-11-19 — full suite green against the live URL via `STATIC_BASE=… npm test` (`43231de`) |
| **M3 — Parity+** | FR-9 direct render URLs, FR-10 languages, FR-11 legal link, NFR-7 cross-browser, NFR-8 accessibility | Acceptance criteria met | In progress — FR-9 done 2026-11-19 |
| **M4 — Optional** | FR-12 exporters, FR-13 pre-warm, offline hosting | Per separate decision | Open |

## 12. Risks and open questions

### 12.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Subpath hosting (`/boxes-static/`) breaks link, base or worker resolution: designed for, never tested | Medium | High | Local subpath simulation in M1; full suite against the live URL in M2 |
| GitHub Pages redirect `/Name` to `/Name/` drops the query string, breaking saved URLs | Ruled out | Medium | Verified in M2: the 301 redirect preserves the query string (`/Name?x=1` → `/Name/?x=1`); no workaround needed |
| Runtime CDN or PyPI outage, or an incompatible new release of `markdown`/`qrcode` | Low–Medium | High (site unusable or output drift) | Q2 (version pins); monitoring |
| Upstream changes break the build: new server internals, new dependencies, Pyodide-incompatible modules | Medium per bump | Medium | Pinned submodule; re-run the full parity suite on every pin bump |
| Pyodide lacks a future upstream compiled dependency | Low | High | Checked on each pin bump; affected generators can be marked unavailable |
| Slow devices: cold start and render time much worse than measured | Medium | Medium | Measure on low-end hardware in M3; progress indicator; FR-13 |
| Non-default parameter combinations not covered (parity measured at defaults only) | Medium | Medium | Add sampled non-default parameter sweeps against the original server |
| GPL compliance mistakes in redistribution | Low | High | Keep upstream notices; publish full source; same license |

### 12.2 Open questions

* **Q1:** Start loading Python on Gallery/Menu (FR-13)? This speeds the first generator click but
  costs CPU and bandwidth for visitors who never open a generator.
* **Q2:** Pin versions of the `micropip`-installed packages? This keeps `micropip` (D5) but removes
  version drift.
* **Q3:** Is P1 language support needed at launch, or after?
* **Q4:** Should `gh-pages` keep full history, or be force-reset each deploy to stay small?
  (Current implementation, `build/deploy.sh`: history kept, per D6.)
* **Q5:** Custom domain, or stay on `john-yan.github.io/boxes-static/`?

## 13. Success metrics

* **Fidelity:** 100% of web-UI generators produce output identical to the original server, at
  defaults and on a sampled non-default parameter set.
* **Performance:** median warm generator switch ≤ 0.5 s; cold start ≤ 15 s on a reference desktop.
* **Maintenance:** an upstream pin bump is one commit plus a rebuild, with no code changes, for
  releases that do not change the server internals.
* **Cost:** zero server infrastructure.

## 14. Licensing and attribution

boxes-static redistributes Boxes.py (© Florian Festi and contributors), licensed GPL-3.0-or-later.
boxes-static is licensed under the same terms. The complete corresponding source, meaning this
repository plus the pinned upstream submodule, is published in the public repository. Upstream
copyright notices are preserved unmodified.

## Appendix A — Prototype test inventory

| Test | Checks |
|---|---|
| Visual parity | Gallery, Menu, ClosedBox screenshots vs the original server |
| E2E | Preview, edits, Download, Generate, QR, Save to URL and prefill, layout page scripts |
| Strict E2E | Error SVG content and recovery; layout script init, with controls proving the assertions can fail |
| Page sweep | All 183 generator pages' default-form output vs the original server |
| In-page navigation | No reload across Gallery/Menu/generator pages, back/forward, stale-preview race, Save to URL after a swap, fallbacks |
| Python-level | Every generator vs upstream `examples/*.svg`, byte-for-byte (Node + Pyodide) |
