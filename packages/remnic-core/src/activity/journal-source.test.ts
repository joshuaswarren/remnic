import assert from "node:assert/strict";
import test from "node:test";

import { resolveJournalSource } from "./journal-source.js";

test("source memoryDir resolves to memoryDir mode", () => {
  assert.deepEqual(resolveJournalSource({ source: "memoryDir" }), {
    ok: true,
    mode: "memoryDir",
  });
});

test("source vault resolves to vault mode", () => {
  assert.deepEqual(resolveJournalSource({ source: "vault" }), {
    ok: true,
    mode: "vault",
  });
});

test("legacy source file aliases memoryDir", () => {
  assert.deepEqual(resolveJournalSource({ source: "file" }), {
    ok: true,
    mode: "memoryDir",
    deprecatedAlias: "file",
  });
});

test("unknown source is unknown_source", () => {
  assert.deepEqual(resolveJournalSource({ source: "" }), {
    ok: false,
    error: "unknown_source",
  });
  assert.deepEqual(resolveJournalSource({ source: "disk" }), {
    ok: false,
    error: "unknown_source",
  });
});
