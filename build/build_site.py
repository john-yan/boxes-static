#!/usr/bin/env python3
"""Build the static Boxes.py site.

Approach: the HTML is NOT re-implemented. Upstream's own ``BServer.serve()``
(scripts/boxesserver) is called as a plain WSGI app at build time, once per
page, and its output is written to disk. Only two mechanical edits are applied
to each page (see ``localize``): a <base> tag so the extensionless relative
links keep working from ``<Name>/index.html``, and a <script> tag for the browser
shim that replaces the server-side rendering and does in-page navigation.

Output (site/):
    index.html, Gallery/, Menu/, <Generator>/index.html   pre-rendered pages
    static/                                               upstream static assets, unmodified
    py/boxes-src.zip                                      python package + boxesserver for Pyodide
    shim/                                                 browser shim (copied from ./shim)

Run with the venv:  .venv/bin/python build/build_site.py
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import shutil
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent  # build/
REPO = HERE.parent
CLONE = Path(os.environ.get("BOXES_SRC", REPO / "upstream")).resolve()
SITE = REPO / "site"

SHIM_TAG = '<script src="shim/boxes-browser.js"></script>'

# --- keep the generated forms identical on every machine --------------------
# Formats() probes for pstoedit/ps2pdf; those binaries cannot exist in a
# browser, so pretend they are absent: the format dropdown then only offers
# the formats Pyodide can really produce.
shutil.which = lambda *a, **k: None  # type: ignore[assignment]

# English only for now: BServer.getLanguages() globs "locale/*" relative to the
# CWD. Run from a directory without one (this one) -> no language dropdown.
os.chdir(HERE)
assert not (HERE / "locale").exists()

# static_url is relative so the site can be hosted under any path.
os.environ["STATIC_URL"] = "static"

sys.path.insert(0, str(CLONE))
loader = importlib.machinery.SourceFileLoader("boxesserver_mod", str(CLONE / "scripts" / "boxesserver"))
spec = importlib.util.spec_from_loader("boxesserver_mod", loader)
assert spec is not None
bsmod = importlib.util.module_from_spec(spec)
sys.modules["boxesserver_mod"] = bsmod
loader.exec_module(bsmod)  # not __main__ -> creates module-level `boxserver`
server = bsmod.boxserver


def fetch(path: str, query: str = "") -> str:
    """Call the upstream WSGI app like a web server would."""
    captured: dict = {}

    def start_response(status, headers, exc_info=None):
        captured["status"] = status

    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "HTTP_HOST": "localhost",
        "SERVER_NAME": "localhost",
        "SERVER_PORT": "80",
        "HTTP_ACCEPT_LANGUAGE": "",
        "wsgi.url_scheme": "http",
        "wsgi.file_wrapper": lambda f, bs: [f.read()],
    }
    body = b"".join(server.serve(environ, start_response))
    if not captured["status"].startswith("200"):
        raise RuntimeError(f"{path}: {captured['status']}")
    return body.decode("utf-8")


def localize(html: str, depth: int) -> str:
    """The only two edits applied to upstream's HTML."""
    base = "../" * depth or "./"
    out = html.replace("<head>", f'<head>\n    <base href="{base}">', 1)
    assert out != html, "no <head> found"
    # The shim is on every page (not just generator pages): it intercepts links so that
    # navigating between pages keeps the Python worker alive. It only starts Python on
    # generator pages.
    out2 = out.replace("</head>", f"    {SHIM_TAG}\n</head>", 1)
    assert out2 != out, "no </head> found"
    return out2


def write(rel: str, text: str) -> None:
    p = SITE / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def build_pages() -> int:
    names = sorted(server.boxes)
    lowered = {n.lower() for n in names}
    assert len(lowered) == len(names), "generator names collide on case-insensitive filesystems"
    assert not ({"gallery", "menu", "static", "shim", "py"} & lowered), "generator name clashes with a site directory"

    gallery = fetch("/")  # "" and "Gallery" are the same page upstream
    write("index.html", localize(gallery, 0))
    write("Gallery/index.html", localize(fetch("/Gallery"), 1))
    write("Menu/index.html", localize(fetch("/Menu"), 1))
    for name in names:
        write(f"{name}/index.html", localize(fetch(f"/{name}"), 1))
    return len(names)


def copy_static() -> None:
    shutil.copytree(CLONE / "static", SITE / "static")


def build_pysrc() -> Path:
    """Zip the python package + the server module for Pyodide to unpack."""
    out = SITE / "py" / "boxes-src.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted((CLONE / "boxes").rglob("*.py")):
            if "__pycache__" in p.parts:
                continue
            z.write(p, Path("boxes") / p.relative_to(CLONE / "boxes"))
        z.write(CLONE / "scripts" / "boxesserver", "boxesserver_mod.py")
    return out


def copy_shim() -> None:
    shutil.copytree(REPO / "shim", SITE / "shim")


def main() -> None:
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir()
    n = build_pages()
    copy_static()
    zpath = build_pysrc()
    copy_shim()
    print(f"pages: {n} generators + index/Gallery/Menu")
    print(f"static: {sum(f.stat().st_size for f in (SITE / 'static').rglob('*') if f.is_file()) / 1e6:.1f} MB")
    print(f"python source zip: {zpath.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
