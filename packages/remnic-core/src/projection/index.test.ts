import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { generateContextTree } from "./index.js";

async function writeFact(memoryDir: string): Promise<void> {
  const factsDir = path.join(memoryDir, "facts");
  await mkdir(factsDir, { recursive: true });
  await writeFile(
    path.join(factsDir, "fact-1.md"),
    [
      "---",
      "id: fact-1",
      "category: fact",
      "created: 2026-05-21T00:00:00.000Z",
      "updated: 2026-05-21T00:00:00.000Z",
      "confidence: 1",
      "confidenceTier: explicit",
      "tags: []",
      "source: test",
      "---",
      "",
      "Stored fact body.",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function writeQuestion(memoryDir: string): Promise<void> {
  const questionsDir = path.join(memoryDir, "questions");
  await mkdir(questionsDir, { recursive: true });
  await writeFile(
    path.join(questionsDir, "question-1.md"),
    [
      "---",
      "id: question-1",
      "category: question",
      "created: 2026-05-21T00:00:00.000Z",
      "updated: 2026-05-21T00:00:00.000Z",
      "confidence: 1",
      "confidenceTier: explicit",
      "tags: []",
      "source: test",
      "---",
      "",
      "Stored question body?",
      "",
    ].join("\n"),
    "utf-8",
  );
}

test("generateContextTree rejects categories that would escape the output directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-category-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outputDir = path.join(root, "context-tree");
    await writeFact(memoryDir);

    await assert.rejects(
      generateContextTree({
        memoryDir,
        outputDir,
        categories: ["../escaped"],
        includeEntities: false,
        includeQuestions: false,
      }),
      /invalid context tree category/,
    );
    await assert.rejects(
      readFile(path.join(root, "escaped", "fact-1.md"), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateContextTree writes valid categories under the output directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-valid-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outputDir = path.join(root, "context-tree");
    await writeFact(memoryDir);

    const result = await generateContextTree({
      memoryDir,
      outputDir,
      categories: ["fact"],
      includeEntities: false,
      includeQuestions: false,
    });

    assert.equal(result.nodesGenerated, 1);
    const projected = await readFile(
      path.join(outputDir, "fact", "fact-1.md"),
      "utf-8",
    );
    assert.match(projected, /Stored fact body/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateContextTree does not include questions when categories exclude question", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-question-filter-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outputDir = path.join(root, "context-tree");
    await writeFact(memoryDir);
    await writeQuestion(memoryDir);

    const result = await generateContextTree({
      memoryDir,
      outputDir,
      categories: ["fact"],
      includeEntities: false,
      includeQuestions: true,
    });

    assert.equal(result.nodesGenerated, 1);
    assert.deepEqual(result.categories, { fact: 1 });
    await assert.rejects(
      readFile(path.join(outputDir, "question", "question-1.md"), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateContextTree rejects symlinked memory category roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-input-symlink-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outsideDir = path.join(root, "outside-facts");
    const outputDir = path.join(root, "context-tree");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "fact-escape.md"), "escaped", "utf-8");
    await symlink(outsideDir, path.join(memoryDir, "facts"), "dir");

    await assert.rejects(
      generateContextTree({
        memoryDir,
        outputDir,
        categories: ["fact"],
        includeEntities: false,
        includeQuestions: false,
      }),
      /symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateContextTree rejects symlinked output path components", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-output-symlink-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outputDir = path.join(root, "context-tree");
    const outsideDir = path.join(root, "outside-output");
    await writeFact(memoryDir);
    await mkdir(outputDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(outputDir, "fact"), "dir");

    await assert.rejects(
      generateContextTree({
        memoryDir,
        outputDir,
        categories: ["fact"],
        includeEntities: false,
        includeQuestions: false,
      }),
      /symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateContextTree processes explicit question category only once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-question-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outputDir = path.join(root, "context-tree");
    await writeQuestion(memoryDir);

    const result = await generateContextTree({
      memoryDir,
      outputDir,
      categories: ["question"],
      includeEntities: false,
    });

    assert.equal(result.nodesGenerated, 1);
    assert.deepEqual(result.categories, { question: 1 });
    const projected = await readFile(
      path.join(outputDir, "question", "question-1.md"),
      "utf-8",
    );
    assert.match(projected, /Stored question body/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateContextTree preserves manual fenced blocks on regeneration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-manual-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outputDir = path.join(root, "context-tree");
    await writeFact(memoryDir);

    await generateContextTree({
      memoryDir,
      outputDir,
      categories: ["fact"],
      includeEntities: false,
      includeQuestions: false,
    });

    const projectedPath = path.join(outputDir, "fact", "fact-1.md");
    const generated = await readFile(projectedPath, "utf-8");
    const manualBlock = [
      "```manual",
      "Keep this human note across regeneration.",
      "```",
    ].join("\n");
    await writeFile(projectedPath, `${generated.trimEnd()}\n\n${manualBlock}\n`, "utf-8");

    await generateContextTree({
      memoryDir,
      outputDir,
      categories: ["fact"],
      includeEntities: false,
      includeQuestions: false,
    });

    const regenerated = await readFile(projectedPath, "utf-8");
    assert.match(regenerated, /Stored fact body/);
    assert.match(regenerated, /## Manual Edits/);
    assert.match(regenerated, /Keep this human note across regeneration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
