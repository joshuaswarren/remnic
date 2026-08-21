import assert from "node:assert/strict";
import test from "node:test";

import { formatVaultWikilink } from "./vault-wikilink.js";

test("formatVaultWikilink returns a wikilink without the .md suffix", () => {
  assert.equal(formatVaultWikilink("Daily Notes/2026-08-18.md"), "[[Daily Notes/2026-08-18]]");
  assert.equal(formatVaultWikilink("Places/ACME Office"), "[[Places/ACME Office]]");
});

test("formatVaultWikilink rejects absolute paths", () => {
  assert.throws(() => formatVaultWikilink("/abs/note.md"), /absolute/i);
  assert.throws(() => formatVaultWikilink("C:/vault/note.md"), /absolute/i);
});

test("formatVaultWikilink rejects parent segments", () => {
  assert.throws(() => formatVaultWikilink("../outside.md"), /\.\./);
  assert.throws(() => formatVaultWikilink("notes/../../secret.md"), /\.\./);
});

test("formatVaultWikilink rejects empty and newline paths", () => {
  assert.throws(() => formatVaultWikilink(""), /empty/i);
  assert.throws(() => formatVaultWikilink("   "), /empty/i);
  assert.throws(() => formatVaultWikilink(".md"), /empty/i);
  assert.throws(() => formatVaultWikilink("foo\nbar.md"), /newline/i);
  assert.throws(() => formatVaultWikilink("foo\rbar.md"), /newline/i);
});
