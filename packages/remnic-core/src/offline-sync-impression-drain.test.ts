import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  drainPendingImpressionsForOfflineSync,
  drainPendingLifecycleForOfflineSync,
} from "./offline-sync-impression-drain.js";
import { isEncryptedFile } from "./secure-store/secure-fs.js";
import { StorageManager } from "./storage.js";

test("retries deferred drains and succeeds when the lock is released", async () => {
  let calls = 0;
  await drainPendingImpressionsForOfflineSync(async () => {
    calls += 1;
    return { pendingDeferred: calls < 2 };
  });
  assert.equal(calls, 2);
});

test("retries a transient drain error before succeeding", async () => {
  let calls = 0;
  await drainPendingImpressionsForOfflineSync(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary lock failure");
    return { pendingDeferred: false };
  });
  assert.equal(calls, 2);
});

test("aborts after repeated deferrals instead of producing an incomplete snapshot", async () => {
  let calls = 0;
  await assert.rejects(
    drainPendingImpressionsForOfflineSync(async () => {
      calls += 1;
      return { pendingDeferred: true };
    }),
    /could not fold pending recall impressions after 3 attempts/,
  );
  assert.equal(calls, 3);
});

const LIFECYCLE_LEDGER_REL = "state/memory-lifecycle-ledger.jsonl";
const LIFECYCLE_PENDING_REL = `${LIFECYCLE_LEDGER_REL}.pending.d`;

// Seed one durable pending lifecycle spill exactly as appendLifecycleEventsSerialized
// does when the ledger lock is held (#2033): a `<uuid>.jsonl` file inside the
// offline-sync-EXCLUDED pending dir under `stateRel`. The nonce proves this row
// was folded rather than dropped by the sync exclude glob.
async function seedPendingLifecycle(root: string, stateRel: string): Promise<string> {
  const nonce = randomUUID();
  const pendingDir = path.join(root, stateRel, "memory-lifecycle-ledger.jsonl.pending.d");
  await mkdir(pendingDir, { recursive: true });
  const line = `${JSON.stringify({ type: "promotion", memoryId: "mem-1", timestamp: "2026-01-01T00:00:00.000Z", nonce })}\n`;
  await writeFile(path.join(pendingDir, `${randomUUID()}.jsonl`), line, "utf-8");
  return nonce;
}

test("drainPendingLifecycleForOfflineSync folds root and per-namespace pending spills (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-"));
  try {
    const rootNonce = await seedPendingLifecycle(root, "state");
    const nsNonce = await seedPendingLifecycle(root, "namespaces/team/state");

    await drainPendingLifecycleForOfflineSync(root);

    const rootPending = await readdir(path.join(root, LIFECYCLE_PENDING_REL)).catch(() => [] as string[]);
    assert.deepEqual(rootPending, [], "root pending spills must be folded and finalized");
    const rootActive = await readFile(path.join(root, LIFECYCLE_LEDGER_REL), "utf-8");
    assert.ok(rootActive.includes(rootNonce), "root lifecycle row must land in the synced active ledger");

    const nsPending = await readdir(
      path.join(root, "namespaces/team", LIFECYCLE_PENDING_REL),
    ).catch(() => [] as string[]);
    assert.deepEqual(nsPending, [], "per-namespace pending spills must be folded and finalized");
    const nsActive = await readFile(
      path.join(root, "namespaces/team", LIFECYCLE_LEDGER_REL),
      "utf-8",
    );
    assert.ok(nsActive.includes(nsNonce), "per-namespace lifecycle row must land in its active ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("drains encrypted lifecycle spills through secure storage (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-secure-"));
  const key = Buffer.alloc(32, 17);
  const storage = new StorageManager(root);
  storage.setSecureStoreRequired(true);
  storage.setSecureStoreKey(key);
  try {
    const nonce = randomUUID();
    const pendingDir = path.join(root, LIFECYCLE_PENDING_REL);
    const pendingPath = path.join(pendingDir, `${randomUUID()}.jsonl`);
    await mkdir(pendingDir, { recursive: true });
    await storage.writeMemoryLifecycleLedgerContent(
      `${JSON.stringify({
        type: "promotion",
        memoryId: "mem-secure",
        timestamp: "2026-01-01T00:00:00.000Z",
        nonce,
      })}\n`,
      pendingPath,
    );

    await drainPendingLifecycleForOfflineSync(
      root,
      (ledgerPath) => storage.drainPendingMemoryLifecycleEventsForSyncAt(ledgerPath),
    );

    assert.deepEqual(await readdir(pendingDir), []);
    assert.ok(
      isEncryptedFile(await readFile(path.join(root, LIFECYCLE_LEDGER_REL))),
      "the active ledger must remain encrypted",
    );
    const activePlaintext = await storage.readMemoryLifecycleLedgerRawBufferForCompaction();
    assert.ok(activePlaintext.toString("utf-8").includes(nonce));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("drainPendingLifecycleForOfflineSync aborts when pending rows cannot be folded (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-abort-"));
  try {
    await seedPendingLifecycle(root, "state");
    // The active ledger path is a DIRECTORY, so the fold's append fails on every
    // attempt: the durable spill can never be committed, so the drain aborts
    // rather than let a caller build a snapshot that silently omits it.
    await mkdir(path.join(root, LIFECYCLE_LEDGER_REL), { recursive: true });

    await assert.rejects(
      drainPendingLifecycleForOfflineSync(root),
      /lifecycle drain could not fold pending memory-lifecycle events after 3 attempts.*aborting snapshot/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
