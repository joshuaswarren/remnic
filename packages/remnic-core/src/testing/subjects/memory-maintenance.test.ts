/**
 * Operator memory-maintenance subject for the scenario-matrix harness
 * (issue #3642).
 *
 * Every canonical row exercises the three maintenance surfaces that matched
 * the `maintenance/**` lifecycle glob but had no registered subject:
 *
 * - `forgetMemory` (maintenance/forget.ts): soft-deletes a fact memory —
 *   frontmatter status flip plus the live tombstone that blocks
 *   re-extraction resurrection.
 * - `ensureCronJob` (maintenance/memory-governance-cron.ts): idempotent
 *   registration of a governance job inside jobs.json, including the
 *   updateExisting merge path.
 * - `summarizeTiers` / `explainTierForMemory` (maintenance/tier-stats.ts):
 *   tier/status accounting over the same memories the forget mutated.
 *
 * Dimension mapping:
 * - remembered-binding rows pre-seed jobs.json with the job already
 *   registered under a stale schedule — the binding a restarted process
 *   would find on disk.
 * - the provider-rebinding row additionally drives `updateExisting` with a
 *   changed schedule and asserts the merge reports `updated: true`.
 * - the dedupe/replay row re-runs `ensureCronJob` and `forgetMemory` and
 *   asserts both are idempotent: no second job, an AlreadyForgotten
 *   rejection, and byte-identical jobs.json.
 * - the restart/reload row rebuilds the storage facade and re-parses
 *   jobs.json from disk — nothing may be lost across a process boundary.
 * - flush-transition rows keep the same contract: these surfaces are
 *   write-through (no buffered flush exists), so on-disk state must be
 *   complete and readable the moment each call resolves.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  forgetMemory,
  ForgetMemoryAlreadyForgottenError,
  type ForgetMemoryResult,
} from "../../maintenance/forget.js";
import { ensureCronJob } from "../../maintenance/memory-governance-cron.js";
import {
  explainTierForMemory,
  summarizeTiers,
  type TierExplainResult,
  type TierSummary,
} from "../../maintenance/tier-stats.js";
import type { StorageManager } from "../../storage.js";
import type { MemoryFile, MemoryFrontmatter, PluginConfig } from "../../types.js";
import { type LifecycleSubject, runLifecycleMatrix } from "../lifecycle-matrix.js";

const NOW = "2026-06-01T00:00:00.000Z";
const CRON_ID = "engram-subject-nightly";
const FORGET_ID = "fact-alpha";
const LEGACY_SCHEDULE = "0 2 * * *";
const CURRENT_SCHEDULE = "0 3 * * *";

interface EnsureResult {
  created: boolean;
  updated: boolean;
  jobId: string;
}

interface MaintenanceState {
  dir: string;
  jobsPath: string;
  hot: MemoryFile[];
  archived: MemoryFile[];
  cold: MemoryFile[];
  frontmatterWrites: Array<{ id: string; patch: Partial<MemoryFrontmatter> }>;
  tombstones: unknown[];
  ensureFirst: EnsureResult | null;
  ensureReplay: EnsureResult | null;
  forgetResult: ForgetMemoryResult | null;
  summary: TierSummary | null;
  reloadedJobs: string | null;
  reloadedSummary: TierSummary | null;
  explain: TierExplainResult | null;
  jobsJsonAfterFirst: string | null;
}

function makeMemory(id: string, overrides: Partial<MemoryFrontmatter> = {}): MemoryFile {
  // SAFETY: the fixture literal fills exactly the fields the maintenance
  // paths read; MemoryFrontmatter carries optional slots the fixture omits.
  return {
    path: `/virtual/${id}.md`,
    content: `synthetic body for ${id}`,
    frontmatter: {
      id,
      category: "preference",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      ...overrides,
    } as MemoryFrontmatter,
  };
}

function makeStorage(state: MaintenanceState): StorageManager {
  const stub: Partial<StorageManager> = {
    readAllMemories: async () => state.hot,
    readArchivedMemories: async () => state.archived,
    readAllColdMemories: async () => state.cold,
    writeMemoryFrontmatter: async (memory, patch) => {
      Object.assign(memory.frontmatter, patch);
      state.frontmatterWrites.push({ id: memory.frontmatter.id, patch });
      return true;
    },
    appendTombstone: async (input) => {
      state.tombstones.push(input);
      return "stub-tombstone";
    },
  };
  // SAFETY: the test double exposes only the StorageManager methods the three
  // maintenance surfaces call; a full StorageManager needs a real memory dir.
  return stub as StorageManager;
}

function makeConfig(memoryDir: string): PluginConfig {
  const config: Partial<PluginConfig> = {
    memoryDir,
    qmdTierMigrationEnabled: true,
    qmdTierDemotionMinAgeDays: 14,
    qmdTierDemotionValueThreshold: 0.35,
    qmdTierPromotionValueThreshold: 0.7,
    memoryUtilityLearningEnabled: false,
    promotionByOutcomeEnabled: false,
    lifecyclePolicyEnabled: false,
    lifecycleStaleDecayThreshold: 0,
    lifecyclePromoteHeatThreshold: 0,
  };
  // SAFETY: same reduced-config shape tier-stats.test.ts uses; the learning
  // flags stay off so explainTierForMemory takes the null-runtime path.
  return config as PluginConfig;
}

function buildJob() {
  return {
    id: CRON_ID,
    schedule: CURRENT_SCHEDULE,
    enabled: true,
    payload: { kind: "nightly-governance" },
  };
}

async function readJobIds(jobsPath: string): Promise<string[]> {
  // SAFETY: jobs.json is written by this fixture's own ensureCronJob calls;
  // the {jobs:[{id}]} shape is the file contract exercised under test.
  const parsed = JSON.parse(await readFile(jobsPath, "utf8")) as { jobs: Array<{ id?: unknown }> };
  return parsed.jobs.map((job) => String(job.id));
}

const subject: LifecycleSubject<MaintenanceState> = {
  async setup(row) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-maintenance-"));
    const jobsPath = path.join(dir, "jobs.json");
    try {
      // remembered-binding rows model an earlier process having already
      // registered the job under a stale schedule.
      const seeded = row.dimensions.rememberedBinding
        ? { jobs: [{ ...buildJob(), schedule: LEGACY_SCHEDULE }] }
        : { jobs: [] };
      await writeFile(jobsPath, JSON.stringify(seeded, null, 2) + "\n", "utf8");
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return {
      dir,
      jobsPath,
      hot: [
        makeMemory(FORGET_ID, {
          category: "fact",
          status: "active",
          contentHash: "hash-fact-alpha",
        }),
        makeMemory("pref-beta", { status: "active" }),
      ],
      archived: [],
      cold: [makeMemory("cold-gamma", { status: "archived" })],
      frontmatterWrites: [],
      tombstones: [],
      ensureFirst: null,
      ensureReplay: null,
      forgetResult: null,
      summary: null,
      reloadedJobs: null,
      reloadedSummary: null,
      explain: null,
      jobsJsonAfterFirst: null,
    };
  },

  async exercise(state, row) {
    const storage = makeStorage(state);
    const rebound = row.dimensions.providerIdentity === "rebound";
    const options = rebound
      ? { updateExisting: true, updateFields: ["schedule", "payload"] }
      : {};

    state.ensureFirst = await ensureCronJob(state.jobsPath, CRON_ID, buildJob, options);
    state.forgetResult = await forgetMemory(storage, {
      id: FORGET_ID,
      reason: "matrix forget",
      now: () => new Date(NOW),
    });
    state.summary = await summarizeTiers(storage);
    state.explain = await explainTierForMemory(storage, FORGET_ID, makeConfig(state.dir));

    if (row.dimensions.dedupeOrReplay) {
      state.jobsJsonAfterFirst = await readFile(state.jobsPath, "utf8");
      state.ensureReplay = await ensureCronJob(state.jobsPath, CRON_ID, buildJob, options);
      await assert.rejects(
        forgetMemory(storage, { id: FORGET_ID, now: () => new Date(NOW) }),
        ForgetMemoryAlreadyForgottenError,
      );
    }

    if (row.dimensions.restart) {
      // A restarted process sees only what is on disk: re-parse jobs.json and
      // rebuild the storage facade over the same persisted memory records.
      state.reloadedJobs = await readFile(state.jobsPath, "utf8");
      state.reloadedSummary = await summarizeTiers(makeStorage(state));
    }
  },

  async invariants(state, row) {
    const seeded = row.dimensions.rememberedBinding;
    const rebound = row.dimensions.providerIdentity === "rebound";

    const first = state.ensureFirst;
    assert.ok(first, "ensureCronJob returned a result");
    assert.equal(first.jobId, CRON_ID);
    assert.equal(first.created, !seeded, "job is created only when no binding was seeded");
    assert.equal(first.updated, rebound, "only the rebinding row rewrites the seeded job");

    const jobIds = await readJobIds(state.jobsPath);
    assert.deepEqual(jobIds, [CRON_ID], "jobs.json holds exactly one registration");

    const forget = state.forgetResult;
    assert.ok(forget, "forgetMemory returned a result");
    assert.equal(forget.id, FORGET_ID);
    assert.equal(forget.priorStatus, "active");
    assert.equal(forget.forgottenAt, NOW);
    assert.equal(forget.reason, "matrix forget");

    const forgotten = state.hot.find((m) => m.frontmatter.id === FORGET_ID);
    assert.equal(forgotten?.frontmatter.status, "forgotten");
    assert.equal(forgotten?.frontmatter.forgottenAt, NOW);
    assert.equal(forgotten?.frontmatter.forgottenReason, "matrix forget");
    assert.ok(state.tombstones.length >= 1, "fact forget emits a live tombstone");

    const summary = state.summary;
    assert.ok(summary, "summarizeTiers returned a summary");
    assert.equal(summary.total, 3);
    assert.equal(summary.byTier.hot, 2);
    assert.equal(summary.byTier.cold, 1);
    assert.equal(summary.byStatus.forgotten, 1);
    assert.equal(summary.forgottenCount, 1);

    const explain = state.explain;
    assert.ok(explain, "explainTierForMemory returned a result");
    assert.equal(explain.id, FORGET_ID);
    assert.equal(explain.currentTier, "hot");
    assert.equal(explain.status, "forgotten");
    assert.ok(Number.isFinite(explain.valueScore), "value score computed");
    assert.ok(explain.decision, "tier transition decision present");

    if (row.dimensions.dedupeOrReplay) {
      const replay = state.ensureReplay;
      assert.ok(replay, "replay ensureCronJob returned a result");
      assert.equal(replay.created, false, "replay must not create a second job");
      assert.equal(replay.updated, false, "replay with identical spec must not rewrite");
      const jobsJsonNow = await readFile(state.jobsPath, "utf8");
      assert.equal(jobsJsonNow, state.jobsJsonAfterFirst, "replay leaves jobs.json byte-identical");
    }

    if (row.dimensions.restart) {
      // SAFETY: reloadedJobs was read from a jobs.json produced by this
      // fixture's ensureCronJob call in the same row.
      const parsed = JSON.parse(state.reloadedJobs ?? "") as { jobs: Array<{ id?: unknown }> };
      assert.deepEqual(parsed.jobs.map((job) => String(job.id)), [CRON_ID]);
      assert.equal(state.reloadedSummary?.forgottenCount, 1, "forgotten status survives a reload");
    }
  },

  async teardown(state) {
    await rm(state.dir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("memory-maintenance", subject);
