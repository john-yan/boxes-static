# boxes-static

[Boxes.py](https://github.com/florianfesti/boxes) — the laser-cut box and part
generator — published as a **static website**. No server: the unmodified
upstream Python code runs in the visitor's browser through
[Pyodide](https://pyodide.org/), and every page is pre-rendered at build time by
upstream's own `BServer.serve()`. Full background, requirements and decisions:
[`PRDs/init.md`](PRDs/init.md).

## Prerequisites

- Linux or macOS, bash
- CPython 3 (tested with 3.14)
- Node.js ≥ 20 and npm
- Network access: the build and tests fetch nothing, but the browser tests load
  the Pyodide runtime from the jsdelivr CDN and pure-Python packages from PyPI
  (same as the deployed site)

## Build

```sh
git clone --recurse-submodules https://github.com/john-yan/boxes-static.git
cd boxes-static
# (already cloned without submodules? run: git submodule update --init)

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
npx playwright install chromium   # browser for the tests

npm run build        # or: .venv/bin/python build/build_site.py
```

The site is written to `site/` (~39 MB, mostly upstream sample photos). Serve
it from any static host; directory URLs (`/ClosedBox/`) are used throughout.

## Test

```sh
npm test             # or: bash tests/run-tests.sh
```

The runner builds the site, starts upstream's original server (from the
`upstream/` submodule) plus a local subpath static server, and runs every
suite. All browser tests run against `http://localhost:8765/boxes-static/` —
the local stand-in for the GitHub Pages subpath (FR-7). Knobs: `ORIG_PORT`,
`STATIC_PORT`, `PREFIX`, `BOXES_SRC` (override the upstream checkout).

| Suite | Covers |
|---|---|
| `test-render` | smoke: Boxes.py renders in Pyodide, byte-identical to `examples/ClosedBox.svg` |
| `test-parity` | FR-1: page screenshots identical to the original server |
| `test-e2e` / `test-e2e-strict` | FR-3/4/5/8: preview, buttons, prefill, error SVG, page scripts |
| `test-spa` | FR-6: in-page navigation keeps the Python worker alive |
| `test-sweep-pages` | FR-2: every generator's default-form output vs the original server |
| `test-all` | FR-2: every generator vs upstream `examples/*.svg`, byte-for-byte |

## Layout

```
build/build_site.py   pre-renders pages via upstream's WSGI app; zips the Python source
shim/                 browser shim (after upstream's self.js) + Pyodide web worker
tests/                suites (Node/Playwright) + subpath server + runner
upstream/             pinned git submodule of florianfesti/boxes
site/                 build output (gitignored)
```

## License

GPL-3.0-or-later, inherited from upstream Boxes.py (© Florian Festi and
contributors). See [`LICENSE`](LICENSE).
