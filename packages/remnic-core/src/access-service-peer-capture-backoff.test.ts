import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { CAPTURE_WRITE_LOCK_BUSY_MESSAGE } from "./capture-write-lock-backoff.js";
import { buildCapturePathLockIdentity, TombstoneBlockedCaptureWriteLock } from "./capture-write-lock.js";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { buildExplicitCaptureDedupKey } from "./storage/tombstone-blocked-capture-index.js";
import { OFFLINE_SYNC_CHANGESET_FORMAT } from "./offline-sync.js";

// Real contention exceeds the legacy deadline but fits inside the configured peer budget.

/** Longer than the legacy 3s capture-lock deadline, shorter than the converge deadline. */
const CONTENTION_HOLD_MS = 3_600;
/** The converge deadline a peer apply is scoped to. */
const CONVERGE_DEADLINE_MS = 8_000;
/** An ordinary capture must still give up near the legacy 3s bound. */
const LEGACY_BOUND_MS = 4_500;

const PEER_REL_PATH = "facts/2026-08-13/peer-apply-target.md";
const ORDINARY_CONTENT = "ordinary capture body";

function peerContent(): Buffer {
  return Buffer.from(
    [
      "---",
      "id: peer-apply-target",
      "category: fact",
      "created: 2026-08-13T00:00:00.000Z",
      "---",
      "",
      "Peer applied body",
      "",
    ].join("\n")
  );
}

async function createPeerService(root: string) {
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir: root,
      namespacesEnabled: false,
      defaultNamespace: "global",
      converge: {
        conflictPolicy: "newest-wins",
        captureWriteLockInitialDelayMs: 20,
        captureWriteLockMaxDelayMs: 50,
        captureWriteLockDeadlineMs: CONVERGE_DEADLINE_MS,
      },
    })
  );
  const storage = await orchestrator.getStorage();
  await storage.ensureDirectories();
  assert.equal(storage.dir, root, "the fixture uses one cached flat-root storage");
  return { storage, service: new EngramAccessService(orchestrator) };
}

/** Hold a capture lock and release it after `holdMs`. */
function holdCaptureLock(stateDir: string, identity: string, holdMs: number) {
  const holder = new TombstoneBlockedCaptureWriteLock({ stateDir });
  const released = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  let timer: NodeJS.Timeout | undefined;
  const holding = holder.withCaptureWriteLock(async () => {
    acquired.resolve();
    timer = setTimeout(() => released.resolve(), holdMs);
    await released.promise;
  }, identity);
  return {
    acquired: acquired.promise,
    release: (): void => {
      clearTimeout(timer);
      released.resolve();
    },
    done: holding,
  };
}

function peerApplyRequest(content: Buffer) {
  return {
    sourceId: "remnic-converge",
    path: PEER_REL_PATH,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.length,
    mtimeMs: 1_700_000_000_000,
    offset: 0,
    content,
  };
}

for (const kind of ["chunk", "changeset"] as const) {
  test(
    `peer ${kind} apply waits out a busy capture lock instead of the legacy deadline`,
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "remnic-peer-capture-backoff-"));
      const { service } = await createPeerService(root);
      const content = peerContent();
      const holder = holdCaptureLock(
        path.join(root, "state"),
        buildCapturePathLockIdentity(path.resolve(root, PEER_REL_PATH)),
        CONTENTION_HOLD_MS
      );
      try {
        await holder.acquired;
        const startedAt = Date.now();
        const apply =
          kind === "chunk"
            ? service.offlineSyncApplyFileContent(peerApplyRequest(content))
            : service.offlineSyncApply({
                returnCurrentFiles: false,
                changeset: {
                  format: OFFLINE_SYNC_CHANGESET_FORMAT,
                  schemaVersion: 1,
                  createdAt: "2026-08-13T00:00:00.000Z",
                  sourceId: "remnic-converge",
                  includeTranscripts: false,
                  changes: [
                    {
                      type: "upsert",
                      path: PEER_REL_PATH,
                      file: {
                        path: PEER_REL_PATH,
                        sha256: createHash("sha256").update(content).digest("hex"),
                        bytes: content.length,
                        mtimeMs: 1_700_000_000_000,
                        contentBase64: content.toString("base64"),
                      },
                    },
                  ],
                },
              });
        const outcome = await apply.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error })
        );
        assert.equal(
          outcome.ok,
          true,
          outcome.ok
            ? ""
            : `peer apply failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
        );
        assert.ok(Date.now() - startedAt >= 2_500, "peer apply must wait out the capture-lock contention");
        assert.equal(await readFile(path.join(root, PEER_REL_PATH), "utf8"), content.toString("utf8"));
      } finally {
        holder.release();
        await holder.done.catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    }
  );
}

test(
  "an ordinary capture keeps the legacy capture-lock bound while a peer apply is in flight",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remnic-peer-capture-isolation-"));
    const { storage, service } = await createPeerService(root);
    const content = peerContent();
    const stateDir = path.join(root, "state");
    const peerHolder = holdCaptureLock(
      stateDir,
      buildCapturePathLockIdentity(path.resolve(root, PEER_REL_PATH)),
      CONTENTION_HOLD_MS
    );
    const ordinaryHolder = holdCaptureLock(
      stateDir,
      buildExplicitCaptureDedupKey(ORDINARY_CONTENT, "fact", undefined),
      CONTENTION_HOLD_MS
    );
    let peerApply: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
    try {
      await Promise.all([peerHolder.acquired, ordinaryHolder.acquired]);
      peerApply = service.offlineSyncApplyFileContent(peerApplyRequest(content)).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      );
      const startedAt = Date.now();
      const outcome = await storage.writeMemory("fact", ORDINARY_CONTENT).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error })
      );
      assert.equal(outcome.ok, false, "ordinary capture must not succeed while the capture lock is held");
      assert.equal(
        outcome.ok ? "" : outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        CAPTURE_WRITE_LOCK_BUSY_MESSAGE
      );
      assert.ok(
        Date.now() - startedAt < LEGACY_BOUND_MS,
        "ordinary capture must keep the legacy capture-lock bound, not the converge deadline"
      );
    } finally {
      peerHolder.release();
      ordinaryHolder.release();
      await Promise.all([peerHolder.done.catch(() => undefined), ordinaryHolder.done.catch(() => undefined)]);
      await peerApply;
      await rm(root, { recursive: true, force: true });
    }
  }
);
test("a failed peer apply does not leak converge capture-lock limits", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-peer-capture-error-scope-"));
  const { storage, service } = await createPeerService(root);
  const content = peerContent();
  const holder = holdCaptureLock(
    path.join(root, "state"),
    buildExplicitCaptureDedupKey(ORDINARY_CONTENT, "fact", undefined),
    CONTENTION_HOLD_MS
  );
  try {
    await assert.rejects(
      service.offlineSyncApplyFileContent({
        ...peerApplyRequest(content),
        sha256: "0".repeat(64),
      })
    );
    await holder.acquired;
    const startedAt = Date.now();
    await assert.rejects(storage.writeMemory("fact", ORDINARY_CONTENT), new RegExp(CAPTURE_WRITE_LOCK_BUSY_MESSAGE));
    assert.ok(
      Date.now() - startedAt < LEGACY_BOUND_MS,
      "ordinary capture after a failed peer apply must keep the legacy lock bound"
    );
  } finally {
    holder.release();
    await holder.done.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
