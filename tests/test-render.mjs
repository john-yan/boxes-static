// Smoke test: can Boxes.py render inside Pyodide (Node)?
// Answers the feasibility unknowns for the browser port:
//   1. do shapely/affine load?            (needed by boxes/__init__.py)
//   2. can qrcode be micropip-installed?  (module-level import in boxes)
//   3. does a real generator produce an SVG?

import { loadPyodide } from "pyodide";
import { fileURLToPath } from "node:url";

const UPSTREAM = process.env.BOXES_SRC ?? fileURLToPath(new URL("../upstream", import.meta.url));

const t0 = Date.now();
const py = await loadPyodide();
console.log(`[timing] pyodide booted in ${Date.now() - t0} ms`);

// --- 1. load compiled deps from the pyodide distribution
// affine is deliberately NOT loaded here: the dist ships v2.4.0 but upstream
// boxes migrated to the affine v3 API (Affine @ tuple), so v3 comes from PyPI below.
const t1 = Date.now();
for (const pkg of ["shapely", "typing-extensions", "micropip"]) {
  await py.loadPackage(pkg);
}
console.log(`[timing] shapely loaded in ${Date.now() - t1} ms`);

// --- 2. pure-Python deps not in (or outdated in) the distribution: install via micropip
const t2 = Date.now();
await py.runPythonAsync(`
import micropip
await micropip.install(["qrcode", "affine>=3.0.1"])
import qrcode, affine
print("[ok] qrcode imported, affine", affine.__version__)
`);
console.log(`[timing] qrcode installed in ${Date.now() - t2} ms`);

// --- 3. mount the upstream clone and render ClosedBox
py.FS.mkdir("/host");
py.FS.mount(py.FS.filesystems.NODEFS, { root: UPSTREAM }, "/host");

const t3 = Date.now();
py.runPython(`
import sys
sys.path.insert(0, "/host")

import boxes
print("[ok] boxes imported from", boxes.__file__)

from boxes.generators.closedbox import ClosedBox
b = ClosedBox()
b.parseArgs(["--x=80", "--y=60", "--h=50"])
b.metadata["url"] = "https://example.org/prototype"
b.open()
b.render()
data = b.close()
svg = data.getvalue().decode() if hasattr(data, "getvalue") else str(data)
assert svg.startswith("<?xml") or svg.startswith("<svg"), "output does not look like SVG"
print(f"[ok] rendered ClosedBox: {len(svg)} chars of SVG")
`);
console.log(`[timing] import+render in ${Date.now() - t3} ms`);

// hand the SVG string back to JS to prove the boundary works
const svg = py.globals.get("svg").toString();
console.log("[ok] SVG crossed the Python->JS boundary:", svg.slice(0, 80).replace(/\n/g, " "), "...");

// --- 4. golden test: byte-for-byte comparison against the upstream reference SVG
// replicates tests/test_svg.py::test_default_generator exactly
const t4 = Date.now();
py.runPython(`
from boxes.generators.closedbox import ClosedBox
b = ClosedBox()
b.parseArgs([])
b.metadata["reproducible"] = True
b.open()
b.render()
data = b.close()
default_svg = data.getvalue().decode()
`);
const rendered = py.globals.get("default_svg").toString();
const reference = await import("node:fs/promises").then(fs =>
  fs.readFile(`${UPSTREAM}/examples/ClosedBox.svg`, "utf8"));
console.log(`[timing] default render in ${Date.now() - t4} ms`);

if (rendered === reference) {
  console.log("[ok] byte-for-byte IDENTICAL to upstream examples/ClosedBox.svg");
} else {
  console.log(`[FAIL] differs from reference: rendered ${rendered.length} chars vs ${reference.length} chars`);
  // locate first difference for diagnosis
  let i = 0;
  while (i < Math.min(rendered.length, reference.length) && rendered[i] === reference[i]) i++;
  console.log("first diff at char", i);
  console.log("  rendered:", JSON.stringify(rendered.slice(Math.max(0, i - 40), i + 60)));
  console.log("  reference:", JSON.stringify(reference.slice(Math.max(0, i - 40), i + 60)));
  await import("node:fs/promises").then(fs =>
    fs.writeFile("/tmp/closedbox-pyodide.svg", rendered));
  console.log("  (rendered output saved to /tmp/closedbox-pyodide.svg)");
  process.exit(1);
}

console.log("\nALL CHECKS PASSED");
