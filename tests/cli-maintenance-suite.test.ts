import test from "node:test";
import { skipUnlessBetterSqlite3 } from "./helpers/native-binding.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  runArchiveObservationsCliCommand,
  runMemoryTimelineCliCommand,
  runRebuildMemoryLifecycleLedgerCliCommand,
  runRebuildMemoryProjectionCliCommand,
  runRepairMemoryProjectionCliCommand,
  runMigrateObservationsCliCommand,
  runRebuildObservationsCliCommand,
  runVerifyMemoryProjectionCliCommand,
} from "../src/cli.js";
import { StorageManager } from "../src/storage.js";
import { isEncryptedFile } from "../src/secure-store/index.js";
import { NamespaceStorageRouter } from "../src/namespaces/storage.js";
import type { PluginConfig } from "../src/types.js";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("archive-observations CLI wrapper defaults to dry-run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-archive-observations-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-01-01.jsonl",
    "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n",
  );

  const result = await runArchiveObservationsCliCommand({
    memoryDir,
    retentionDays: 30,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.scannedFiles, 1);
});

test("rebuild-observations CLI wrapper writes only with --write semantics", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-observations-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    JSON.stringify({
      timestamp: "2026-02-25T10:05:00.000Z",
      role: "user",
      content: "u1",
      sessionKey: "agent:main:default",
    }) + "\n",
  );

  const dryRunResult = await runRebuildObservationsCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runRebuildObservationsCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});

test("rebuild-memory-lifecycle-ledger CLI wrapper respects dry-run default and write mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-memory-lifecycle-"));
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

  const dryRunResult = await runRebuildMemoryLifecycleLedgerCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runRebuildMemoryLifecycleLedgerCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});

test("rebuild-memory-lifecycle-ledger CLI recovery preserves append-only history frontmatter cannot reconstruct (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-lifecycle-preserve-"));
  try {
    // A memory file the rebuild reconstructs created/updated events from.
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
    );
    // An APPEND-ONLY ledger row with NO backing memory file: frontmatter cannot
    // reconstruct it, so a frontmatter-only recovery rebuild would silently drop
    // this history. The recovery command must preserve it (#2033).
    const appendOnly = {
      schemaVersion: 1,
      eventId: "evt-capture",
      memoryId: "m-ghost",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-07T00:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    await writeText(memoryDir, "state/memory-lifecycle-ledger.jsonl", `${JSON.stringify(appendOnly)}\n`);

    const writeResult = await runRebuildMemoryLifecycleLedgerCliCommand({
      memoryDir,
      write: true,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });
    assert.equal(writeResult.dryRun, false);

    const ledger = await readFile(writeResult.outputPath, "utf-8");
    assert.ok(
      ledger.includes("evt-capture"),
      "append-only history preserved by the recovery rebuild — not dropped",
    );
    assert.ok(ledger.includes("fact-1"), "frontmatter-derived events still reconstructed");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuild-memory-lifecycle-ledger CLI refuses a locked secure store instead of a keyless plaintext rewrite (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-lifecycle-secure-"));
  const key = Buffer.alloc(32, 0x3c);
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  try {
    // Seed an encrypted-at-rest store: an encrypted memory to reconstruct from
    // plus an encrypted lifecycle ledger on disk.
    const unlocked = new StorageManager(memoryDir);
    unlocked.setSecureStoreRequired(true);
    unlocked.setSecureStoreKey(key, true);
    await unlocked.ensureDirectories();
    await unlocked.writeMemory("fact", "encrypted lifecycle fact");
    await unlocked.writeMemoryLifecycleLedgerContent(
      JSON.stringify({
        schemaVersion: 1,
        eventId: "evt-seed",
        memoryId: "m-seed",
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
      }) + "\n",
    );
    const encryptedBefore = await readFile(ledgerPath);
    assert.ok(isEncryptedFile(encryptedBefore), "precondition: ledger encrypted at rest");

    // A locked secure store (required, no key) must be refused, never rewritten
    // — a keyless rewrite would downgrade the ledger to plaintext.
    const locked = new StorageManager(memoryDir);
    locked.setSecureStoreRequired(true);
    await assert.rejects(
      () => runRebuildMemoryLifecycleLedgerCliCommand({ memoryDir, write: true, storage: locked }),
      /secure store is locked/,
    );
    assert.deepEqual(
      await readFile(ledgerPath),
      encryptedBefore,
      "locked refusal must leave the encrypted ledger untouched",
    );

    // With the unlocked secure store the rebuild proceeds and stays encrypted.
    const writeResult = await runRebuildMemoryLifecycleLedgerCliCommand({
      memoryDir,
      write: true,
      now: new Date("2026-03-08T12:00:00.000Z"),
      storage: unlocked,
    });
    assert.equal(writeResult.dryRun, false);
    assert.ok(
      isEncryptedFile(await readFile(ledgerPath)),
      "rebuilt ledger stays encrypted at rest through the unlocked secure storage",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuild-memory-lifecycle-ledger CLI recovers a namespaced encrypted ledger through namespace-scoped secure storage (#2033)", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-lifecycle-ns-"));
  // A namespace store lives under namespaces/<ns>/ — the exact path an oversized
  // encrypted namespace ledger occupies. The namespace-aware CLI resolves this
  // memoryDir and its secure StorageManager so the recovery targets it instead of
  // the root store.
  const namespaceDir = path.join(rootDir, "namespaces", "team");
  const key = Buffer.alloc(32, 0x5a);
  const ledgerPath = path.join(namespaceDir, "state", "memory-lifecycle-ledger.jsonl");
  try {
    const unlocked = new StorageManager(namespaceDir);
    unlocked.setSecureStoreRequired(true);
    unlocked.setSecureStoreKey(key, true);
    await unlocked.ensureDirectories();
    await unlocked.writeMemory("fact", "encrypted namespace fact");
    await unlocked.writeMemoryLifecycleLedgerContent(
      JSON.stringify({
        schemaVersion: 1,
        eventId: "evt-ns-seed",
        memoryId: "m-ns-seed",
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
      }) + "\n",
    );
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "precondition: namespace ledger encrypted at rest");

    const writeResult = await runRebuildMemoryLifecycleLedgerCliCommand({
      memoryDir: namespaceDir,
      write: true,
      now: new Date("2026-03-08T12:00:00.000Z"),
      storage: unlocked,
    });
    assert.equal(writeResult.dryRun, false);
    assert.equal(path.resolve(writeResult.outputPath), path.resolve(ledgerPath), "rebuilt the namespace ledger, not the root");
    assert.ok(
      isEncryptedFile(await readFile(ledgerPath)),
      "rebuilt namespace ledger stays encrypted at rest through the namespace secure storage",
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("rebuild-memory-lifecycle-ledger recovery targets the router-resolved (tokenized) namespace dir, not the raw namespaces/<ns> path (#2033)", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-lifecycle-ns-token-"));
  try {
    const config = {
      memoryDir: rootDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      entitySchemas: {},
      inlineSourceAttributionFormat: undefined,
    } as unknown as PluginConfig;
    const router = new NamespaceStorageRouter(config);
    const namespace = "team";

    // The router serves a non-default namespace from the TOKENIZED root
    // (namespaces/ns-<hex>), which diverges from the raw namespaces/<ns> path the
    // legacy resolver builds. Recovery must follow the router-resolved storage.dir.
    const storage = await router.storageFor(namespace);
    const routerDir = storage.dir;
    const rawDir = path.join(rootDir, "namespaces", namespace);
    assert.notEqual(
      path.resolve(routerDir),
      path.resolve(rawDir),
      "precondition: router dir is tokenized and differs from the raw namespaces/<ns> path",
    );
    await storage.writeMemory("fact", "namespace fact for tokenized recovery");

    // The FIX: recovery uses the router-resolved storage.dir and rebuilds in place.
    const writeResult = await runRebuildMemoryLifecycleLedgerCliCommand({
      memoryDir: routerDir,
      write: true,
      now: new Date("2026-03-08T12:00:00.000Z"),
      storage,
    });
    assert.equal(
      path.resolve(writeResult.outputPath),
      path.resolve(path.join(routerDir, "state", "memory-lifecycle-ledger.jsonl")),
      "rebuilt the ledger under the router-resolved tokenized namespace dir",
    );

    // The OLD wiring — raw namespaces/<ns> path as memoryDir with the tokenized
    // storage — is the exact mismatch the fix avoids: it REJECTS the tokenized
    // storage rather than recovering it.
    await assert.rejects(
      () => runRebuildMemoryLifecycleLedgerCliCommand({
        memoryDir: rawDir,
        write: true,
        storage,
      }),
      /storage\.dir.*must match.*memoryDir/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("rebuild-memory-projection CLI wrapper respects dry-run default and write mode", { skip: skipUnlessBetterSqlite3() }, async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-memory-projection-"));
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

  const dryRunResult = await runRebuildMemoryProjectionCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runRebuildMemoryProjectionCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});

test("memory-timeline CLI wrapper reads rows from the derived projection store", { skip: skipUnlessBetterSqlite3() }, async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-memory-timeline-"));
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
  await runRebuildMemoryProjectionCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });

  const rows = await runMemoryTimelineCliCommand({
    memoryDir,
    memoryId: "fact-1",
  });
  assert.deepEqual(rows.map((row) => row.eventType), ["created", "updated"]);
});

test("verify-memory-projection and repair-memory-projection CLI wrappers detect and repair drift", { skip: skipUnlessBetterSqlite3() }, async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-verify-memory-projection-"));
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
  await runRebuildMemoryProjectionCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T02:00:00.000Z"),
  });

  await writeText(
    memoryDir,
    "facts/2026-03-08/fact-2.md",
    `---
id: fact-2
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
---

beta
`,
  );

  const verify = await runVerifyMemoryProjectionCliCommand({ memoryDir });
  assert.equal(verify.ok, false);
  assert.deepEqual(verify.missingCurrentMemoryIds, ["fact-2"]);

  const dryRunRepair = await runRepairMemoryProjectionCliCommand({ memoryDir });
  assert.equal(dryRunRepair.dryRun, true);
  assert.equal(dryRunRepair.repaired, false);

  const writeRepair = await runRepairMemoryProjectionCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T04:00:00.000Z"),
  });
  assert.equal(writeRepair.dryRun, false);
  assert.equal(writeRepair.repaired, true);

  const verifiedAfter = await runVerifyMemoryProjectionCliCommand({ memoryDir });
  assert.equal(verifiedAfter.ok, true);
});

test("migrate-observations CLI wrapper respects dry-run default and write mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-observations-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/legacy.jsonl",
    JSON.stringify({
      session: "agent:main:default",
      timestamp: "2026-02-25T10:05:00.000Z",
      role: "user",
    }) + "\n",
  );

  const dryRunResult = await runMigrateObservationsCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runMigrateObservationsCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});
