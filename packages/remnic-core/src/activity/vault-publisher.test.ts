import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { publishVaultNote } from "./vault-publisher.js";

const DATE = "2026-08-21";

/**
 * Fixture daily note shaped like a real vault user's: frontmatter, human
 * sections, a foreign agent's owned section, and a Remnic marker pair.
 * Synthetic data only (public repo).
 */
const NOTE = [
  "---",
  "tags: daily-notes",
  "mood: good",
  "---",
  "# Friday",
  "",
  "scratchpad text that must never change",
  "",
  "## Tasks",
  "",
  "- [ ] water the plants",
  "",
  "<!-- other-agent:section:start -->",
  "foreign body",
  "<!-- other-agent:section:end -->",
  "",
  "<!-- remnic:timeline:start -->",
  "stale recap",
  "<!-- remnic:timeline:end -->",
  "",
  "trailing human text",
  "",
].join("\n");

function makeVault(): { vault: string; notePath: string } {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, "Daily Notes", "2026", "08", `${DATE}.md`);
  mkdirSync(path.dirname(notePath), { recursive: true });
  writeFileSync(notePath, NOTE, "utf8");
  return { vault, notePath };
}

test("publishVaultNote updates only the managed region and preserves every other byte", () => {
  const { vault, notePath } = makeVault();
  const before = readFileSync(notePath, "utf8");
  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "Daily Notes/{yyyy}/{MM}/{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: code review (42m)\n- card-b: writing (18m)" }],
  });

  assert.equal(status.counts.updated, 1);
  assert.equal(status.results[0]?.outcome, "updated");

  const after = readFileSync(notePath, "utf8");
  const startMarker = "<!-- remnic:timeline:start -->";
  const endMarker = "<!-- remnic:timeline:end -->";
  const beforeStart = before.slice(0, before.indexOf(startMarker));
  const afterEnd = before.slice(before.indexOf(endMarker) + endMarker.length);
  assert.equal(after.slice(0, after.indexOf(startMarker)), beforeStart);
  assert.equal(after.slice(after.indexOf(endMarker) + endMarker.length), afterEnd);
  assert.match(after, /- card-a: code review \(42m\)/);
  assert.doesNotMatch(after, /stale recap/);
  assert.equal(after.match(/---/g)?.length, 2, "frontmatter delimiters untouched");
});

test("republishing unchanged content performs no write (mtime preserved)", () => {
  const { vault, notePath } = makeVault();
  const content = "- card-a: code review (42m)";
  publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "Daily Notes/{yyyy}/{MM}/{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content }],
  });
  const mtimeAfterFirst = statSync(notePath).mtimeMs;
  const second = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "Daily Notes/{yyyy}/{MM}/{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content }],
  });
  assert.equal(second.counts.unchanged, 1);
  assert.equal(statSync(notePath).mtimeMs, mtimeAfterFirst);
});

test("dry-run reports the would-be outcome and writes nothing", () => {
  const { vault, notePath } = makeVault();
  const before = readFileSync(notePath, "utf8");
  const mtime = statSync(notePath).mtimeMs;
  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "Daily Notes/{yyyy}/{MM}/{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap" }],
    dryRun: true,
  });
  assert.equal(status.counts.updated, 1);
  assert.equal(readFileSync(notePath, "utf8"), before);
  assert.equal(statSync(notePath).mtimeMs, mtime);
});

test("a crossed begin/end marker pair is refused and the file is untouched", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  const crossed = [
    "<!-- remnic:timeline:start -->",
    "stale recap",
    "<!-- remnic:standup:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, crossed, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.match(status.results[0]?.reason ?? "", /name_mismatch:timeline:standup/);
  assert.equal(readFileSync(notePath, "utf8"), crossed);
});

test("a symlink inside the vault pointing outside is refused before any write", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, "Daily Notes", "2026", "08", `${DATE}.md`);
  mkdirSync(path.dirname(notePath), { recursive: true });
  const outside = mkdtempSync(path.join(tmpdir(), "remnic-vault-outside-"));
  const outsideNote = path.join(outside, `${DATE}.md`);
  writeFileSync(outsideNote, NOTE, "utf8");
  symlinkSync(outsideNote, notePath);

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "Daily Notes/{yyyy}/{MM}/{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "must not land" }],
  });

  assert.equal(status.results[0]?.outcome, "error");
  assert.equal(status.results[0]?.reason, "symlink_escape");
  assert.equal(readFileSync(outsideNote, "utf8"), NOTE);
});
