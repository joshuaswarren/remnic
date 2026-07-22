/**
 * Multi-peer integration tests — issue #679 completion.
 *
 * Exercises self + remote-agent + human-collaborator round-trip:
 *
 *   1. Register three peers with different kinds (self, agent, human).
 *   2. Append synthetic interactions for each.
 *   3. Verify the reasoner-input pipeline can read all three interaction
 *      logs and that profile writes round-trip correctly.
 *   4. Verify recall injection selects correct peer by session mapping.
 *   5. Verify recall X-ray records peer-profile injection when feature is on.
 *   6. Verify forgetPeer removes only the targeted peer, leaving siblings intact.
 *
 * All fixture data is synthetic (CLAUDE.md public-repo rule — no real users).
 * Tests are pure storage / logic tests — no orchestrator, no LLM calls.
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
  readPeerInteractionLog,
  listPeers,
  type Peer,
  type PeerProfile,
} from "../../packages/remnic-core/src/peers/index.js";

import {
  buildXraySnapshot,
  type RecallXrayPeerProfileInjection,
} from "../../packages/remnic-core/src/recall-xray.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const makeTempDir = (): Promise<string> => managedTempDir("multi-peer-intg-");

/** Returns three synthetic peers with distinct kinds */
function threeFixturePeers(): [Peer, Peer, Peer] {
  const self: Peer = {
    id: "self",
    kind: "self",
    displayName: "Self",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
  const agent: Peer = {
    id: "codex-agent",
    kind: "agent",
    displayName: "Codex Agent",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
  const human: Peer = {
    id: "human-collaborator",
    kind: "human",
    displayName: "Human Collaborator",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
  return [self, agent, human];
}

function syntheticProfileFor(peerId: string): PeerProfile {
  return {
    peerId,
    updatedAt: "2026-04-25T00:00:00.000Z",
    fields: {
      communication_style: `${peerId} prefers concise responses.`,
      primary_focus: `${peerId} focuses on code quality.`,
    },
    provenance: {
      communication_style: [
        { observedAt: "2026-04-22T00:00:00.000Z", signal: "explicit_preference" },
      ],
      primary_focus: [
        { observedAt: "2026-04-20T00:00:00.000Z", signal: "topic_recurrence" },
      ],
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// 1. Register + ingest + round-trip for three peers
// ──────────────────────────────────────────────────────────────────────

test("multi-peer: register self + agent + human, list all three", async () => {
  const dir = await makeTempDir();
  const [self, agent, human] = threeFixturePeers();
  await writePeer(dir, self);
  await writePeer(dir, agent);
  await writePeer(dir, human);

  const peers = await listPeers(dir);
  const ids = peers.map((p) => p.id).sort();
  assert.deepEqual(ids, ["codex-agent", "human-collaborator", "self"]);
  assert.equal(
    peers.find((p) => p.id === "self")?.kind,
    "self",
    "self peer must have kind=self",
  );
  assert.equal(
    peers.find((p) => p.id === "codex-agent")?.kind,
    "agent",
    "agent peer must have kind=agent",
  );
  assert.equal(
    peers.find((p) => p.id === "human-collaborator")?.kind,
    "human",
    "human peer must have kind=human",
  );
});

test("multi-peer: append interactions to each peer independently", async () => {
  const dir = await makeTempDir();
  const [self, agent, human] = threeFixturePeers();
  await writePeer(dir, self);
  await writePeer(dir, agent);
  await writePeer(dir, human);

  // Append different counts to each peer so we can verify isolation.
  await appendInteractionLog(dir, self.id, {
    timestamp: "2026-04-25T09:00:00.000Z",
    kind: "conversation",
    summary: "Self interaction A",
  });
  await appendInteractionLog(dir, agent.id, {
    timestamp: "2026-04-25T10:00:00.000Z",
    kind: "conversation",
    summary: "Agent interaction A",
  });
  await appendInteractionLog(dir, agent.id, {
    timestamp: "2026-04-25T10:05:00.000Z",
    kind: "tool_use",
    summary: "Agent interaction B",
  });
  await appendInteractionLog(dir, human.id, {
    timestamp: "2026-04-25T11:00:00.000Z",
    kind: "conversation",
    summary: "Human interaction A",
  });
  await appendInteractionLog(dir, human.id, {
    timestamp: "2026-04-25T11:05:00.000Z",
    kind: "feedback",
    summary: "Human interaction B",
  });
  await appendInteractionLog(dir, human.id, {
    timestamp: "2026-04-25T11:10:00.000Z",
    kind: "conversation",
    summary: "Human interaction C",
  });

  const selfLog = await readPeerInteractionLog(dir, self.id);
  const agentLog = await readPeerInteractionLog(dir, agent.id);
  const humanLog = await readPeerInteractionLog(dir, human.id);

  assert.equal(selfLog.length, 1, "self peer must have 1 interaction");
  assert.equal(agentLog.length, 2, "agent peer must have 2 interactions");
  assert.equal(humanLog.length, 3, "human peer must have 3 interactions");
});

// ──────────────────────────────────────────────────────────────────────
// 2. Profile write + round-trip for all three peers
// ──────────────────────────────────────────────────────────────────────

test("multi-peer: profile written for each peer round-trips independently", async () => {
  const dir = await makeTempDir();
  const [self, agent, human] = threeFixturePeers();
  await writePeer(dir, self);
  await writePeer(dir, agent);
  await writePeer(dir, human);

  await writePeerProfile(dir, syntheticProfileFor(self.id));
  await writePeerProfile(dir, syntheticProfileFor(agent.id));
  await writePeerProfile(dir, syntheticProfileFor(human.id));

  const selfProfile = await readPeerProfile(dir, self.id);
  const agentProfile = await readPeerProfile(dir, agent.id);
  const humanProfile = await readPeerProfile(dir, human.id);

  assert.ok(selfProfile, "self profile must exist");
  assert.ok(agentProfile, "agent profile must exist");
  assert.ok(humanProfile, "human profile must exist");

  // Each profile must contain the correct peerId and peer-specific value.
  assert.equal(selfProfile.peerId, self.id);
  assert.equal(agentProfile.peerId, agent.id);
  assert.equal(humanProfile.peerId, human.id);

  // Fields must be isolated — each profile has its own content.
  assert.match(
    selfProfile.fields.communication_style ?? "",
    /self prefers/,
    "self profile must contain self-specific field value",
  );
  assert.match(
    agentProfile.fields.communication_style ?? "",
    /codex-agent prefers/,
    "agent profile must contain agent-specific field value",
  );
  assert.match(
    humanProfile.fields.communication_style ?? "",
    /human-collaborator prefers/,
    "human profile must contain human-specific field value",
  );
});

// ──────────────────────────────────────────────────────────────────────
// 3. Profile field selection logic for recall injection
// ──────────────────────────────────────────────────────────────────────

/**
 * Pure helper mirroring the orchestrator's peer-profile recall injection
 * logic (as of PR 3/5 + completion). Returns { section, fieldsInjected }.
 */
function buildPeerProfileRecallResult(
  profile: PeerProfile,
  maxFields: number,
): { section: string | null; fieldsInjected: number } {
  const allFields = Object.entries(profile.fields);
  if (allFields.length === 0) return { section: null, fieldsInjected: 0 };
  if (maxFields <= 0) return { section: null, fieldsInjected: 0 };

  const fieldsByRecency = allFields
    .map(([key, value]) => {
      const prov = profile.provenance[key];
      let latestMs = 0;
      if (Array.isArray(prov) && prov.length > 0) {
        for (const p of prov) {
          if (typeof p.observedAt === "string") {
            const parsed = Date.parse(p.observedAt);
            if (Number.isFinite(parsed) && parsed > latestMs) latestMs = parsed;
          }
        }
      }
      return { key, value, latestMs };
    })
    .sort((a, b) => {
      if (b.latestMs !== a.latestMs) return b.latestMs - a.latestMs;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  const capped = fieldsByRecency.slice(0, maxFields);
  const lines = capped.map(({ key, value }) => `**${key}**: ${value}`);
  return {
    section: `## Peer Profile\n\n${lines.join("\n\n")}`,
    fieldsInjected: capped.length,
  };
}

test("multi-peer: recall injection selects correct peer fields per session", async () => {
  const dir = await makeTempDir();
  const [self, agent, human] = threeFixturePeers();
  await writePeer(dir, self);
  await writePeer(dir, agent);
  await writePeer(dir, human);

  await writePeerProfile(dir, syntheticProfileFor(agent.id));
  await writePeerProfile(dir, syntheticProfileFor(human.id));
  // self has no profile — injection must be null for self session.

  // Simulate "agent session" — inject agent profile.
  const agentProfile = await readPeerProfile(dir, agent.id);
  assert.ok(agentProfile);
  const agentResult = buildPeerProfileRecallResult(agentProfile, 5);
  assert.ok(agentResult.section, "agent session must produce a profile section");
  assert.match(agentResult.section, /codex-agent prefers/);
  assert.equal(agentResult.fieldsInjected, 2);

  // Simulate "human session" — inject human profile.
  const humanProfile = await readPeerProfile(dir, human.id);
  assert.ok(humanProfile);
  const humanResult = buildPeerProfileRecallResult(humanProfile, 1);
  assert.ok(humanResult.section, "human session must produce a profile section");
  assert.equal(humanResult.fieldsInjected, 1, "maxFields cap must apply");
  // 1 field = most-recent; communication_style has newer observedAt (2026-04-22)
  assert.match(humanResult.section, /communication_style/);

  // Self has no profile — null return.
  const selfProfile = await readPeerProfile(dir, self.id);
  assert.equal(selfProfile, null, "self must have no profile yet");
});

// ──────────────────────────────────────────────────────────────────────
// 4. Recall X-ray records peer-profile injection
// ──────────────────────────────────────────────────────────────────────

test("recall xray snapshot includes peerProfileInjection when injection occurred", () => {
  const injection: RecallXrayPeerProfileInjection = {
    peerId: "codex-agent",
    fieldsInjected: 2,
  };
  const snapshot = buildXraySnapshot({
    query: "multi-peer integration test query",
    results: [],
    filters: [],
    budget: { chars: 4096, used: 100 },
    peerProfileInjection: injection,
    // Deterministic for test.
    now: () => 1745710800000,
    snapshotIdGenerator: () => "00000000-0000-0000-0000-000000000001",
  });

  assert.ok(snapshot.peerProfileInjection, "snapshot must have peerProfileInjection");
  assert.equal(snapshot.peerProfileInjection.peerId, "codex-agent");
  assert.equal(snapshot.peerProfileInjection.fieldsInjected, 2);
});

test("recall xray snapshot records null when no injection", () => {
  const snapshot = buildXraySnapshot({
    query: "no-injection test query",
    results: [],
    filters: [],
    budget: { chars: 4096, used: 0 },
    peerProfileInjection: null,
    now: () => 1745710800000,
    snapshotIdGenerator: () => "00000000-0000-0000-0000-000000000002",
  });

  assert.equal(
    snapshot.peerProfileInjection,
    null,
    "explicit null injection must be preserved in snapshot",
  );
});

test("recall xray snapshot omits peerProfileInjection when not provided", () => {
  const snapshot = buildXraySnapshot({
    query: "absent injection test query",
    results: [],
    filters: [],
    budget: { chars: 4096, used: 0 },
    now: () => 1745710800000,
    snapshotIdGenerator: () => "00000000-0000-0000-0000-000000000003",
  });

  assert.equal(
    "peerProfileInjection" in snapshot,
    false,
    "peerProfileInjection must be absent when not provided",
  );
});

test("recall xray peerProfileInjection is deep-copied (caller mutation safe)", () => {
  const injection: RecallXrayPeerProfileInjection = {
    peerId: "human-collaborator",
    fieldsInjected: 3,
  };
  const snapshot = buildXraySnapshot({
    query: "mutation test",
    results: [],
    filters: [],
    peerProfileInjection: injection,
    now: () => 1745710800000,
    snapshotIdGenerator: () => "00000000-0000-0000-0000-000000000004",
  });

  // Mutating the original input after build must not affect the snapshot.
  (injection as { peerId: string }).peerId = "mutated-id";
  assert.equal(
    snapshot.peerProfileInjection?.peerId,
    "human-collaborator",
    "snapshot peerProfileInjection must be independent of caller's object",
  );
});

// ──────────────────────────────────────────────────────────────────────
// 5. forgetPeer removes targeted peer, siblings intact
// ──────────────────────────────────────────────────────────────────────

test("multi-peer: forgetPeer removes targeted peer, all siblings survive", async () => {
  const dir = await makeTempDir();
  const [self, agent, human] = threeFixturePeers();
  await writePeer(dir, self);
  await writePeer(dir, agent);
  await writePeer(dir, human);

  // Write profiles and logs for all three.
  await writePeerProfile(dir, syntheticProfileFor(self.id));
  await writePeerProfile(dir, syntheticProfileFor(agent.id));
  await writePeerProfile(dir, syntheticProfileFor(human.id));
  await appendInteractionLog(dir, agent.id, {
    timestamp: "2026-04-25T10:00:00.000Z",
    kind: "conversation",
    summary: "Agent turn 1",
  });

  // Forget only the agent peer.
  const result = await forgetPeer(dir, agent.id, { confirm: "yes" });
  assert.equal(result.purged, true, "forgetPeer must purge agent peer");

  // Agent directory must be gone.
  const agentDir = path.join(dir, "peers", agent.id);
  const agentDirStat = await fs.stat(agentDir).catch(() => null);
  assert.equal(agentDirStat, null, "agent peer directory must not exist after forget");

  // Agent profile must be unreadable.
  const agentProfile = await readPeerProfile(dir, agent.id);
  assert.equal(agentProfile, null, "agent profile must be null after forget");

  // Self and human peers must be fully intact.
  const selfPeer = await readPeer(dir, self.id);
  const humanPeer = await readPeer(dir, human.id);
  assert.ok(selfPeer, "self peer must survive agent forget");
  assert.ok(humanPeer, "human peer must survive agent forget");

  const selfProfileAfter = await readPeerProfile(dir, self.id);
  const humanProfileAfter = await readPeerProfile(dir, human.id);
  assert.ok(selfProfileAfter, "self profile must survive agent forget");
  assert.ok(humanProfileAfter, "human profile must survive agent forget");

  // listPeers must only return self and human.
  const remaining = await listPeers(dir);
  const remainingIds = remaining.map((p) => p.id).sort();
  assert.deepEqual(remainingIds, ["human-collaborator", "self"]);
});

// ──────────────────────────────────────────────────────────────────────
// 6. Source wiring: orchestrator X-ray annotation
// ──────────────────────────────────────────────────────────────────────

test("orchestrator sets peerProfileXrayAnnotation before xray capture", () => {
  // #1526 seam 18: recallInternal (and its X-ray capture block) moved to
  // orchestration/recall-internal.ts; the wiring assertion follows it.
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestration/recall-internal.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /peerProfileXrayAnnotation\s*=\s*\{\s*peerId,\s*fieldsInjected:/,
    "orchestrator must set peerProfileXrayAnnotation with peerId + fieldsInjected",
  );
  assert.match(
    src,
    /peerProfileInjection:\s*peerProfileXrayAnnotation/,
    "orchestrator must forward peerProfileXrayAnnotation to buildXraySnapshot",
  );
});

test("recall-xray.ts exports RecallXrayPeerProfileInjection interface", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/recall-xray.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /export interface RecallXrayPeerProfileInjection/,
    "recall-xray.ts must export RecallXrayPeerProfileInjection interface",
  );
  assert.match(
    src,
    /peerProfileInjection\?:/,
    "RecallXraySnapshot must declare peerProfileInjection field",
  );
  assert.match(
    src,
    /setPeerProfileInjection\(/,
    "RecallXrayBuilder must expose setPeerProfileInjection method",
  );
});
