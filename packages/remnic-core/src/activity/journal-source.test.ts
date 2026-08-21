import assert from "node:assert/strict";
import test from "node:test";

import { resolveJournalSource } from "./journal-source.js";

test("source file resolves to file mode", () => {
  assert.deepEqual(resolveJournalSource({ source: "file", heading: "" }), {
    ok: true,
    mode: "file",
  });
});

test("source vault with a heading resolves to vault mode", () => {
  assert.deepEqual(resolveJournalSource({ source: "vault", heading: "Journal" }), {
    ok: true,
    mode: "vault",
    heading: "Journal",
  });
});

test("source vault with an empty heading is missing_heading", () => {
  assert.deepEqual(resolveJournalSource({ source: "vault", heading: "" }), {
    ok: false,
    error: "missing_heading",
  });
  assert.deepEqual(resolveJournalSource({ source: "vault", heading: "   " }), {
    ok: false,
    error: "missing_heading",
  });
});

test("unknown source is unknown_source", () => {
  assert.deepEqual(resolveJournalSource({ source: "memoryDir", heading: "Journal" }), {
    ok: false,
    error: "unknown_source",
  });
});
