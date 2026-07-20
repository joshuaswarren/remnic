/**
 * Recall-budget contract lifecycle subject for the scenario-matrix harness
 * (issue #2067, umbrella #1988). The recall-output budgeting subsystem
 * (orchestration/recall-section-coordinator.ts, fed by config.ts
 * buildRecallPipelineConfig and consumed through retrieval / recall-qos /
 * recall-mmr) is the contract that keeps injected memory context inside a
 * bounded character budget derived from `maxMemoryTokens`. A regression there
 * silently over- or under-injects context, so the matrix guards it directly.
 *
 * The nine rows are realized honestly against the coordinator's REAL behavior —
 * no mocks. Config is built through the production `parseConfig` path so the
 * budget derivation (recallBudgetChars = maxMemoryTokens * 4), section
 * enablement filtering, per-section maxChars caps, and cap-after-filter
 * ordering are all exercised as they ship. Each row asserts one recall-budget
 * contract invariant:
 *   - explicit-provider-identity : budget cap honored AFTER section filtering
 *   - sparse-metadata-with-binding: section sum ≤ maxMemoryTokens-derived budget
 *   - sparse-metadata-without-binding: a gated (disabled) fallback never injects
 *   - provider-rebinding         : minimal-mode budget override caps retrieval
 *   - restart-reload-recovery    : budget assembly is stable across restart
 *   - compaction-flush           : truncation respects the per-section budget
 *   - before-reset               : oversized sections are capped, not overrun
 *   - session-end                : a zero limit produces an empty injection
 *   - dedupe-replay              : assembly is idempotent; protected section kept
 */

import assert from "node:assert/strict";

import { parseConfig } from "../../config.js";
import { RecallSectionCoordinator } from "../../orchestration/recall-section-coordinator.js";
import { formatRecallSectionMetric } from "../../recall-qos.js";
import { reorderRecallResultsWithMmr } from "../../recall-mmr.js";
import { expandQuery } from "../../retrieval.js";
import type { PluginConfig, RecallSectionConfig } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";

/**
 * The budget-capped assembly result the coordinator produces. Declared here
 * (not via `ReturnType<...>`) so the subject couples to a named contract, not
 * to the coordinator method's implementation signature.
 */
interface AssembledSections {
  sections: string[];
  includedIds: string[];
  omittedIds: string[];
  truncated: boolean;
  finalChars: number;
}

interface RecallBudgetState {
  /** Mutable so the restart / rebinding rows can swap in a fresh config. */
  config: PluginConfig;
  coordinator: RecallSectionCoordinator;
  buckets: Map<string, string[]>;
  /** Assembly output captured in `exercise`, asserted in `invariants`. */
  assembled?: AssembledSections;
  /** Second assembly for the idempotency row. */
  assembledReplay?: AssembledSections;
  /** appendRecallSection return values, keyed by section id (gating row). */
  appendReturns: Map<string, boolean>;
}

/** Build a real PluginConfig through the production parse path. */
function buildConfig(overrides: {
  maxMemoryTokens?: number;
  recallBudgetChars?: number;
  recallPipeline?: RecallSectionConfig[];
}): PluginConfig {
  return parseConfig({ openaiApiKey: "sk-test", ...overrides });
}

/** A body of `chars` deterministic non-whitespace characters. */
function body(label: string, chars: number): string {
  const seed = `[${label}] `;
  if (chars <= seed.length) return "x".repeat(chars);
  return seed + "x".repeat(chars - seed.length);
}

/** The separator the coordinator inserts between assembled sections. */
const SECTION_SEPARATOR = "\n\n---\n\n";

/** Total character length of an assembled section list including separators. */
function assembledCharLength(sections: readonly string[]): number {
  if (sections.length === 0) return 0;
  const content = sections.reduce((sum, s) => sum + s.length, 0);
  return content + SECTION_SEPARATOR.length * (sections.length - 1);
}

function makeCoordinator(state: { config: PluginConfig }): RecallSectionCoordinator {
  return new RecallSectionCoordinator({ getConfig: () => state.config });
}

const subject: LifecycleSubject<RecallBudgetState> = {
  async setup(row: MatrixRow): Promise<RecallBudgetState> {
    // Per-row config: each row pins the exact budget dimension it probes so the
    // assertion is unambiguous.
    let config: PluginConfig;
    switch (row.id) {
      case "sparse-metadata-with-binding":
        // No explicit recallBudgetChars — force the maxMemoryTokens derivation.
        config = buildConfig({
          maxMemoryTokens: 40,
          recallPipeline: [
            { id: "profile", enabled: true },
            { id: "memories", enabled: true },
            { id: "recent", enabled: true },
          ],
        });
        break;
      case "session-end":
        config = buildConfig({
          maxMemoryTokens: 0,
          recallBudgetChars: 0,
          recallPipeline: [
            { id: "memories", enabled: true },
            { id: "capped", enabled: true, maxChars: 0 },
          ],
        });
        break;
      case "sparse-metadata-without-binding":
        config = buildConfig({
          recallBudgetChars: 4000,
          recallPipeline: [
            { id: "memories", enabled: true },
            // The fallback section is disabled — a no-recall-style gate.
            { id: "peer-profile", enabled: false },
          ],
        });
        break;
      case "compaction-flush":
        config = buildConfig({
          recallBudgetChars: 4000,
          recallPipeline: [{ id: "memories", enabled: true, maxChars: 30 }],
        });
        break;
      default:
        config = buildConfig({
          recallBudgetChars: 400,
          recallPipeline: [
            { id: "profile", enabled: true },
            { id: "memories", enabled: true },
            { id: "recent", enabled: true },
            { id: "disabled-section", enabled: false },
          ],
        });
    }
    const state: RecallBudgetState = {
      config,
      coordinator: makeCoordinator({ config } as { config: PluginConfig }),
      buckets: new Map(),
      appendReturns: new Map(),
    };
    // Rebind the coordinator's getter to the state so mutable config swaps
    // (restart / rebinding rows) are honored.
    state.coordinator = new RecallSectionCoordinator({ getConfig: () => state.config });
    return state;
  },

  async exercise(state: RecallBudgetState, row: MatrixRow): Promise<void> {
    const { coordinator, buckets, appendReturns } = state;
    switch (row.id) {
      case "explicit-provider-identity": {
        // Fill enabled + disabled sections; the disabled one must be filtered
        // out before the budget cap is applied.
        appendReturns.set("profile", coordinator.appendRecallSection(buckets, "profile", body("profile", 80)));
        appendReturns.set("memories", coordinator.appendRecallSection(buckets, "memories", body("memories", 80)));
        appendReturns.set(
          "disabled-section",
          coordinator.appendRecallSection(buckets, "disabled-section", body("disabled", 80)),
        );
        state.assembled = coordinator.assembleRecallSections(buckets);
        return;
      }
      case "sparse-metadata-with-binding": {
        // Content far exceeds the derived budget so the cap must bite.
        coordinator.appendRecallSection(buckets, "profile", body("profile", 300));
        coordinator.appendRecallSection(buckets, "memories", body("memories", 300));
        coordinator.appendRecallSection(buckets, "recent", body("recent", 300));
        state.assembled = coordinator.assembleRecallSections(buckets);
        return;
      }
      case "sparse-metadata-without-binding": {
        appendReturns.set("memories", coordinator.appendRecallSection(buckets, "memories", body("memories", 120)));
        appendReturns.set(
          "peer-profile",
          coordinator.appendRecallSection(buckets, "peer-profile", body("fallback", 120)),
        );
        state.assembled = coordinator.assembleRecallSections(buckets);
        return;
      }
      case "provider-rebinding": {
        coordinator.appendRecallSection(buckets, "profile", body("profile", 150));
        coordinator.appendRecallSection(buckets, "memories", body("memories", 150));
        coordinator.appendRecallSection(buckets, "recent", body("recent", 150));
        // Full budget first, then a minimal-mode override that caps retrieval.
        state.assembled = coordinator.assembleRecallSections(buckets);
        state.assembledReplay = coordinator.assembleRecallSections(buckets, 120);
        return;
      }
      case "restart-reload-recovery": {
        coordinator.appendRecallSection(buckets, "profile", body("profile", 120));
        coordinator.appendRecallSection(buckets, "memories", body("memories", 120));
        state.assembled = coordinator.assembleRecallSections(buckets);
        // Simulate a restart: a fresh coordinator over the same live config.
        state.coordinator = new RecallSectionCoordinator({ getConfig: () => state.config });
        state.assembledReplay = state.coordinator.assembleRecallSections(buckets);
        return;
      }
      case "compaction-flush": {
        appendReturns.set("memories", coordinator.appendRecallSection(buckets, "memories", body("memories", 500)));
        state.assembled = coordinator.assembleRecallSections(buckets);
        return;
      }
      case "before-reset": {
        // Every section is individually larger than the whole budget.
        coordinator.appendRecallSection(buckets, "profile", body("profile", 600));
        coordinator.appendRecallSection(buckets, "memories", body("memories", 600));
        coordinator.appendRecallSection(buckets, "recent", body("recent", 600));
        state.assembled = coordinator.assembleRecallSections(buckets);
        return;
      }
      case "session-end": {
        // Content enters the bucket; the zero budget must then drop it entirely.
        appendReturns.set("memories", coordinator.appendRecallSection(buckets, "memories", body("memories", 200)));
        // A maxChars:0 section refuses injection at append time.
        appendReturns.set("capped", coordinator.appendRecallSection(buckets, "capped", body("capped", 200)));
        // Assemble with an explicit zero-limit override.
        state.assembled = coordinator.assembleRecallSections(buckets, 0);
        return;
      }
      case "dedupe-replay": {
        // A genuine recall replay: run the full inject-then-assemble path
        // twice over independent buckets and assert the second run reproduces
        // the first exactly. This exercises the real replay flow (re-injecting
        // the same recall), not merely re-calling a pure function on one Map.
        const inject = (target: Map<string, string[]>): void => {
          coordinator.appendRecallSection(target, "memories", body("memories", 120));
          coordinator.appendRecallSection(target, "recent", body("recent", 400));
        };
        inject(buckets);
        state.assembled = coordinator.assembleRecallSections(buckets);
        const replayBuckets = new Map<string, string[]>();
        inject(replayBuckets);
        state.assembledReplay = coordinator.assembleRecallSections(replayBuckets);
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async invariants(state: RecallBudgetState, row: MatrixRow): Promise<void> {
    const { coordinator, config } = state;
    const assembled = state.assembled;
    assert.ok(assembled, "exercise must produce an assembly");
    const budget = coordinator.getRecallBudgetChars();

    switch (row.id) {
      case "explicit-provider-identity": {
        // The disabled section is filtered out; the cap is honored on the rest.
        assert.equal(state.appendReturns.get("disabled-section"), false, "a disabled section must not inject");
        assert.ok(!assembled.includedIds.includes("disabled-section"), "disabled section absent from assembly");
        assert.deepEqual(assembled.includedIds, ["profile", "memories"], "only enabled, non-empty sections assemble");
        assert.ok(assembled.finalChars <= budget, "assembled chars stay within the budget cap");
        assert.equal(assembled.finalChars, assembledCharLength(assembled.sections), "finalChars accounts for separators");
        return;
      }
      case "sparse-metadata-with-binding": {
        // Budget is derived from maxMemoryTokens (recallBudgetChars = tokens*4).
        assert.equal(config.recallBudgetChars, config.maxMemoryTokens * 4, "budget derives from maxMemoryTokens");
        assert.equal(budget, config.maxMemoryTokens * 4, "coordinator honors the token-derived budget");
        assert.ok(assembled.finalChars <= budget, "section sum stays within the token-derived budget");
        assert.ok(assembled.truncated, "oversized content forces truncation");
        return;
      }
      case "sparse-metadata-without-binding": {
        // The gated fallback never injects — nothing fabricates its content.
        assert.equal(state.appendReturns.get("peer-profile"), false, "a gated fallback section is refused");
        assert.equal(state.appendReturns.get("memories"), true, "the bound section still injects");
        assert.ok(!assembled.includedIds.includes("peer-profile"), "gated fallback absent from assembly");
        assert.deepEqual(assembled.includedIds, ["memories"], "only the resolvable section assembles");
        return;
      }
      case "provider-rebinding": {
        const minimal = state.assembledReplay;
        assert.ok(minimal, "minimal-mode assembly must exist");
        assert.ok(minimal.finalChars <= 120, "minimal-mode override caps the assembled chars");
        assert.ok(minimal.finalChars < assembled.finalChars, "minimal mode injects strictly less than full mode");
        assert.ok(minimal.includedIds.length <= assembled.includedIds.length, "minimal mode retrieves no more sections");
        assert.ok(minimal.omittedIds.length >= 1, "the tighter budget omits at least one section");
        // The sibling recall stages carry their own budget contracts. MMR's
        // topN prioritizes a diverse head WITHOUT dropping recall content (no
        // silent drops), and query expansion caps the derived query count.
        const pool = Array.from({ length: 8 }, (_v, i) => ({ path: `p${i}`, snippet: `snippet ${i}`, score: 1 - i / 10 }));
        const reordered = reorderRecallResultsWithMmr(pool, { topN: 3 });
        assert.equal(reordered.reordered.length, pool.length, "MMR reorders without dropping any candidate");
        assert.deepEqual(
          [...reordered.reordered.map((r) => r.path)].sort(),
          pool.map((r) => r.path).sort(),
          "every recalled candidate survives the MMR reorder",
        );
        assert.equal(reordered.diversity.considered, pool.length, "MMR considers the full pool");
        const expanded = expandQuery("budget aware recall pipeline section caps", { maxQueries: 3, minTokenLen: 3 });
        assert.ok(expanded.length <= 3, "query expansion caps the number of derived queries");
        assert.equal(expanded[0], "budget aware recall pipeline section caps", "the original query is always retained first");
        return;
      }
      case "restart-reload-recovery": {
        const afterRestart = state.assembledReplay;
        assert.ok(afterRestart, "post-restart assembly must exist");
        assert.deepEqual(afterRestart, assembled, "assembly is identical after a restart over the same config");
        assert.ok(afterRestart.finalChars <= budget, "post-restart chars stay within budget");
        return;
      }
      case "compaction-flush": {
        // The per-section maxChars cap truncates the appended content.
        const perSectionCap = coordinator.getRecallSectionMaxChars("memories");
        assert.equal(perSectionCap, 30, "the per-section cap is resolved from config");
        const chunks = state.buckets.get("memories");
        assert.ok(chunks && chunks.length === 1, "the section holds one truncated chunk");
        const chunk = chunks![0]!;
        assert.ok(chunk.includes("...(trimmed)"), "the per-section truncation marker is present");
        // The chunk is exactly the first `perSectionCap` chars of the original
        // content followed by the trim marker — proving where the cut landed,
        // not merely that a re-slice has the cap length.
        const original = body("memories", 500);
        assert.equal(chunk, `${original.slice(0, perSectionCap!)}\n\n...(trimmed)\n`, "content is cut at the per-section budget, then marked");
        assert.ok(chunk.length < original.length, "the truncated chunk is shorter than the original content");
        // truncateRecallSectionToBudget respects a hard per-section budget too.
        const truncated = coordinator.truncateRecallSectionToBudget(body("m", 200), 50);
        assert.equal(truncated.length, 50, "budget-aware truncation lands exactly on the per-section limit");
        // A budget-skipped section reports as a debug-level "skip" metric — the
        // QoS accounting that flags a section dropped for the budget deadline.
        const skipMetric = formatRecallSectionMetric({
          section: "memories",
          priority: "enrichment",
          durationMs: 0,
          deadlineMs: 50,
          source: "skip",
          success: false,
        });
        assert.equal(skipMetric.timing, "skip", "a skipped section is timed as 'skip'");
        assert.equal(skipMetric.level, "debug", "a skipped enrichment section logs at debug level");
        return;
      }
      case "before-reset": {
        // Cap-after-filter: every section is oversized, so the assembly is
        // truncated and later sections are omitted, never overrunning budget.
        assert.ok(assembled.finalChars <= budget, "oversized sections never overrun the budget");
        assert.ok(assembled.truncated, "oversized assembly is marked truncated");
        assert.ok(assembled.omittedIds.length >= 1, "sections past the budget are omitted");
        assert.equal(assembled.finalChars, assembledCharLength(assembled.sections), "finalChars is accurate under pressure");
        return;
      }
      case "session-end": {
        // A zero limit produces an empty injection — no partial context.
        assert.equal(budget, 0, "the budget is zero");
        assert.deepEqual(assembled.sections, [], "zero budget injects no sections");
        assert.deepEqual(assembled.includedIds, [], "zero budget includes nothing");
        assert.equal(assembled.finalChars, 0, "zero budget yields zero chars");
        assert.ok(assembled.truncated, "dropping present content marks the assembly truncated");
        assert.equal(state.appendReturns.get("memories"), true, "content-bearing section injects before assembly");
        assert.equal(state.appendReturns.get("capped"), false, "a maxChars:0 section refuses injection");
        return;
      }
      case "dedupe-replay": {
        const replay = state.assembledReplay;
        assert.ok(replay, "replayed assembly must exist");
        assert.deepEqual(replay, assembled, "a re-injected recall replay reproduces the assembly exactly");
        // "memories" is protected — retained even though "recent" overflows.
        assert.ok(assembled.includedIds.includes("memories"), "the protected memories section is always kept");
        assert.ok(assembled.finalChars <= budget, "protected assembly still respects the budget");
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async teardown(): Promise<void> {
    // Pure in-memory subject — no external state to release.
  },
};

runLifecycleMatrix("recall-budget", subject);
