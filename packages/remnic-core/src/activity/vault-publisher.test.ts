import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, lstatSync, readFileSync, symlinkSync, statSync, writeFileSync } from "node:fs";
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

test("a crossed pair AFTER a valid pair still refuses the whole note", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // The valid standup pair comes first, so a scan that stops at the first
  // closed region never sees the crossed timeline/weekly pair below it.
  // `applyManagedRegion` would then pair the timeline start with the LAST
  // timeline end and delete every byte in between.
  const note = [
    "<!-- remnic:standup:start -->",
    "standup body",
    "<!-- remnic:standup:end -->",
    "",
    "user content that must survive",
    "",
    "<!-- remnic:timeline:start -->",
    "stale recap",
    "<!-- remnic:weekly:end -->",
    "more user content",
    "<!-- remnic:timeline:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.match(status.results[0]?.reason ?? "", /name_mismatch:timeline:weekly/);
  const after = readFileSync(notePath, "utf8");
  assert.equal(after, note, "every byte of the note is preserved");
  assert.ok(after.includes("user content that must survive"));
  assert.ok(after.includes("more user content"));
  assert.ok(after.includes("<!-- remnic:weekly:end -->"));
});

test("frontmatter updates only match top-level keys, never nested user metadata", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  const note = [
    "---",
    "tags: daily-notes",
    "custom:",
    "  remnic_focus: old",
    "---",
    "<!-- remnic:timeline:start -->",
    "stale recap",
    "<!-- remnic:timeline:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap", properties: { focus: "new" } }],
    propertiesMode: "frontmatter",
  });

  assert.equal(status.results[0]?.outcome, "updated");
  const after = readFileSync(notePath, "utf8");
  assert.ok(after.includes("  remnic_focus: old"), "nested user key is untouched");
  assert.ok(after.includes("\nremnic_focus: new"), "top-level key is inserted");
  assert.ok(after.includes("custom:"));
  assert.ok(after.includes("tags: daily-notes"));
});

test("nested start markers (start:A, start:B, end:A, end:B) refuse the whole note", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // Marker order start:timeline, start:standup, end:timeline, end:standup.
  // A scan that only looks for a mismatched END accepts end:timeline as a
  // valid close and never sees the orphaned end:standup, so
  // `applyManagedRegion` pairs start:timeline with end:timeline and deletes
  // the standup start marker plus every user byte between them.
  const note = [
    "<!-- remnic:timeline:start -->",
    "stale recap",
    "<!-- remnic:standup:start -->",
    "standup body the user wrote",
    "<!-- remnic:timeline:end -->",
    "user content between the ends",
    "<!-- remnic:standup:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.match(status.results[0]?.reason ?? "", /nested_start:timeline:standup/);
  const after = readFileSync(notePath, "utf8");
  assert.equal(after, note, "every byte of the note is preserved");
  // Each intervening byte the crossed replacement would have eaten.
  assert.ok(after.includes("<!-- remnic:standup:start -->"), "inner start marker survives");
  assert.ok(after.includes("standup body the user wrote"), "inner region body survives");
  assert.ok(after.includes("user content between the ends"), "text between the ends survives");
  assert.ok(after.includes("<!-- remnic:standup:end -->"), "inner end marker survives");
  assert.ok(after.includes("stale recap"), "nothing is published over the stale region");
});

test("an orphan end marker with no open region refuses the whole note", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  const note = ["user notes", "<!-- remnic:timeline:end -->", "more user notes", ""].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.match(status.results[0]?.reason ?? "", /orphan_end:timeline/);
  assert.equal(readFileSync(notePath, "utf8"), note);
});

test("colon-bearing marker names cannot delete the user bytes between a malformed pair", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // Marker order start:Work:Timeline, end:Other:Section, end:Work:Timeline.
  // A scanner that captures the name with `[^:]+?` sees NO markers here, so
  // the malformed sequence passes, and `applyManagedRegion` — which pairs by
  // literal `indexOf` — pairs the start with the LAST end and deletes the
  // orphan end marker plus every user byte between them.
  const note = [
    "<!-- remnic:Work:Timeline:start -->",
    "stale recap",
    "<!-- remnic:Other:Section:end -->",
    "user content that must survive",
    "<!-- remnic:Work:Timeline:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  // A colon-bearing section name is refused before the note is opened.
  assert.throws(
    () =>
      publishVaultNote({
        vaultPath: vault,
        notePathTemplate: "{yyyy}-{MM}-{dd}.md",
        date: DATE,
        sections: [{ name: "Work:Timeline", content: "fresh recap" }],
      }),
    /not a valid region name/,
  );
  assert.equal(readFileSync(notePath, "utf8"), note, "every byte of the note is preserved");

  // The note's own colon-bearing markers are still parsed and still refuse it,
  // even when the configured section name is legal.
  writeFileSync(
    notePath,
    `${note}<!-- remnic:timeline:start -->\nstale\n<!-- remnic:timeline:end -->\n`,
    "utf8",
  );
  const mixed = readFileSync(notePath, "utf8");
  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.match(status.results[0]?.reason ?? "", /name_mismatch:Work:Timeline:Other:Section/);
  const after = readFileSync(notePath, "utf8");
  assert.equal(after, mixed, "every byte of the note is preserved");
  assert.ok(after.includes("user content that must survive"), "intervening user bytes survive");
  assert.ok(after.includes("<!-- remnic:Other:Section:end -->"), "orphan end marker survives");
  assert.ok(after.includes("stale recap"), "nothing is published over the stale region");
});

test("a marker line with no parseable name refuses the whole note", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  const note = ["<!-- remnic::start -->", "user bytes", "<!-- remnic:timeline:end -->", ""].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.match(status.results[0]?.reason ?? "", /unparsable_marker/);
  assert.equal(readFileSync(notePath, "utf8"), note);
});

test("heading strategy ignores a heading inside a fenced code block", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // The only `## Timeline` line lives inside a fenced example. A scanner
  // without fence state accepts it as the owned heading and replaces the rest
  // of the code block plus the human text after it, through EOF.
  const note = [
    "# Daily",
    "",
    "## Notes",
    "",
    "How to publish:",
    "",
    "```md",
    "## Timeline",
    "- example card inside the fence",
    "~~~",
    "```",
    "",
    "human paragraph after the fence",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    strategy: "heading",
    sections: [{ name: "Timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.equal(status.results[0]?.reason, "no_heading");
  assert.equal(readFileSync(notePath, "utf8"), note, "every byte of the note is preserved");
});

test("a fenced heading does not terminate the owned section early", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // The owned `## Timeline` body contains a fenced `## Notes`, and the real
  // `## Notes` follows the fence. A scanner without fence state ends the
  // owned section at the FENCED heading, so the replacement lands mid-fence
  // and leaves an unterminated code block plus an orphaned fence tail.
  const note = [
    "## Timeline",
    "stale recap",
    "",
    "```",
    "## Notes",
    "fenced example line",
    "```",
    "",
    "## Notes",
    "",
    "human paragraph",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    strategy: "heading",
    sections: [{ name: "Timeline", content: "fresh recap" }],
  });

  assert.equal(status.results[0]?.outcome, "updated");
  const after = readFileSync(notePath, "utf8");
  // The whole fenced block sat inside the region Remnic owns, so it is
  // replaced as one unit; the human content after the real heading is intact.
  assert.equal(after, ["## Timeline", "fresh recap", "## Notes", "", "human paragraph", ""].join("\n"));
  assert.ok(!after.includes("```"), "no unterminated fence is left behind");
  assert.ok(after.includes("human paragraph"), "content after the real heading survives");
});

test("heading strategy republish is idempotent when the recap has its own headings", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // The persisted journal recap begins with `# Journal` and carries `##`
  // sections. Untouched, those headings terminate the managed region on
  // the next publish, so every republish leaves the previous copy behind.
  const note = [
    "# Daily",
    "",
    "## Timeline",
    "",
    "stale body",
    "",
    "## Notes",
    "",
    "human paragraph",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");
  const recap = [
    "# Journal — 2026-08-21 (UTC)",
    "",
    "## Categories",
    "",
    "- code review: 42m",
  ].join("\n");
  const publish = () =>
    publishVaultNote({
      vaultPath: vault,
      notePathTemplate: "{yyyy}-{MM}-{dd}.md",
      date: DATE,
      strategy: "heading",
      sections: [{ name: "Timeline", content: recap }],
    });

  publish();
  const first = readFileSync(notePath, "utf8");
  const second = publish();
  const afterSecond = readFileSync(notePath, "utf8");
  const third = publish();

  assert.equal(second.results[0]?.outcome, "unchanged");
  assert.equal(third.results[0]?.outcome, "unchanged");
  assert.equal(afterSecond, first, "second publish is byte-identical to the first");
  assert.equal(readFileSync(notePath, "utf8"), first, "third publish is byte-identical too");
  assert.equal((first.match(/Journal — 2026-08-21/g) ?? []).length, 1, "exactly one copy of the recap heading");
  assert.ok(first.includes("### Journal — 2026-08-21 (UTC)"), "recap heading is demoted under the owning heading");
  assert.ok(first.includes("#### Categories"), "recap sections are demoted one level deeper");
  assert.ok(first.includes("## Notes\n\nhuman paragraph"), "the next real section survives");
});

test("createMissingNotes creates the confined nested parent hierarchy for a new note", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  writeFileSync(path.join(vault, "daily.md"), "# {yyyy}-{MM}-{dd}\n", "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "Daily/{yyyy}/{MM}/{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: review (42m)" }],
    createMissingNotes: true,
    noteTemplate: "daily.md",
  });

  assert.equal(status.results[0]?.outcome, "updated");
  const notePath = path.join(vault, "Daily", "2026", "08", "21.md");
  const text = readFileSync(notePath, "utf8");
  assert.match(text, /- card-a: review \(42m\)/);
  assert.match(text, /remnic:timeline:start/);
});

test("an escaping noteTemplate refuses and creates no directories", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "Daily/{yyyy}/{MM}/{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "must not land" }],
    createMissingNotes: true,
    noteTemplate: "../outside-vault.md",
  });

  assert.equal(status.results[0]?.outcome, "error");
  assert.equal(status.results[0]?.reason, "template_escape");
  assert.ok(!existsSync(path.join(vault, "Daily")), "no parent directory was created");
  assert.ok(!existsSync(path.join(vault, "Daily", "2026", "08", "21.md")));
});


test("marker strategy ignores a marker pair inside a fenced code block", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // The fenced example carries a complete `timeline` pair BEFORE the real
  // region. A scanner without fence state pairs the fenced markers first
  // and replaces the example's contents while reporting a successful publish.
  const fencedExample = [
    "```markdown",
    "## How to publish",
    "<!-- remnic:timeline:start -->",
    "replace this sample text to see it work",
    "<!-- remnic:timeline:end -->",
    "```",
  ].join("\n");
  const note = [
    "---",
    "title: daily",
    "---",
    "",
    "Example from the docs:",
    "",
    fencedExample,
    "",
    "Real region:",
    "",
    "<!-- remnic:timeline:start -->",
    "stale recap",
    "<!-- remnic:timeline:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: code review (42m)" }],
  });

  assert.equal(status.results[0]?.outcome, "updated");
  const after = readFileSync(notePath, "utf8");
  assert.ok(after.includes(fencedExample), "the fenced example is byte-identical");
  assert.ok(!after.includes("stale recap"), "the real region was replaced");
  assert.ok(after.includes("- card-a: code review (42m)"));
});

test("marker strategy ignores a marker pair inside a four-space-indented code block", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // The indented example carries a complete `timeline` pair BEFORE the real
  // region. A scanner that trims a row before classifying it erases the
  // indentation, pairs the example's markers first, and replaces the
  // example's contents while reporting a successful publish (issue #1985).
  const indentedExample = [
    "    <!-- remnic:timeline:start -->",
    "    replace this sample text to see it work",
    "    <!-- remnic:timeline:end -->",
  ].join("\n");
  const note = [
    "---",
    "title: daily",
    "---",
    "",
    "Example from the docs:",
    "",
    indentedExample,
    "",
    "Real region:",
    "",
    "<!-- remnic:timeline:start -->",
    "stale recap",
    "<!-- remnic:timeline:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: code review (42m)" }],
  });

  assert.equal(status.results[0]?.outcome, "updated");
  const after = readFileSync(notePath, "utf8");
  assert.ok(after.includes(indentedExample), "the indented example is byte-identical");
  assert.ok(!after.includes("stale recap"), "the real region was replaced");
  assert.ok(after.includes("- card-a: code review (42m)"));
});

test("marker strategy ignores a marker pair inside a tab-indented code block", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // One tab is a full four-column indent (CommonMark tab handling), so the
  // tab-indented example is code exactly like the four-space variant.
  const indentedExample = [
    "\t<!-- remnic:timeline:start -->",
    "\treplace this sample text to see it work",
    "\t<!-- remnic:timeline:end -->",
  ].join("\n");
  const note = [
    "Example from the docs:",
    "",
    indentedExample,
    "",
    "<!-- remnic:timeline:start -->",
    "stale recap",
    "<!-- remnic:timeline:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: code review (42m)" }],
  });

  assert.equal(status.results[0]?.outcome, "updated");
  const after = readFileSync(notePath, "utf8");
  assert.ok(after.includes(indentedExample), "the tab-indented example is byte-identical");
  assert.ok(!after.includes("stale recap"), "the real region was replaced");
  assert.ok(after.includes("- card-a: code review (42m)"));
});

test("a marker pair indented under a list item is skipped, not published", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // CommonMark measures indentation relative to the containing block, so a
  // marker indented under a list item CAN be live content rather than code.
  // Distinguishing that needs full list tracking; this fix classifies any
  // indent >= 4 as code instead. The ambiguity resolves to "skip": a refused
  // publish is recoverable, an overwritten region is not.
  const note = [
    "- morning routine",
    "",
    "    <!-- remnic:timeline:start -->",
    "    stale recap",
    "    <!-- remnic:timeline:end -->",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: code review (42m)" }],
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.equal(status.results[0]?.reason, "no_marker");
  assert.equal(readFileSync(notePath, "utf8"), note, "the ambiguous region is left untouched");
});

test("insertUnderHeading never inserts into a fenced heading", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const notePath = path.join(vault, `${DATE}.md`);
  // The only `## Timeline` heading lives inside a fenced example. An
  // insertion scanner without fence state treats it as the target and
  // writes a live managed region into the user's code block.
  const note = [
    "# Daily",
    "",
    "```markdown",
    "## Timeline",
    "- sample entry inside the fence",
    "```",
    "",
  ].join("\n");
  writeFileSync(notePath, note, "utf8");

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "{yyyy}-{MM}-{dd}.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: code review (42m)" }],
    insertUnderHeading: "Timeline",
  });

  assert.equal(status.results[0]?.outcome, "skipped");
  assert.equal(status.results[0]?.reason, "no_marker");
  assert.equal(readFileSync(notePath, "utf8"), note, "nothing is inserted into the fence");
});

test("a symlinked destination note is refused, not replaced", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-vault-publisher-"));
  const target = ["<!-- remnic:timeline:start -->", "stale recap", "<!-- remnic:timeline:end -->", ""].join("\n");
  const targetPath = path.join(vault, "real-note.md");
  const linkPath = path.join(vault, "link-note.md");
  writeFileSync(targetPath, target, "utf8");
  symlinkSync(targetPath, linkPath);

  const status = publishVaultNote({
    vaultPath: vault,
    notePathTemplate: "link-note.md",
    date: DATE,
    sections: [{ name: "timeline", content: "- card-a: code review (42m)" }],
  });

  assert.equal(status.results[0]?.outcome, "error");
  assert.equal(status.results[0]?.reason, "symlinked_note");
  assert.ok(lstatSync(linkPath).isSymbolicLink(), "the symlink still exists");
  assert.equal(readFileSync(targetPath, "utf8"), target, "the target is not left stale");
});
