"""The `Atspi` calls atspi.py makes, answered from the JSON tree in STUB_ATSPI_TREE: a list of applications, each
{pid, children: [frame...]} and each node {name, role, description, text, states, attributes, children}; STUB_ATSPI_LOG names the file that gets the role of every node whose text is read."""
import json
import os


class _States:
    def __init__(self, names):
        self.names = names

    def contains(self, state):
        return state in self.names


class _Node:
    def __init__(self, spec):
        self.spec = spec
        self.kids = [_Node(child) for child in spec.get("children", [])]

    def get_process_id(self):
        return self.spec.get("pid", -1)

    def get_name(self):
        return self.spec.get("name", "")

    def get_role_name(self):
        return self.spec.get("role", "frame")

    def get_description(self):
        return self.spec.get("description", "")

    def get_text_iface(self):
        return self.spec if "text" in self.spec else None

    def get_state_set(self):
        return _States(self.spec.get("states", ["showing"]))

    def get_child_count(self):
        return len(self.kids)

    def get_child_at_index(self, index):
        return self.kids[index]


class _Desktop(_Node):
    def __init__(self):
        super().__init__({"children": json.loads(os.environ["STUB_ATSPI_TREE"])})


class Atspi:
    class StateType:
        SHOWING = "showing"
        ACTIVE = "active"

    class Text:
        @staticmethod
        def get_character_count(node):
            return len(node.spec["text"])

        @staticmethod
        def get_text(node, start, end):
            log = os.environ.get("STUB_ATSPI_LOG")
            if log:
                with open(log, "a") as out:
                    out.write(node.spec.get("role", "") + "\n")
            return node.spec["text"][start:end]

    class Document:
        @staticmethod
        def get_document_attributes(node):
            return node.spec.get("attributes")

    @staticmethod
    def init():
        return None

    @staticmethod
    def get_desktop(index):
        return _Desktop()
