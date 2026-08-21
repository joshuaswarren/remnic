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

test("applyManagedRegion heading replaces only the named section", () => {
  const fileText = [
    "---",
    "title: daily",
    "---",
    "",
    "scratchpad",
    "## Timeline",
    "old cards",
    "## Notes",
    "keep me",
    "",
  ].join("\n");
  const result = applyManagedRegion(fileText, {
    strategy: "heading",
    name: "Timeline",
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
      "scratchpad",
      "## Timeline",
      "new cards",
      "## Notes",
      "keep me",
      "",
    ].join("\n"),
  );

  const crlf = fileText.replace(/\n/g, "\r\n");
  const crlfResult = applyManagedRegion(crlf, {
    strategy: "heading",
    name: "Timeline",
    content: "new cards\nline two",
  });
  assert.equal(crlfResult.ok, true);
  if (!crlfResult.ok) return;
  assert.equal(
    crlfResult.text,
    [
      "---",
      "title: daily",
      "---",
      "",
      "scratchpad",
      "## Timeline",
      "new cards",
      "line two",
      "## Notes",
      "keep me",
      "",
    ].join("\r\n"),
  );

  const prefix = "---\nkeep: me\n---\n\nscratchpad\n## Timeline";
  const suffix = "\n## Notes\nkeep me\n";
  const outside = `${prefix}\nold\n${suffix}`;
  const headingAt = outside.indexOf("## Timeline");
  const notesAt = outside.indexOf("\n## Notes");
  const headingLineEnd = headingAt + "## Timeline".length;
  const before = Buffer.from(outside.slice(0, headingLineEnd), "utf8");
  const after = Buffer.from(outside.slice(notesAt), "utf8");
  const byteResult = applyManagedRegion(outside, {
    strategy: "heading",
    name: "Timeline",
    content: "replacement",
  });
  assert.equal(byteResult.ok, true);
  if (!byteResult.ok) return;
  const nextHeading = byteResult.text.indexOf("## Timeline");
  const nextNotes = byteResult.text.indexOf("\n## Notes");
  assert.deepEqual(Buffer.from(byteResult.text.slice(0, nextHeading + "## Timeline".length), "utf8"), before);
  assert.deepEqual(Buffer.from(byteResult.text.slice(nextNotes), "utf8"), after);
});

test("applyManagedRegion heading is a no-op when the heading is missing", () => {
  const fileText = "# Daily\n\nno timeline here\n";
  const result = applyManagedRegion(fileText, {
    strategy: "heading",
    name: "Timeline",
    content: "new cards",
  });
  assert.deepEqual(result, { ok: false, reason: "no_heading", text: fileText });
});

test("applyManagedRegion heading refuses duplicate headings and lists line numbers", () => {
  const fileText = ["# Daily", "", "## Timeline", "first", "", "## Timeline", "second", ""].join("\n");
  const result = applyManagedRegion(fileText, {
    strategy: "heading",
    name: "Timeline",
    content: "new cards",
  });
  assert.deepEqual(result, { ok: false, reason: "duplicate_heading", lines: [3, 6], text: fileText });
});

test("applyManagedRegion heading demotes owned headings below the owning heading, clamped at six", () => {
  const first = applyManagedRegion("## Timeline\nold\n\n## Notes\nkeep\n", {
    strategy: "heading",
    name: "Timeline",
    content: "# Journal\n\n## Cards\n\n- a",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.text, "## Timeline\n### Journal\n\n#### Cards\n\n- a\n## Notes\nkeep\n");

  const second = applyManagedRegion(first.text, {
    strategy: "heading",
    name: "Timeline",
    content: "# Journal\n\n## Cards\n\n- a",
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.text, first.text);

  // A recap heading already at six stays six — still strictly deeper than
  // a level-2 owning heading, so it cannot terminate the region either.
  const clamped = applyManagedRegion("## Timeline\nold\n", {
    strategy: "heading",
    name: "Timeline",
    content: "###### deep",
  });
  assert.equal(clamped.ok, true);
  if (!clamped.ok) return;
  assert.equal(clamped.text, "## Timeline\n###### deep\n");
});

test("applyManagedRegion heading under a level-6 owner flattens owned headings to bold text", () => {
  const first = applyManagedRegion("###### Timeline\nold\n", {
    strategy: "heading",
    name: "Timeline",
    content: "# Journal\nbody",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.text, "###### Timeline\n**Journal**\nbody\n");

  const second = applyManagedRegion(first.text, {
    strategy: "heading",
    name: "Timeline",
    content: "# Journal\nbody",
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.text, first.text);
});
