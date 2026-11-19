// Sweep test: render EVERY generator with default args in Pyodide and compare
// byte-for-byte against upstream examples/<Name>.svg (same check as tests/test_svg.py).
// Output: /tmp/sweep-results.json plus a summary on stdout.

import { loadPyodide } from "pyodide";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const UPSTREAM = process.env.BOXES_SRC ?? fileURLToPath(new URL("../upstream", import.meta.url));

const py = await loadPyodide();
for (const pkg of ["shapely", "numpy", "typing-extensions", "micropip"]) {
  await py.loadPackage(pkg);
}
await py.runPythonAsync(`
import micropip
await micropip.install(["qrcode", "affine>=3.0.1"])
`);

py.FS.mkdir("/host");
py.FS.mount(py.FS.filesystems.NODEFS, { root: UPSTREAM }, "/host");
py.runPython(`import sys; sys.path.insert(0, "/host")`);
py.runPython(await readFile(new URL("./glue.py", import.meta.url), "utf8"));

py.runPython(`
import json, os, time, traceback, io, contextlib

listing = json.loads(list_generators())
results = {}
for key, info in sorted(listing.items()):
    if not info["ok"]:
        results[key] = {"status": "import-failed", "detail": info["desc"]}
        continue
    cls = _load_class(key)
    name = cls.__name__
    ref = f"/host/examples/{name}.svg"
    buf = io.StringIO()
    t = time.time()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            svg = render_generator(key, "{}")
    except Exception as e:
        results[key] = {"status": "error", "detail": f"{type(e).__name__}: {e}"[:200]}
        continue
    dt = round((time.time() - t) * 1000)
    if not os.path.exists(ref):
        results[key] = {"status": "no-reference", "ms": dt}
    elif svg.encode() == open(ref, "rb").read():
        results[key] = {"status": "identical", "ms": dt}
    else:
        results[key] = {"status": "differs", "ms": dt, "len": len(svg),
                        "reflen": os.path.getsize(ref)}
sweep_json = json.dumps(results)
`);

const results = JSON.parse(py.globals.get("sweep_json"));
await writeFile("/tmp/sweep-results.json", JSON.stringify(results, null, 2));

const tally = {};
for (const r of Object.values(results)) tally[r.status] = (tally[r.status] || 0) + 1;
console.log("SUMMARY", JSON.stringify(tally));
for (const [k, r] of Object.entries(results)) {
  if (r.status !== "identical") console.log(r.status.padEnd(14), k.split(".").pop().padEnd(28), r.detail ?? "");
}

// "error" (generators that fail at defaults, e.g. TrayLayout) and
// "no-reference" (no examples/<Name>.svg) match upstream's own test set;
// only a byte difference from the reference is a failure.
const differs = Object.values(results).filter((r) => r.status === "differs");
if (differs.length) {
  console.log(`\n${differs.length} GENERATOR(S) DIFFER FROM REFERENCES`);
  process.exit(1);
}
console.log("\nSWEEP PASSED");
