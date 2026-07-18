import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager, type PluginConfig } from "../index.js";
import { CompoundingEngine, type CompoundingPromotionReport } from "./engine.js";

/**
 * Issue #1645 — a tombstone-blocked promotion write lands pending_review (no
 * active copy). promoteCandidate must divert blocked ids to a distinct
 * `tombstoneBlocked` report field and NEVER report them as promoted — mirroring
 * the postWriteGuard consumption pattern in the orchestrator extraction path.
 *
 * The tombstone chokepoint currently gates on category === "fact", so a
 * rule/principle/preference promotion cannot be blocked by a real tombstone
 * today. The defensive consumption is still correct (the gate may widen), so
 * this test exercises the diversion logic with a storage double that returns
 * tombstoneBlocked: true — pinning the CALLER contract, not the gate.
 */
test("#1645: tombstone-blocked promotion is diverted, not reported as promoted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-compounding-"));
  try {
    const weekId = "2026-W27";
    const candidateContent = "Always write tests before shipping code.";
    await mkdir(path.join(dir, "compounding", "weekly"), { recursive: true });
    await writeFile(
      path.join(dir, "compounding", "weekly", `${weekId}.json`),
      JSON.stringify({
        version: 2,
        generatedAt: "2026-07-07T00:00:00Z",
        weekId,
        promotionCandidates: [
          {
            id: "cand-1",
            sourceType: "action-outcome",
            subject: "testing",
            category: "rule",
            content: candidateContent,
            score: 0.9,
            rationale: "high signal",
            outcome: null,
            provenance: [],
            agent: null,
            workflow: null,
          },
        ],
      }),
      "utf-8",
    );

    const config = {
      memoryDir: dir,
      workspaceDir: dir,
      compoundingEnabled: true,
      compoundingSemanticEnabled: true,
    } as unknown as PluginConfig;
    const engine = new CompoundingEngine(config, new StorageManager(dir));

    // Storage double: writeMemory reports tombstoneBlocked (simulating the
    // chokepoint downgrading the promotion to pending_review).
    let writeCallCount = 0;
    const blockedStorage = {
      dir,
      async readAllMemories() {
        return [];
      },
      async writeSealedMemory() {
        writeCallCount += 1;
        return { id: "blocked-promo-1", tombstoneBlocked: true, blockedBy: "tomb-1" };
      },
    } as unknown as StorageManager;

    const report: CompoundingPromotionReport = await engine.promoteCandidate({
      weekId,
      candidateId: "cand-1",
      storage: blockedStorage,
    });

    assert.equal(writeCallCount, 1, "the promotion write still happens (pending_review row)");
    assert.equal(report.promoted.length, 0, "blocked write must NOT appear in promoted");
    assert.equal(report.tombstoneBlocked.length, 1, "blocked write diverted to tombstoneBlocked");
    assert.equal(report.tombstoneBlocked[0]?.id, "blocked-promo-1");
    assert.equal(report.tombstoneBlocked[0]?.candidateId, "cand-1");
    assert.equal(report.tombstoneBlocked[0]?.content, candidateContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
