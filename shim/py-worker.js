// Web Worker (module): runs upstream's BServer inside Pyodide.
//
// The page shim sends {id, path, query, scheme, host, prefix}; the worker
// calls BServer.serve() as a WSGI app - the very code that answers
// ?render=1|2|3|4 on the real server - and returns {status, headers, body}.
// Nothing about rendering, error SVGs, QR codes or download file names is
// re-implemented here.

const PYODIDE_VERSION = "314.0.8";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const progress = (text) => postMessage({ type: "progress", text });

const PY_INIT = `
import sys
sys.path.insert(0, "/pysrc")
import boxesserver_mod as bs

def handle(path, query, scheme, host, prefix):
    bs.boxserver.url_prefix = prefix
    out = {}

    def start_response(status, headers, exc_info=None):
        out["status"] = status
        out["headers"] = [list(h) for h in headers]

    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "HTTP_HOST": host,
        "SERVER_NAME": host.split(":")[0],
        "SERVER_PORT": "443" if scheme == "https" else "80",
        "HTTP_ACCEPT_LANGUAGE": "",
        "wsgi.url_scheme": scheme,
        "wsgi.file_wrapper": lambda f, block_size: [f.read()],
    }
    body = b"".join(bs.boxserver.serve(environ, start_response))
    return out["status"], out["headers"], body
`;

async function init() {
  progress("Loading Python runtime…");
  const { loadPyodide } = await import(`${CDN}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: CDN });

  progress("Loading compiled libraries (shapely, pillow)…");
  // One name per call: a multi-name loadPackage() silently dropped packages in testing.
  for (const pkg of ["shapely", "pillow", "typing-extensions", "micropip"]) {
    await py.loadPackage(pkg);
  }

  progress("Installing pure-Python dependencies…");
  // affine is pinned: Pyodide's own copy is 2.4.0 but boxes needs the v3 API.
  await py.runPythonAsync(`
import micropip
await micropip.install(["markdown", "qrcode", "affine>=3.0.1"])
`);

  progress("Loading Boxes.py…");
  const zip = await (await fetch(new URL("../py/boxes-src.zip", import.meta.url))).arrayBuffer();
  py.unpackArchive(zip, "zip", { extractDir: "/pysrc" });
  py.runPython(PY_INIT);
  progress("");
  return py;
}

let ready = null;

self.onmessage = async (e) => {
  const { id, path, query, scheme, host, prefix } = e.data;
  const fail = (err) =>
    postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });

  let py;
  try {
    ready ??= init();
    py = await ready;
  } catch (err) {
    ready = null; // a failed init (e.g. offline) must be retried by the next request
    return fail(err);
  }

  try {
    const handle = py.globals.get("handle");
    const result = handle(path, query, scheme, host, prefix);
    const [status, headers, body] = result.toJs();
    result.destroy();
    handle.destroy();
    postMessage({ id, ok: true, status, headers, body }, [body.buffer]);
  } catch (err) {
    fail(err);
  }
};
