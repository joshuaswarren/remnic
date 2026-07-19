import assert from "node:assert/strict";
import { mkdtemp, open, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readMaybeEncryptedLines,
  readMemoryLifecycleEventsFromLines,
  STATE_FILE_MAX_DECRYPT_BYTES,
} from "./secure-line-reader.js";
import { MAGIC_BYTES, MAGIC_HEADER_SIZE } from "../secure-store/secure-fs.js";
import type { MemoryLifecycleEvent } from "../types.js";

function event(eventId: string, memoryId: string, timestamp: string): MemoryLifecycleEvent {
  return { eventId, memoryId, eventType: "created", timestamp, actor: "test", ruleVersion: "1" };
}

async function* fromArray(rows: string[]): AsyncGenerator<string> {
  for (const row of rows) yield row;
}

test("readMemoryLifecycleEventsFromLines keeps only the last `limit` appended rows", async () => {
  const rows = [
    JSON.stringify(event("a", "m1", "2026-01-01T00:00:00.000Z")),
    JSON.stringify(event("b", "m2", "2026-01-02T00:00:00.000Z")),
    JSON.stringify(event("c", "m3", "2026-01-03T00:00:00.000Z")),
  ];
  const tail = await readMemoryLifecycleEventsFromLines(fromArray(rows), 2);
  assert.deepEqual(
    tail.map((e) => e.eventId),
    ["b", "c"],
  );
});

test("readMemoryLifecycleEventsFromLines skips malformed/blank rows fail-open and honors limit 0", async () => {
  const rows = [
    "   ",
    "{not json",
    JSON.stringify({ eventId: "x", memoryId: "m", eventType: "created", timestamp: "t", actor: 42, ruleVersion: "1" }),
    JSON.stringify(event("keep", "m", "2026-01-01T00:00:00.000Z")),
  ];
  assert.deepEqual(await readMemoryLifecycleEventsFromLines(fromArray(rows), 5), [
    event("keep", "m", "2026-01-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(await readMemoryLifecycleEventsFromLines(fromArray(rows), 0), []);
});

test("readMemoryLifecycleEventsFromLines admits any structurally valid eventType (readAll parity, issue #1910)", async () => {
  const unknown = { eventId: "bad", memoryId: "m", eventType: "exploded", timestamp: "2026-01-01T00:00:00.000Z", actor: "test", ruleVersion: "1" };
  const empty = { eventId: "empty", memoryId: "m", eventType: "", timestamp: "2026-01-02T00:00:00.000Z", actor: "test", ruleVersion: "1" };
  const rows = [
    // Unknown/typoed and empty-string eventTypes are structurally valid, so the
    // bounded governance read MUST keep them — it has to match readAll, which
    // admits any string eventType. Only genuinely malformed rows are dropped.
    JSON.stringify(unknown),
    JSON.stringify(empty),
    JSON.stringify(event("keep", "m", "2026-01-03T00:00:00.000Z")),
  ];
  const kept = await readMemoryLifecycleEventsFromLines(fromArray(rows), 5);
  assert.deepEqual(
    kept.map((e) => e.eventId).sort(),
    ["bad", "empty", "keep"],
  );
});

test("readMemoryLifecycleEventsFromLines filters by memoryId when provided", async () => {
  const rows = [
    JSON.stringify(event("a", "target", "2026-01-01T00:00:00.000Z")),
    JSON.stringify(event("b", "other", "2026-01-02T00:00:00.000Z")),
    JSON.stringify(event("c", "target", "2026-01-03T00:00:00.000Z")),
  ];
  const tail = await readMemoryLifecycleEventsFromLines(fromArray(rows), 10, "target");
  assert.deepEqual(
    tail.map((e) => e.eventId),
    ["a", "c"],
  );
});

test("readMaybeEncryptedLines streams plaintext lines without the encrypted fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-slr-plain-"));
  const filePath = path.join(dir, "state.jsonl");
  await writeFile(filePath, "one\ntwo\nthree\n", "utf8");
  try {
    const out: string[] = [];
    for await (const line of readMaybeEncryptedLines(filePath, async () => {
      throw new Error("plaintext must not use the encrypted whole-file reader");
    })) {
      if (line.trim()) out.push(line);
    }
    assert.deepEqual(out, ["one", "two", "three"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMaybeEncryptedLines refuses an oversized encrypted file before decrypting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-slr-oversize-"));
  const filePath = path.join(dir, "state.jsonl");
  // Write a valid encrypted magic header, then sparsely grow the file past the
  // decrypt ceiling. `truncate` produces a sparse file, so this costs ~no disk.
  const header = Buffer.alloc(MAGIC_HEADER_SIZE);
  MAGIC_BYTES.copy(header, 0);
  const handle = await open(filePath, "w");
  await handle.write(header, 0, header.length, 0);
  await handle.close();
  await truncate(filePath, STATE_FILE_MAX_DECRYPT_BYTES + 1);
  try {
    let decryptCalled = false;
    await assert.rejects(
      async () => {
        for await (const _line of readMaybeEncryptedLines(
          filePath,
          async () => {
            decryptCalled = true;
            return "";
          },
          STATE_FILE_MAX_DECRYPT_BYTES,
        )) {
          // no-op
        }
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /whole-file decrypt limit/);
        assert.match(message, /rebuild-memory-lifecycle-ledger|doctor/);
        // The remedy is namespace-aware (#2033): an oversized encrypted ledger
        // under namespaces/<ns>/state must not be pointed at a root-only command.
        assert.match(message, /--namespace/);
        assert.ok(message.includes(filePath));
        return true;
      },
    );
    assert.equal(decryptCalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMaybeEncryptedLines does not refuse an oversized encrypted file without a decrypt ceiling (memory-actions parity, issue #1910)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-slr-nolimit-"));
  const filePath = path.join(dir, "state.jsonl");
  const header = Buffer.alloc(MAGIC_HEADER_SIZE);
  MAGIC_BYTES.copy(header, 0);
  const handle = await open(filePath, "w");
  await handle.write(header, 0, header.length, 0);
  await handle.close();
  await truncate(filePath, STATE_FILE_MAX_DECRYPT_BYTES + 1);
  try {
    // No maxDecryptBytes argument: the caller (e.g. the memory-actions ledger)
    // has no compaction remedy, so the size guard must NOT fire — decryption is
    // attempted exactly as before the lifecycle-only ceiling was added.
    let decryptCalled = false;
    const lines: string[] = [];
    for await (const line of readMaybeEncryptedLines(filePath, async () => {
      decryptCalled = true;
      return "row-1\nrow-2";
    })) {
      lines.push(line);
    }
    assert.equal(decryptCalled, true, "decrypt runs when no ceiling is supplied");
    assert.deepEqual(lines, ["row-1", "row-2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMaybeEncryptedLines refuses a symlinked state file before opening it (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-slr-symlink-"));
  try {
    const realTarget = path.join(dir, "real.jsonl");
    await writeFile(realTarget, "one\ntwo\n", "utf8");
    const linkPath = path.join(dir, "link.jsonl");
    await symlink(realTarget, linkPath);
    let decryptCalled = false;
    await assert.rejects(
      async () => {
        for await (const _line of readMaybeEncryptedLines(linkPath, async () => {
          decryptCalled = true;
          return "";
        })) {
          // no-op — the symlink must be refused before any line is yielded.
        }
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /non-regular state file/);
        assert.match(message, /symlink\/FIFO\/device/);
        assert.ok(message.includes(linkPath));
        return true;
      },
    );
    assert.equal(decryptCalled, false, "never opened or decrypted the symlink target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
