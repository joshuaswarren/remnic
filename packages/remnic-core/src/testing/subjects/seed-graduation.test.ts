/**
 * Seed-graduation subject for the scenario-matrix harness.
 *
 * Every canonical row runs the real graduation pass twice: once gated off
 * (the shipped default, which must touch storage zero times) and once enabled
 * with independent corroboration present. The scenario dimensions are
 * orthogonal to the gate, so the same promote/hold invariant holds per row.
 */
import assert from "node:assert/strict";

import {
  SEED_GRADUATION_DEFAULTS,
  runSeedGraduationPass,
  type SeedGraduationStorage,
} from "../../lifecycle/seed-graduation.js";
import type { MemoryFile, MemoryFrontmatter } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";

const SEED_TEXT = "The launch moved to September twelfth after the vendor call.";
const RESTATE_TEXT = "Launch moved to September twelfth after the vendor call.";

interface PromotionCall {
  id: string;
  attributeUpdates: Record<string, string>;
}

interface SeedGraduationState {
  memories: MemoryFile[];
  calls: PromotionCall[];
  storage: SeedGraduationStorage;
}

function memory(overrides: {
  id: string;
  content: string;
  created: string;
  status?: MemoryFrontmatter["status"];
  sessionKey: string;
}): MemoryFile {
  return {
    path: `facts/${overrides.id}.md`,
    content: overrides.content,
    frontmatter: {
      id: overrides.id,
      category: "fact",
      created: overrides.created,
      updated: overrides.created,
      source: "extraction",
      confidence: 0.7,
      confidenceTier: "inferred",
      tags: [],
      status: overrides.status,
      structuredAttributes: { sessionKey: overrides.sessionKey },
    },
  };
}

const subject: LifecycleSubject<SeedGraduationState> = {
  async setup(row: MatrixRow): Promise<SeedGraduationState> {
    const calls: PromotionCall[] = [];
    const memories = [
      memory({
        id: `seed-${row.id}`,
        content: SEED_TEXT,
        created: "2026-08-01T10:00:00.000Z",
        status: "pending_review",
        sessionKey: `session-seed-${row.id}`,
      }),
      memory({
        id: `evidence-a-${row.id}`,
        content: RESTATE_TEXT,
        created: "2026-08-02T10:00:00.000Z",
        sessionKey: `session-a-${row.id}`,
      }),
      memory({
        id: `evidence-b-${row.id}`,
        content: RESTATE_TEXT,
        created: "2026-08-03T10:00:00.000Z",
        sessionKey: `session-b-${row.id}`,
      }),
    ];
    return {
      memories,
      calls,
      storage: {
        async promoteWearableMemory(id, attributeUpdates): Promise<boolean> {
          calls.push({ id, attributeUpdates });
          return true;
        },
      },
    };
  },

  async exercise(state): Promise<void> {
    // Gate off (shipped default): no evaluation, no storage contact at all.
    const off = await runSeedGraduationPass({
      memories: state.memories,
      storage: state.storage,
      config: SEED_GRADUATION_DEFAULTS,
    });
    assert.equal(off.disabled, true);
    assert.equal(off.promoted, 0);
    assert.equal(state.calls.length, 0);

    // Enabled with two independent corroborations: the seed graduates.
    const on = await runSeedGraduationPass({
      memories: state.memories,
      storage: state.storage,
      config: { enabled: true, minCorroborations: 2 },
    });
    assert.equal(on.disabled, false);
    assert.equal(on.promoted, 1);
  },

  async invariants(state): Promise<void> {
    assert.equal(state.calls.length, 1);
    const call = state.calls[0];
    assert.ok(call?.id.startsWith("seed-"));
    assert.equal(call?.attributeUpdates.graduatedBy, "independent-corroboration");
    assert.equal(call?.attributeUpdates.corroborationCount, "2");
  },

  async teardown(): Promise<void> {
    // Pure in-memory corpus and fake storage — nothing durable to clean up.
  },
};

runLifecycleMatrix("seed-graduation", subject);
