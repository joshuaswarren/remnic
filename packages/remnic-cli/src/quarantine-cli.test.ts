import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WriteQuarantineStore } from "@remnic/core/write-quarantine.js";

import { renderQuarantineList, renderReplayResult, replayQuarantine } from "./quarantine-cli.js";

async function withStore(fn: (store: WriteQuarantineStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-qcli-"));
  try {
    await fn(new WriteQuarantineStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("renderQuarantineList text: empty and populated", async () => {
  await withStore(async (store) => {
    assert.equal(renderQuarantineList(await store.list(), "text"), "No quarantined writes.");
    await store.quarantine({
      operation: "memory_store",
      principal: "alice",
      attemptedNamespace: "ns-x",
      payload: { content: "hi" },
    });
    const text = renderQuarantineList(await store.list(), "text");
    assert.match(text, /Quarantined writes \(1\)/);
    assert.match(text, /memory_store/);
    assert.match(text, /principal=alice/);
    assert.match(text, /attemptedNamespace=ns-x/);
  });
});

test("renderQuarantineList uses a dash for a null principal", async () => {
  await withStore(async (store) => {
    await store.quarantine({ operation: "observe", principal: undefined, attemptedNamespace: "ns", payload: {} });
    assert.match(renderQuarantineList(await store.list(), "text"), /principal=-/);
  });
});

test("renderQuarantineList json returns metadata but never the payload", async () => {
  await withStore(async (store) => {
    await store.quarantine({
      operation: "observe",
      principal: "bob",
      attemptedNamespace: "ns",
      payload: { secret: "user memory text" },
    });
    const raw = renderQuarantineList(await store.list(), "json");
    assert.doesNotMatch(raw, /payload|user memory text/);
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.operation, "observe");
    assert.equal(parsed[0]?.principal, "bob");
    assert.equal(parsed[0]?.attemptedNamespace, "ns");
    assert.equal("payload" in (parsed[0] ?? {}), false);
  });
});

test("renderQuarantineList throws on an unsupported format", () => {
  assert.throws(
    () => renderQuarantineList([], "csv" as unknown as Parameters<typeof renderQuarantineList>[1]),
    /Unsupported quarantine format/
  );
});

test("replayQuarantine re-submits with the target namespace + suppression and removes the entry on success", async () => {
  await withStore(async (store) => {
    await store.quarantine({
      operation: "memory_store",
      principal: "alice",
      attemptedNamespace: "ns-x",
      payload: { content: "hi" },
    });
    const submitted: Array<{ operation: string; request: Record<string, unknown> }> = [];
    const result = await replayQuarantine({
      store,
      targetNamespace: "alice-self",
      principal: "alice",
      submit: async (operation, request) => {
        submitted.push({ operation, request: request as Record<string, unknown> });
      },
    });
    assert.equal(result.replayed, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.deleteFailures.length, 0);
    assert.equal(await store.count(), 0);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.operation, "memory_store");
    assert.equal(submitted[0]?.request.namespace, "alice-self");
    assert.equal(submitted[0]?.request.suppressQuarantine, true);
    assert.equal(submitted[0]?.request.authenticatedPrincipal, "alice");
    assert.equal(submitted[0]?.request.content, "hi");
  });
});

test("replayQuarantine defaults the principal to the record and sets a stable idempotency key", async () => {
  await withStore(async (store) => {
    await store.quarantine({
      operation: "memory_store",
      principal: "dave",
      attemptedNamespace: "ns-x",
      payload: { content: "yo" },
    });
    const seen: Array<Record<string, unknown>> = [];
    const result = await replayQuarantine({
      store,
      targetNamespace: "dave-self",
      submit: async (_op, request) => {
        seen.push(request as Record<string, unknown>);
      },
    });
    assert.equal(result.replayed, 1);
    // No --principal override: authz falls back to the parked principal.
    assert.equal(seen[0]?.authenticatedPrincipal, "dave");
    // A stable idempotency key lets a re-run after a failed delete dedupe.
    assert.equal(typeof seen[0]?.idempotencyKey, "string");
    assert.match(String(seen[0]?.idempotencyKey), /^quarantine-replay:/);
  });
});

test("replayQuarantine preserves an idempotencyKey already present in the payload", async () => {
  await withStore(async (store) => {
    await store.quarantine({
      operation: "memory_store",
      principal: "erin",
      attemptedNamespace: "ns-x",
      payload: { content: "z", idempotencyKey: "caller-key-1" },
    });
    const seen: Array<Record<string, unknown>> = [];
    await replayQuarantine({
      store,
      targetNamespace: "erin-self",
      submit: async (_op, request) => {
        seen.push(request as Record<string, unknown>);
      },
    });
    assert.equal(seen[0]?.idempotencyKey, "caller-key-1");
  });
});

test("replayQuarantine records a failure and leaves the entry parked when submit throws", async () => {
  await withStore(async (store) => {
    await store.quarantine({
      operation: "observe",
      principal: "bob",
      attemptedNamespace: "ns-x",
      payload: { messages: [] },
    });
    const result = await replayQuarantine({
      store,
      targetNamespace: "bob-self",
      submit: async () => {
        throw new Error("still not writable");
      },
    });
    assert.equal(result.replayed, 0);
    assert.equal(result.deleteFailures.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.operation, "observe");
    assert.equal(result.failures[0]?.attemptedNamespace, "bob-self");
    assert.equal(result.failures[0]?.error, "still not writable");
    assert.equal(await store.count(), 1);
  });
});

test("replayQuarantine reports a delete failure without counting it as replayed", async () => {
  const entry = {
    record: {
      operation: "memory_store" as const,
      principal: "carol",
      attemptedNamespace: "ns-x",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { content: "x" },
    },
    path: "/tmp/remnic-quarantine-absent.json",
  };
  const fakeStore = {
    entries: async () => [entry],
    removeEntry: async () => false,
  } as unknown as WriteQuarantineStore;
  const result = await replayQuarantine({
    store: fakeStore,
    targetNamespace: "carol-self",
    submit: async () => {},
  });
  assert.equal(result.replayed, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(result.deleteFailures.length, 1);
  assert.equal(result.deleteFailures[0]?.path, "/tmp/remnic-quarantine-absent.json");
});

test("renderReplayResult renders text and json", () => {
  const result = {
    replayed: 2,
    failures: [{ operation: "observe" as const, attemptedNamespace: "ns-x", error: "nope" }],
    deleteFailures: [{ path: "/tmp/x.json", error: "gone" }],
  };
  const text = renderReplayResult(result, "target-ns", "text");
  assert.match(text, /Replayed 2 quarantined write\(s\) into namespace target-ns/);
  assert.match(text, /Failures \(1\)/);
  assert.match(text, /observe {2}attemptedNamespace=ns-x {2}error=nope/);
  assert.match(text, /Delete failures \(1\)/);

  const parsed = JSON.parse(renderReplayResult(result, "target-ns", "json")) as Record<string, unknown>;
  assert.equal(parsed.replayed, 2);
  assert.equal(parsed.targetNamespace, "target-ns");
  assert.equal((parsed.failures as unknown[]).length, 1);
  assert.equal((parsed.deleteFailures as unknown[]).length, 1);
});
