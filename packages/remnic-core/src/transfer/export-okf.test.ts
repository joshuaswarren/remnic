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
    assert.match(factBody, /type: "Memory Fact"/);
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
    assert.match(profile, /type: "Profile"/);
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
    assert.match(log, /\*\*Creation\*\*/);
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

test("existing empty out dir is replaced; a non-directory out is rejected", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const outDir = path.join(os.tmpdir(), `remnic-okf-empty-${Date.now()}`);
  const fileOut = path.join(os.tmpdir(), `remnic-okf-file-${Date.now()}`);
  try {
    await seedStore(memoryDir);
    await mkdir(outDir);
    await exportOkfBundle({ memoryDir, outDir });
    assert.equal(existsSync(path.join(outDir, "index.md")), true);
    await writeFile(fileOut, "x", "utf8");
    await assert.rejects(exportOkfBundle({ memoryDir, outDir: fileOut }), /not a directory/);
    assert.equal(await readFile(fileOut, "utf8"), "x");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
    await rm(fileOut, { force: true });
  }
});

test("namespace traversal is rejected and the namespace subtree is exported", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const outDir = path.join(os.tmpdir(), `remnic-okf-ns-${Date.now()}`);
  try {
    await seedStore(memoryDir);
    await assert.rejects(
      exportOkfBundle({ memoryDir, namespace: "../escape", outDir }),
      /invalid namespace path/,
    );
    const teamDir = path.join(memoryDir, "namespaces", "team");
    await mkdir(path.dirname(teamDir), { recursive: true });
    await seedStore(teamDir);
    const result = await exportOkfBundle({ memoryDir, namespace: "team", outDir });
    assert.equal(result.exported, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("child directories carry index.md files without frontmatter", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const outDir = path.join(os.tmpdir(), `remnic-okf-child-${Date.now()}`);
  try {
    await seedStore(memoryDir);
    await exportOkfBundle({ memoryDir, outDir });
    const files = collectFiles(outDir);
    const decisionIndex = files.find((rel) => /^decisions\/[^/]+\/index\.md$/.test(rel));
    assert.ok(decisionIndex, `missing decisions index.md in ${files.join(",")}`);
    const factIndex = files.find((rel) => /^facts\/[^/]+\/index\.md$/.test(rel));
    assert.ok(factIndex, `missing facts index.md in ${files.join(",")}`);
    const child = await readFile(path.join(outDir, decisionIndex!), "utf8");
    assert.doesNotMatch(child, /^---/);
    assert.match(child, /^# 20\d{2}-\d{2}-\d{2}$/m);
    assert.match(child, /\[Use SQLite\]\(\/decisions\//);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("frontmatter quotes string scalars that look like other YAML types", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-src-"));
  const outDir = path.join(os.tmpdir(), `remnic-okf-quote-${Date.now()}`);
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    await storage.writeMemory("fact", "# true\n\nA title that would parse as a boolean.", { source: "test" });
    await exportOkfBundle({ memoryDir, outDir });
    const files = collectFiles(outDir).filter((rel) => rel.startsWith("facts/") && !rel.endsWith("index.md"));
    const body = await readFile(path.join(outDir, files[0]!), "utf8");
    assert.match(body, /^title: "true"$/m);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
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
