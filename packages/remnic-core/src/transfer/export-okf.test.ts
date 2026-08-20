import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "../storage.js";
import {
  DEFAULT_OKF_LOG_MAX_ENTRIES,
  exportOkfBundle,
  OKF_EXPORT_VERSION,
  OKF_LOG_TRUNCATION_MARKER,
  parseIncludeStatus,
} from "./export-okf.js";

async function seedStore(dir: string): Promise<{ factId: string; decisionId: string }> {
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  const decision = await storage.writeMemory("decision", "# Use SQLite\n\nWe use SQLite for the local store.", {
    source: "test",
    confidence: 0.9,
  });
  const fact = await storage.writeMemory(
    "fact",
    "# Rate limit\n\nAPI rate limit is 100/min.\n\n<oai-mem-citation>\n<citation_entries>\nfacts/note.md:1-2|note=[source]\n</citation_entries>\n</oai-mem-citation>\n",
    {
      source: "test",
      confidence: 0.9,
      tags: ["api"],
      links: [{ targetId: decision.id, linkType: "supports", strength: 0.8 }],
    },
  );
  const superseded = await storage.writeMemory("fact", "# Old limit\n\nAPI rate limit is 10/min.", { source: "test" });
  await storage.writeMemoryFrontmatter((await storage.getMemoryById(superseded.id))!, { status: "superseded" });
  const pending = await storage.writeMemory("correction", "# Pending\n\nNeeds review.", { source: "test" });
  await storage.writeMemoryFrontmatter((await storage.getMemoryById(pending.id))!, { status: "pending_review" });
  await writeFile(path.join(dir, "profile.md"), "# User\n\nPrefers short answers.\n", "utf8");
  return { factId: fact.id, decisionId: decision.id };
}
test("parseIncludeStatus rejects unknown values", () => {
  assert.deepEqual(parseIncludeStatus(undefined), ["active"]);
  assert.throws(() => parseIncludeStatus("nope"), /allowed:/);
});

test("exportOkfBundle writes a deterministic active-only bundle", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const outA = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-a-"));
  const outB = path.join(os.tmpdir(), `remnic-okf-b-${Date.now()}`);
  try {
    await seedStore(memoryDir);
    await rm(outA, { recursive: true, force: true });
    const first = await exportOkfBundle({ memoryDir, outDir: outA });
    assert.equal(first.exported, 2);
    assert.ok(first.excluded >= 2);
    const root = await readFile(path.join(outA, "index.md"), "utf8");
    assert.match(root, new RegExp(`okf_version: "${OKF_EXPORT_VERSION}"`));
    assert.doesNotMatch(root, /^type:/m);
    assert.equal(existsSync(path.join(outA, "profile.md")), false);
    const files = collectFiles(outA);
    assert.ok(files.some((f) => f.includes("facts/")));
    const factFile = files.find((f) => f.includes("facts/"))!;
    const factBody = await readFile(path.join(outA, factFile), "utf8");
    assert.match(factBody, /# Citations/);
    assert.match(factBody, /# Related/);
    assert.match(factBody, /type: Memory Fact/);
    await exportOkfBundle({ memoryDir, outDir: outB });
    assert.deepEqual(collectFiles(outA), collectFiles(outB));
    for (const rel of collectFiles(outA)) {
      assert.equal(await readFile(path.join(outA, rel), "utf8"), await readFile(path.join(outB, rel), "utf8"));
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outA, { recursive: true, force: true });
    await rm(outB, { recursive: true, force: true });
  }
});

test("profile stays off unless requested; non-empty out requires --force", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const outDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-out-"));
  try {
    await seedStore(memoryDir);
    await rm(outDir, { recursive: true, force: true });
    await exportOkfBundle({ memoryDir, outDir, includeProfile: true });
    const profile = await readFile(path.join(outDir, "profile.md"), "utf8");
    assert.match(profile, /type: Profile/);
    await writeFile(path.join(outDir, "keep.txt"), "old", "utf8");
    await assert.rejects(exportOkfBundle({ memoryDir, outDir }), /not empty/);
    assert.equal(await readFile(path.join(outDir, "keep.txt"), "utf8"), "old");
    await exportOkfBundle({ memoryDir, outDir, force: true });
    assert.equal(existsSync(path.join(outDir, "keep.txt")), false);
    assert.equal(existsSync(path.join(outDir, "index.md")), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("log.md is newest-first and marks truncation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const outDir = path.join(os.tmpdir(), `remnic-okf-log-${Date.now()}`);
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    await storage.writeMemory("fact", "# One\n\nbody", { source: "test" });
    await storage.appendMemoryLifecycleEvents([
      {
        eventId: "e2",
        memoryId: "m1",
        eventType: "created",
        timestamp: "2026-08-02T00:00:00.000Z",
        actor: "test",
        ruleVersion: "1",
      },
      {
        eventId: "e1",
        memoryId: "m1",
        eventType: "updated",
        timestamp: "2026-08-01T00:00:00.000Z",
        actor: "test",
        ruleVersion: "1",
      },
    ]);
    await exportOkfBundle({ memoryDir, outDir, includeLog: true, logMaxEntries: 1 });
    const log = await readFile(path.join(outDir, "log.md"), "utf8");
    assert.match(log, /## 20\d{2}-\d{2}-\d{2}/);
    assert.match(log, new RegExp(OKF_LOG_TRUNCATION_MARKER));
    assert.ok(DEFAULT_OKF_LOG_MAX_ENTRIES > 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("symlink out is rejected", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const real = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-real-"));
  const link = `${real}-link`;
  try {
    await seedStore(memoryDir);
    await symlink(real, link);
    await assert.rejects(exportOkfBundle({ memoryDir, outDir: link }), /symlink/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(real, { recursive: true, force: true });
    await rm(link, { force: true });
  }
});

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

test("--namespace cannot escape the namespace root", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-ns-"));
  const outDir = path.join(await mkdtemp(path.join(os.tmpdir(), "remnic-okf-nsout-")), "bundle");
  try {
    await seedStore(memoryDir);
    // A raw path.join on the operator value used to resolve outside
    // <memoryDir>/namespaces and export an arbitrary tree.
    for (const namespace of ["../../..", "../sibling", path.resolve(memoryDir)]) {
      await assert.rejects(
        () => exportOkfBundle({ memoryDir, namespace, outDir }),
        /invalid --namespace/,
        `namespace ${namespace} must be rejected`,
      );
    }
    assert.equal(existsSync(outDir), false, "a rejected namespace must not create the bundle");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a plain --namespace still exports from the namespace subtree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-nsok-"));
  const outDir = path.join(root, "bundle");
  try {
    await seedStore(path.join(root, "namespaces", "team-a"));
    const result = await exportOkfBundle({ memoryDir: root, namespace: "team-a", outDir });
    assert.ok(result.exported > 0, "namespaced export must find its own memories");
    assert.ok(existsSync(path.join(outDir, "index.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a leftover backup directory does not block a forced export", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-bk-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-bkout-"));
  const outDir = path.join(root, "bundle");
  try {
    await seedStore(memoryDir);
    await exportOkfBundle({ memoryDir, outDir });
    // Simulate a crash between the two publish renames, or any directory a
    // user happens to own at the old fixed backup path.
    const stale = `${outDir}.okf-prev`;
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "keep.md"), "stale\n", "utf8");

    const again = await exportOkfBundle({ memoryDir, outDir, force: true });
    assert.ok(again.exported > 0);
    assert.ok(existsSync(path.join(outDir, "index.md")), "forced export must republish");
    assert.equal(existsSync(path.join(stale, "keep.md")), true, "an unrelated directory is left alone");
    const leftovers = readdirSync(root).filter((name) => name.startsWith("bundle.okf-prev-"));
    assert.deepEqual(leftovers, [], "each attempt removes its own backup");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("--out that is a file is rejected before anything is written", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-file-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-fileout-"));
  const outDir = path.join(root, "bundle");
  try {
    await seedStore(memoryDir);
    await writeFile(outDir, "not a directory\n", "utf8");
    await assert.rejects(
      () => exportOkfBundle({ memoryDir, outDir, force: true }),
      /--out exists and is not a directory/,
    );
    assert.equal(await readFile(outDir, "utf8"), "not a directory\n", "the file is left untouched");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
