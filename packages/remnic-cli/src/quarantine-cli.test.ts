import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WriteQuarantineStore } from "@remnic/core/write-quarantine.js";

import { renderQuarantineList } from "./quarantine-cli.js";

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
