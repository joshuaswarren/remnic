import assert from "node:assert/strict";
import test from "node:test";
import { parseOfflineSyncDigestCache } from "./offline-sync-digest-cache.js";

const digest = {
  statBytes: 120, mtimeMs: 1_760_000_000_000, ctimeMs: 1_760_000_000_500,
  encrypted: false, sha256: "a".repeat(64), bytes: 118,
};
const entry = { path: "facts/alpha.md", ...digest };
const cacheFile = (entries: unknown[]) => JSON.stringify({ version: 1, entries });

test("digest cache parses valid plaintext and encrypted entries without losing fields", () => {
  const encrypted = { ...digest, encrypted: true, bytes: 0, sha256: "ABCDEF0123456789".repeat(4) };
  assert.deepEqual([...parseOfflineSyncDigestCache(cacheFile([
    entry, { path: "facts/beta.md", ...encrypted },
  ]))], [[entry.path, digest], ["facts/beta.md", encrypted]]);
});

test("digest cache skips legacy records missing stat data but does not expire old timestamps", () => {
  const old = { ...digest, mtimeMs: 1, ctimeMs: 1 };
  const legacy = ["statBytes", "mtimeMs", "ctimeMs", "bytes", "sha256"].map((field) => ({
    ...entry, [field]: undefined,
  }));
  // Freshness is checked against the file's stat by the caller, not by an age-based TTL here.
  assert.deepEqual([...parseOfflineSyncDigestCache(cacheFile([
    ...legacy, { path: "facts/old.md", ...old },
  ]))], [["facts/old.md", old]]);
});

test("digest cache rejects garbage shapes and unsafe records while retaining valid siblings", () => {
  for (const raw of ["null", "[]", "42", "{}", '{"entries":{}}']) {
    assert.equal(parseOfflineSyncDigestCache(raw).size, 0);
  }
  const invalid = [
    null, [], "garbage",
    ...["", "..", "../escape.md", "/absolute.md"].map((path) => ({ ...entry, path })),
    { ...entry, sha256: "z".repeat(64) }, { ...entry, sha256: "abc" },
    { ...entry, statBytes: "120" }, { ...entry, mtimeMs: 1e400 },
    { ...entry, ctimeMs: null }, { ...entry, bytes: "118" },
  ];
  assert.deepEqual([...parseOfflineSyncDigestCache(cacheFile([...invalid, entry]))], [[entry.path, digest]]);
  for (const raw of ["", "{", '{"entries":[}']) {
    assert.throws(() => parseOfflineSyncDigestCache(raw), SyntaxError);
  }
});
