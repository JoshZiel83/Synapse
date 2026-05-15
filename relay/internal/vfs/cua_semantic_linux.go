//go:build linux

package vfs

import "github.com/PekingSpades/Synapse/relay/internal/relaypaths"

func newCUASemanticProvider(paths relaypaths.ResolvedPaths) cuaSemanticProvider {
	return &scriptCUASemanticProvider{
		backend:     "atspi",
		interpreter: "python3",
		extension:   ".py",
		tempRoot:    semanticProviderTempRoot(paths),
		script: `#!/usr/bin/env python3
import json
import sys

MAX_NODES = 800

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))

def clip(value, limit=240):
    text = str("" if value is None else value).replace("\n", " ").strip()
    if not text:
        return ""
    return text if len(text) <= limit else text[:limit] + "…"

try:
    import pyatspi
except Exception as exc:
    emit({
        "supported": False,
        "backend": "atspi",
        "message": "pyatspi is unavailable: %s" % clip(exc, 200),
        "rootIds": [],
        "nodes": []
    })
    sys.exit(0)

def safe_role(acc):
    try:
        return clip(acc.getRoleName(), 120)
    except Exception:
        return ""

def safe_name(acc):
    try:
        return clip(acc.name, 200)
    except Exception:
        return ""

def safe_desc(acc):
    try:
        return clip(acc.description, 200)
    except Exception:
        return ""

def safe_text(acc):
    try:
        text_iface = acc.queryText()
        return clip(text_iface.getText(0, min(text_iface.characterCount, 160)), 200)
    except Exception:
        return ""

def safe_value(acc):
    try:
        value_iface = acc.queryValue()
        return clip(value_iface.currentValue, 200)
    except Exception:
        return safe_text(acc)

def safe_states(acc):
    values = []
    try:
        raw = acc.getState().getStates()
    except Exception:
        return values
    for state in raw:
        text = clip(str(state).split('.')[-1].lower(), 80)
        if text and text not in values:
            values.append(text)
    return values

def safe_bounds(acc):
    try:
        component = acc.queryComponent()
        extents = component.getExtents(pyatspi.DESKTOP_COORDS)
        return {
            "x": int(extents.x),
            "y": int(extents.y),
            "w": int(extents.width),
            "h": int(extents.height),
        }
    except Exception:
        return {"x": 0, "y": 0, "w": 0, "h": 0}

def iter_children(acc):
    try:
        count = int(acc.childCount)
    except Exception:
        count = 0
    for index in range(count):
        try:
            child = acc.getChildAtIndex(index)
        except Exception:
            child = None
        if child is not None:
            yield index, child

def first_focus(acc, limit=MAX_NODES):
    stack = [acc]
    seen = 0
    while stack and seen < limit:
        current = stack.pop()
        seen += 1
        states = safe_states(current)
        if "focused" in states:
            return current
        children = list(iter_children(current))
        for _, child in reversed(children):
            stack.append(child)
    return None

def first_active_window(desktop):
    for _, app in iter_children(desktop):
        for _, child in iter_children(app):
            states = safe_states(child)
            if "active" in states or "focused" in states:
                return child, app
    for _, app in iter_children(desktop):
        for _, child in iter_children(app):
            return child, app
    for _, app in iter_children(desktop):
        return app, app
    return None, None

def ascended_root(acc):
    current = acc
    app = None
    while True:
        try:
            parent = current.parent
        except Exception:
            parent = None
        if parent is None:
            break
        role = safe_role(parent).lower()
        if role == "application":
            app = parent
            break
        current = parent
    return current, app

desktop = pyatspi.Registry.getDesktop(0)
focus = first_focus(desktop)
if focus is not None:
    root, app = ascended_root(focus)
else:
    root, app = first_active_window(desktop)

if root is None:
    emit({
        "supported": False,
        "backend": "atspi",
        "message": "AT-SPI did not return an active accessibility tree. Make sure accessibility support is enabled for the target app.",
        "rootIds": [],
        "nodes": []
    })
    sys.exit(0)

nodes = []
focused_id = ""
truncated = False

def serialize(acc, parent_id, path, depth):
    global focused_id, truncated
    if len(nodes) >= MAX_NODES:
        truncated = True
        return None

    node_id = "root" if not path else ".".join(str(part) for part in path)
    role = safe_role(acc)
    name = safe_name(acc)
    desc = safe_desc(acc)
    value = safe_value(acc)
    text = safe_text(acc)
    states = safe_states(acc)
    if "focused" in states and not focused_id:
        focused_id = node_id
    record = {
        "id": node_id,
        "parentId": parent_id or "",
        "depth": depth,
        "role": role,
        "name": name,
        "description": desc,
        "value": value,
        "text": text,
        "bounds": safe_bounds(acc),
        "state": states,
        "attributes": {},
        "appName": safe_name(app) if app is not None else "",
        "windowTitle": safe_name(root),
        "processId": 0,
        "summary": clip(" ".join(part for part in ["[" + role + "]" if role else "", json.dumps(name) if name else "", json.dumps(value) if value and value != name else ""] if part), 240),
        "childIds": [],
        "actions": []
    }
    nodes.append(record)

    for index, child in iter_children(acc):
        child_id = serialize(child, node_id, path + [index], depth + 1)
        if child_id:
            record["childIds"].append(child_id)
    return node_id

root_id = serialize(root, "", [], 0)
message = ""
if truncated:
    message = "AT-SPI tree was truncated at %d nodes." % MAX_NODES

emit({
    "supported": True,
    "backend": "atspi",
    "message": message,
    "appName": safe_name(app) if app is not None else "",
    "windowTitle": safe_name(root),
    "processId": 0,
    "rootIds": [root_id] if root_id else [],
    "focusedId": focused_id,
    "nodes": nodes
})
`,
	}
}
