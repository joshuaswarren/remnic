import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSpace, loadManifest } from "./index.js";

test("personal space bootstrap prefers REMNIC_MEMORY_DIR over legacy ENGRAM_MEMORY_DIR", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-current-"));
  const remnicMemoryDir = path.join(baseDir, "remnic-memory");
  const legacyMemoryDir = path.join(baseDir, "engram-memory");
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;

  process.env.REMNIC_MEMORY_DIR = remnicMemoryDir;
  process.env.ENGRAM_MEMORY_DIR = legacyMemoryDir;
  try {
    const manifest = loadManifest(baseDir);
    assert.equal(manifest.spaces[0]?.memoryDir, remnicMemoryDir);
  } finally {
    if (previousRemnic === undefined) delete process.env.REMNIC_MEMORY_DIR;
    else process.env.REMNIC_MEMORY_DIR = previousRemnic;
    if (previousEngram === undefined) delete process.env.ENGRAM_MEMORY_DIR;
    else process.env.ENGRAM_MEMORY_DIR = previousEngram;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("personal space bootstrap keeps ENGRAM_MEMORY_DIR as a legacy fallback", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-legacy-"));
  const legacyMemoryDir = path.join(baseDir, "engram-memory");
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;

  delete process.env.REMNIC_MEMORY_DIR;
  process.env.ENGRAM_MEMORY_DIR = legacyMemoryDir;
  try {
    const manifest = loadManifest(baseDir);
    assert.equal(manifest.spaces[0]?.memoryDir, legacyMemoryDir);
  } finally {
    if (previousRemnic === undefined) delete process.env.REMNIC_MEMORY_DIR;
    else process.env.REMNIC_MEMORY_DIR = previousRemnic;
    if (previousEngram === undefined) delete process.env.ENGRAM_MEMORY_DIR;
    else process.env.ENGRAM_MEMORY_DIR = previousEngram;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("personal space bootstrap normalizes relative memoryDir env values", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-relative-env-"));
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;

  process.env.REMNIC_MEMORY_DIR = "relative-personal-memory";
  try {
    const manifest = loadManifest(baseDir);
    assert.equal(manifest.spaces[0]?.memoryDir, path.resolve("relative-personal-memory"));
  } finally {
    if (previousRemnic === undefined) delete process.env.REMNIC_MEMORY_DIR;
    else process.env.REMNIC_MEMORY_DIR = previousRemnic;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("createSpace normalizes caller-provided memoryDir before saving manifest", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-spaces-relative-create-"));
  const projectMemoryDir = path.resolve("relative-project-memory");
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;

  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  try {
    const created = createSpace({
      baseDir,
      name: "Project",
      kind: "project",
      memoryDir: "relative-project-memory",
    });
    assert.equal(created.memoryDir, projectMemoryDir);

    const manifest = loadManifest(baseDir);
    const saved = manifest.spaces.find((space) => space.id === "project");
    assert.equal(saved?.memoryDir, projectMemoryDir);
  } finally {
    if (previousRemnic === undefined) delete process.env.REMNIC_MEMORY_DIR;
    else process.env.REMNIC_MEMORY_DIR = previousRemnic;
    if (previousEngram === undefined) delete process.env.ENGRAM_MEMORY_DIR;
    else process.env.ENGRAM_MEMORY_DIR = previousEngram;
    await rm(baseDir, { recursive: true, force: true });
    await rm(projectMemoryDir, { recursive: true, force: true });
  }
});
