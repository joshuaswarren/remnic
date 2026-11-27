
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  convertMemoriesToRecords,
  getTrainingExportAdapter,
} from "@remnic/core";

import {
  ensureWecloneExportAdapterRegistered,
  synthesizeTrainingPairs,
  sweepPii,
  wecloneExportAdapter,
} from "./index.js";

interface SyntheticMemory {
  id: string;
  category?: string;
  confidence?: number;
  created?: string;
  tags?: string[];
  content: string;
}

async function writeSyntheticMemory(
  dir: string,
  subdir: string,
  filename: string,
  mem: SyntheticMemory,
): Promise<void> {
  const fullDir = path.join(dir, subdir);
  await mkdir(fullDir, { recursive: true });
  const tags = mem.tags ?? [];
  const md = [
    "---",
    `id: ${mem.id}`,
    `category: ${mem.category ?? "fact"}`,
    `created: ${mem.created ?? "2026-01-15T10:00:00.000Z"}`,
    `updated: ${mem.created ?? "2026-01-15T10:00:00.000Z"}`,
    `source: test`,
    `confidence: ${mem.confidence ?? 0.9}`,
    `confidenceTier: explicit`,
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    "",
    mem.content,
  ].join("\n");
  await writeFile(path.join(fullDir, filename), md, "utf-8");
}

describe("@remnic/export-weclone — end-to-end integration", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weclone-int-"));

    await writeSyntheticMemory(tmpDir, "facts", "coffee.md", {
      id: "mem-001",
      category: "preference",
      confidence: 0.9,
      tags: ["food", "coffee"],
      content: "Prefers dark roast coffee, specifically Ethiopian Yirgacheffe.",
    });
    await writeSyntheticMemory(tmpDir, "facts", "typescript.md", {
      id: "mem-002",
      category: "skill",
      confidence: 0.85,
      tags: ["typescript", "language"],
      content: "Proficient with TypeScript generics and conditional types.",
    });
    await writeSyntheticMemory(tmpDir, "corrections", "postgres.md", {
      id: "mem-003",
      category: "decision",
      confidence: 0.95,
      tags: ["database"],
      content: "Chose PostgreSQL over MySQL for its JSONB support.",
    });
    await writeSyntheticMemory(tmpDir, "facts", "lowconf.md", {
      id: "mem-004",
      category: "fact",
      confidence: 0.4,
      content: "Unverified claim that should not reach the dataset.",
    });
    await writeSyntheticMemory(tmpDir, "facts", "pii.md", {
      id: "mem-005",
      category: "fact",
      confidence: 0.9,
      content: "Contact placeholder alice@example.test for the shared demo.",
    });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers the weclone adapter via side-effect import", () => {
    ensureWecloneExportAdapterRegistered();
    const looked = getTrainingExportAdapter("weclone");
    assert.ok(looked, "weclone adapter must be registered");
    assert.equal(looked, wecloneExportAdapter);
    assert.equal(looked!.fileExtension, ".json");
  });

  it("can register into a caller-supplied core registry", () => {
    const registered = new Map<string, typeof wecloneExportAdapter>();
    const didRegister = ensureWecloneExportAdapterRegistered({
      getTrainingExportAdapter: (name) => registered.get(name),
      registerTrainingExportAdapter: (adapter) => {
        registered.set(adapter.name, adapter);
      },
    });

    assert.equal(didRegister, true);
    assert.equal(registered.get("weclone"), wecloneExportAdapter);
  });

  it("converts memoryDir → Alpaca JSON end-to-end", async () => {
    const records = await convertMemoriesToRecords({
      memoryDir: tmpDir,
      minConfidence: 0.7,
    });

    const ids = records.map((r) => r.sourceIds?.[0]).sort();
    assert.deepEqual(ids, ["mem-001", "mem-002", "mem-003", "mem-005"]);

    const { cleanRecords, redactedCount } = sweepPii(records);
    assert.ok(redactedCount >= 1, "PII sweep should redact the email");

    const json = wecloneExportAdapter.formatRecords(cleanRecords);
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, cleanRecords.length);
    for (const row of parsed) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ["input", "instruction", "output"],
        "adapter must emit only Alpaca fields",
      );
    }

    assert.doesNotMatch(
      json,
      /alice@example\.test/,
      "PII must be redacted before adapter serialization",
    );
  });

  it("produces conversational Q/A pairs when synthesis is enabled", async () => {
    const raw = await convertMemoriesToRecords({
      memoryDir: tmpDir,
      minConfidence: 0.7,
    });
    const pairs = synthesizeTrainingPairs(raw);

    assert.equal(pairs.length, raw.length);

    const coffeePair = pairs.find((p) => p.sourceIds?.[0] === "mem-001");
    assert.ok(coffeePair, "expected mem-001 to survive synthesis");
    assert.match(coffeePair!.instruction.toLowerCase(), /like|preference|favorite/);
    assert.match(coffeePair!.instruction.toLowerCase(), /food, coffee/);

    const skillPair = pairs.find((p) => p.sourceIds?.[0] === "mem-002");
    assert.ok(skillPair);
    assert.match(skillPair!.instruction.toLowerCase(), /tell|know|explain/);

    const json = wecloneExportAdapter.formatRecords(pairs);
    const parsed = JSON.parse(json) as Array<{ instruction: string }>;
    assert.equal(parsed.length, pairs.length);
    for (const row of parsed) {
      assert.ok(row.instruction.length > 0);
    }
  });

  it("honours category filter end-to-end", async () => {
    const records = await convertMemoriesToRecords({
      memoryDir: tmpDir,
      categories: ["preference"],
      minConfidence: 0.7,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "mem-001");

    const json = wecloneExportAdapter.formatRecords(records);
    const parsed = JSON.parse(json) as Array<{ output: string }>;
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].output, /dark roast/i);
  });

  it("honours since/until date filters end-to-end", async () => {
    await writeSyntheticMemory(tmpDir, "facts", "old.md", {
      id: "mem-old",
      category: "fact",
      confidence: 0.9,
      created: "2025-01-01T00:00:00.000Z",
      content: "Out-of-window fact.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: tmpDir,
      since: new Date("2026-01-01T00:00:00.000Z"),
      until: new Date("2027-01-01T00:00:00.000Z"),
    });

    const ids = records.map((r) => r.sourceIds?.[0]);
    assert.ok(!ids.includes("mem-old"), "out-of-window memory must be excluded");
    assert.ok(ids.includes("mem-001"), "in-window memory must be included");
  });
});
