import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StorageManager,
  createJournalMemoryWriter,
  parseConfig,
  readJournalForDate,
  type JournalExtractionDeps,
  type PluginConfig,
} from "@remnic/core";
import { createJournalCommandDeps, runJournalBinaryCommand, runJournalCommand, type JournalCommandDeps } from "./journal.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

interface Capture {
  code: number;
  out: string[];
  err: string[];
}

async function capture(
  config: PluginConfig,
  rest: string[],
  deps?: JournalCommandDeps,
): Promise<Capture> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runJournalCommand(
    config,
    rest,
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    deps,
  );
  return { code, out, err };
}

function vaultConfigFor(vaultPath: string): PluginConfig {
  return parseConfig({
    memoryDir: path.join(vaultPath, "memory"),
    activity: {
      timeline: {
        journal: { enabled: true, source: "vault", extractionMode: "off" },
        vault: {
          enabled: true,
          vaultPath,
          dailyNotePath: "{yyyy}-{MM}-{dd}.md",
          readback: { journalSection: "Journal" },
        },
      },
    },
  });
}

function memoryDirConfigFor(memoryDir: string): PluginConfig {
  return parseConfig({
    memoryDir,
    activity: { timeline: { journal: { enabled: true, source: "memoryDir" } } },
  });
}

/** Tree hash of a directory: proves a command wrote nothing. */
function treeHash(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return 0;
  });
  const parts: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    parts.push(entry.isDirectory() ? `d:${entry.name}:${treeHash(full)}` : `f:${entry.name}:${fs.readFileSync(full, "utf8")}`);
  }
  return parts.join("|");
}

function withVault(fn: (vault: string, config: PluginConfig) => void | Promise<void>): Promise<void> {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-journal-cli-"));
  return Promise.resolve(fn(vault, vaultConfigFor(vault))).finally(() =>
    rmSync(vault, { recursive: true, force: true }),
  );
}

test("show prints a provenance header naming the vault note, then the section", async () => {
  await withVault(async (vault, config) => {
    const note = path.join(vault, "2026-08-20.md");
    fs.writeFileSync(note, ["## Journal", "user text", START, "card", END, "## Other", ""].join("\n"));
    const result = await capture(config, ["show", "--date", "2026-08-20"]);
    assert.equal(result.code, 0);
    assert.match(result.out[0]!, /^# journal source: .*2026-08-20\.md :: Journal$/);
    assert.equal(result.out.slice(1).join("\n"), "user text");
    // Read-only: the note is untouched.
    assert.match(fs.readFileSync(note, "utf8"), /card/);
  });
});

test("show on a missing note prints exists:false with the reason", async () => {
  await withVault(async (_vault, config) => {
    const result = await capture(config, ["show", "--date", "2026-08-20"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["exists:false (missing_file)"]);
  });
});

test("edit-path prints the vault note path, not the memoryDir journal path", async () => {
  await withVault(async (vault, config) => {
    const result = await capture(config, ["edit-path", "--date", "2026-08-20"]);
    assert.equal(result.code, 0);
    assert.equal(result.out[0], path.join(vault, "2026-08-20.md"));
  });
});

test("seed refuses in vault mode: non-zero exit, nothing written anywhere", async () => {
  await withVault(async (vault, config) => {
    const before = treeHash(vault);
    const result = await capture(config, ["seed", "--date", "2026-08-20"]);
    assert.equal(result.code, 1);
    assert.equal(result.err.length, 1);
    assert.match(result.err[0]!, /seed is not available/);
    assert.match(result.err[0]!, /never writes to it/);
    assert.equal(result.out.length, 0);
    assert.equal(treeHash(vault), before);
  });
});

test("seed with --force still refuses in vault mode", async () => {
  await withVault(async (vault, config) => {
    const before = treeHash(vault);
    const result = await capture(config, ["seed", "--date", "2026-08-20", "--force"]);
    assert.equal(result.code, 1);
    assert.equal(treeHash(vault), before);
  });
});

test("memoryDir mode is unchanged: show and edit-path use the journal day file", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-cli-memdir-"));
  try {
    const config = memoryDirConfigFor(memoryDir);
    const dayFile = path.join(memoryDir, "journal", "2026-08-20.md");
    fs.mkdirSync(path.dirname(dayFile), { recursive: true });
    fs.writeFileSync(dayFile, "memoryDir journal body\n");

    const editPath = await capture(config, ["edit-path", "--date", "2026-08-20"]);
    assert.equal(editPath.code, 0);
    assert.equal(editPath.out[0], dayFile);

    const show = await capture(config, ["show", "--date", "2026-08-20"]);
    assert.equal(show.code, 0);
    assert.equal(show.out.join("\n"), "memoryDir journal body");

    const seed = await capture(config, ["seed", "--date", "2026-08-20"]);
    assert.equal(seed.code, 0);
    assert.match(seed.out[0]!, /^unchanged /);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

// ── extract fixtures (issue #1987 review-only pass wiring) ──────────────────

function reviewVaultConfigFor(vaultPath: string, timezone = "UTC"): PluginConfig {
  return parseConfig({
    memoryDir: path.join(vaultPath, "memory"),
    activity: {
      timezone,
      timeline: {
        journal: { enabled: true, source: "vault", extractionMode: "review" },
        vault: {
          enabled: true,
          vaultPath,
          dailyNotePath: "{yyyy}-{MM}-{dd}.md",
          readback: { journalSection: "Journal" },
        },
      },
    },
  });
}

function reviewMemoryDirConfigFor(memoryDir: string): PluginConfig {
  return parseConfig({
    memoryDir,
    activity: { timeline: { journal: { enabled: true, source: "memoryDir", extractionMode: "review" } } },
  });
}

interface RecordedWrite {
  status: string;
  tags: string[];
}

function fakeExtractionDeps(
  facts: string[],
  options: { throwOnExtract?: boolean } = {},
): { deps: JournalExtractionDeps; writes: RecordedWrite[]; extractCalls: () => number } {
  let extractCalls = 0;
  const writes: RecordedWrite[] = [];
  const deps: JournalExtractionDeps = {
    extract: async () => {
      extractCalls += 1;
      if (options.throwOnExtract) throw new Error("provider down");
      return {
        facts: facts.map((content) => ({
          content,
          category: "decision" as const,
          confidence: 0.9,
          tags: [],
          entityRef: undefined,
        })),
        profileUpdates: [],
        entities: [],
        questions: [],
      };
    },
    writer: {
      writeSealedMemory: async (envelope, extras) => {
        writes.push({ status: extras.status, tags: envelope.tags });
        return {};
      },
      hasJournalMemoryContent: async () => false,
    },
  };
  return { deps, writes, extractCalls: () => extractCalls };
}

/** Deps seam with a read-call counter: proves an action never read the note. */
function countingDeps(overrides: Partial<JournalCommandDeps> = {}): JournalCommandDeps & { reads: () => number } {
  let reads = 0;
  const deps: JournalCommandDeps = {
    readJournal: (input) => {
      reads += 1;
      return readJournalForDate(input);
    },
    extractionDeps: async () => {
      throw new Error("extraction deps must not build for this action");
    },
    now: () => new Date(),
    ...overrides,
  };
  return { ...deps, reads: () => reads };
}

test("journal.enabled is the master gate: every action refuses before any read or write", async () => {
  await withVault(async (vault) => {
    fs.writeFileSync(path.join(vault, "2026-08-20.md"), ["## Journal", "user text", ""].join("\n"));
    const config = parseConfig({
      memoryDir: path.join(vault, "memory"),
      activity: {
        timeline: {
          journal: { enabled: false, source: "vault", extractionMode: "review" },
          vault: {
            enabled: true,
            vaultPath: vault,
            dailyNotePath: "{yyyy}-{MM}-{dd}.md",
            readback: { journalSection: "Journal" },
          },
        },
      },
    });
    const before = treeHash(vault);
    for (const action of ["show", "edit-path", "seed", "extract"]) {
      const deps = countingDeps();
      const result = await capture(config, [action, "--date", "2026-08-20"], deps);
      assert.equal(result.code, 1, `${action} exits 1 when disabled`);
      assert.match(result.err[0]!, /timeline\.journal\.enabled is false/);
      assert.equal(result.out.length, 0, `${action} prints nothing when disabled`);
      assert.equal(deps.reads(), 0, `${action} reads nothing when disabled`);
    }
    assert.equal(treeHash(vault), before, "disabled runs leave the tree untouched");
  });
});

test("--help short-circuits before config load: malformed config still prints usage, exit 0", async () => {
  // Discovery walks cwd before the home default, so a malformed
  // remnic.config.json in a temp cwd makes every config load fail —
  // exactly the state in which --help must still work.
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-journal-cli-cfg-"));
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  const origLog = console.log;
  const origError = console.error;
  const logged: string[] = [];
  try {
    fs.writeFileSync(path.join(dir, "remnic.config.json"), "{ not json");
    process.chdir(dir);
    console.log = ((...args: unknown[]) => {
      logged.push(String(args[0]));
    }) as typeof console.log;
    console.error = ((...args: unknown[]) => {
      logged.push(`ERR:${String(args[0])}`);
    }) as typeof console.error;
    process.exitCode = undefined;

    await runJournalBinaryCommand(["--help"]);
    assert.equal(process.exitCode, undefined, "help exits 0 even with a malformed config");
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /^Usage: remnic journal <show\|edit-path\|seed\|extract>/);
    assert.match(logged[0]!, /extract\s+Run the review-only extraction pass/);

    // Same malformed config, real action: the constant failure message
    // proves the config file really is consulted on the non-help path.
    logged.length = 0;
    await runJournalBinaryCommand(["show"]);
    assert.deepEqual(logged, [
      "ERR:journal: failed to load the Remnic config — run `remnic doctor` and check the config file for errors",
    ]);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exitCode = prevExitCode;
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omitted --date derives from activity.timezone, not the host clock (opposing midnight zones)", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-cli-tz-"));
  try {
    // 2026-08-20T23:30:00Z is Aug 21 in Pacific/Kiritimati (UTC+14) and
    // still Aug 20 in Pacific/Pago_Pago (UTC-11) — the same instant straddles
    // two civil dates at opposing midnights.
    const now = () => new Date("2026-08-20T23:30:00Z");
    const kiritimati = parseConfig({
      memoryDir,
      activity: { timezone: "Pacific/Kiritimati", timeline: { journal: { enabled: true, source: "memoryDir" } } },
    });
    const pagoPago = parseConfig({
      memoryDir,
      activity: { timezone: "Pacific/Pago_Pago", timeline: { journal: { enabled: true, source: "memoryDir" } } },
    });
    const east = await capture(kiritimati, ["edit-path"], countingDeps({ now }));
    assert.ok(east.out[0]!.endsWith(path.join("journal", "2026-08-21.md")), east.out[0]);
    const west = await capture(pagoPago, ["edit-path"], countingDeps({ now }));
    assert.ok(west.out[0]!.endsWith(path.join("journal", "2026-08-20.md")), west.out[0]);
    // Explicit --date always wins over the zone-derived default.
    const explicit = await capture(kiritimati, ["edit-path", "--date", "2026-08-19"], countingDeps({ now }));
    assert.ok(explicit.out[0]!.endsWith(path.join("journal", "2026-08-19.md")), explicit.out[0]);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("omitted --date reaches the vault read with the timezone-derived date", async () => {
  await withVault(async (vault) => {
    fs.writeFileSync(path.join(vault, "2026-08-21.md"), ["## Journal", "user text", ""].join("\n"));
    const config = parseConfig({
      memoryDir: path.join(vault, "memory"),
      activity: {
        timezone: "Pacific/Kiritimati",
        timeline: {
          journal: { enabled: true, source: "vault" },
          vault: {
            enabled: true,
            vaultPath: vault,
            dailyNotePath: "{yyyy}-{MM}-{dd}.md",
            readback: { journalSection: "Journal" },
          },
        },
      },
    });
    const deps = countingDeps({ now: () => new Date("2026-08-20T23:30:00Z") });
    const result = await capture(config, ["edit-path"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.out[0], path.join(vault, "2026-08-21.md"));
    assert.equal(deps.reads(), 1);
  });
});

test("extract refuses unless extractionMode is review, before any note read", async () => {
  await withVault(async (vault, config) => {
    fs.writeFileSync(path.join(vault, "2026-08-20.md"), ["## Journal", "user text", ""].join("\n"));
    const deps = countingDeps();
    const result = await capture(config, ["extract", "--date", "2026-08-20"], deps);
    assert.equal(result.code, 1);
    assert.match(result.err[0]!, /extract requires activity\.timeline\.journal\.extractionMode "review"/);
    assert.equal(result.err[0]!.includes('currently "off"'), true);
    assert.equal(deps.reads(), 0, "mode gate fires before any note read");
  });
});

test("extract runs the review pass: counts, pending_review only, hash-skip on rerun", async () => {
  await withVault(async (vault) => {
    fs.writeFileSync(
      path.join(vault, "2026-08-20.md"),
      ["## Journal", "I decided to move the parser to its own module.", ""].join("\n"),
    );
    const config = reviewVaultConfigFor(vault);
    const fake = fakeExtractionDeps(["I decided to move the parser to its own module."]);
    const result = await capture(config, ["extract", "--date", "2026-08-20"], countingDeps({ extractionDeps: async () => fake.deps }));
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["pending_review: 1", "rejected_by_judge: 0", "skipped: 0"]);
    assert.equal(fake.extractCalls(), 1);
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.writes[0]!.status, "pending_review", "candidates are never auto-approved");
    assert.deepEqual(fake.writes[0]!.tags, ["journal", "journal-day:2026-08-20"]);

    // The day's hash advanced, so the identical rerun hash-skips.
    const rerun = await capture(config, ["extract", "--date", "2026-08-20"], countingDeps({ extractionDeps: async () => fake.deps }));
    assert.equal(rerun.code, 0);
    assert.deepEqual(rerun.out, ["unchanged 2026-08-20 (hash-skip)"]);
    assert.equal(fake.extractCalls(), 1, "an unchanged day never re-extracts");
  });
});

test("extract on a missing note is a no-journal day, not an error", async () => {
  await withVault(async (vault) => {
    const config = reviewVaultConfigFor(vault);
    let built = 0;
    const deps = countingDeps({
      extractionDeps: async () => {
        built += 1;
        throw new Error("must not be reached");
      },
    });
    const result = await capture(config, ["extract", "--date", "2026-08-20"], deps);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["no journal 2026-08-20 (missing_file)"]);
    assert.equal(built, 0, "no extraction deps built for a no-journal day");
    assert.equal(deps.reads(), 1);
  });
});

test("extract failure exits 1 and leaves the day hash unadvanced (retry next run)", async () => {
  await withVault(async (vault) => {
    fs.writeFileSync(path.join(vault, "2026-08-20.md"), ["## Journal", "user text", ""].join("\n"));
    const config = reviewVaultConfigFor(vault);
    const failing = fakeExtractionDeps([], { throwOnExtract: true });
    const failed = await capture(config, ["extract", "--date", "2026-08-20"], countingDeps({ extractionDeps: async () => failing.deps }));
    assert.equal(failed.code, 1);
    assert.match(failed.err[0]!, /extraction did not complete for 2026-08-20/);
    assert.equal(failing.extractCalls(), 1);

    const healthy = fakeExtractionDeps(["I decided to ship."]);
    const retried = await capture(config, ["extract", "--date", "2026-08-20"], countingDeps({ extractionDeps: async () => healthy.deps }));
    assert.equal(retried.code, 0);
    assert.deepEqual(retried.out, ["pending_review: 1", "rejected_by_judge: 0", "skipped: 0"]);
    assert.equal(healthy.extractCalls(), 1, "the failed day re-ran — its hash was not advanced");
  });
});

test("memoryDir mode extract reads the day file, writes pending_review, hash-skips", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-cli-xmem-"));
  try {
    const dayFile = path.join(memoryDir, "journal", "2026-08-20.md");
    fs.mkdirSync(path.dirname(dayFile), { recursive: true });
    fs.writeFileSync(dayFile, "memoryDir journal body\n");
    const config = reviewMemoryDirConfigFor(memoryDir);
    const fake = fakeExtractionDeps(["memoryDir journal body fact"]);
    const result = await capture(config, ["extract", "--date", "2026-08-20"], countingDeps({ extractionDeps: async () => fake.deps }));
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["pending_review: 1", "rejected_by_judge: 0", "skipped: 0"]);
    assert.equal(fake.writes[0]!.status, "pending_review");
    const rerun = await capture(config, ["extract", "--date", "2026-08-20"], countingDeps({ extractionDeps: async () => fake.deps }));
    assert.deepEqual(rerun.out, ["unchanged 2026-08-20 (hash-skip)"]);
    assert.equal(fake.extractCalls(), 1);

    const missing = await capture(config, ["extract", "--date", "2026-08-21"], countingDeps({ extractionDeps: async () => fake.deps }));
    assert.equal(missing.code, 0);
    assert.deepEqual(missing.out, ["no journal 2026-08-21 (missing_file)"]);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});


const STORAGE_FACT = "I decided the journal writer must stay sealed.";

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

test("extract without injected storage fails closed instead of constructing StorageManager(memoryDir)", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-cli-nostore-"));
  try {
    const dayFile = path.join(memoryDir, "journal", "2026-08-20.md");
    fs.mkdirSync(path.dirname(dayFile), { recursive: true });
    fs.writeFileSync(dayFile, `${STORAGE_FACT}\n`);
    const config = reviewMemoryDirConfigFor(memoryDir);
    await assert.rejects(
      () => capture(config, ["extract", "--date", "2026-08-20"]),
      /resolved StorageManager|orchestrator/,
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("extract through injected StorageManager encrypts writes and leaves no plaintext fact", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-cli-enc-"));
  try {
    const dayFile = path.join(memoryDir, "journal", "2026-08-20.md");
    fs.mkdirSync(path.dirname(dayFile), { recursive: true });
    fs.writeFileSync(dayFile, `${STORAGE_FACT}\n`);
    const config = reviewMemoryDirConfigFor(memoryDir);
    const storage = new StorageManager(config.memoryDir);
    await storage.ensureDirectories();
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(Buffer.alloc(32, 11));
    const deps = createJournalCommandDeps(config, storage);
    deps.extractionDeps = async () => ({
      extract: async () => ({
        facts: [
          {
            content: STORAGE_FACT,
            category: "decision" as const,
            confidence: 0.9,
            tags: [],
            entityRef: undefined,
          },
        ],
        profileUpdates: [],
        entities: [],
        questions: [],
      }),
      writer: createJournalMemoryWriter(storage),
    });
    const result = await capture(config, ["extract", "--date", "2026-08-20"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.out[0], "pending_review: 1");
    const bodies = walkFiles(memoryDir)
      .filter((file) => !file.endsWith(`${path.sep}journal${path.sep}2026-08-20.md`))
      .filter((file) => !file.includes(`${path.sep}state${path.sep}`))
      .map((file) => fs.readFileSync(file));
    assert.ok(bodies.some((buf) => buf.subarray(0, 10).equals(Buffer.from("REMNIC-ENC"))));
    assert.equal(
      bodies.some((buf) => buf.toString("utf8").includes(STORAGE_FACT)),
      false,
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
