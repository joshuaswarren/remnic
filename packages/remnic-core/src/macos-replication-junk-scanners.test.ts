import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readCalibrationCorrections } from "./calibration.js";
import { CorrectionPlanner, type PlannerDeps } from "./correction/correction-planner.js";
import { listJsonFiles } from "./json-store.js";
import { ProfilingCollector } from "./profiling.js";
import { scanMemoryDir } from "./search/document-scanner.js";
import { StorageManager } from "./storage.js";
import { hasSupersessionAudit } from "./storage/supersession-audit.js";

const CORRECTION_BODY = [
  "---",
  "id: correction-sidecar",
  "confidence: 0.9",
  "---",
  "Synthetic correction that must not be loaded from Finder metadata.",
].join("\n");

test("scanMemoryDir ignores AppleDouble and .DS_Store index inputs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scan-macos-junk-"));
  try {
    const factsDir = path.join(memoryDir, "facts", "2026-02-22");
    await mkdir(factsDir, { recursive: true });
    await writeFile(
      path.join(factsDir, "inside.md"),
      ["---", "id: inside", "category: fact", "---", "A real fact."].join("\n"),
      "utf8"
    );
    await writeFile(path.join(factsDir, "._inside.md"), Buffer.from([0, 5, 22]));
    await writeFile(path.join(factsDir, ".DS_Store"), "finder");

    const docs = await scanMemoryDir(memoryDir);
    assert.deepEqual(
      docs.map((doc) => doc.docid),
      ["inside"]
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("memory reads skip macOS replication junk beside real facts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-memories-macos-junk-"));
  try {
    const storage = new StorageManager(memoryDir);
    const written = await storage.writeMemory("fact", "Synthetic dome schedule is stored once.");
    const factDir = path.dirname(written.memory.path);
    await writeFile(path.join(factDir, "._inside.md"), CORRECTION_BODY, "utf8");
    await writeFile(path.join(factDir, ".DS_Store"), "finder");

    const memories = await storage.readAllMemories();
    assert.deepEqual(
      memories.map((memory) => memory.frontmatter.id),
      [written.id]
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("correction scans and calibration ignore macOS replication junk", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-corrections-macos-junk-"));
  try {
    const correctionsDir = path.join(memoryDir, "corrections");
    await mkdir(correctionsDir, { recursive: true });
    await writeFile(
      path.join(correctionsDir, "correction-real.md"),
      CORRECTION_BODY.replace("correction-sidecar", "correction-real"),
      "utf8"
    );
    await writeFile(path.join(correctionsDir, "._sidecar.md"), CORRECTION_BODY, "utf8");
    await writeFile(path.join(correctionsDir, ".DS_Store"), "finder");

    const corrections = await readCalibrationCorrections(memoryDir);
    assert.deepEqual(
      corrections.map((correction) => correction.id),
      ["correction-real"]
    );

    const reads: string[] = [];
    const found = await hasSupersessionAudit(
      {
        correctionsDir,
        async readMemoryByPath(filePath) {
          reads.push(path.basename(filePath));
          return null;
        },
      },
      "old-id",
      "new-id",
      "audit body"
    );
    assert.equal(found, false);
    assert.deepEqual(reads, ["correction-real.md"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("state JSON listings and pending correction plans ignore macOS replication junk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-state-macos-junk-"));
  try {
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "real.json"), "{}\n");
    await writeFile(path.join(stateDir, "._state.json"), "{}\n");
    await writeFile(path.join(stateDir, ".DS_Store"), "finder");
    const listed = (await listJsonFiles(stateDir)).map((file) => path.basename(file));
    assert.deepEqual(listed, ["real.json"]);

    const pendingDir = path.join(stateDir, "corrections", "pending");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(path.join(pendingDir, "._plan.json"), "{}\n");
    await writeFile(path.join(pendingDir, ".DS_Store"), "finder");
    const planner = new CorrectionPlanner({
      storageDir: async () => root,
    } as unknown as PlannerDeps);
    assert.deepEqual(await planner.listPending("default"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profiling prune keeps AppleDouble traces and deletes only real jsonl files", async () => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), "remnic-profiling-macos-junk-"));
  try {
    const junk = path.join(storageDir, "._trace.jsonl");
    const older = path.join(storageDir, "recall-old.jsonl");
    const newer = path.join(storageDir, "recall-new.jsonl");
    await writeFile(junk, "sidecar\n");
    await writeFile(older, "old\n");
    await writeFile(newer, "new\n");
    const oldTime = new Date("2020-01-01T00:00:00Z");
    const newTime = new Date("2024-01-01T00:00:00Z");
    await utimes(older, oldTime, oldTime);
    await utimes(newer, newTime, newTime);

    const collector = new ProfilingCollector({ enabled: false, storageDir, maxTraces: 1 });
    await collector.pruneFiles();

    assert.equal(await readFile(junk, "utf8"), "sidecar\n");
    assert.equal(await readFile(newer, "utf8"), "new\n");
    await assert.rejects(() => readFile(older), { code: "ENOENT" });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
