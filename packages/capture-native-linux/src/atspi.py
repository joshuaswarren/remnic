"""Read one window's accessibility tree over AT-SPI and print it as JSON.

Usage: atspi.py --pid PID --title TITLE --max-nodes N [--url-only]
Prints {"found": false} when the process is not on the accessibility bus or when not exactly one of its frames is
named TITLE (a frame of another name may be another window, so it is never read), else
{"found": true, "url": str|null, "root": node} where node is
{role, name, description, text, showing, children}; a password field is {role} alone, and neither its text nor its
name nor anything under it is read. With --url-only the reader reads the document address
and no node name or text, and prints no "root". Exit 3 with one line on stderr when AT-SPI cannot be used.
"""
import argparse
import json
import sys

TEXT_LIMIT = 20000
PASSWORD_ROLE = "password text"

try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except (ImportError, ValueError) as error:
    sys.stderr.write(f"{error}\n")
    sys.exit(3)


def text_of(node):
    if node.get_text_iface() is None:
        return ""
    count = Atspi.Text.get_character_count(node)
    return Atspi.Text.get_text(node, 0, min(count, TEXT_LIMIT)) if count else ""


def read(node, budget):
    budget[0] -= 1
    role = node.get_role_name()
    if role == PASSWORD_ROLE:
        return {"role": role}
    out = {
        "role": role,
        "name": node.get_name() or "",
        "description": node.get_description() or "",
        "text": text_of(node),
        "showing": node.get_state_set().contains(Atspi.StateType.SHOWING),
        "children": [],
    }
    for index in range(node.get_child_count()):
        if budget[0] <= 0:
            break
        child = node.get_child_at_index(index)
        if child is not None:
            out["children"].append(read(child, budget))
    return out


def document_url(node, depth=0):
    """The address of the first web document that is showing under `node`. A hidden document (another tab) is not
    entered, so an address never comes from a page the window does not display."""
    if depth > 0 and not node.get_state_set().contains(Atspi.StateType.SHOWING):
        return None
    if node.get_role_name() == "document web":
        attributes = Atspi.Document.get_document_attributes(node) or {}
        return attributes.get("URI") or attributes.get("DocURL")
    if depth > 20:
        return None
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        found = document_url(child, depth + 1) if child is not None else None
        if found:
            return found
    return None


def pick_frame(apps, title):
    """The one frame named exactly `title`, or None. Another frame of the same process may be a window the caller did not
    ask about, so a title that matches no frame, or more than one, reads nothing."""
    frames = [app.get_child_at_index(i) for app in apps for i in range(app.get_child_count())]
    named = [f for f in frames if f is not None and f.get_name() == title]
    return named[0] if len(named) == 1 else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--max-nodes", type=int, required=True)
    parser.add_argument("--url-only", action="store_true")
    args = parser.parse_args()
    Atspi.init()
    desktop = Atspi.get_desktop(0)
    apps = [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]
    process_apps = [a for a in apps if a is not None and a.get_process_id() == args.pid]
    frame = pick_frame(process_apps, args.title)
    if frame is None:
        print(json.dumps({"found": False}))
        return
    result = {"found": True, "url": document_url(frame)}
    if not args.url_only:
        result["root"] = read(frame, [args.max_nodes])
    print(json.dumps(result))


main()
