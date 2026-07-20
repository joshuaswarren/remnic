import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  drainPendingImpressionsForOfflineSync,
  drainPendingLifecycleForOfflineSync,
  getOfflineSyncStorage,
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
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /lifecycle drain could not fold pending memory-lifecycle events after 3 attempts.*aborting snapshot/s,
        );
        assert.ok(
          !err.message.includes(root),
          "abort error must not leak the ledger's absolute path (#2033)",
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborted impression drain redacts the underlying error path (#2033)", async () => {
  // A persona path standing in for a real operator's memory dir. displayErrorDetail
  // must reduce the thrown fs error to its class + errno code so the absolute path
  // never reaches CLI stderr / the offline snapshot failure.
  const secretPath = "/home/user/.remnic/state/recall_impressions.jsonl";
  await assert.rejects(
    drainPendingImpressionsForOfflineSync(async () => {
      const err = new Error(`EACCES: permission denied, open '${secretPath}'`);
      (err as NodeJS.ErrnoException).code = "EACCES";
      throw err;
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretPath), "raw fs path must not leak into the abort error");
      assert.match(err.message, /could not fold pending recall impressions after 3 attempts/);
      assert.match(err.message, /EACCES/, "the path-free error class + code still surfaces");
      return true;
    },
  );
});

test("drainPendingLifecycleForOfflineSync skips a symlinked namespace child (#2033 containment)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-symlink-child-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-outside-"));
  try {
    const rootNonce = await seedPendingLifecycle(root, "state");
    const teamNonce = await seedPendingLifecycle(root, "namespaces/team/state");
    // A poisoned namespace child symlinked outside the memory root, carrying its
    // own pending spill. The drain must NOT fold through it (no ledger appended
    // outside memoryDir) yet still fold the root and the legit namespace.
    await seedPendingLifecycle(outside, "state");
    await mkdir(path.join(root, "namespaces"), { recursive: true });
    await symlink(outside, path.join(root, "namespaces", "evil"));

    await drainPendingLifecycleForOfflineSync(root);

    assert.deepEqual(await readdir(path.join(root, LIFECYCLE_PENDING_REL)).catch(() => [] as string[]), []);
    assert.ok((await readFile(path.join(root, LIFECYCLE_LEDGER_REL), "utf-8")).includes(rootNonce));
    assert.ok(
      (await readFile(path.join(root, "namespaces/team", LIFECYCLE_LEDGER_REL), "utf-8")).includes(teamNonce),
    );
    // The escaping child's spill is left untouched and no ledger was written
    // through the link.
    assert.equal(
      (await readdir(path.join(outside, LIFECYCLE_PENDING_REL))).length,
      1,
      "escaping namespace spill must be left untouched",
    );
    await assert.rejects(
      () => readFile(path.join(outside, LIFECYCLE_LEDGER_REL), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("drainPendingLifecycleForOfflineSync refuses a symlinked namespaces base (#2033 containment)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-symlink-base-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-base-outside-"));
  try {
    const rootNonce = await seedPendingLifecycle(root, "state");
    // A legit-looking namespace living under the symlinked base target.
    await seedPendingLifecycle(outside, "team/state");
    await symlink(outside, path.join(root, "namespaces"));

    await drainPendingLifecycleForOfflineSync(root);

    // The root ledger is still folded through the real state dir.
    assert.ok((await readFile(path.join(root, LIFECYCLE_LEDGER_REL), "utf-8")).includes(rootNonce));
    // The symlinked base is refused wholesale: nothing under it is drained.
    assert.equal(
      (await readdir(path.join(outside, "team", "state", "memory-lifecycle-ledger.jsonl.pending.d"))).length,
      1,
      "namespaces base symlink must be refused, leaving its spills untouched",
    );
    await assert.rejects(
      () => readFile(path.join(outside, "team", LIFECYCLE_LEDGER_REL), "utf-8"),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

type FakeLifecycleStorage = {
  dir: string;
  drainPendingMemoryLifecycleEventsForSync(): Promise<{ folded: boolean; pendingDeferred: boolean }>;
};

function fakeOfflineOrchestrator(memoryRoot: string, namespaceDirs: Record<string, string>) {
  const lifecycleDrains: string[] = [];
  let impressionDrains = 0;
  const storages: Record<string, FakeLifecycleStorage> = {};
  for (const [name, dir] of Object.entries(namespaceDirs)) {
    storages[name] = {
      dir,
      drainPendingMemoryLifecycleEventsForSync: async () => {
        lifecycleDrains.push(name);
        return { folded: false, pendingDeferred: false };
      },
    };
  }
  const orchestrator = {
    config: { memoryDir: memoryRoot },
    drainPendingRecallImpressions: async () => {
      impressionDrains += 1;
      return { pendingDeferred: false };
    },
    getStorage: async (ns: string) => {
      const storage = storages[ns];
      if (!storage) throw new Error(`no fake storage for namespace ${ns}`);
      return storage;
    },
    listOfflineSyncNamespaces: async () => Object.keys(namespaceDirs).filter((n) => n !== "root"),
  };
  return { orchestrator, lifecycleDrains, impressions: () => impressionDrains };
}

test("getOfflineSyncStorage drains every namespace ledger for a root snapshot (#2033)", async () => {
  const memoryRoot = path.join(os.tmpdir(), "remnic-root-drain-fanout");
  const { orchestrator, lifecycleDrains, impressions } = fakeOfflineOrchestrator(memoryRoot, {
    root: memoryRoot,
    team: path.join(memoryRoot, "namespaces", "team"),
    ops: path.join(memoryRoot, "namespaces", "ops"),
  });

  await getOfflineSyncStorage(orchestrator, "root");

  assert.deepEqual(lifecycleDrains, ["root", "team", "ops"], "root snapshot folds root + every namespace ledger");
  assert.equal(impressions(), 1, "global impressions are folded for a root snapshot");
});

test("getOfflineSyncStorage folds only the namespace's own ledger for a namespace snapshot (#2033)", async () => {
  const memoryRoot = path.join(os.tmpdir(), "remnic-ns-drain-scope");
  const { orchestrator, lifecycleDrains, impressions } = fakeOfflineOrchestrator(memoryRoot, {
    root: memoryRoot,
    team: path.join(memoryRoot, "namespaces", "team"),
  });

  await getOfflineSyncStorage(orchestrator, "team");

  assert.deepEqual(lifecycleDrains, ["team"], "namespace snapshot folds only its own ledger");
  assert.equal(impressions(), 0, "global impressions are left pending for the root sync");
});

test("getOfflineSyncStorage never double-folds the root ledger when it is listed as a namespace (#2033)", async () => {
  const memoryRoot = path.join(os.tmpdir(), "remnic-root-drain-dedup");
  const { orchestrator, lifecycleDrains } = fakeOfflineOrchestrator(memoryRoot, {
    root: memoryRoot,
    // A listing that also surfaces the default namespace pointing back at root.
    default: memoryRoot,
    team: path.join(memoryRoot, "namespaces", "team"),
  });

  await getOfflineSyncStorage(orchestrator, "root");

  assert.deepEqual(lifecycleDrains, ["root", "team"], "root ledger is folded exactly once");
});
