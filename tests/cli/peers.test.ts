/**
 * CLI-level tests for `remnic peer` subcommands (issue #679 PR 4/5).
 *
 * These tests exercise the storage primitives that the CLI delegates to
 * directly — no orchestrator required. Each test creates a fresh temp
 * directory and tears it down afterward.
 *
 * Covered commands:
 *   - peer list      (via listPeers)
 *   - peer show      (via readPeer)
 *   - peer set       (via writePeer / readPeer round-trip)
 *   - peer delete    (via writePeer + unlink round-trip)
 *   - peer profile   (via readPeerProfile)
 *
 * All test data is synthetic (CLAUDE.md public-repo rule: no real
 * conversation content or user identifiers).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { makeTempDir as managedTempDir } from "../helpers/tmp-dir.mjs";

import {
  assertValidPeerId,
  listPeers,
  readPeer,
  writePeer,
  readPeerProfile,
  writePeerProfile,
} from "../../packages/remnic-core/src/peers/index.js";
import type { Peer, PeerProfile } from "../../packages/remnic-core/src/peers/types.js";

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

const makeTempDir = (): Promise<string> => managedTempDir("remnic-peers-test-");

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function makePeer(overrides: Partial<Peer> & { id: string }): Peer {
  return {
    kind: "human",
    displayName: overrides.id,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// assertValidPeerId
// ──────────────────────────────────────────────────────────────────────

test("assertValidPeerId accepts valid ids", () => {
  const valid = ["alice", "bob-42", "agent.codex", "self", "a", "A1", "integration_v2"];
  for (const id of valid) {
    assert.doesNotThrow(() => assertValidPeerId(id), `expected ${id} to be valid`);
  }
});

test("assertValidPeerId rejects empty string", () => {
  assert.throws(() => assertValidPeerId(""), /must not be empty/);
});

test("assertValidPeerId rejects ids with consecutive separators", () => {
  // The regex itself rejects `--` (requires alphanumeric after each separator),
  // so the error message refers to the pattern rather than "consecutive" text.
  assert.throws(() => assertValidPeerId("alice--bob"), /invalid/i);
});

test("assertValidPeerId rejects ids exceeding max length", () => {
  const longId = "a".repeat(65);
  assert.throws(() => assertValidPeerId(longId), /≤ 64/);
});

test("assertValidPeerId rejects non-string", () => {
  assert.throws(() => assertValidPeerId(42), /must be a string/);
});

// ──────────────────────────────────────────────────────────────────────
// peer list — via listPeers
// ──────────────────────────────────────────────────────────────────────

test("peer list: returns empty array when no peers directory exists", async () => {
  const dir = await makeTempDir();
  try {
    const peers = await listPeers(dir);
    assert.deepEqual(peers, []);
  } finally {
    await removeTempDir(dir);
  }
});

test("peer list: returns registered peers sorted alphabetically", async () => {
  const dir = await makeTempDir();
  try {
    const now = "2026-04-01T00:00:00.000Z";
    await writePeer(dir, makePeer({ id: "zara", kind: "human", displayName: "Zara", createdAt: now, updatedAt: now }));
    await writePeer(dir, makePeer({ id: "alice", kind: "human", displayName: "Alice", createdAt: now, updatedAt: now }));
    await writePeer(dir, makePeer({ id: "bob", kind: "agent", displayName: "Bob Bot", createdAt: now, updatedAt: now }));

    const peers = await listPeers(dir);
    assert.equal(peers.length, 3);
    assert.equal(peers[0]!.id, "alice");
    assert.equal(peers[1]!.id, "bob");
    assert.equal(peers[2]!.id, "zara");
  } finally {
    await removeTempDir(dir);
  }
});

// ──────────────────────────────────────────────────────────────────────
// peer show — via readPeer
// ──────────────────────────────────────────────────────────────────────

test("peer show: returns null for non-existent peer", async () => {
  const dir = await makeTempDir();
  try {
    const peer = await readPeer(dir, "missing");
    assert.equal(peer, null);
  } finally {
    await removeTempDir(dir);
  }
});

test("peer show: round-trips identity fields", async () => {
  const dir = await makeTempDir();
  try {
    const original = makePeer({
      id: "alice",
      kind: "human",
      displayName: "Alice Aliceson",
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T10:00:00.000Z",
      notes: "Works in ops",
    });
    await writePeer(dir, original);

    const retrieved = await readPeer(dir, "alice");
    assert.ok(retrieved !== null);
    assert.equal(retrieved.id, "alice");
    assert.equal(retrieved.kind, "human");
    assert.equal(retrieved.displayName, "Alice Aliceson");
    assert.equal(retrieved.notes, "Works in ops");
  } finally {
    await removeTempDir(dir);
  }
});

// ──────────────────────────────────────────────────────────────────────
// peer set — create then update (writePeer logic)
// ──────────────────────────────────────────────────────────────────────

test("peer set: creates peer on first write", async () => {
  const dir = await makeTempDir();
  try {
    const peer = makePeer({ id: "codex-agent", kind: "agent", displayName: "Codex" });
    await writePeer(dir, peer);

    const retrieved = await readPeer(dir, "codex-agent");
    assert.ok(retrieved !== null);
    assert.equal(retrieved.kind, "agent");
    assert.equal(retrieved.displayName, "Codex");
  } finally {
    await removeTempDir(dir);
  }
});

test("peer set: overwrites displayName on update (kind immutable by convention)", async () => {
  const dir = await makeTempDir();
  try {
    const now = "2026-04-01T00:00:00.000Z";
    const later = "2026-04-02T00:00:00.000Z";
    await writePeer(dir, makePeer({ id: "alice", createdAt: now, updatedAt: now }));

    const updated: Peer = {
      id: "alice",
      kind: "human",
      displayName: "Alice Updated",
      createdAt: now,
      updatedAt: later,
    };
    await writePeer(dir, updated);

    const retrieved = await readPeer(dir, "alice");
    assert.ok(retrieved !== null);
    assert.equal(retrieved.displayName, "Alice Updated");
    assert.equal(retrieved.createdAt, now);
    assert.equal(retrieved.updatedAt, later);
  } finally {
    await removeTempDir(dir);
  }
});

test("peer set: rejects invalid peer id", async () => {
  const dir = await makeTempDir();
  try {
    const peer: Peer = {
      id: "bad/id",
      kind: "human",
      displayName: "Bad",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };
    await assert.rejects(
      () => writePeer(dir, peer),
      /invalid/i,
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ──────────────────────────────────────────────────────────────────────
// peer delete — via unlink of identity.md
// ──────────────────────────────────────────────────────────────────────

test("peer delete: identity.md removed; directory preserved", async () => {
  const dir = await makeTempDir();
  try {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");

    const peer = makePeer({ id: "to-delete", kind: "human" });
    await writePeer(dir, peer);

    // Verify file exists.
    const identityFile = path.join(dir, "peers", "to-delete", "identity.md");
    await assert.doesNotReject(() => fs.access(identityFile));

    // Delete.
    await fs.unlink(identityFile);

    // File gone; directory still present.
    await assert.rejects(() => fs.access(identityFile), /ENOENT/);
    const peerDirStat = await fs.stat(path.join(dir, "peers", "to-delete"));
    assert.ok(peerDirStat.isDirectory());
  } finally {
    await removeTempDir(dir);
  }
});

test("peer delete: idempotent — unlink on missing file gives ENOENT only", async () => {
  const dir = await makeTempDir();
  try {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");

    const identityFile = path.join(dir, "peers", "ghost", "identity.md");
    const err = await fs.unlink(identityFile).then(() => null).catch((e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
  } finally {
    await removeTempDir(dir);
  }
});

// ──────────────────────────────────────────────────────────────────────
// peer profile — via readPeerProfile
// ──────────────────────────────────────────────────────────────────────

test("peer profile: returns null when no profile file exists", async () => {
  const dir = await makeTempDir();
  try {
    // Write peer identity so the directory exists but no profile.
    await writePeer(dir, makePeer({ id: "no-profile" }));
    const profile = await readPeerProfile(dir, "no-profile");
    assert.equal(profile, null);
  } finally {
    await removeTempDir(dir);
  }
});

test("peer profile: round-trips structured profile data", async () => {
  const dir = await makeTempDir();
  try {
    await writePeer(dir, makePeer({ id: "with-profile" }));

    const profileIn: PeerProfile = {
      peerId: "with-profile",
      updatedAt: "2026-04-10T00:00:00.000Z",
      fields: {
        communication_style: "Prefers async, concise summaries.",
        recurring_concerns: "Performance regressions in hot path.",
      },
      provenance: {
        communication_style: [
          {
            observedAt: "2026-04-09T00:00:00.000Z",
            signal: "explicit_preference",
            note: "Stated directly in session",
          },
        ],
      },
    };
    await writePeerProfile(dir, profileIn);

    const profileOut = await readPeerProfile(dir, "with-profile");
    assert.ok(profileOut !== null);
    assert.equal(profileOut.peerId, "with-profile");
    assert.equal(profileOut.updatedAt, "2026-04-10T00:00:00.000Z");
    assert.equal(profileOut.fields.communication_style, "Prefers async, concise summaries.");
    assert.equal(profileOut.fields.recurring_concerns, "Performance regressions in hot path.");
    assert.equal(profileOut.provenance.communication_style?.[0]?.signal, "explicit_preference");
  } finally {
    await removeTempDir(dir);
  }
});

test("peer profile: handles profile with empty fields gracefully", async () => {
  const dir = await makeTempDir();
  try {
    await writePeer(dir, makePeer({ id: "empty-profile" }));

    const emptyProfile: PeerProfile = {
      peerId: "empty-profile",
      updatedAt: "2026-04-01T00:00:00.000Z",
      fields: {},
      provenance: {},
    };
    await writePeerProfile(dir, emptyProfile);

    const result = await readPeerProfile(dir, "empty-profile");
    assert.ok(result !== null);
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.provenance, {});
  } finally {
    await removeTempDir(dir);
  }
});
