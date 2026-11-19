#!/usr/bin/env python3
"""Serve the built site under a URL subpath — local stand-in for GitHub Pages.

GitHub Pages hosts boxes-static at /boxes-static/; this server serves site/ at
an arbitrary prefix so the browser tests can run against the same shape of URL
(FR-7, local half). It also reproduces the host behaviour D7 relies on:
a request for /prefix/Name is 301-redirected to /prefix/Name/ (the redirect
keeps the prefix because it is emitted from self.path, which translate_path
never touches).

Usage: python tests/serve_static.py [--directory DIR] [--prefix /boxes-static]
                                    [--port 8765] [--bind 127.0.0.1]
"""
from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def make_handler(directory: Path, prefix: str):
    class PrefixHandler(SimpleHTTPRequestHandler):
        def translate_path(self, path):
            # Strip only the argument; self.path keeps the prefix so the base
            # class's 301 directory redirect stays prefix-correct.
            if path == prefix:
                path = "/"
            elif path.startswith(prefix + "/"):
                path = path[len(prefix):] or "/"
            return super().translate_path(path)

    return partial(PrefixHandler, directory=str(directory))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--directory", type=Path, default=REPO / "site",
                    help="site directory to serve (default: %(default)s)")
    ap.add_argument("--prefix", default="/boxes-static",
                    help="URL prefix to serve under (default: %(default)s)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    prefix = "/" + args.prefix.strip("/")
    httpd = ThreadingHTTPServer((args.bind, args.port), make_handler(args.directory, prefix))
    print(f"serving {args.directory} at http://{args.bind}:{args.port}{prefix}/", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
