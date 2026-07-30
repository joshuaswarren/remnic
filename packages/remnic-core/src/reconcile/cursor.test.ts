import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  clearConvergeRefreshPending,
  defaultConvergeCursorPath,
  deriveConvergeCursorBase,
  hashPeerNamespace,
  markConvergeRefreshPending,
  normalizeConvergeCursor,
  normalizeConvergePeerUrl,
  readConvergeCursor,
  writeConvergeCursor,
  type ConvergeCursorState,
} from "./cursor.js";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

test("hashPeerNamespace: deterministic key normalization", () => {
  const k1 = hashPeerNamespace("http://peer.example.com/", "default");
  const k2 = hashPeerNamespace("http://peer.example.com", "DEFAULT ");
  assert.equal(k1, k2);
  assert.equal(k1.length, 16);
});

test("hashPeerNamespace: accepts non-URL local peer identifiers", () => {
  assert.equal(hashPeerNamespace("local", "default").length, 16);
});

test("hashPeerNamespace: preserves path case while normalizing URL authority and trailing slash", () => {
  const uppercasePath = hashPeerNamespace("HTTP://PEER.EXAMPLE.COM/Memory/", "default");
  const lowercasePath = hashPeerNamespace("http://peer.example.com/memory", "default");

  assert.notEqual(uppercasePath, lowercasePath);
  assert.equal(
    uppercasePath,
    hashPeerNamespace("http://peer.example.com/Memory", "DEFAULT "),
  );
  assert.equal(
    lowercasePath,
    hashPeerNamespace("HTTP://PEER.EXAMPLE.COM/memory/", "default"),
  );
});

test("normalizeConvergePeerUrl: strips credentials and request-only URL parts without folding path case", () => {
  assert.equal(
    normalizeConvergePeerUrl(" HTTPS://user:secret@PEER.EXAMPLE.COM:443/Memory/?token=abc#fragment "),
    "https://peer.example.com/Memory",
  );
  assert.equal(
    hashPeerNamespace("https://user:secret@peer.example.com/Memory?token=abc#fragment", "default"),
    hashPeerNamespace("https://peer.example.com/Memory/", "DEFAULT "),
  );
  assert.notEqual(
    hashPeerNamespace("https://peer.example.com/Memory", "default"),
    hashPeerNamespace("https://peer.example.com/memory", "default"),
  );
});

test("defaultConvergeCursorPath: constructs path under memoryDir state", () => {
  const p = defaultConvergeCursorPath("/tmp/mem", "http://localhost:4318", "general");
  assert.ok(p.includes(path.join(".remnic", "state", "converge-cursors")));
  assert.ok(p.endsWith(".json"));
});

test("deriveConvergeCursorBase retains a deferred semantic agreement", () => {
  const semanticAgreement = {
    local: { path: "facts/local.md", sha256: shaA },
    peer: { path: "facts/peer.md", sha256: shaB },
  };

  assert.deepEqual(
    deriveConvergeCursorBase([], "default", [semanticAgreement]).semanticAgreements,
    [semanticAgreement]
  );
});

test("normalizeConvergeCursor: validates envelope shape", () => {
  assert.throws(() => normalizeConvergeCursor(null), /must be an object/);
  assert.throws(() => normalizeConvergeCursor({ version: 2 }), /version must be 1/);
  assert.throws(
    () => normalizeConvergeCursor({ version: 1, peerUrl: "" }),
    /missing peerUrl/,
  );
  assert.throws(
    () => normalizeConvergeCursor({ version: 1, peerUrl: "http://peer", namespace: "" }),
    /missing namespace/,
  );

  const valid = normalizeConvergeCursor({
    version: 1,
    peerUrl: "http://peer",
    namespace: "default",
    baseFiles: [{ path: "a.md", sha256: shaA }],
    semanticAgreements: [{
      local: { path: "facts/local.md", sha256: shaA },
      peer: { path: "facts/peer.md", sha256: shaB },
    }],
  });
  assert.equal(valid.peerUrl, "http://peer");
  assert.equal(valid.namespace, "default");
  assert.equal(valid.baseFiles.length, 1);
  assert.equal(valid.baseFiles[0]?.path, "a.md");
  assert.deepEqual(valid.semanticAgreements, [{
    local: { path: "facts/local.md", sha256: shaA },
    peer: { path: "facts/peer.md", sha256: shaB },
  }]);
});

test("readConvergeCursor: returns null when file is missing or invalid", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-cursor-test-"));
  try {
    const missing = await readConvergeCursor(path.join(tmpDir, "missing.json"));
    assert.equal(missing, null);

    const invalidPath = path.join(tmpDir, "invalid.json");
    await fs.writeFile(invalidPath, "{ invalid json", "utf-8");
    const invalid = await readConvergeCursor(invalidPath);
    assert.equal(invalid, null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeConvergeCursor & readConvergeCursor: atomic write roundtrip", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-cursor-test-"));
  const cursorPath = path.join(tmpDir, "state", "cursor.json");
  try {
    const cursor: ConvergeCursorState = {
      version: 1,
      peerUrl: "http://localhost:4318",
      namespace: "default",
      lastConvergedAt: new Date().toISOString(),
      baseFiles: [{ path: "facts/a.md", sha256: shaA, bytes: 120, mtimeMs: 1000 }],
      completedPaths: ["facts/a.md"],
      semanticAgreements: [{
        local: { path: "facts/local.md", sha256: shaA },
        peer: { path: "facts/peer.md", sha256: shaB },
      }],
    };

    await writeConvergeCursor(cursorPath, cursor);
    const read = await readConvergeCursor(cursorPath);
    assert.ok(read);
    assert.equal(read.peerUrl, "http://localhost:4318");
    assert.equal(read.namespace, "default");
    assert.equal(read.baseFiles.length, 1);
    assert.equal(read.baseFiles[0]?.sha256, shaA);
    assert.deepEqual(read.completedPaths, ["facts/a.md"]);
    assert.deepEqual(read.semanticAgreements, [{
      local: { path: "facts/local.md", sha256: shaA },
      peer: { path: "facts/peer.md", sha256: shaB },
    }]);

    // Update existing cursor atomically
    const updated: ConvergeCursorState = {
      ...read,
      lastConvergedAt: new Date().toISOString(),
      completedPaths: ["facts/a.md", "facts/b.md"],
    };
    await writeConvergeCursor(cursorPath, updated);
    const readUpdated = await readConvergeCursor(cursorPath);
    assert.ok(readUpdated);
    assert.equal(readUpdated.completedPaths?.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("converge refresh obligations survive restart and clear independently", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-cursor-refresh-"));
  const cursorPath = defaultConvergeCursorPath(tmpDir, "https://peer.example.test", "team");
  try {
    await markConvergeRefreshPending(cursorPath, {
      peerUrl: "https://peer.example.test",
      namespace: "team",
      target: "receiver",
    });
    await markConvergeRefreshPending(cursorPath, {
      peerUrl: "https://peer.example.test",
      namespace: "team",
      target: "local",
    });

    const restarted = await readConvergeCursor(cursorPath);
    assert.ok(restarted);
    assert.deepEqual(restarted.pendingRefreshes, ["local", "receiver"]);
    assert.deepEqual(restarted.baseFiles, []);

    await clearConvergeRefreshPending(cursorPath, "receiver");
    assert.deepEqual((await readConvergeCursor(cursorPath))?.pendingRefreshes, ["local"]);

    await clearConvergeRefreshPending(cursorPath, "local");
    assert.deepEqual((await readConvergeCursor(cursorPath))?.pendingRefreshes, []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
