/**
 * Tests for `remnic peer forget` CLI surface (issue #679 completion).
 *
 * Covers:
 *   - forgetPeer storage primitive: purges full peer directory
 *   - forgetPeer idempotent: no-op when directory absent
 *   - forgetPeer rejects invalid peerId
 *   - forgetPeer rejects wrong confirm value
 *   - EngramAccessService.peerForget delegates to storage correctly
 *   - CLI source wiring: --confirm guard present, routes through service
 *   - HTTP source wiring: ?forget=true handler present
 *   - MCP source wiring: engram.peer_forget tool registered
 *
 * All fixtures are synthetic — no real user data (CLAUDE.md public-repo rule).
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { makeTempDir as managedTempDir } from "../helpers/tmp-dir.mjs";

import {
  writePeer,
  writePeerProfile,
  appendInteractionLog,
  forgetPeer,
  readPeer,
  readPeerProfile,
  type Peer,
  type PeerProfile,
} from "../../packages/remnic-core/src/peers/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const makeTempDir = (): Promise<string> => managedTempDir("peer-forget-test-");

function syntheticPeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "forget-test-peer",
    kind: "agent",
    displayName: "Forget Test Peer",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function syntheticProfile(peerId: string): PeerProfile {
  return {
    peerId,
    updatedAt: "2026-04-25T00:00:00.000Z",
    fields: {
      communication_style: "Verbose and exploratory.",
      preferred_format: "Plain text.",
    },
    provenance: {
      communication_style: [{ observedAt: "2026-04-20T00:00:00.000Z", signal: "explicit" }],
      preferred_format: [{ observedAt: "2026-04-18T00:00:00.000Z", signal: "tool_pattern" }],
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Storage-level unit tests
// ──────────────────────────────────────────────────────────────────────

test("forgetPeer purges identity.md + profile.md + interactions.log.md", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer();
  await writePeer(dir, peer);
  await writePeerProfile(dir, syntheticProfile(peer.id));
  await appendInteractionLog(dir, peer.id, {
    timestamp: "2026-04-25T10:00:00.000Z",
    kind: "conversation",
    summary: "Synthetic interaction for test",
  });

  // Verify all three files exist before purge.
  const peerDir = path.join(dir, "peers", peer.id);
  const identityBefore = await fs.stat(path.join(peerDir, "identity.md")).catch(() => null);
  const profileBefore = await fs.stat(path.join(peerDir, "profile.md")).catch(() => null);
  const logBefore = await fs.stat(path.join(peerDir, "interactions.log.md")).catch(() => null);
  assert.ok(identityBefore, "identity.md must exist before forget");
  assert.ok(profileBefore, "profile.md must exist before forget");
  assert.ok(logBefore, "interactions.log.md must exist before forget");

  const result = await forgetPeer(dir, peer.id, { confirm: "yes" });
  assert.equal(result.purged, true, "forgetPeer must return { purged: true }");

  // The entire peer directory must be gone.
  const dirAfter = await fs.stat(peerDir).catch(() => null);
  assert.equal(dirAfter, null, "peer directory must be removed after forget");
});

test("forgetPeer is idempotent — returns purged: false when directory absent", async () => {
  const dir = await makeTempDir();
  const result = await forgetPeer(dir, "nonexistent-peer", { confirm: "yes" });
  assert.equal(result.purged, false, "forgetPeer must return { purged: false } for absent peer");
});

test("forgetPeer is idempotent — second call after first purge returns purged: false", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer();
  await writePeer(dir, peer);

  const first = await forgetPeer(dir, peer.id, { confirm: "yes" });
  assert.equal(first.purged, true);

  const second = await forgetPeer(dir, peer.id, { confirm: "yes" });
  assert.equal(second.purged, false, "second forgetPeer call must be idempotent");
});

test("forgetPeer rejects invalid peerId", async () => {
  const dir = await makeTempDir();
  await assert.rejects(
    () => forgetPeer(dir, "../../traversal", { confirm: "yes" }),
    /invalid/i,
    "forgetPeer must reject traversal-style peer ids",
  );
});

test("forgetPeer rejects wrong confirm value", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer();
  await writePeer(dir, peer);

  await assert.rejects(
    () => forgetPeer(dir, peer.id, { confirm: "no" }),
    /confirm/i,
    "forgetPeer must reject when confirm !== 'yes'",
  );

  // Peer directory must still exist.
  const peerDir = path.join(dir, "peers", peer.id);
  const dirStat = await fs.stat(peerDir).catch(() => null);
  assert.ok(dirStat, "peer directory must be intact after rejected forget");
});

test("forgetPeer does not purge sibling peers", async () => {
  const dir = await makeTempDir();
  const peerA = syntheticPeer({ id: "alpha-peer" });
  const peerB = syntheticPeer({ id: "beta-peer" });
  await writePeer(dir, peerA);
  await writePeer(dir, peerB);

  await forgetPeer(dir, peerA.id, { confirm: "yes" });

  const remaining = await readPeer(dir, peerB.id);
  assert.ok(remaining, "sibling peer must survive forgetPeer on another peer");
});

// ──────────────────────────────────────────────────────────────────────
// Static source-wiring tests (fast — no I/O)
// ──────────────────────────────────────────────────────────────────────

test("peers/storage.ts exports forgetPeer function", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/peers/storage.ts"),
    "utf-8",
  );
  assert.match(src, /export async function forgetPeer\(/, "storage.ts must export forgetPeer");
  assert.match(
    src,
    /opts\.confirm !== ["']yes["']/,
    "forgetPeer must guard against missing confirm",
  );
  // Cursor finding #2: forgetPeer must call assertPeerDirNotEscaped for
  // realpath containment, matching the contract of every other I/O entry-point.
  assert.match(
    src,
    /assertPeerDirNotEscaped\(memoryDir, peerId\)/,
    "forgetPeer must call assertPeerDirNotEscaped for realpath containment",
  );
});

test("peers/index.ts re-exports forgetPeer", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/peers/index.ts"),
    "utf-8",
  );
  assert.match(src, /forgetPeer/, "peers/index.ts must re-export forgetPeer");
});

test("access-service.ts has peerForget method with confirm guard", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/access-service.ts"),
    "utf-8",
  );
  assert.match(src, /async peerForget\(/, "access-service must have peerForget method");
  assert.match(
    src,
    /opts\.confirm !== ["']yes["']/,
    "peerForget must guard confirm in access-service",
  );
});

test("cli.ts has peer forget subcommand with --confirm guard", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/cli.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /\.command\(["']forget <id>["']\)/,
    "cli.ts must register 'peer forget <id>' subcommand",
  );
  assert.match(
    src,
    /confirm !== ["']yes["']/,
    "cli.ts peer forget must reject when --confirm is not 'yes'",
  );
  assert.match(
    src,
    /peerForgetService\.peerForget\(/,
    "cli.ts peer forget must route through EngramAccessService.peerForget",
  );
});

test("access-http.ts has DELETE ?forget=true route with confirm body guard", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/access-http.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /forgetParam === ["']true["']/,
    "access-http.ts must check ?forget=true query param",
  );
  assert.match(
    src,
    /confirm_required/,
    "access-http.ts must return confirm_required error code when confirm absent",
  );
  assert.match(
    src,
    /this\.service\.peerForget\(/,
    "access-http.ts must call service.peerForget",
  );
});

test("access-mcp.ts registers engram.peer_forget tool", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/access-mcp.ts"),
    "utf-8",
  );
  assert.match(src, /["']engram\.peer_forget["']/, "MCP must register engram.peer_forget tool");
  // After the #1525 boundary migration, tools dispatch through the
  // operation registry (getOperation) rather than per-tool case branches.
  // Verify peer_forget is in the migrated-operations map AND registered
  // as a boundary operation.
  assert.match(
    src,
    /["']engram\.peer_forget["']\s*:\s*["']peer_forget["']/,
    "MCP must map engram.peer_forget to the peer_forget operation",
  );
});
