/**
 * Peer registry tests — issue #679 PR 1/5.
 *
 * Covers schema + storage primitives only. No reasoner, recall, or CLI
 * coverage in this PR. All fixtures are synthetic.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendInteractionLog,
  assertValidPeerId,
  deletePeer,
  listPeers,
  PEER_ID_PATTERN,
  readInteractionLogRaw,
  readPeerInteractionLog,
  readPeer,
  readPeerProfile,
  writePeer,
  writePeerProfile,
  type Peer,
  type PeerInteractionLogEntry,
  type PeerProfile,
} from "./index.js";

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "peers-test-"));
}

function samplePeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "self",
    kind: "self",
    displayName: "Operator",
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    notes: "Initial identity kernel.",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Round-trip
// ──────────────────────────────────────────────────────────────────────

test("writePeer + readPeer round-trips identity", async () => {
  const dir = await makeTempDir();
  const peer = samplePeer({ id: "agent.codex", kind: "agent", displayName: "Codex" });
  await writePeer(dir, peer);
  const loaded = await readPeer(dir, "agent.codex");
  assert.ok(loaded);
  assert.equal(loaded.id, "agent.codex");
  assert.equal(loaded.kind, "agent");
  assert.equal(loaded.displayName, "Codex");
  assert.equal(loaded.createdAt, peer.createdAt);
  assert.equal(loaded.updatedAt, peer.updatedAt);
  assert.equal(loaded.notes, "Initial identity kernel.");
});

test("readPeer round-trips peers with quote/backslash characters in displayName", async () => {
  const dir = await makeTempDir();
  const peer = samplePeer({
    id: "human.alex",
    kind: "human",
    displayName: 'Alex "the architect" \\ collaborator',
  });
  await writePeer(dir, peer);
  const loaded = await readPeer(dir, "human.alex");
  assert.ok(loaded);
  assert.equal(loaded.displayName, 'Alex "the architect" \\ collaborator');
});

test("readPeer returns null for a non-existent peer", async () => {
  const dir = await makeTempDir();
  const loaded = await readPeer(dir, "ghost");
  assert.equal(loaded, null);
});

test("readPeer returns null when the peers root does not exist", async () => {
  const dir = await makeTempDir();
  // makeTempDir creates the dir but no peers/ subtree.
  const loaded = await readPeer(dir, "self");
  assert.equal(loaded, null);
});

// ──────────────────────────────────────────────────────────────────────
// listPeers
// ──────────────────────────────────────────────────────────────────────

test("listPeers enumerates multiple peers in deterministic order", async () => {
  const dir = await makeTempDir();
  const peers = [
    samplePeer({ id: "self", kind: "self", displayName: "Operator" }),
    samplePeer({ id: "agent.codex", kind: "agent", displayName: "Codex" }),
    samplePeer({ id: "human.alex", kind: "human", displayName: "Alex" }),
  ];
  for (const p of peers) {
    await writePeer(dir, p);
  }
  const listed = await listPeers(dir);
  assert.equal(listed.length, 3);
  // Listing is sorted by id.
  assert.deepEqual(
    listed.map((p) => p.id),
    ["agent.codex", "human.alex", "self"],
  );
  for (const p of listed) {
    const ref = peers.find((q) => q.id === p.id);
    assert.ok(ref);
    assert.equal(p.kind, ref.kind);
    assert.equal(p.displayName, ref.displayName);
  }
});

test("listPeers returns [] when peers root does not exist", async () => {
  const dir = await makeTempDir();
  const listed = await listPeers(dir);
  assert.deepEqual(listed, []);
});

test("listPeers skips directory entries with invalid peer ids", async () => {
  const dir = await makeTempDir();
  await writePeer(dir, samplePeer({ id: "ok", displayName: "OK" }));
  // Create stray directory with an illegal name — should be ignored.
  await fs.mkdir(path.join(dir, "peers", "..hidden"), { recursive: true });
  await fs.mkdir(path.join(dir, "peers", "has space"), { recursive: true });
  const listed = await listPeers(dir);
  assert.deepEqual(
    listed.map((p) => p.id),
    ["ok"],
  );
});

test("listPeers skips directories that lack identity.md", async () => {
  const dir = await makeTempDir();
  await writePeer(dir, samplePeer({ id: "ok", displayName: "OK" }));
  await fs.mkdir(path.join(dir, "peers", "empty"), { recursive: true });
  const listed = await listPeers(dir);
  assert.deepEqual(
    listed.map((p) => p.id),
    ["ok"],
  );
});

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

test("PEER_ID_PATTERN accepts canonical ids", () => {
  for (const id of [
    "self",
    "agent.codex",
    "human.alex",
    "a",
    "A1",
    "x-y_z.0",
    "kebab-case-id",
    "snake_case_id",
  ]) {
    assert.ok(PEER_ID_PATTERN.test(id), `expected ${id} to match`);
  }
});

test("assertValidPeerId rejects invalid ids", () => {
  const bad = [
    "", // empty
    " ", // space
    "has space", // contains space
    "-leading", // leading dash
    "trailing-", // trailing dash
    ".dot", // leading dot
    "dot.", // trailing dot
    "double..dot", // consecutive dots
    "double--dash", // consecutive dashes
    "weird/slash", // path separator
    "..", // traversal
    "a".repeat(65), // too long (limit is 64)
  ];
  for (const id of bad) {
    assert.throws(
      () => assertValidPeerId(id),
      (err: Error) => err instanceof Error,
      `expected ${JSON.stringify(id)} to be rejected`,
    );
  }
});

test("assertValidPeerId rejects non-string input", () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.throws(() => assertValidPeerId(v as unknown));
  }
});

test("writePeer rejects invalid kind", async () => {
  const dir = await makeTempDir();
  await assert.rejects(
    writePeer(dir, samplePeer({ kind: "robot" as never })),
    /peer kind must be one of/,
  );
});

// ──────────────────────────────────────────────────────────────────────
// Interaction log — monotonic append
// ──────────────────────────────────────────────────────────────────────

test("appendInteractionLog appends entries in order", async () => {
  const dir = await makeTempDir();
  const peerId = "agent.codex";
  await writePeer(dir, samplePeer({ id: peerId, kind: "agent", displayName: "Codex" }));
  const entries: PeerInteractionLogEntry[] = [
    {
      timestamp: "2026-04-25T00:00:01.000Z",
      kind: "message",
      summary: "first turn",
      sessionId: "s-1",
    },
    {
      timestamp: "2026-04-25T00:00:02.000Z",
      kind: "tool_call",
      summary: "second turn — used recall",
      sessionId: "s-1",
    },
    {
      timestamp: "2026-04-25T00:00:03.000Z",
      kind: "preference_set",
      summary: "third turn — set preference",
    },
  ];
  for (const e of entries) {
    await appendInteractionLog(dir, peerId, e);
  }
  const raw = await readInteractionLogRaw(dir, peerId);
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 3);
  // Entries appear in append order — verify by timestamp prefix.
  assert.ok(lines[0].includes("[2026-04-25T00:00:01.000Z]"));
  assert.ok(lines[0].includes("(message)"));
  assert.ok(lines[0].includes("first turn"));
  assert.ok(lines[1].includes("[2026-04-25T00:00:02.000Z]"));
  assert.ok(lines[1].includes("second turn"));
  assert.ok(lines[2].includes("[2026-04-25T00:00:03.000Z]"));
  assert.ok(lines[2].includes("third turn"));
});

test("appendInteractionLog escapes embedded newlines so each entry stays one line", async () => {
  const dir = await makeTempDir();
  const peerId = "human.alex";
  await appendInteractionLog(dir, peerId, {
    timestamp: "2026-04-25T00:00:00.000Z",
    kind: "message",
    summary: "line one\nline two\nline three",
  });
  const raw = await readInteractionLogRaw(dir, peerId);
  assert.equal(raw.split("\n").filter((l) => l.length > 0).length, 1);
});

test("appendInteractionLog creates peer directory on demand", async () => {
  const dir = await makeTempDir();
  // No prior writePeer — the log helper should still work.
  await appendInteractionLog(dir, "self", {
    timestamp: "2026-04-25T00:00:00.000Z",
    kind: "message",
    summary: "no identity yet",
  });
  const raw = await readInteractionLogRaw(dir, "self");
  assert.ok(raw.includes("no identity yet"));
});

test("appendInteractionLog rejects non-canonical timestamps", async () => {
  const dir = await makeTempDir();

  await assert.rejects(
    appendInteractionLog(dir, "self", {
      timestamp: "zzzz",
      kind: "peer_profile_reasoner_run",
      summary: "bad marker",
    }),
    /canonical ISO-8601 timestamp/,
  );
});

test("readPeerInteractionLog skips malformed timestamp lines before timestamp filtering", async () => {
  const dir = await makeTempDir();
  const peerDir = path.join(dir, "peers", "self");
  await fs.mkdir(peerDir, { recursive: true });
  await fs.writeFile(
    path.join(peerDir, "interactions.log.md"),
    [
      "- [zzzz] (peer_profile_reasoner_run) bad marker",
      "- [2026-04-25T00:00:01.000Z] (message) good marker",
      "",
    ].join("\n"),
    "utf8",
  );

  const entries = await readPeerInteractionLog(dir, "self", {
    afterTimestamp: "2026-04-25T00:00:00.000Z",
  });

  assert.deepEqual(
    entries.map((entry) => entry.summary),
    ["good marker"],
  );
});

test("readInteractionLogRaw returns empty string when log does not exist", async () => {
  const dir = await makeTempDir();
  const raw = await readInteractionLogRaw(dir, "self");
  assert.equal(raw, "");
});

// ──────────────────────────────────────────────────────────────────────
// Profile read/write (schema scaffold)
// ──────────────────────────────────────────────────────────────────────

test("writePeerProfile + readPeerProfile round-trips fields and provenance", async () => {
  const dir = await makeTempDir();
  const profile: PeerProfile = {
    peerId: "agent.codex",
    updatedAt: "2026-04-25T01:00:00.000Z",
    fields: {
      communication_style: "Terse, prefers code blocks.",
      recurring_concerns: "Test coverage on retrieval paths.",
    },
    provenance: {
      communication_style: [
        {
          observedAt: "2026-04-25T00:30:00.000Z",
          signal: "explicit_preference",
          sourceSessionId: "s-1",
          note: "User said 'keep it short'",
        },
      ],
      recurring_concerns: [
        {
          observedAt: "2026-04-25T00:45:00.000Z",
          signal: "decision_pattern",
        },
      ],
    },
  };
  await writePeerProfile(dir, profile);
  const loaded = await readPeerProfile(dir, "agent.codex");
  assert.ok(loaded);
  assert.equal(loaded.peerId, "agent.codex");
  assert.equal(loaded.updatedAt, profile.updatedAt);
  assert.deepEqual(loaded.fields, profile.fields);
  assert.equal(loaded.provenance.communication_style.length, 1);
  assert.equal(loaded.provenance.communication_style[0].signal, "explicit_preference");
  assert.equal(loaded.provenance.communication_style[0].note, "User said 'keep it short'");
  assert.equal(loaded.provenance.recurring_concerns[0].signal, "decision_pattern");
});

test("readPeerProfile returns null when profile does not exist", async () => {
  const dir = await makeTempDir();
  await writePeer(dir, samplePeer({ id: "self" }));
  const loaded = await readPeerProfile(dir, "self");
  assert.equal(loaded, null);
});

// ──────────────────────────────────────────────────────────────────────
// On-disk shape — confirms the YAML+markdown contract
// ──────────────────────────────────────────────────────────────────────

test("identity.md is YAML frontmatter + markdown body", async () => {
  const dir = await makeTempDir();
  const peer = samplePeer({ id: "self", notes: "Operator notes." });
  await writePeer(dir, peer);
  const file = path.join(dir, "peers", "self", "identity.md");
  const raw = await fs.readFile(file, "utf8");
  // Frontmatter open + close, then a body section.
  assert.ok(raw.startsWith("---\n"));
  const lines = raw.split("\n");
  const closeIndex = lines.indexOf("---", 1);
  assert.ok(closeIndex > 0, "expected closing --- delimiter");
  const fmBlock = lines.slice(1, closeIndex).join("\n");
  assert.ok(fmBlock.includes("id:"));
  assert.ok(fmBlock.includes("kind:"));
  assert.ok(fmBlock.includes("displayName:"));
  assert.ok(fmBlock.includes("createdAt:"));
  assert.ok(fmBlock.includes("updatedAt:"));
  const body = lines.slice(closeIndex + 1).join("\n");
  assert.ok(body.includes("Operator notes."));
});

// ──────────────────────────────────────────────────────────────────────
// deletePeer (Cursor M, PR #756) — symlink-safe unlink contract.
// ──────────────────────────────────────────────────────────────────────

test("deletePeer removes identity.md and is idempotent", async () => {
  const dir = await makeTempDir();
  const peer = samplePeer({ id: "alice", kind: "human" });
  await writePeer(dir, peer);
  const first = await deletePeer(dir, "alice");
  assert.equal(first, true);
  const second = await deletePeer(dir, "alice");
  assert.equal(second, false);
});

test("deletePeer returns false when peer dir does not exist", async () => {
  const dir = await makeTempDir();
  const result = await deletePeer(dir, "ghost");
  assert.equal(result, false);
});

test("deletePeer rejects invalid peer ids", async () => {
  const dir = await makeTempDir();
  await assert.rejects(() => deletePeer(dir, "../escape"), /invalid|peerId/i);
});

test("deletePeer refuses to follow a symlinked identity.md", async () => {
  const dir = await makeTempDir();
  // Build a peer dir without writing identity.md, then plant a symlink at
  // identity.md pointing outside memoryDir. A naive `fs.unlink` would
  // remove the symlink itself, but the safe-delete contract refuses to
  // touch it (we can't safely distinguish symlink-removal from following
  // a redirected-target unlink without lstat).
  const peerDir = path.join(dir, "peers", "alice");
  await fs.mkdir(peerDir, { recursive: true });
  const outsideTarget = path.join(dir, "outside-target.md");
  await fs.writeFile(outsideTarget, "should not be deleted", "utf8");
  await fs.symlink(outsideTarget, path.join(peerDir, "identity.md"));
  await assert.rejects(() => deletePeer(dir, "alice"), /symlink/);
  // The outside file is intact.
  const stillThere = await fs.readFile(outsideTarget, "utf8");
  assert.equal(stillThere, "should not be deleted");
});

test("deletePeer leaves sibling profile and interaction log intact", async () => {
  const dir = await makeTempDir();
  const peer = samplePeer({ id: "alice", kind: "human" });
  await writePeer(dir, peer);
  const profile: PeerProfile = {
    peerId: "alice",
    fields: { tone: "warm" },
    provenance: {},
    updatedAt: "2026-04-26T00:00:00.000Z",
  };
  await writePeerProfile(dir, profile);
  const result = await deletePeer(dir, "alice");
  assert.equal(result, true);
  // Profile survives.
  const reread = await readPeerProfile(dir, "alice");
  assert.ok(reread, "profile should still exist after deletePeer");
  // Identity is gone.
  const identity = await readPeer(dir, "alice");
  assert.equal(identity, null);
});
