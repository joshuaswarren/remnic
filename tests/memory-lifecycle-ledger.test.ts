import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import {
  backupExistingLedger,
  rebuildMemoryLifecycleLedger,
} from "../src/maintenance/rebuild-memory-lifecycle-ledger.ts";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("StorageManager appends and reads memory lifecycle events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-events-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const wrote = await storage.appendMemoryLifecycleEvents([
      {
        eventId: "evt-1",
        memoryId: "fact-1",
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
        actor: "storage.writeMemory",
        ruleVersion: "memory-lifecycle-ledger.v1",
      },
      {
        eventId: "evt-2",
        memoryId: "fact-1",
        eventType: "updated",
        timestamp: "2026-03-08T00:01:00.000Z",
        actor: "storage.updateMemory",
        ruleVersion: "memory-lifecycle-ledger.v1",
      },
    ]);

    assert.equal(wrote, 2);
    const loaded = await storage.readMemoryLifecycleEvents(10);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.eventType, "created");
    assert.equal(loaded[1]?.eventType, "updated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager readMemoryLifecycleEvents ignores malformed rows fail-open", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.appendMemoryLifecycleEvents([
      {
        eventId: "evt-1",
        memoryId: "fact-1",
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
        actor: "storage.writeMemory",
        ruleVersion: "memory-lifecycle-ledger.v1",
      },
    ]);
    await appendFile(path.join(dir, "state", "memory-lifecycle-ledger.jsonl"), "{bad-json}\n", "utf-8");

    const loaded = await storage.readMemoryLifecycleEvents(10);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.memoryId, "fact-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager emits created updated and archived lifecycle events for memory mutations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-mutations-"));
  try {
    const storage = new StorageManager(dir);
    const id = await storage.writeMemory("fact", "Initial memory content", {
      source: "test",
      tags: ["lifecycle"],
    });
    const memories = await storage.readAllMemories();
    const memory = memories.find((entry) => entry.frontmatter.id === id);
    assert.ok(memory);

    const updated = await storage.updateMemory(id, "Updated memory content");
    assert.equal(updated, true);

    const archivedPath = await storage.archiveMemory(memory!);
    assert.equal(typeof archivedPath, "string");

    const events = await storage.readMemoryLifecycleEvents(10);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.eventType), ["created", "updated", "archived"]);
    assert.equal(events.every((event) => event.memoryId === id), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager writeMemory preserves explicit lifecycle actor overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-actor-"));
  try {
    const storage = new StorageManager(dir);
    const id = await storage.writeMemory("fact", "Tool-authored memory content", {
      source: "test",
      actor: "tool.memory_action_apply",
    });

    const events = await storage.readMemoryLifecycleEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.memoryId, id);
    assert.equal(events[0]?.actor, "tool.memory_action_apply");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager updateMemory preserves explicit lifecycle actor overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-update-actor-"));
  try {
    const storage = new StorageManager(dir);
    const id = await storage.writeMemory("fact", "Tool-authored memory content", {
      source: "test",
    });

    const updated = await storage.updateMemory(id, "Updated tool-authored memory content", {
      actor: "tool.memory_action_apply",
    });

    assert.equal(updated, true);
    const events = await storage.readMemoryLifecycleEvents(10);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.memoryId, id);
    assert.equal(events[1]?.actor, "tool.memory_action_apply");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager writeArtifact preserves explicit lifecycle actor overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-artifact-actor-"));
  try {
    const storage = new StorageManager(dir);

    const id = await storage.writeArtifact("Artifact body", {
      actor: "tool.memory_action_apply",
      sourceMemoryId: "fact-existing",
    } as any);
    assert.match(id, /^artifact-/);

    const events = await storage.readMemoryLifecycleEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actor, "tool.memory_action_apply");
    assert.deepEqual(events[0]?.relatedMemoryIds, ["fact-existing"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archiveMemory fails open when lifecycle ledger append throws after archive move", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-archive-fail-open-"));
  try {
    const storage = new StorageManager(dir);
    const id = await storage.writeMemory("fact", "Archive me", {
      source: "test",
      tags: ["archive"],
    });
    const memories = await storage.readAllMemories();
    const memory = memories.find((entry) => entry.frontmatter.id === id);
    assert.ok(memory);

    const originalAppend = (storage as any).appendGeneratedMemoryLifecycleEvent;
    let throwOnce = true;
    (storage as any).appendGeneratedMemoryLifecycleEvent = async (...args: unknown[]) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("simulated ledger failure");
      }
      return originalAppend.apply(storage, args);
    };

    const archivedPath = await storage.archiveMemory(memory!);
    assert.equal(typeof archivedPath, "string");
    await stat(archivedPath as string);
    await assert.rejects(() => stat(memory!.path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory write paths fail open when lifecycle ledger append throws", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-write-fail-open-"));
  try {
    const storage = new StorageManager(dir);
    let failCount = 4;
    (storage as any).appendGeneratedMemoryLifecycleEvent = async () => {
      if (failCount > 0) {
        failCount -= 1;
        throw new Error("simulated ledger failure");
      }
    };

    const memoryId = await storage.writeMemory("fact", "Write path memory", { source: "test" });
    assert.match(memoryId, /^fact-/);

    const memories = await storage.readAllMemories();
    const memory = memories.find((entry) => entry.frontmatter.id === memoryId);
    assert.ok(memory);

    const updated = await storage.updateMemory(memoryId, "Updated content");
    assert.equal(updated, true);

    const frontmatterUpdated = await storage.writeMemoryFrontmatter(memory!, {
      lifecycleState: "active",
      updated: "2026-03-08T12:00:00.000Z",
    });
    assert.equal(frontmatterUpdated, true);

    const artifactId = await storage.writeArtifact("Important quote", { sourceMemoryId: memoryId });
    assert.match(artifactId, /^artifact-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger dry-run computes inferred events without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-dry-"));
  await writeText(
    memoryDir,
    "facts/2026-03-08/fact-1.md",
    `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
  );
  await writeText(
    memoryDir,
    "archive/2026-03-08/fact-2.md",
    `---
id: fact-2
category: fact
created: 2026-03-07T00:00:00.000Z
updated: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
status: archived
archivedAt: 2026-03-08T02:00:00.000Z
---

beta
`,
  );

  const result = await rebuildMemoryLifecycleLedger({ memoryDir });
  assert.equal(result.dryRun, true);
  assert.equal(result.scannedMemories, 2);
  assert.equal(result.rebuiltRows, 4);
  await assert.rejects(() => stat(result.outputPath));
});

test("rebuildMemoryLifecycleLedger includes hot cold and archived memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-cold-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-hot.md",
      `---
id: fact-hot
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["hot"]
---

hot
`,
    );
    await writeText(
      memoryDir,
      "cold/facts/2026-03-08/fact-cold.md",
      `---
id: fact-cold
category: fact
created: 2026-03-08T02:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["cold"]
---

cold
`,
    );
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      `---
id: fact-archived
category: fact
created: 2026-03-08T04:00:00.000Z
updated: 2026-03-08T05:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
status: archived
archivedAt: 2026-03-08T06:00:00.000Z
---

archived
`,
    );

    const result = await rebuildMemoryLifecycleLedger({ memoryDir });

    assert.equal(result.scannedMemories, 3);
    assert.equal(result.rebuiltRows, 7);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger writes deterministic ledger and backs up existing file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-live-"));
  await writeText(
    memoryDir,
    "facts/2026-03-08/fact-1.md",
    `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
  );
  await writeText(
    memoryDir,
    "state/memory-lifecycle-ledger.jsonl",
    "{\"legacy\":true}\n",
  );

  const result = await rebuildMemoryLifecycleLedger({
    memoryDir,
    dryRun: false,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });

  assert.equal(result.rebuiltRows, 2);
  assert.equal(result.backupPath != null, true);

  const backupRaw = await readFile(result.backupPath as string, "utf-8");
  assert.equal(backupRaw, "{\"legacy\":true}\n");

  const rebuiltRaw = await readFile(result.outputPath, "utf-8");
  const rows = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.eventType), ["created", "updated"]);
  assert.equal(rows[0]?.memoryId, "fact-1");
} );

test("backupExistingLedger rethrows non-missing stat failures", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-stat-failure-"));
  try {
    await writeFile(path.join(memoryDir, "state"), "not-a-directory", "utf-8");

    await assert.rejects(
      () => backupExistingLedger(
        memoryDir,
        path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl"),
        new Date("2026-03-08T12:00:00.000Z"),
      ),
      /ENOTDIR|not a directory/i,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger preserves active ledger when atomic replacement fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-fail-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
    );
    const originalLedger = "{\"legacy\":true}\n";
    await writeText(memoryDir, "state/memory-lifecycle-ledger.jsonl", originalLedger);
    await writeText(
      memoryDir,
      "archive/memory-lifecycle-ledger/20260308T120000Z/state",
      "not-a-directory",
    );

    await assert.rejects(
      () => rebuildMemoryLifecycleLedger({
        memoryDir,
        dryRun: false,
        now: new Date("2026-03-08T12:00:00.000Z"),
      }),
    );

    assert.equal(
      await readFile(path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl"), "utf-8"),
      originalLedger,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger uses semantic event ordering for timestamp ties", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-tie-order-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T00:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
status: archived
archivedAt: 2026-03-08T00:00:00.000Z
---

alpha
`,
    );
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-2.md",
      `---
id: fact-2
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T00:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
status: superseded
supersededBy: fact-3
supersededAt: 2026-03-08T00:00:00.000Z
---

beta
`,
    );

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const rebuiltRaw = await readFile(result.outputPath, "utf-8");
    const rows = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
    assert.deepEqual(
      rows.filter((row) => row.memoryId === "fact-1").map((row) => row.eventType),
      ["created", "archived"],
    );
    assert.deepEqual(
      rows.filter((row) => row.memoryId === "fact-2").map((row) => row.eventType),
      ["created", "superseded"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger suppresses duplicate updated events across both status transitions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-dual-transition-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
status: archived
supersededBy: fact-2
supersededAt: 2026-03-08T01:00:00.000Z
archivedAt: 2026-03-08T02:00:00.000Z
---

alpha
`,
    );

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const rebuiltRaw = await readFile(result.outputPath, "utf-8");
    const rows = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
    assert.deepEqual(
      rows.filter((row) => row.memoryId === "fact-1").map((row) => [row.eventType, row.timestamp]),
      [
        ["created", "2026-03-08T00:00:00.000Z"],
        ["superseded", "2026-03-08T01:00:00.000Z"],
        ["archived", "2026-03-08T02:00:00.000Z"],
      ],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger suppresses updated when archived fallback uses updated timestamp", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-archived-fallback-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
status: archived
---

alpha
`,
    );

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const rebuiltRaw = await readFile(result.outputPath, "utf-8");
    const rows = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
    assert.deepEqual(
      rows.filter((row) => row.memoryId === "fact-1").map((row) => [row.eventType, row.timestamp]),
      [
        ["created", "2026-03-08T00:00:00.000Z"],
        ["archived", "2026-03-08T01:00:00.000Z"],
      ],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
