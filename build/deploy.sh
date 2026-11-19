#!/usr/bin/env bash
# Deploy the built site to GitHub Pages (PRD D6).
#
# Commits site/ to the gh-pages branch and pushes. History on gh-pages is
# kept: git stores identical files once, so each rebuild adds only the files
# that changed (PRD Q4 default). Also enables Pages once (idempotent) via
# the gh CLI.
#
# Usage: bash build/deploy.sh        (run `npm run build` first)
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-gh-pages}"

[ -f site/index.html ] || { echo "FAIL: site/ is not built; run npm run build first" >&2; exit 1; }

SLUG=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
SRC_REV=$(git rev-parse --short HEAD)
REMOTE_URL=$(git remote get-url "$REMOTE")

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  echo "cloning existing $BRANCH from $REMOTE (history kept)"
  git clone --quiet --branch "$BRANCH" --single-branch "$REMOTE_URL" "$TMP"
else
  echo "creating new orphan branch $BRANCH"
  git init --quiet -b "$BRANCH" "$TMP"
  git -C "$TMP" remote add origin "$REMOTE_URL"
fi

rsync -a --delete --exclude=.git site/ "$TMP/"
# GitHub Pages: serve files as-is, skip the Jekyll pass
touch "$TMP/.nojekyll"

git -C "$TMP" add -A
if git -C "$TMP" diff --cached --quiet; then
  echo "nothing changed since the last deploy"
else
  git -C "$TMP" commit -q -m "Deploy site built from $(git branch --show-current)@${SRC_REV}"
  echo "committed deploy of ${SRC_REV}"
fi
git -C "$TMP" push --quiet -u origin "$BRANCH"

# Pages only needs enabling once — a push to gh-pages triggers the build by
# itself. The API write can 404 for tokens without Pages access, so treat it
# as a warning with manual instructions rather than a failed deploy.
if gh api "repos/$SLUG/pages" >/dev/null 2>&1; then
  echo "Pages already enabled: $(gh api "repos/$SLUG/pages" --jq .html_url)"
else
  gh api --method POST "repos/$SLUG/pages" -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null \
    || echo "WARN: could not enable Pages via the API; enable it manually: Settings -> Pages -> $BRANCH / (root)" >&2
fi
OWNER=${SLUG%%/*}; REPO=${SLUG#*/}
echo "deployed: https://${OWNER}.github.io/${REPO}/ (Pages build may take a minute)"
