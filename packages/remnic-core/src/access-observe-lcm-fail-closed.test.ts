/**
 * LCM archival acceptance is durable and fail-closed.
 *
 * The observe surface used to enqueue archival without waiting: an archive
 * failure was invisible, the response reported the turn as archived, and the
 * client never retried — the lossless copy of the turn was simply gone.
 *
 * These tests drive the REAL orchestrator (real LCM engine, real SQLite
 * archive, real capture buffer) and pin the contract: a successful observe
 * means the archive accepted the turn, and a failed archive rejects the
 * observe BEFORE extraction starts, so the caller can retry the same turns.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import {
  cleanupDir,
  makeLifecycleConfig,
  mkTempMemoryDir,
} from "./testing/orchestrator-lite.js";

function observeRequest(
  overrides: Partial<EngramAccessObserveRequest>,
): EngramAccessObserveRequest {
  // SAFETY: the literal sets every required observe field the surface reads.
  return {
    sessionKey: "observe-fail-closed-session",
    messages: [
      { role: "user", content: "what database are we using?" },
      { role: "assistant", content: "we use postgres for the primary store" },
    ],
    ...overrides,
  } as EngramAccessObserveRequest;
}

test("observe reports the turn as archived only after the archive accepted it", async () => {
  const memoryDir = await mkTempMemoryDir("observe-lcm-ok");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, { lcmEnabled: true, lcmLeafBatchSize: 1 }),
  );
  try {
    const service = new EngramAccessService(orchestrator);

    const response = await service.observe(observeRequest({}));

    assert.equal(response.lcmArchived, true);
    const archived = await orchestrator.lcmEngine?.searchContextFull(
      "postgres",
      10,
      "observe-fail-closed-session",
    );
    assert.equal(
      archived?.length ?? 0,
      1,
      "the observed turn must be in the durable LCM archive",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("observe rejects and starts no extraction when the LCM archive fails", async () => {
  const memoryDir = await mkTempMemoryDir("observe-lcm-fail");
  // The LCM archive database cannot be opened (a directory sits where the
  // SQLite file belongs), so the archive rejects the turn: exactly the
  // "archive failed" case a client must be able to retry.
  await mkdir(path.join(memoryDir, "state", "lcm.sqlite"), { recursive: true });
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, { lcmEnabled: true, lcmLeafBatchSize: 1 }),
  );
  try {
    const service = new EngramAccessService(orchestrator);

    await assert.rejects(() => service.observe(observeRequest({})));

    const bufferKeys = await orchestrator.buffer.findBufferKeysForSession(
      "observe-fail-closed-session",
    );
    assert.deepEqual(
      bufferKeys,
      [],
      "extraction must not start when the lossless archive rejected the turn",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("observe rejects a closed LCM engine instead of acknowledging an empty archive", async () => {
  const memoryDir = await mkTempMemoryDir("observe-lcm-closed");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, { lcmEnabled: true, lcmLeafBatchSize: 1 }),
  );
  try {
    // The engine is closed underneath the observe surface: acceptance must
    // fail loudly instead of reporting lcmArchived:true for a turn that was
    // never stored.
    orchestrator.lcmEngine?.close();
    const service = new EngramAccessService(orchestrator);

    await assert.rejects(() => service.observe(observeRequest({})));

    const bufferKeys = await orchestrator.buffer.findBufferKeysForSession(
      "observe-fail-closed-session",
    );
    assert.deepEqual(bufferKeys, [], "no capture may be admitted when the archive is closed");
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});
