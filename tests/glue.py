# Browser-side glue API for Boxes.py running under Pyodide.
# Exposes three functions called from JS:
#   list_generators()        -> JSON str: {"module.Class": {"group", "desc", "ok"}}
#   get_form_spec(gen_key)   -> JSON str describing the generator's argparse fields
#   render_generator(gen_key, params_json) -> SVG (or other format) as str
#
# This mirrors what scripts/boxesserver does per request, minus everything
# that needs a server (static files, caching, QR links, pstoedit conversion).

import importlib
import inspect
import json
import pkgutil
import sys

import boxes
import boxes.generators


def _load_class(gen_key):
    module_name, class_name = gen_key.rsplit(".", 1)
    module = importlib.import_module(module_name)
    return getattr(module, class_name)


def list_generators():
    """Fault-tolerant variant of boxes.generators.getAllBoxGenerators().

    Upstream imports every module in one go; here a module with an unmet
    dependency is reported as broken instead of killing the whole listing.
    """
    result = {}
    for _, modname, _ in pkgutil.walk_packages(
            path=boxes.generators.__path__, prefix="boxes.generators."):
        if modname.split(".")[-1].startswith("_"):
            continue
        try:
            module = importlib.import_module(modname)
        except Exception as e:
            result[modname] = {"group": "Broken", "desc": f"import failed: {e}", "ok": False}
            continue
        for k, v in vars(module).items():
            if (inspect.isclass(v) and v is not boxes.Boxes
                    and issubclass(v, boxes.Boxes)
                    and v.__name__[0] != "_"
                    and v.__module__ == modname):
                group = getattr(v, "ui_group", None)
                group_name = getattr(group, "name", "Misc") if group else "Misc"
                result[f"{modname}.{v.__name__}"] = {
                    "group": group_name,
                    "desc": inspect.cleandoc(v.__doc__ or "").split("\n")[0],
                    "ok": True,
                }
    return json.dumps(result)


def _json_default(value):
    return str(value)


def get_form_spec(gen_key):
    """Serialize a generator's argparse configuration to JSON.

    Mirrors the metadata boxesserver's args2html() uses to build its forms.
    """
    cls = _load_class(gen_key)
    box = cls()
    groups = []
    for group in box.argparser._action_groups:
        actions = []
        for a in group._group_actions:
            if a.dest in ("help", "output", "debug"):
                continue  # CLI-only arguments, meaningless in the browser
            default = a.default
            if default is not None and not isinstance(default, (int, float, str, bool)):
                default = str(default)
            actions.append({
                "dest": a.dest,
                "help": a.help or "",
                "default": default,
                "choices": list(a.choices) if a.choices else None,
                # type can be a builtin (float), a class (BoolArg) or an
                # instance (ArgparseEdgeType / argparseSections)
                "type": getattr(a.type, "__name__", None) or
                        (a.type.__class__.__name__ if a.type else None),
            })
        if actions:
            groups.append({"title": group.title or "", "actions": actions})
    return json.dumps({"groups": groups}, default=_json_default)


def render_generator(gen_key, params_json):
    """Render a generator to a string (SVG by default).

    Same call sequence as boxesserver.serve(): parseArgs -> open -> render
    -> close, with reproducible=True like the upstream regression tests.
    """
    params = json.loads(params_json)
    args = [f"--{k}={v}" for k, v in params.items()]
    cls = _load_class(gen_key)
    box = cls()
    box.parseArgs(args)
    box.metadata["reproducible"] = True
    box.open()
    box.render()
    data = box.close()
    return data.getvalue().decode()
