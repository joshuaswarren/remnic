import assert from "node:assert/strict";
import test from "node:test";

import { joinVaultSegments } from "./vault-join.js";

test("joinVaultSegments joins relative parts with /", () => {
  assert.equal(
    joinVaultSegments(["Daily Notes", "2026", "08", "2026-08-18.md"]),
    "Daily Notes/2026/08/2026-08-18.md",
  );
});

test("joinVaultSegments rejects ..", () => {
  assert.throws(() => joinVaultSegments(["Daily Notes", "..", "secret"]), /\.\./);
  assert.throws(() => joinVaultSegments(["foo/../bar"]), /\.\./);
});

test("joinVaultSegments rejects empty", () => {
  assert.throws(() => joinVaultSegments([]), /empty/i);
  assert.throws(() => joinVaultSegments(["Daily Notes", ""]), /empty/i);
});
