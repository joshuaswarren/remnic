
import assert from "node:assert/strict";

import { parseConfig } from "../../config.js";
import { RecallSectionCoordinator } from "../../orchestration/recall-section-coordinator.js";
import { estimateTokenCount } from "../../token-estimate.js";
import { createRecallSectionMetricRecorder, formatRecallSectionMetric } from "../../recall-qos.js";
import { reorderRecallResultsWithMmr } from "../../recall-mmr.js";
import { applyRuntimeRetrievalPolicy, expandQuery } from "../../retrieval.js";
import type { PluginConfig, RecallSectionConfig } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";

interface AssembledSections {
  sections: string[];
  includedIds: string[];
  omittedIds: string[];
  truncated: boolean;
  finalChars: number;
}

interface RecallBudgetState {
  config: PluginConfig;
  coordinator: RecallSectionCoordinator;
  buckets: Map<string, string[]>;
  assembled?: AssembledSections;
  assembledReplay?: AssembledSections;
  assembledAfterReplayAppend?: AssembledSections;
  appendReturns: Map<string, boolean>;
}

function buildConfig(overrides: {
  maxMemoryTokens?: number;
  recallBudgetChars?: number;
  recallPipeline?: RecallSectionConfig[];
}): PluginConfig {
  return parseConfig({ openaiApiKey: "sk-test", ...overrides });
}

function body(label: string, chars: number): string {
  const seed = `[${label}] `;
  if (chars <= seed.length) return "x".repeat(chars);
  return seed + "x".repeat(chars - seed.length);
}

/** The separator the coordinator inserts between assembled sections. */
const SECTION_SEPARATOR = "\n\n---\n\n";

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
    let config: PluginConfig;
    switch (row.id) {
      case "sparse-metadata-with-binding":
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
            { id: "memories", enabled: true, maxResults: 7 },
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
    state.coordinator = new RecallSectionCoordinator({ getConfig: () => state.config });
    return state;
  },

  async exercise(state: RecallBudgetState, row: MatrixRow): Promise<void> {
    const { coordinator, buckets, appendReturns } = state;
    switch (row.id) {
      case "explicit-provider-identity": {
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
        state.assembled = coordinator.assembleRecallSections(buckets);
        state.assembledReplay = coordinator.assembleRecallSections(buckets, 120);
        return;
      }
      case "restart-reload-recovery": {
        coordinator.appendRecallSection(buckets, "profile", body("profile", 120));
        coordinator.appendRecallSection(buckets, "memories", body("memories", 120));
        state.assembled = coordinator.assembleRecallSections(buckets);
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
        coordinator.appendRecallSection(buckets, "profile", body("profile", 600));
        coordinator.appendRecallSection(buckets, "memories", body("memories", 600));
        coordinator.appendRecallSection(buckets, "recent", body("recent", 600));
        state.assembled = coordinator.assembleRecallSections(buckets);
        return;
      }
      case "session-end": {
        appendReturns.set("memories", coordinator.appendRecallSection(buckets, "memories", body("memories", 200)));
        appendReturns.set("capped", coordinator.appendRecallSection(buckets, "capped", body("capped", 200)));
        state.assembled = coordinator.assembleRecallSections(buckets, 0);
        return;
      }
      case "dedupe-replay": {
        const inject = (target: Map<string, string[]>): void => {
          coordinator.appendRecallSection(target, "memories", body("memories", 120));
          coordinator.appendRecallSection(target, "recent", body("recent", 400));
        };
        inject(buckets);
        state.assembled = coordinator.assembleRecallSections(buckets);
        const replayBuckets = new Map<string, string[]>();
        inject(replayBuckets);
        state.assembledReplay = coordinator.assembleRecallSections(replayBuckets);
        coordinator.appendRecallSection(buckets, "memories", body("memories", 120));
        state.assembledAfterReplayAppend = coordinator.assembleRecallSections(buckets);
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
        assert.equal(state.appendReturns.get("disabled-section"), false, "a disabled section must not inject");
        assert.ok(!assembled.includedIds.includes("disabled-section"), "disabled section absent from assembly");
        assert.deepEqual(assembled.includedIds, ["profile", "memories"], "only enabled, non-empty sections assemble");
        assert.ok(assembled.finalChars <= budget, "assembled chars stay within the budget cap");
        assert.equal(assembled.finalChars, assembledCharLength(assembled.sections), "finalChars accounts for separators");
        const summary = coordinator.buildLastRecallBudgetSummary({
          requestedTopK: 5,
          recallResultLimit: assembled.includedIds.length,
          qmdFetchLimit: 10,
          qmdHybridFetchLimit: 4,
          finalContextChars: assembled.finalChars,
          truncated: assembled.truncated,
          includedSections: assembled.includedIds,
          omittedSections: assembled.omittedIds,
        });
        assert.equal(summary.recallBudgetChars, budget, "budget summary reports the resolved char budget");
        assert.equal(summary.maxMemoryTokens, config.maxMemoryTokens, "budget summary reports maxMemoryTokens");
        assert.equal(summary.appliedTopK, assembled.includedIds.length, "budget summary reports the applied topK");
        assert.deepEqual(summary.includedSections, assembled.includedIds, "budget summary lists the included sections");
        const sources = coordinator.collectLastRecallSources(state.buckets, "hot_qmd");
        assert.ok(sources.includes("hot_qmd"), "the recall source is recorded");
        assert.ok(sources.includes("memories"), "a populated section id is recorded as a source");
        return;
      }
      case "sparse-metadata-with-binding": {
        assert.equal(config.recallBudgetChars, config.maxMemoryTokens * 4, "budget derives from maxMemoryTokens");
        assert.ok(budget <= config.maxMemoryTokens * 4, "coordinator honors the character budget");
        assert.ok(assembled.finalChars <= budget, "section sum stays within the character budget");
        assert.ok(assembled.truncated, "oversized content forces truncation");
        return;
      }
      case "sparse-metadata-without-binding": {
        assert.equal(state.appendReturns.get("peer-profile"), false, "a gated fallback section is refused");
        assert.equal(state.appendReturns.get("memories"), true, "the bound section still injects");
        assert.ok(!assembled.includedIds.includes("peer-profile"), "gated fallback absent from assembly");
        assert.deepEqual(assembled.includedIds, ["memories"], "only the resolvable section assembles");
        assert.equal(coordinator.getRecallSectionNumber("memories", "maxResults"), 7, "a per-section numeric budget is read from config");
        assert.equal(coordinator.getRecallSectionNumber("memories", "maxTurns"), undefined, "an unset per-section field is undefined");
        assert.equal(coordinator.isSpecializedRecallSectionEnabled("peer-profile", true), false, "a disabled section stays off even when its subsystem is enabled");
        assert.equal(coordinator.isSpecializedRecallSectionEnabled("memories", false), true, "an explicitly-enabled section overrides a disabled subsystem default");
        return;
      }
      case "provider-rebinding": {
        const minimal = state.assembledReplay;
        assert.ok(minimal, "minimal-mode assembly must exist");
        assert.ok(minimal.finalChars <= 120, "minimal-mode override caps the assembled chars");
        assert.ok(minimal.finalChars < assembled.finalChars, "minimal mode injects strictly less than full mode");
        assert.ok(minimal.includedIds.length <= assembled.includedIds.length, "minimal mode retrieves no more sections");
        assert.ok(minimal.omittedIds.length >= 1, "the tighter budget omits at least one section");
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
        assert.equal(applyRuntimeRetrievalPolicy({ recencyWeight: 0.4 }, { recencyWeight: 5 }).recencyWeight, 1, "an over-range runtime recency weight is clamped to 1");
        assert.equal(applyRuntimeRetrievalPolicy({ recencyWeight: 0.4 }, { recencyWeight: -5 }).recencyWeight, 0, "an under-range runtime recency weight is clamped to 0");
        assert.equal(applyRuntimeRetrievalPolicy({ recencyWeight: 0.4 }, null).recencyWeight, 0.4, "no runtime override falls back to the base recency weight");
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
        const perSectionCap = coordinator.getRecallSectionMaxChars("memories");
        assert.equal(perSectionCap, 30, "the per-section cap is resolved from config");
        const chunks = state.buckets.get("memories");
        assert.ok(chunks && chunks.length === 1, "the section holds one truncated chunk");
        const chunk = chunks![0]!;
        assert.ok(chunk.includes("...(trimmed)"), "the per-section truncation marker is present");
        const original = body("memories", 500);
        assert.equal(chunk, `${original.slice(0, perSectionCap!)}\n\n...(trimmed)\n`, "content is cut at the per-section budget, then marked");
        assert.ok(chunk.length < original.length, "the truncated chunk is shorter than the original content");
        const truncated = coordinator.truncateRecallSectionToBudget(body("m", 200), 50);
        assert.equal(truncated.length, 50, "budget-aware truncation lands exactly on the per-section limit");
        const tokenTrimmed = coordinator.truncateRecallSectionToBudget("x".repeat(200), 200, 20);
        assert.match(tokenTrimmed, /\.\.\.\(memory context trimmed\)$/);
        assert.ok(estimateTokenCount(tokenTrimmed) <= 20, "token-aware truncation keeps its marker inside the cap");
        const markerBudget = estimateTokenCount("\n\n...(memory context trimmed)");
        const markerOnlyBudget = coordinator.truncateRecallSectionToBudget("日本語".repeat(100), 200, markerBudget);
        assert.ok(markerOnlyBudget.length > 0, "a marker-only budget keeps useful content");
        assert.doesNotMatch(markerOnlyBudget, /\.\.\.\(memory context trimmed\)$/);
        assert.ok(estimateTokenCount(markerOnlyBudget) <= markerBudget);
        const wideScriptTrimmed = coordinator.truncateRecallSectionToBudget("日".repeat(100), 30, markerBudget);
        assert.equal([...wideScriptTrimmed].length, 8, "wide-script fallback uses the available character room");
        assert.ok(estimateTokenCount(wideScriptTrimmed) <= markerBudget);
        assert.doesNotMatch(wideScriptTrimmed, /\.\.\.\(memory context trimmed\)$/);
        const emojiTrimmed = coordinator.truncateRecallSectionToBudget("😀".repeat(30), 60, 29);
        assert.ok(emojiTrimmed.length <= 60, "astral text stays within the UTF-16 character cap");
        assert.ok(estimateTokenCount(emojiTrimmed) <= 29, "astral text stays within the token cap");
        assert.match(emojiTrimmed, /\.\.\.\(memory context trimmed\)$/);
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
        const timings: Record<string, string> = {};
        const infoLogs: string[] = [];
        const record = createRecallSectionMetricRecorder({
          timings,
          logger: { info: (m: string) => infoLogs.push(m), debug: () => {} },
        });
        const coreEntry = record({
          section: "memories",
          priority: "core",
          durationMs: 12,
          deadlineMs: 100,
          source: "fresh",
          success: true,
        });
        assert.equal(timings.memories, coreEntry.timing, "the recorder writes the section timing into the timings map");
        assert.equal(coreEntry.level, "info", "a successful core section records at info level");
        assert.equal(infoLogs.length, 1, "the info-level metric is routed to the info logger");
        return;
      }
      case "before-reset": {
        assert.ok(assembled.finalChars <= budget, "oversized sections never overrun the budget");
        assert.ok(assembled.truncated, "oversized assembly is marked truncated");
        assert.ok(assembled.omittedIds.length >= 1, "sections past the budget are omitted");
        assert.ok(assembled.includedIds.includes("memories"), "the protected memories section survives budget pressure");
        assert.ok(!assembled.omittedIds.includes("memories"), "the protected memories section is never omitted under pressure");
        assert.equal(assembled.finalChars, assembledCharLength(assembled.sections), "finalChars is accurate under pressure");
        return;
      }
      case "session-end": {
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
        assert.ok(assembled.includedIds.includes("memories"), "the protected memories section is always kept");
        assert.ok(assembled.finalChars <= budget, "protected assembly still respects the budget");
        assert.equal(state.buckets.get("memories")?.length, 2, "a replayed append is not coalesced by the coordinator");
        const afterReplay = state.assembledAfterReplayAppend;
        assert.ok(afterReplay, "post-replay-append assembly must exist");
        assert.ok(afterReplay.finalChars <= budget, "a replayed injection cannot overrun the budget");
        assert.ok(afterReplay.includedIds.includes("memories"), "the protected section survives a replayed injection");
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
