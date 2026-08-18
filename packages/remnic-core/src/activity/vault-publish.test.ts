import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyManagedRegion, publishVaultRegion } from "./vault-publish.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

function withVault(fn: (vaultPath: string) => void): void {
  const vaultPath = mkdtempSync(path.join(tmpdir(), "remnic-vault-"));
  try {
    fn(vaultPath);
  } finally {
    rmSync(vaultPath, { recursive: true, force: true });
  }
}

test("applyManagedRegion replaces only the marked region", () => {
  const fileText = [
    "---",
    "title: daily",
    "---",
    "",
    "human notes",
    START,
    "old cards",
    END,
    "more human",
    "",
  ].join("\n");
  const result = applyManagedRegion(fileText, {
    strategy: "markers",
    name: "timeline",
    content: "new cards",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.text,
    [
      "---",
      "title: daily",
      "---",
      "",
      "human notes",
      START,
      "new cards",
      END,
      "more human",
      "",
    ].join("\n"),
  );
});

test("applyManagedRegion is a no-op when markers are missing", () => {
  const fileText = "no managed region here\n";
  const result = applyManagedRegion(fileText, {
    strategy: "markers",
    name: "timeline",
    content: "new cards",
  });
  assert.deepEqual(result, { ok: false, reason: "no_marker", text: fileText });
});

test("applyManagedRegion preserves CRLF outside and inside the owned region", () => {
  const fileText = [
    "---",
    "title: daily",
    "---",
    "",
    "human notes",
    START,
    "old cards",
    END,
    "more human",
    "",
  ].join("\r\n");
  const result = applyManagedRegion(fileText, {
    strategy: "markers",
    name: "timeline",
    content: "new cards\nline two",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.text,
    [
      "---",
      "title: daily",
      "---",
      "",
      "human notes",
      START,
      "new cards",
      "line two",
      END,
      "more human",
      "",
    ].join("\r\n"),
  );
  assert.equal(result.text.includes("\n") && !result.text.includes("\r\n"), false);
});

test("applyManagedRegion keeps every outside byte identical", () => {
  const prefix = "---\nkeep: me\n---\n\n- [ ] task\n```dataview\nLIST\n```\n";
  const suffix = "\n<!-- other-agent:start -->\nleave this\n<!-- other-agent:end -->\n  trailing  \n";
  const fileText = `${prefix}${START}\nold\n${END}${suffix}`;
  const startAt = fileText.indexOf(START);
  const endAt = fileText.indexOf(END);
  const before = Buffer.from(fileText.slice(0, startAt + START.length), "utf8");
  const after = Buffer.from(fileText.slice(endAt), "utf8");
  const result = applyManagedRegion(fileText, {
    strategy: "markers",
    name: "timeline",
    content: "replacement",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const nextStart = result.text.indexOf(START);
  const nextEnd = result.text.indexOf(END);
  assert.deepEqual(Buffer.from(result.text.slice(0, nextStart + START.length), "utf8"), before);
  assert.deepEqual(Buffer.from(result.text.slice(nextEnd), "utf8"), after);
});

test("publishVaultRegion updates an existing note and skips an unchanged rewrite", () => {
  withVault((vaultPath) => {
    const relativeFile = "Daily Notes/2026-08-17.md";
    const dest = path.join(vaultPath, relativeFile);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, `intro\n${START}\nold\n${END}\noutro\n`);
    const first = publishVaultRegion({
      vaultPath,
      relativeFile,
      name: "timeline",
      content: "new cards",
    });
    assert.deepEqual(first, { ok: true, status: "updated" });
    assert.equal(readFileSync(dest, "utf8"), `intro\n${START}\nnew cards\n${END}\noutro\n`);
    const mtime = statSync(dest).mtimeMs;
    const second = publishVaultRegion({
      vaultPath,
      relativeFile,
      name: "timeline",
      content: "new cards",
    });
    assert.deepEqual(second, { ok: true, status: "unchanged" });
    assert.equal(statSync(dest).mtimeMs, mtime);
  });
});

test("publishVaultRegion never creates a missing file", () => {
  withVault((vaultPath) => {
    const relativeFile = "missing.md";
    const result = publishVaultRegion({
      vaultPath,
      relativeFile,
      name: "timeline",
      content: "new cards",
    });
    assert.deepEqual(result, { ok: false, reason: "missing_file" });
    assert.equal(existsSync(path.join(vaultPath, relativeFile)), false);
  });
});
