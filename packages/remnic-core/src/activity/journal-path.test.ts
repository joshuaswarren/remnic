import assert from "node:assert/strict";
import test from "node:test";

import { parseJournalFilePath } from "./journal-path.js";

test("parseJournalFilePath accepts a relative path", () => {
  assert.deepEqual(parseJournalFilePath("journal/2026-08-19.md"), {
    ok: true,
    path: "journal/2026-08-19.md",
  });
  assert.deepEqual(parseJournalFilePath("  notes/today.md  "), {
    ok: true,
    path: "notes/today.md",
  });
});

test("parseJournalFilePath rejects an empty path", () => {
  assert.deepEqual(parseJournalFilePath(""), { ok: false, error: "missing_path" });
  assert.deepEqual(parseJournalFilePath("   "), { ok: false, error: "missing_path" });
});

test("parseJournalFilePath rejects ..", () => {
  assert.deepEqual(parseJournalFilePath("../secret"), { ok: false, error: "invalid_path" });
  assert.deepEqual(parseJournalFilePath("foo/../bar"), { ok: false, error: "invalid_path" });
});
