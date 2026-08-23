import assert from "node:assert/strict";
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { publisherOwnedSectionNames, readJournalForDate, readVerifiedDailyNote } from "./journal-read.js";
import type { ActivityTimelineVaultConfig } from "./types.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

function makeVault(): string {
  return mkdtempSync(path.join(tmpdir(), "remnic-journal-read-"));
}

function vaultConfig(vaultPath: string, overrides: Partial<ActivityTimelineVaultConfig> = {}): ActivityTimelineVaultConfig {
  return {
    enabled: true,
    vaultPath,
    dailyNotePath: "{yyyy}-{MM}-{dd}.md",
    weeklyNotePath: "",
    createMissingNotes: false,
    noteTemplate: "",
    sectionStrategy: "markers",
    publish: {
      timeline: { enabled: true, target: "daily", section: "Timeline" },
      standup: { enabled: false, target: "daily", section: "Standup" },
      weekly: { enabled: false, target: "weekly", section: "Weekly Review" },
      locations: { enabled: false, target: "daily", section: "Locations" },
    },
    insertUnderHeading: "",
    readback: { journalSection: "Journal" },
    wikilinks: { places: false, placesFolder: "Places" },
    properties: { mode: "off", prefix: "remnic_" },
    autoPublish: true,
    ...overrides,
  };
}

test("resolves the note through the #1985 template resolver and returns provenance", () => {
  const vault = makeVault();
  try {
    writeFileSync(
      path.join(vault, "2026-08-20.md"),
      ["## Journal", "user text", "## Other", ""].join("\n"),
    );
    const result = readJournalForDate({ vault: vaultConfig(vault), date: "2026-08-20" });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.exists);
    assert.equal(result.filePath, path.join(vault, "2026-08-20.md"));
    assert.equal(result.heading, "Journal");
    assert.equal(result.text, "user text");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("every template layout the resolver supports works unchanged", () => {
  const vault = makeVault();
  try {
    mkdirSync(path.join(vault, "days"), { recursive: true });
    writeFileSync(path.join(vault, "days", "20.md"), ["## Journal", "nested", ""].join("\n"));
    const result = readJournalForDate({
      vault: vaultConfig(vault, { dailyNotePath: "days/{dd}.md" }),
      date: "2026-08-20",
    });
    assert.ok(result.ok && result.exists);
    assert.equal(result.text, "nested");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("missing note is a no-journal day, not an error, with the resolved path", () => {
  const vault = makeVault();
  try {
    const result = readJournalForDate({ vault: vaultConfig(vault), date: "2026-08-20" });
    assert.deepEqual(result, {
      ok: true,
      exists: false,
      reason: "missing_file",
      filePath: path.join(vault, "2026-08-20.md"),
    });
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("missing vault root is a no-journal day", () => {
  const result = readJournalForDate({
    vault: vaultConfig(path.join(tmpdir(), "remnic-journal-read-absent-root")),
    date: "2026-08-20",
  });
  assert.ok(result.ok && !result.exists);
});

test("missing section is distinct from a missing note", () => {
  const vault = makeVault();
  try {
    writeFileSync(path.join(vault, "2026-08-20.md"), "## Notes\nonly notes\n");
    const result = readJournalForDate({ vault: vaultConfig(vault), date: "2026-08-20" });
    assert.deepEqual(result, {
      ok: true,
      exists: false,
      reason: "missing_heading",
      filePath: path.join(vault, "2026-08-20.md"),
    });
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("duplicate headings refuse with line numbers", () => {
  const vault = makeVault();
  try {
    writeFileSync(
      path.join(vault, "2026-08-20.md"),
      ["## Journal", "one", "## Notes", "## Journal", "two", ""].join("\n"),
    );
    const result = readJournalForDate({ vault: vaultConfig(vault), date: "2026-08-20" });
    assert.ok(!result.ok);
    assert.ok(result.reason === "duplicate_heading");
    assert.deepEqual(result.lines, [1, 4]);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("non-ASCII heading resolves and extracts identically to ASCII", () => {
  const vault = makeVault();
  try {
    writeFileSync(
      path.join(vault, "2026-08-20.md"),
      ["## Tagebuch 📝", "Heute ruhig.", "## Andere", ""].join("\n"),
    );
    const result = readJournalForDate({
      vault: vaultConfig(vault, { readback: { journalSection: "Tagebuch 📝" } }),
      date: "2026-08-20",
    });
    assert.ok(result.ok && result.exists);
    assert.equal(result.heading, "Tagebuch 📝");
    assert.equal(result.text, "Heute ruhig.");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("embedded remnic regions are stripped before the text is returned", () => {
  const vault = makeVault();
  try {
    writeFileSync(
      path.join(vault, "2026-08-20.md"),
      ["## Journal", "I walked.", START, "card", END, "Still thinking.", ""].join("\n"),
    );
    const result = readJournalForDate({ vault: vaultConfig(vault), date: "2026-08-20" });
    assert.ok(result.ok && result.exists);
    assert.match(result.text, /I walked\./);
    assert.match(result.text, /Still thinking\./);
    assert.doesNotMatch(result.text, /card/);
    assert.doesNotMatch(result.text, /remnic:/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("heading-strategy publisher sections nested inside the journal section are stripped", () => {
  const vault = makeVault();
  try {
    writeFileSync(
      path.join(vault, "2026-08-20.md"),
      ["## Journal", "mine", "### Timeline", "published", "## After", ""].join("\n"),
    );
    const markers = readJournalForDate({
      vault: vaultConfig(vault),
      date: "2026-08-20",
    });
    assert.ok(markers.ok && markers.exists);
    assert.equal(markers.text, "mine\n### Timeline\npublished");

    const heading = readJournalForDate({
      vault: vaultConfig(vault, { sectionStrategy: "heading" }),
      date: "2026-08-20",
    });
    assert.ok(heading.ok && heading.exists);
    assert.equal(heading.text, "mine");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("reads exactly one file per call — the note is read once", () => {
  const vault = makeVault();
  try {
    const notePath = path.join(vault, "2026-08-20.md");
    writeFileSync(notePath, "## Journal\nuser\n");
    const before = readFileSync(notePath, "utf8");
    const result = readJournalForDate({ vault: vaultConfig(vault), date: "2026-08-20" });
    assert.ok(result.ok && result.exists);
    // Snapshot semantics: the note is untouched by reads.
    assert.equal(readFileSync(notePath, "utf8"), before);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("refuses a daily note that is a symlink", () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    writeFileSync(path.join(outside, "escaped.md"), "## Journal\nstolen\n");
    symlinkSync(path.join(outside, "escaped.md"), path.join(vault, "2026-08-20.md"));
    const result = readJournalForDate({ vault: vaultConfig(vault), date: "2026-08-20" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : "", "symlink_escape");
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("refuses an ancestor directory swapped for a symlink out of the vault", () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    const nested = path.join(vault, "days");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "2026-08-20.md"), "## Journal\nmine\n");
    writeFileSync(path.join(outside, "2026-08-20.md"), "## Journal\nstolen\n");
    rmSync(nested, { recursive: true, force: true });
    symlinkSync(outside, nested);
    const result = readJournalForDate({
      vault: vaultConfig(vault, { dailyNotePath: "days/{yyyy}-{MM}-{dd}.md" }),
      date: "2026-08-20",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : "", "symlink_escape");
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── issue #2872: config-known strip ownership + portable fd-chain seams ─────

test("a disabled daily target keeps owning its historical heading section", () => {
  const vault = makeVault();
  try {
    writeFileSync(
      path.join(vault, "2026-08-20.md"),
      [
        "## Journal",
        "user line",
        "## Timeline",
        "published card from before the target was disabled",
        "## Standup",
        "standup card from a target that was never enabled",
        "",
      ].join("\n"),
    );
    const config = vaultConfig(vault, {
      sectionStrategy: "heading",
      publish: {
        timeline: { enabled: false, target: "daily", section: "Timeline" },
        standup: { enabled: false, target: "daily", section: "Standup" },
        weekly: { enabled: true, target: "weekly", section: "Weekly Review" },
        locations: { enabled: true, target: "daily", section: "Locations" },
      },
    });
    // Config-known daily sections are owned enabled or not; weekly is not.
    assert.deepEqual(publisherOwnedSectionNames(config).sort(), ["Locations", "Standup", "Timeline"]);
    const result = readJournalForDate({ vault: config, date: "2026-08-20" });
    assert.ok(result.ok && result.exists);
    assert.equal(result.text, "user line");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("note swapped for a symlink at open time is refused by the no-follow open", () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    const note = path.join(vault, "2026-08-20.md");
    writeFileSync(note, "## Journal\nuser text\n");
    writeFileSync(path.join(outside, "escaped.md"), "## Journal\nstolen\n");
    const io = {
      open: (openedPath: string, flags: number) => {
        const openingNote =
          path.basename(openedPath) === "2026-08-20.md" && (flags & (fsConstants.O_DIRECTORY ?? 0)) === 0;
        if (openingNote && existsSync(note) && lstatSync(note).isFile()) {
          renameSync(note, `${note}.real`);
          symlinkSync(path.join(outside, "escaped.md"), note);
        }
        return openSync(openedPath, flags);
      },
    };
    assert.throws(
      () => readVerifiedDailyNote(vault, note, io),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.equal(existsSync(note) && lstatSync(note).isSymbolicLink(), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("ancestor swapped after opens cannot leak outside content", () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    const days = path.join(vault, "days");
    mkdirSync(days);
    const note = path.join(days, "2026-08-20.md");
    writeFileSync(note, "## Journal\nuser text\n");
    writeFileSync(path.join(outside, "stolen.md"), "## Journal\nstolen\n");
    let swapped = false;
    const io = {
      open: (openedPath: string, flags: number) => {
        const openingNote =
          path.basename(openedPath) === "2026-08-20.md" && (flags & (fsConstants.O_DIRECTORY ?? 0)) === 0;
        if (openingNote && !swapped) {
          swapped = true;
          renameSync(days, `${days}.orig`);
          mkdirSync(days);
          writeFileSync(path.join(days, "2026-08-20.md"), "## Journal\nstolen\n");
        }
        try {
          return openSync(openedPath, flags);
        } finally {
          if (openingNote && existsSync(`${days}.orig`)) {
            rmSync(days, { recursive: true, force: true });
            renameSync(`${days}.orig`, days);
          }
        }
      },
    };
    let text: string | undefined;
    try {
      text = readVerifiedDailyNote(vault, note, io);
    } catch (err) {
      assert.equal(
        (err as NodeJS.ErrnoException).code === "ELOOP" || /symlink refused/.test(String(err)),
        true,
      );
      return;
    }
    assert.equal(text.includes("stolen"), false);
    assert.equal(text, "## Journal\nuser text\n");
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the default io seam reads the verified note unchanged", () => {
  const vault = makeVault();
  try {
    writeFileSync(path.join(vault, "2026-08-20.md"), "## Journal\nplain read\n");
    assert.equal(readVerifiedDailyNote(vault, path.join(vault, "2026-08-20.md")), "## Journal\nplain read\n");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
