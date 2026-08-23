import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig, type PluginConfig } from "@remnic/core";
import { runJournalCommand } from "./journal.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

interface Capture {
  code: number;
  out: string[];
  err: string[];
}

async function capture(config: PluginConfig, rest: string[]): Promise<Capture> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runJournalCommand(config, rest, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
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

