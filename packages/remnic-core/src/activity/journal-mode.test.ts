import assert from "node:assert/strict";
import test from "node:test";

import { parseJournalMode } from "./journal-mode.js";

test("file is allowed", () => {
  assert.deepEqual(parseJournalMode("file"), {
    ok: true,
    mode: "file",
  });
});

test("vault is allowed", () => {
  assert.deepEqual(parseJournalMode("vault"), {
    ok: true,
    mode: "vault",
  });
});

test("unknown mode is unknown_mode", () => {
  assert.deepEqual(parseJournalMode("memoryDir"), {
    ok: false,
    error: "unknown_mode",
  });
});

test("empty mode is unknown_mode", () => {
  assert.deepEqual(parseJournalMode(""), {
    ok: false,
    error: "unknown_mode",
  });
});
