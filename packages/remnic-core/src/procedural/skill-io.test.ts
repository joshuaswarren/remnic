/**
 * Skill bundle export / import I/O (issue #2369).
 *
 * Covers the acceptance matrix:
 *   - export → import into a FRESH memory dir reproduces the procedure steps
 *     with import provenance;
 *   - imported procedures land as `pending_review`, never active;
 *   - a bundle carrying `scripts/` imports the SKILL.md text only and flags
 *     `hasUnimportedResources`;
 *   - symlinked bundle dirs / SKILL.md files and escaping entries are skipped
 *     with a reason instead of being walked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

import { StorageManager } from "../storage.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import { buildProcedurePersistBody, parseProcedureStepsFromBody } from "./procedure-types.js";
import { exportSkillBundles, persistImportedSkills, readSkillBundlesFromDir } from "./skill-io.js";
import { projectProceduresToSkills, SKILL_FILE_NAME } from "./skill-projection.js";
import type { MemoryFile } from "../types.js";

const STEPS = [
  { order: 1, intent: "Read the failing output." },
  { order: 2, intent: "Fix the smallest cause.", expectedOutcome: "The suite passes." },
];

function makeProcedure(id: string, title: string): MemoryFile {
  return {
    path: `procedures/2026-08-18/${id}.md`,
    content: buildProcedurePersistBody(title, STEPS),
    frontmatter: {
      id,
      category: "procedure",
      created: "2026-08-18T00:00:00.000Z",
      updated: "2026-08-18T00:00:00.000Z",
      source: "procedure-miner",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: [],
    } as MemoryFile["frontmatter"],
  };
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("export then import into a fresh memory dir reproduces the steps as pending_review", async () => {
  const outDir = await tempDir("remnic-skill-export-");
  const memoryDir = await tempDir("remnic-skill-memory-");
  try {
    const source = makeProcedure("procedure-1", "Fix a failing test");
    const written = await exportSkillBundles({
      bundles: projectProceduresToSkills([source]),
      outDir,
    });
    assert.deepEqual(written.slugs, ["fix-a-failing-test"]);

    const read = await readSkillBundlesFromDir(outDir);
    assert.equal(read.bundles.length, 1);
    assert.equal(read.bundles[0].hasUnimportedResources, false);

    const storage = new StorageManager(memoryDir);
    const result = await persistImportedSkills({ storage, bundles: read.bundles });
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].steps, 2);
    assert.deepEqual(result.rejected, []);

    const memories = await storage.readAllMemories();
    const imported = memories.filter((m) => m.frontmatter.category === "procedure");
    assert.equal(imported.length, 1);
    assert.equal(imported[0].frontmatter.status, "pending_review");
    assert.equal(imported[0].frontmatter.source, "skill-import");
    assert.equal(imported[0].frontmatter.structuredAttributes?.skill_slug, "fix-a-failing-test");
    assert.equal(imported[0].frontmatter.structuredAttributes?.skill_origin_memory_id, "procedure-1");
    assert.equal(imported[0].frontmatter.structuredAttributes?.hasUnimportedResources, undefined);

    // storage.writeMemory appends a "[Attributes: ...]" footer to any memory
    // carrying structuredAttributes; it is machine provenance, not a step.
    assert.deepEqual(
      parseProcedureStepsFromBody(stripAttributesSuffix(imported[0].content)),
      parseProcedureStepsFromBody(source.content),
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a bundle with scripts/ imports text only and flags hasUnimportedResources", async () => {
  const dir = await tempDir("remnic-skill-scripts-");
  const memoryDir = await tempDir("remnic-skill-memory-");
  try {
    const bundleDir = path.join(dir, "risky-skill");
    await mkdir(path.join(bundleDir, "scripts"), { recursive: true });
    await writeFile(
      path.join(bundleDir, SKILL_FILE_NAME),
      ["---", "name: risky-skill", "description: Do the risky thing", "---", "", "Do the risky thing", "", "## Step 1", "", "Run the checklist.", ""].join("\n"),
    );
    await writeFile(path.join(bundleDir, "scripts", "install.sh"), "#!/bin/sh\necho nope\n");

    const read = await readSkillBundlesFromDir(dir);
    assert.equal(read.bundles.length, 1);
    assert.equal(read.bundles[0].hasUnimportedResources, true);
    assert.equal(read.bundles[0].steps?.length, 1);
    assert.ok(!read.bundles[0].body.includes("echo nope"));

    const storage = new StorageManager(memoryDir);
    await persistImportedSkills({ storage, bundles: read.bundles });
    const imported = (await storage.readAllMemories()).filter((m) => m.frontmatter.category === "procedure");
    assert.equal(imported.length, 1);
    assert.equal(imported[0].frontmatter.structuredAttributes?.hasUnimportedResources, "true");
    assert.equal(imported[0].frontmatter.status, "pending_review");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a step-less body is stored verbatim", async () => {
  const dir = await tempDir("remnic-skill-prose-");
  const memoryDir = await tempDir("remnic-skill-memory-");
  try {
    const bundleDir = path.join(dir, "prose-skill");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, SKILL_FILE_NAME), "---\nname: prose-skill\n---\n\nJust prose guidance.\n");

    const read = await readSkillBundlesFromDir(dir);
    assert.equal(read.bundles[0].steps, null);

    const storage = new StorageManager(memoryDir);
    await persistImportedSkills({ storage, bundles: read.bundles });
    const imported = (await storage.readAllMemories()).filter((m) => m.frontmatter.category === "procedure");
    assert.match(imported[0].content, /Just prose guidance\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("symlinked bundles and escaping entries are skipped with a reason", async () => {
  const dir = await tempDir("remnic-skill-symlink-");
  const outside = await tempDir("remnic-skill-outside-");
  try {
    const real = path.join(dir, "real-skill");
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, SKILL_FILE_NAME), "---\nname: real-skill\n---\n\nReal body\n");

    // A symlinked bundle directory pointing outside the import root.
    await mkdir(path.join(outside, "evil"), { recursive: true });
    await writeFile(path.join(outside, "evil", SKILL_FILE_NAME), "---\nname: evil\n---\n\nEscaped body\n");
    await symlink(path.join(outside, "evil"), path.join(dir, "linked-skill"), "dir");

    // A bundle whose SKILL.md is itself a symlink.
    const linkedFile = path.join(dir, "linked-file-skill");
    await mkdir(linkedFile, { recursive: true });
    await symlink(path.join(outside, "evil", SKILL_FILE_NAME), path.join(linkedFile, SKILL_FILE_NAME), "file");

    // A directory with no SKILL.md at all.
    await mkdir(path.join(dir, "empty-skill"), { recursive: true });

    const read = await readSkillBundlesFromDir(dir);
    assert.deepEqual(read.bundles.map((b) => b.slug), ["real-skill"]);
    const reasons = new Map(read.skipped.map((s) => [s.entry, s.reason]));
    assert.equal(reasons.get("linked-skill"), "symlink");
    assert.match(reasons.get("linked-file-skill") ?? "", /not a regular file/);
    assert.match(reasons.get("empty-skill") ?? "", /no SKILL\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlinked import root is refused outright", async () => {
  const dir = await tempDir("remnic-skill-root-");
  const linkParent = await tempDir("remnic-skill-link-");
  try {
    const link = path.join(linkParent, "linked-root");
    await symlink(dir, link, "dir");
    await assert.rejects(() => readSkillBundlesFromDir(link), /symlinked directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(linkParent, { recursive: true, force: true });
  }
});
