#!/usr/bin/env bash
# M1 test runner: build the site, start the original server + a subpath static
# server, run every test suite, tear down. Exit non-zero if any suite fails.
#
# Env knobs:
#   ORIG_PORT   port for the original upstream server     (default 8001)
#   STATIC_PORT port for the subpath static server        (default 8765)
#   PREFIX      URL subpath to serve the site under       (default /boxes-static)
#   BOXES_SRC   upstream checkout to build from           (default ./upstream)
set -euo pipefail
cd "$(dirname "$0")/.."

ORIG_PORT="${ORIG_PORT:-8001}"
STATIC_PORT="${STATIC_PORT:-8765}"
PREFIX="${PREFIX:-/boxes-static}"
export ORIG_BASE="http://localhost:${ORIG_PORT}"
export STATIC_BASE="http://localhost:${STATIC_PORT}${PREFIX}"

ORIG_PID=""
STATIC_PID=""
cleanup() {
  [ -n "$ORIG_PID" ] && kill "$ORIG_PID" 2>/dev/null || true
  [ -n "$STATIC_PID" ] && kill "$STATIC_PID" 2>/dev/null || true
}
trap cleanup EXIT

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# ---- 1. prerequisites -------------------------------------------------------
if [ ! -f upstream/boxes/__init__.py ]; then
  log "initializing upstream submodule"
  git submodule update --init --recursive
fi
if [ ! -x .venv/bin/python ]; then
  log "creating .venv"
  python3 -m venv .venv
fi
log "installing Python requirements"
.venv/bin/pip -q install -r requirements.txt
if [ ! -d node_modules ]; then
  log "installing Node requirements"
  npm ci
fi
# idempotent no-op when the browser is already installed
npx playwright install chromium >/dev/null 2>&1

# ---- 2. pinned versions must agree (NFR-6) ----------------------------------
pyodide_shim=$(grep -oP 'PYODIDE_VERSION = "\K[^"]+' shim/py-worker.js)
pyodide_npm=$(node -p "require('pyodide/package.json').version")
if [ "$pyodide_shim" != "$pyodide_npm" ]; then
  echo "FAIL: shim/py-worker.js pins Pyodide $pyodide_shim but package.json has $pyodide_npm" >&2
  exit 1
fi

# ---- 3. build ---------------------------------------------------------------
log "building site"
.venv/bin/python build/build_site.py

# ---- 4. original server (upstream's own, English, like the build) -----------
# cwd = repo root: BServer.getLanguages() globs "locale/*" relative to the cwd,
# and there is no locale/ here -> English only, matching the pre-rendered pages.
# (The FileChecker dev-reload thread only restarts the server when a watched
# source file's mtime changes; nothing changes mid-run.)
log "starting original server on :${ORIG_PORT}"
.venv/bin/python upstream/scripts/boxesserver --host 127.0.0.1 --port "$ORIG_PORT" \
  >/tmp/boxes-orig.log 2>&1 &
ORIG_PID=$!

# ---- 5. static site under a subpath (FR-7, local half) ----------------------
log "starting subpath static server on :${STATIC_PORT}${PREFIX}"
.venv/bin/python tests/serve_static.py --port "$STATIC_PORT" --prefix "$PREFIX" \
  >/tmp/boxes-static.log 2>&1 &
STATIC_PID=$!

# ---- 6. readiness -----------------------------------------------------------
wait_ready() {
  local url="$1" name="$2" i
  for i in $(seq 1 60); do
    if .venv/bin/python -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1], timeout=2)" "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  echo "FAIL: $name did not become ready at $url (see its log)" >&2
  return 1
}
wait_ready "$ORIG_BASE/Menu" "original server"
wait_ready "$STATIC_BASE/" "static server"

# ---- 7. suites (cheap first; keep going on failure) -------------------------
declare -a failed_suites=()
run_suite() {
  local suite="$1" frs="$2"
  log "suite: ${suite}  (${frs})"
  if node "tests/${suite}.mjs"; then
    :
  else
    failed_suites+=("${suite}")
  fi
}
run_suite test-render      "smoke"
run_suite test-parity      "FR-1"
run_suite test-e2e         "FR-3/4/5/8"
run_suite test-e2e-strict  "FR-5/8 strict"
run_suite test-spa         "FR-6"
run_suite test-sweep-pages "FR-2 web sweep"
run_suite test-all         "FR-2 python-level sweep"

# ---- 8. summary --------------------------------------------------------------
log "summary"
echo "  upstream unmodified (NFR-2): $(git -C upstream status --porcelain | wc -l) changed files"
if [ "${#failed_suites[@]}" -gt 0 ]; then
  echo "FAILED suites: ${failed_suites[*]}" >&2
  exit 1
fi
echo "ALL SUITES PASSED"
