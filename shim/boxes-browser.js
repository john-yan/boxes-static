// Browser shim for the pre-rendered Boxes.py generator pages.
//
// Loaded AFTER upstream's static/self.js (which stays unmodified). It replaces
// only what needed a server:
//   1. refreshPreview()    - self.js points <img src> at "<action>?...&render=4"
//   2. the form buttons    - Generate / Download / Save to URL / QR Code (render=1/2/0/3)
//   3. form pre-fill       - the server filled the form from the query string
//   4. page-specific init  - self.js picks TrayLayout/PhotoFrame/... from the last
//                            path segment, which is empty under "<Name>/" URLs
//   5. in-page navigation  - links between Gallery/Menu/generator pages swap the page
//                            content instead of reloading, so the Python worker (which
//                            takes seconds to boot) survives. Falls back to a normal
//                            page load on any problem.
// All rendering is delegated to a Pyodide worker that runs upstream's BServer.

(() => {
  "use strict";

  const SHIM_URL = document.currentScript.src;
  const $ = (id) => document.getElementById(id);

  // The pages ship a *relative* <base href="../">. history.pushState() changes the document
  // URL, so freeze the base to the absolute site root once; relative links/actions then keep
  // resolving to the same place no matter which page we are "on".
  const ROOT = new URL(document.baseURI);
  const baseEl = document.querySelector("base");
  if (baseEl) baseEl.href = ROOT.href;

  let lastStatus = ""; // re-shown after a page swap (init progress may arrive while on the Menu)
  let pageGen = 0; // bumped on every page swap; async results from an older page are dropped

  // ---------------------------------------------------------------- worker
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function setStatus(text) {
    lastStatus = text;
    let el = $("boxes-status");
    if (!el) {
      const bar = $("preview_buttons");
      if (!bar) return;
      el = document.createElement("span");
      el.id = "boxes-status";
      el.style.marginLeft = "1em";
      el.setAttribute("role", "status");
      bar.appendChild(el);
    }
    el.textContent = text;
  }

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("py-worker.js", SHIM_URL), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") return setStatus(m.text);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.error));
    };
    worker.onerror = (e) => {
      const err = new Error("Python worker failed to start: " + (e.message || "unknown error"));
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      worker = null; // next request tries again
    };
    return worker;
  }

  function generatorName() {
    // form action is "./<Name>" -> resolved against <base> to ".../<Name>"
    return new URL($("arguments").action).pathname.split("/").filter(Boolean).pop();
  }

  function request(query) {
    const id = ++nextId;
    const basePath = new URL(document.baseURI).pathname.replace(/\/$/, "");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      getWorker().postMessage({
        id,
        path: "/" + generatorName(),
        query,
        scheme: location.protocol.replace(":", ""),
        host: location.host,
        prefix: basePath,
      });
    });
  }

  const header = (r, name) =>
    (r.headers.find(([k]) => k.toLowerCase() === name) || [])[1] || "";

  const toBlobUrl = (r) =>
    URL.createObjectURL(new Blob([r.body], { type: header(r, "content-type").split(";")[0] }));

  // --------------------------------------------------------------- preview
  let previewBusy = false;
  let previewPending = null; // latest query that arrived while busy (older ones are dropped)
  let previewUrl = null;

  async function runPreview(query) {
    if (previewBusy) {
      previewPending = query;
      return;
    }
    previewBusy = true;
    const gen = pageGen;
    try {
      const r = await request(query);
      if (gen === pageGen) {
        // else: the user already left this page; its preview must not land on the new one
        const url = toBlobUrl(r);
        $("preview_img").src = url;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = url;
        setStatus(r.status.startsWith("200") ? "" : r.status);
      }
    } catch (e) {
      if (gen === pageGen) setStatus("Error: " + e.message);
    } finally {
      previewBusy = false;
      if (previewPending !== null) {
        const q = previewPending;
        previewPending = null;
        runPreview(q);
      }
    }
  }

  // Same query the original builds (self.js:112), minus the server round trip.
  window.refreshPreview = function refreshPreview() {
    if ($("preview_img").hidden || $("preview").hidden) return;
    const data = new FormData($("arguments"));
    data.set("format", "svg");
    runPreview(new URLSearchParams(data).toString() + "&render=4");
  };

  // --------------------------------------------------------------- buttons
  function download(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const form = ev.target;
    const submitter = ev.submitter;
    const params = new URLSearchParams(new FormData(form, submitter));
    if (!params.has("render")) params.set("render", "1"); // implicit submit (Enter key)
    const mode = params.get("render");

    if (mode === "0") {
      // "Save to URL": the original reloads the page with the values in the query.
      // pathname is used on purpose - a relative "?..." would resolve against <base>.
      history.replaceState(null, "", location.pathname + "?" + params.toString());
      shown = location.pathname + location.search;
      return;
    }

    // Open the tab synchronously (inside the click) or popup blockers refuse it later.
    const win = submitter && submitter.formTarget === "_blank" ? window.open("", "_blank") : null;
    if (win) win.document.body.textContent = "Rendering… (the first request loads the Python runtime, ~10 s)";
    setStatus("Rendering…");
    try {
      const r = await request(params.toString());
      const url = toBlobUrl(r);
      const disposition = header(r, "content-disposition");
      const m = /filename="?([^";]+)"?/.exec(disposition);
      if (/attachment/i.test(disposition) || !win) {
        win && win.close();
        download(url, m ? m[1] : generatorName() + ".svg");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        win.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      setStatus(r.status.startsWith("200") ? "" : r.status);
    } catch (e) {
      win && win.close();
      setStatus("Error: " + e.message);
    }
  }

  // ---------------------------------------------------------- form pre-fill
  const truthy = (v) => !["", "none", "0", "off", "false"].includes(v.toLowerCase()); // BoolArg

  function prefillFromQuery() {
    const form = $("arguments");
    const last = new Map();
    for (const [k, v] of new URLSearchParams(location.search)) last.set(k, v); // last wins, like argparse
    for (const [k, v] of last) {
      if (k === "render" || k === "language" || v === "") continue;
      const el = form.elements.namedItem(k);
      if (!el) continue;
      if (el instanceof RadioNodeList) {
        // BoolArg renders a hidden "0" plus a checkbox under one name
        for (const e of el) if (e.type === "checkbox") e.checked = truthy(v);
      } else if (el.type === "checkbox") {
        el.checked = truthy(v);
      } else if (el.tagName === "SELECT") {
        if ([...el.options].some((o) => o.value === v)) el.value = v;
      } else {
        el.value = v;
      }
    }
  }

  // self.js addCallbacks() keys on the last path segment ("TrayLayout"), which is
  // empty for "<Name>/". Only compensate in that case to avoid double init.
  const PAGE_INIT = {
    TrayLayout: "TrayLayoutInit",
    GridfinityTrayLayout: "GridfinityTrayLayoutInit",
    PhotoFrame: "PhotoFrameInit",
  };

  // Everything a generator page needs on top of upstream's own init. `swapped` = the page was
  // inserted by in-page navigation, so self.js's DOMContentLoaded hook never ran for it.
  function setupGeneratorPage(swapped) {
    const form = $("arguments");
    if (!form) return; // Gallery / Menu
    prefillFromQuery();
    form.addEventListener("submit", onSubmit);
    if (swapped || location.pathname.endsWith("/")) {
      const init = window[PAGE_INIT[generatorName()]];
      if (typeof init === "function") init();
    }
  }

  document.addEventListener("DOMContentLoaded", () => setupGeneratorPage(false));

  // ------------------------------------------------------- in-page navigation
  const RESERVED = new Set(["static", "shim", "py"]);
  const ONLOAD_RE = /^\s*(initPage|initArgsPage)\(\s*(\d*)\s*\)\s*;?\s*$/; // the only body onloads upstream emits
  let shown = location.pathname + location.search; // what the current content corresponds to
  let navToken = 0;

  // "ClosedBox" / "Menu" / "" (Gallery) for same-site page URLs; null for anything else
  // (external, static files, other paths) - those are left to the browser.
  function pageRel(url) {
    if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return null;
    const rest = url.pathname.slice(ROOT.pathname.length);
    if (rest === "") return "";
    const m = /^([A-Za-z0-9_]+)\/?$/.exec(rest);
    return m && !RESERVED.has(m[1]) ? m[1] : null;
  }

  function swapIn(doc, pageUrl, push) {
    const onload = doc.body.getAttribute("onload");
    const m = onload && ONLOAD_RE.exec(onload);
    if (onload && !m) throw new Error("unrecognised body onload: " + onload); // checked before touching the page
    doc.body.removeAttribute("onload"); // would be wired to window.onload; it has already fired

    pageGen++;
    previewPending = null;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    if (push) history.pushState(null, "", pageUrl);
    shown = location.pathname + location.search;
    document.title = doc.title;
    document.body.replaceWith(doc.body);

    window.preview_scale = 100; // upstream global, initialised once at script load
    window.scrollTo(0, 0);
    setupGeneratorPage(true);
    // what the browser would have done for <body onload="...">
    if (m) window[m[1]](m[2] === "" ? undefined : Number(m[2]));
    if (lastStatus) setStatus(lastStatus);
  }

  async function navigate(url, push) {
    const token = ++navToken;
    const rel = pageRel(url);
    try {
      if (rel === null) throw new Error("not a site page");
      const dir = rel ? rel + "/" : "";
      const resp = await fetch(new URL(dir + "index.html", ROOT));
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const doc = new DOMParser().parseFromString(await resp.text(), "text/html");
      if (token !== navToken) return; // a newer navigation superseded this one
      swapIn(doc, ROOT.pathname + dir + url.search, push);
    } catch (e) {
      if (token !== navToken) return;
      console.warn("in-page navigation failed, doing a normal page load:", e);
      location.assign(url.href);
    }
  }

  document.addEventListener("click", (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest && ev.target.closest("a[href]");
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const url = new URL(a.href);
    if (pageRel(url) === null) return;
    if (url.pathname + url.search === shown && url.hash) return; // same-page anchor
    ev.preventDefault();
    navigate(url, true);
  });

  window.addEventListener("popstate", () => {
    if (location.pathname + location.search === shown) return; // hash-only change
    navigate(new URL(location.href), false);
  });
})();
