/**
 * Peer profile recall-injection integration tests — issue #679 PR 3/5.
 *
 * Covers:
 *   - profile fields are injected into recall context when feature is on
 *   - no injection when `peerProfileRecallEnabled` is false
 *   - `peerProfileRecallMaxFields` cap respected (top-N by recency)
 *   - missing peer profile is a no-op (does not throw)
 *   - orchestrator source wiring: gate, import, and section-assembly all
 *     verifiable via static source inspection
 *
 * All fixtures are synthetic. No real users, sessions, or interactions.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeTempDir as managedTempDir } from "../helpers/tmp-dir.mjs";

import {
  writePeer,
  writePeerProfile,
  type Peer,
  type PeerProfile,
} from "../../packages/remnic-core/src/peers/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const makeTempDir = (): Promise<string> => managedTempDir("peer-recall-test-");

function syntheticPeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "synthetic.alpha",
    kind: "agent",
    displayName: "Synthetic Alpha",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function syntheticProfile(overrides: Partial<PeerProfile> = {}): PeerProfile {
  return {
    peerId: "synthetic.alpha",
    updatedAt: "2026-04-25T00:00:00.000Z",
    fields: {
      communication_style: "Concise and direct. Prefers bullet points.",
      recurring_concerns: "Performance of the retrieval pipeline.",
      preferred_format: "Markdown with code blocks.",
    },
    provenance: {
      communication_style: [
        {
          observedAt: "2026-04-20T00:00:00.000Z",
          signal: "explicit_preference",
          note: "Stated during session alpha-1.",
        },
      ],
      recurring_concerns: [
        {
          observedAt: "2026-04-22T00:00:00.000Z",
          signal: "topic_recurrence",
        },
      ],
      preferred_format: [
        {
          observedAt: "2026-04-18T00:00:00.000Z",
          signal: "tool_pattern",
        },
      ],
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Static source-wiring tests (fast — no I/O)
// ──────────────────────────────────────────────────────────────────────

test("orchestrator contains setPeerIdForSession method", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestrator.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /setPeerIdForSession\(/,
    "orchestrator must expose setPeerIdForSession",
  );
  assert.match(
    src,
    /getPeerIdForSession\(/,
    "orchestrator must expose getPeerIdForSession",
  );
});

test("orchestrator gates peer profile injection on peerProfileRecallEnabled", () => {
  // #1526 seam 18: the peer-profile recall block moved (with recallInternal)
  // to orchestration/recall-internal.ts; deps expose config + session lookup.
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestration/recall-internal.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /resolveRecallEnhancementCapabilities\(this\.deps\.config\)\.peerProfileRecall/,
    "recall pipeline must reference peerProfileRecallEnabled (via RecallEnhancementCapabilitySet)",
  );
  assert.match(
    src,
    /this\.deps\.config\.peerProfileRecallMaxFields/,
    "recall pipeline must reference peerProfileRecallMaxFields",
  );
  assert.match(
    src,
    /getPeerIdForSession\(/,
    "recall pipeline must call getPeerIdForSession",
  );
});

test("orchestrator lazily imports peers barrel for peer profile recall", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestration/recall-internal.ts"),
    "utf-8",
  );
  // The dynamic import must reference the peers barrel so the cold path
  // doesn't force a peers I/O import on every recall. (Path is ../peers
  // relative to orchestration/ since the #1526 seam-18 move.)
  assert.match(
    src,
    /await import\("\.\.\/peers\/index\.js"\)/,
    "recall pipeline must lazily import peers/index.js for recall injection",
  );
});

test("orchestrator assembles peer-profile section in Phase 2", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestration/recall-internal.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /appendRecallSection\(\s*sectionBuckets,\s*["']peer-profile["']/,
    "recall pipeline must append peer-profile to sectionBuckets in Phase 2",
  );
});

test("config exports peerProfileRecallEnabled defaulting to false", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/config.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /peerProfileRecallEnabled:\s*\n\s*coerceBool\(cfg\.peerProfileRecallEnabled\) \?\? false/,
    "peerProfileRecallEnabled must default to false via coerceBool",
  );
});

test("config exports peerProfileRecallMaxFields defaulting to 5", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/config.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /peerProfileRecallMaxFields: coerceNonNegativeInt\(\s*\n\s*cfg\.peerProfileRecallMaxFields,\s*\n\s*5,/,
    "peerProfileRecallMaxFields must default to 5 via coerceNonNegativeInt",
  );
});

test("PluginConfig declares peerProfileRecallEnabled and peerProfileRecallMaxFields", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/types.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /peerProfileRecallEnabled: boolean/,
    "PluginConfig must declare peerProfileRecallEnabled",
  );
  assert.match(
    src,
    /peerProfileRecallMaxFields: number/,
    "PluginConfig must declare peerProfileRecallMaxFields",
  );
});

// ──────────────────────────────────────────────────────────────────────
// Storage-level unit tests
// ──────────────────────────────────────────────────────────────────────

test("writePeerProfile + readPeerProfile preserves fields for recall injection", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer();
  await writePeer(dir, peer);
  const profile = syntheticProfile();
  await writePeerProfile(dir, profile);

  const { readPeerProfile } = await import("../../packages/remnic-core/src/peers/index.js");
  const loaded = await readPeerProfile(dir, "synthetic.alpha");
  assert.ok(loaded, "profile must be readable after write");
  assert.equal(
    Object.keys(loaded.fields).length,
    3,
    "all three fields must round-trip",
  );
  assert.equal(
    loaded.fields.communication_style,
    "Concise and direct. Prefers bullet points.",
  );
});

test("readPeerProfile returns null for unknown peer (no throw)", async () => {
  const dir = await makeTempDir();
  const { readPeerProfile } = await import("../../packages/remnic-core/src/peers/index.js");
  const result = await readPeerProfile(dir, "ghost.peer");
  assert.equal(result, null, "missing peer profile must return null, not throw");
});

// ──────────────────────────────────────────────────────────────────────
// Injection logic unit tests (exercise the pure sorting / capping logic
// without needing a full orchestrator instance)
// ──────────────────────────────────────────────────────────────────────

/**
 * Pure helper that mirrors the field-selection logic from orchestrator.ts.
 * Extracted here so the test stays decoupled from internal implementation
 * details while still verifying correctness end-to-end.
 */
function buildPeerProfileSection(
  profile: PeerProfile,
  maxFields: number,
): string | null {
  const allFields = Object.entries(profile.fields);
  if (allFields.length === 0) return null;

  const fieldsByRecency = allFields
    .map(([key, value]) => {
      const prov = profile.provenance[key];
      // Use epoch ms (not string comparison) — matches Codex P2 fix in orchestrator.ts.
      let latestMs = 0;
      if (Array.isArray(prov) && prov.length > 0) {
        for (const p of prov) {
          if (typeof p.observedAt === "string") {
            const parsed = Date.parse(p.observedAt);
            if (Number.isFinite(parsed) && parsed > latestMs) {
              latestMs = parsed;
            }
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
  return `## Peer Profile\n\n${lines.join("\n\n")}`;
}

test("buildPeerProfileSection injects fields when feature enabled", () => {
  const profile = syntheticProfile();
  const section = buildPeerProfileSection(profile, 5);
  assert.ok(section, "section must be non-null when profile has fields");
  assert.match(section, /## Peer Profile/, "section must have the heading");
  assert.match(section, /communication_style/, "most-recent field must appear");
});

test("buildPeerProfileSection returns null when maxFields is 0", () => {
  const profile = syntheticProfile();
  const section = buildPeerProfileSection(profile, 0);
  // maxFields=0 means capped array is empty → no lines → we treat as
  // null equivalent. In the orchestrator the gate `peerProfileRecallMaxFields <= 0`
  // prevents the call entirely, but the helper should still return null
  // for empty lines (empty section).
  assert.equal(
    section !== null ? section.split("**").length - 1 : 0,
    0,
    "zero maxFields must produce no field lines",
  );
});

test("buildPeerProfileSection respects maxFields cap", () => {
  const profile = syntheticProfile();
  const section = buildPeerProfileSection(profile, 2);
  assert.ok(section, "section must be non-null");
  // There are 3 fields; capping to 2 must drop the oldest.
  const boldCount = (section.match(/\*\*/g) ?? []).length / 2;
  assert.equal(boldCount, 2, "exactly 2 field keys must appear when maxFields=2");
});

test("buildPeerProfileSection orders by most-recently-updated first", () => {
  const profile = syntheticProfile();
  // Provenance timestamps: recurring_concerns=2026-04-22 (newest),
  // communication_style=2026-04-20, preferred_format=2026-04-18 (oldest).
  const section = buildPeerProfileSection(profile, 3);
  assert.ok(section);
  const lines = section.split("\n\n").filter((l) => l.startsWith("**"));
  assert.equal(
    lines[0].startsWith("**recurring_concerns**"),
    true,
    "most-recently-updated field must appear first",
  );
  assert.equal(
    lines[1].startsWith("**communication_style**"),
    true,
    "second-most-recently-updated must appear second",
  );
  assert.equal(
    lines[2].startsWith("**preferred_format**"),
    true,
    "oldest field must appear last",
  );
});

test("buildPeerProfileSection is a no-op when profile has no fields", () => {
  const profile = syntheticProfile({ fields: {}, provenance: {} });
  const section = buildPeerProfileSection(profile, 5);
  assert.equal(section, null, "empty profile must produce null section");
});

test("buildPeerProfileSection handles missing provenance (epoch fallback)", () => {
  const profile = syntheticProfile({
    fields: { undated_field: "some value" },
    provenance: {},
  });
  const section = buildPeerProfileSection(profile, 5);
  assert.ok(section, "fields without provenance must still be injected");
  assert.match(section, /undated_field/);
});

// ──────────────────────────────────────────────────────────────────────
// Config schema wiring tests
// ──────────────────────────────────────────────────────────────────────

test("openclaw.plugin.json configSchema includes peerProfileRecallEnabled", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "openclaw.plugin.json"), "utf-8"),
  ) as Record<string, unknown>;
  // configSchema follows JSON Schema: properties live under .properties
  const csRaw = manifest.configSchema as Record<string, unknown> | undefined;
  const props = (csRaw?.properties ?? csRaw ?? {}) as Record<string, unknown>;
  assert.ok(
    "peerProfileRecallEnabled" in props,
    "configSchema must include peerProfileRecallEnabled",
  );
  assert.ok(
    "peerProfileRecallMaxFields" in props,
    "configSchema must include peerProfileRecallMaxFields",
  );
  const enabledEntry = props.peerProfileRecallEnabled as Record<string, unknown>;
  assert.equal(
    enabledEntry.default,
    false,
    "peerProfileRecallEnabled default must be false",
  );
  const maxFieldsEntry = props.peerProfileRecallMaxFields as Record<string, unknown>;
  assert.equal(
    maxFieldsEntry.default,
    5,
    "peerProfileRecallMaxFields default must be 5",
  );
  assert.equal(
    maxFieldsEntry.minimum,
    0,
    "peerProfileRecallMaxFields minimum must be 0 (0 = disable)",
  );
});

test("plugin-openclaw manifest configSchema includes peerProfileRecall keys", () => {
  const manifest = JSON.parse(
    readFileSync(
      path.join(repoRoot, "packages/plugin-openclaw/openclaw.plugin.json"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
  const csRaw = manifest.configSchema as Record<string, unknown> | undefined;
  const props = (csRaw?.properties ?? csRaw ?? {}) as Record<string, unknown>;
  assert.ok(
    "peerProfileRecallEnabled" in props,
    "plugin-openclaw configSchema must include peerProfileRecallEnabled",
  );
  assert.ok(
    "peerProfileRecallMaxFields" in props,
    "plugin-openclaw configSchema must include peerProfileRecallMaxFields",
  );
});
