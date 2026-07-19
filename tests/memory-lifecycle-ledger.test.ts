import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import type { MemoryLifecycleEvent } from "../src/types.ts";
import {
  backupExistingLedger,
  rebuildMemoryLifecycleLedger,
} from "../src/maintenance/rebuild-memory-lifecycle-ledger.ts";
import {
  memoryLifecycleLedgerLockPath,
} from "../src/memory-lifecycle-ledger-utils.ts";

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
    const { id: id } = await storage.writeMemory("fact", "Initial memory content", {
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
    const { id: id } = await storage.writeMemory("fact", "Tool-authored memory content", {
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
    const { id: id } = await storage.writeMemory("fact", "Tool-authored memory content", {
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
    const { id: id } = await storage.writeMemory("fact", "Archive me", {
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

    const { id: memoryId } = await storage.writeMemory("fact", "Write path memory", { source: "test" });
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

test("rebuildMemoryLifecycleLedger skips duplicate events and blank IDs without aborting", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-anomalies-"));
  try {
    const duplicate = `---
id: duplicate-id
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: []
---

duplicate
`;
    await writeText(memoryDir, "facts/2026-03-08/hot.md", duplicate);
    await writeText(memoryDir, "cold/facts/2026-03-08/cold.md", duplicate);
    await writeText(memoryDir, "facts/2026-03-08/blank-a.md", duplicate.replace("id: duplicate-id", "id:"));
    await writeText(memoryDir, "archive/2026-03-08/blank-b.md", duplicate.replace("id: duplicate-id", "id:   "));

    const result = await rebuildMemoryLifecycleLedger({ memoryDir, dryRun: false });

    assert.equal(result.scannedMemories, 4);
    assert.equal(result.rebuiltRows, 2);
    assert.equal(result.skippedBlankIdMemories.length, 2);
    assert.equal(result.skippedDuplicateEvents.length, 2);
    assert.equal(result.skippedDuplicateEvents.every((entry) => entry.eventId.includes("duplicate-id")), true);
    const rows = (await readFile(result.outputPath, "utf-8")).trim().split("\n");
    assert.equal(rows.length, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger rejects a storage whose dir does not match memoryDir (#1910)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-dir-mismatch-a-"));
  const otherDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-dir-mismatch-b-"));
  try {
    const mismatched = new StorageManager(otherDir);
    await assert.rejects(
      () => rebuildMemoryLifecycleLedger({ memoryDir, dryRun: false, storage: mismatched }),
      /storage\.dir .* must match .*memoryDir/,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(otherDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger aborts and leaves the ledger intact when preserve read fails (#1910)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-preserve-readfail-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: []\n---\n\nalpha\n`,
    );
    // An append-only row a frontmatter-only rebuild cannot reconstruct.
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const appendOnly = {
      eventId: "cap-1",
      memoryId: "fact-1",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-08T02:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    const originalLedger = `${JSON.stringify(appendOnly)}\n`;
    await writeFile(ledgerPath, originalLedger, "utf-8");

    // Simulate a genuinely unreadable ledger during the preserve read (e.g.
    // corruption, or a locked required secure store). storage.dir === memoryDir
    // so the dir-match guard passes and the compaction preserve read is what
    // fails. (An oversize encrypted ledger no longer fails here — the uncapped
    // buffer read shrinks it — so the abort contract is now exercised through a
    // real read failure, #2033.)
    class UnreadableLedgerStorage extends StorageManager {
      override async readAllMemoryLifecycleEventsForCompaction(): Promise<MemoryLifecycleEvent[]> {
        throw new Error("simulated lifecycle ledger read failure (corruption or locked store)");
      }
    }
    const storage = new UnreadableLedgerStorage(memoryDir);

    await assert.rejects(
      () => rebuildMemoryLifecycleLedger({
        memoryDir,
        dryRun: false,
        storage,
        preserveExistingEvents: true,
      }),
      /rebuild aborted: cannot read existing events to preserve/,
    );
    // No lossy rewrite: the append-only history must survive the failed compaction.
    assert.equal(
      await readFile(ledgerPath, "utf-8"),
      originalLedger,
      "ledger must be untouched after a preserve-read abort",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger does not lose a lifecycle event appended during compaction (#1910)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-concurrent-append-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: []\n---\n\nalpha\n`,
    );
    // An append-only row that only the preserve path can carry over.
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const capOne: MemoryLifecycleEvent = {
      eventId: "cap-1",
      memoryId: "fact-1",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-08T02:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    await writeFile(ledgerPath, `${JSON.stringify(capOne)}\n`, "utf-8");

    // Fire a concurrent append the instant the rebuild reads the ledger to
    // preserve it — i.e. while the rebuild holds the ledger lock. The append
    // must block on that lock and land on the compacted ledger afterwards
    // instead of being clobbered by the rewrite/rename.
    const appender = new StorageManager(memoryDir);
    const capTwo: MemoryLifecycleEvent = {
      eventId: "cap-2",
      memoryId: "fact-1",
      eventType: "imported",
      timestamp: "2026-03-08T03:00:00.000Z",
      actor: "importer",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    let appendPromise: Promise<number> | undefined;
    class RebuildStorageWithConcurrentAppend extends StorageManager {
      private fired = false;
      override async readAllMemoryLifecycleEventsForCompaction(): Promise<MemoryLifecycleEvent[]> {
        const events = await super.readAllMemoryLifecycleEventsForCompaction();
        if (!this.fired) {
          this.fired = true;
          // Not awaited: it cannot complete until the rebuild releases the lock.
          appendPromise = appender.appendMemoryLifecycleEvents([capTwo]);
        }
        return events;
      }
    }
    const storage = new RebuildStorageWithConcurrentAppend(memoryDir);

    await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      storage,
      preserveExistingEvents: true,
    });
    assert.ok(appendPromise, "concurrent append must have been fired during the preserve read");
    await appendPromise;

    const finalIds = (await new StorageManager(memoryDir).readAllMemoryLifecycleEvents())
      .map((event) => event.eventId)
      .sort();
    assert.ok(finalIds.includes("cap-1"), "preserved append-only event must survive compaction");
    assert.ok(
      finalIds.includes("cap-2"),
      "event appended during compaction must land on the compacted ledger, not be lost",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger refuses to run unlocked when the ledger lock cannot be acquired (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-lock-timeout-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: []\n---\n\nalpha\n`,
    );
    // An append-only row a frontmatter-only rebuild cannot reconstruct: proves
    // the ledger is left untouched, not rewritten from frontmatter alone.
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const appendOnly: MemoryLifecycleEvent = {
      eventId: "cap-1",
      memoryId: "fact-1",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-08T02:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    const originalLedger = `${JSON.stringify(appendOnly)}\n`;
    await writeFile(ledgerPath, originalLedger, "utf-8");

    // Hold the cross-process lock with a FRESH (non-stale) lock file so
    // acquisition times out and withHeldFileLock invokes the rebuild with
    // acquired=false. A short lockOptions budget keeps the test deterministic.
    const lockPath = memoryLifecycleLedgerLockPath(ledgerPath);
    await writeFile(lockPath, `${process.pid} held-by-test ${new Date().toISOString()}\n`, "utf-8");

    await assert.rejects(
      () => rebuildMemoryLifecycleLedger({
        memoryDir,
        dryRun: false,
        preserveExistingEvents: true,
        lockOptions: { maxWaitMs: 100, pollMs: 20 },
      }),
      /could not acquire the ledger lock/,
    );
    // No unlocked rewrite: the append-only history must survive untouched.
    assert.equal(
      await readFile(ledgerPath, "utf-8"),
      originalLedger,
      "ledger must be untouched when the lock is not acquired",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("compaction preserves a frontmatter-derived lifecycle row that raced the corpus scan (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-scan-race-"));
  try {
    // A memory present at scan time → the reconstruction emits fact-1 created@T0.
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `source: test\nconfidence: 0.8\nconfidenceTier: implied\ntags: []\n---\n\nalpha\n`,
    );
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    // Seed the ledger with fact-1's live created row (same content key as the
    // reconstruction → must collapse to one) plus fact-2's created row: a
    // memory the corpus scan never saw because it was created after the scan.
    // That is a frontmatter-derived ("created") row the reconstruction cannot
    // reproduce; the old eventType-only filter deleted it. It must survive.
    const liveCreatedFact1: MemoryLifecycleEvent = {
      eventId: "mle-fact1-created",
      memoryId: "fact-1",
      eventType: "created",
      timestamp: "2026-03-08T00:00:00.000Z",
      actor: "storage.writeMemory",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    const racedCreatedFact2: MemoryLifecycleEvent = {
      eventId: "mle-fact2-created",
      memoryId: "fact-2",
      eventType: "created",
      timestamp: "2026-03-08T05:00:00.000Z",
      actor: "storage.writeMemory",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    await writeFile(
      ledgerPath,
      `${JSON.stringify(liveCreatedFact1)}\n${JSON.stringify(racedCreatedFact2)}\n`,
      "utf-8",
    );

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      storage: new StorageManager(memoryDir),
      preserveExistingEvents: true,
    });

    const final = await new StorageManager(memoryDir).readAllMemoryLifecycleEvents();
    const fact2Created = final.filter((e) => e.memoryId === "fact-2" && e.eventType === "created");
    assert.equal(fact2Created.length, 1, "raced frontmatter-derived row must survive compaction");
    assert.equal(fact2Created[0]?.eventId, "mle-fact2-created");
    const fact1Created = final.filter((e) => e.memoryId === "fact-1" && e.eventType === "created");
    assert.equal(
      fact1Created.length,
      1,
      "the scanned memory's created event must collapse to exactly one row",
    );
    assert.equal(
      fact1Created[0]?.eventId,
      "rebuild-fact-1-created-2026-03-08T00:00:00.000Z",
      "the collapsed row must be the fresh reconstruction, not the live duplicate",
    );
    assert.ok(
      (result.preservedAppendOnlyRows ?? 0) >= 1,
      "the raced row is counted as preserved beyond the reconstruction",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuild bounds a large append-only history under maxLedgerBytes, archiving the overflow to the backup (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-bound-"));
  try {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    // Many append-only events with no frontmatter equivalent — a preserving
    // rebuild would otherwise carry ALL of them and could leave the ledger over
    // the read/decrypt cap. Distinct ascending timestamps make "newest" precise.
    const total = 200;
    const events: MemoryLifecycleEvent[] = [];
    for (let i = 0; i < total; i += 1) {
      events.push({
        eventId: `cap-${String(i).padStart(3, "0")}`,
        memoryId: "mem-a",
        eventType: "explicit_capture_accepted",
        // Monotonic ascending ISO timestamps so "newest" is unambiguous.
        timestamp: new Date(Date.UTC(2026, 2, 8, 0, 0, 0, 0) + i * 1000).toISOString(),
        actor: "explicit-capture",
        ruleVersion: "memory-lifecycle-ledger.v1",
      });
    }
    const originalLedger = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await writeFile(ledgerPath, originalLedger, "utf-8");
    const rowBytes = Buffer.byteLength(`${JSON.stringify(events[0])}\n`, "utf8");
    // Cap admits only ~20 rows so bounding must drop the rest.
    const cap = rowBytes * 20 + Math.floor(rowBytes / 2);

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      preserveExistingEvents: true,
      maxLedgerBytes: cap,
    });

    const rewritten = await readFile(ledgerPath, "utf-8");
    assert.ok(Buffer.byteLength(rewritten, "utf8") < cap, "rewritten ledger is under the byte cap");
    assert.ok((result.archivedOverflowRows ?? 0) > 0, "overflow rows were archived, not all kept");
    assert.equal(
      result.rebuiltRows + (result.archivedOverflowRows ?? 0),
      total,
      "kept + archived rows account for every original row",
    );
    // The NEWEST events survive in the active ledger; the oldest were dropped.
    const keptIds = rewritten.trim().split("\n").map((l) => (JSON.parse(l) as MemoryLifecycleEvent).eventId);
    assert.ok(keptIds.includes(`cap-${String(total - 1).padStart(3, "0")}`), "newest event kept");
    assert.ok(!keptIds.includes("cap-000"), "oldest event dropped from the active ledger");
    // The dropped rows are archived in the verbatim backup, so nothing is lost.
    assert.ok(result.backupPath, "a backup was written");
    const backup = await readFile(result.backupPath!, "utf-8");
    assert.equal(backup, originalLedger, "backup holds every original row verbatim");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuild bounds finalEvents under maxLedgerBytes even when the on-disk ledger is all-invalid (existing empty) (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-bound-empty-existing-"));
  try {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    // Many memories → a large frontmatter reconstruction (created + updated per
    // memory) that must be bounded by the cap.
    const total = 60;
    for (let i = 0; i < total; i += 1) {
      const created = new Date(Date.UTC(2026, 2, 8, 0, 0, 0, 0) + i * 2000).toISOString();
      const updated = new Date(Date.UTC(2026, 2, 8, 0, 0, 1, 0) + i * 2000).toISOString();
      await writeText(
        memoryDir,
        `facts/2026-03-08/fact-${String(i).padStart(3, "0")}.md`,
        `---\nid: fact-${String(i).padStart(3, "0")}\ncategory: fact\ncreated: ${created}\nupdated: ${updated}\nsource: test\nconfidence: 0.8\nconfidenceTier: implied\ntags: ["t"]\n---\n\nbody ${i}\n`,
      );
    }
    // The on-disk ledger is oversized but EVERY row fails validation, so the
    // preserve read returns [] — the exact case that previously skipped the byte
    // cap and let a large frontmatter reconstruction be written unbounded (#2033).
    const garbage = `${"not-a-valid-lifecycle-row\n".repeat(400)}`;
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, garbage, "utf-8");
    const cap = 2000;

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      preserveExistingEvents: true,
      maxLedgerBytes: cap,
    });

    const rewritten = await readFile(ledgerPath, "utf-8");
    assert.ok(Buffer.byteLength(rewritten, "utf8") < cap, "rewritten ledger is under the byte cap despite empty existing");
    assert.ok((result.archivedOverflowRows ?? 0) > 0, "overflow rows were dropped from the active ledger");
    // The verbatim (invalid) on-disk bytes are preserved in the backup.
    assert.ok(result.backupPath, "a backup was written");
    assert.equal(await readFile(result.backupPath!, "utf-8"), garbage, "backup holds the original bytes verbatim");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
