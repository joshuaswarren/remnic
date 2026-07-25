/**
 * Regression tests for issue #686: cold QMD remains opt-in.
 *
 * Default recall skips the cold collection, does not re-query hot QMD, and
 * uses the query-aware fallback. Opting in queries the cold collection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { QmdSearchResult } from "../src/types.js";

interface ColdAuditState {
  coldQmdCalls: number;
  queryAwareFallbackCalls: number;
  hotPrimaryCalls: number;
  observedCollections: (string | undefined)[];
}

async function buildAuditedOrchestrator(opts: {
  memoryDir: string;
  workspaceDir: string;
  qmdColdTierEnabled?: boolean;
}): Promise<{ orchestrator: any; state: ColdAuditState }> {
  const cfgInput: Record<string, unknown> = {
    openaiApiKey: "sk-test",
    memoryDir: opts.memoryDir,
    workspaceDir: opts.workspaceDir,
    qmdEnabled: true,
    qmdMaxResults: 4,
    qmdCollection: "engram-hot",
    qmdColdCollection: "engram-cold",
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: true,
  };
  if (opts.qmdColdTierEnabled !== undefined) {
    cfgInput.qmdColdTierEnabled = opts.qmdColdTierEnabled;
  }
  const config = parseConfig(cfgInput);
  const orchestrator = new Orchestrator(config) as any;

  const state: ColdAuditState = {
    coldQmdCalls: 0,
    queryAwareFallbackCalls: 0,
    hotPrimaryCalls: 0,
    observedCollections: [],
  };

  // Stub QMD adapter so any direct call is recorded.
  orchestrator.qmd = {
    isAvailable: () => true,
    search: async (_query: string, collection?: string) => {
      state.observedCollections.push(collection);
      if (collection === "engram-cold") {
        state.coldQmdCalls += 1;
      } else if (collection === undefined || collection === "engram-hot") {
        state.hotPrimaryCalls += 1;
      }
      return [] as QmdSearchResult[];
    },
    hybridSearch: async (_query: string, collection?: string) => {
      state.observedCollections.push(collection);
      // Mirror the hot/cold counter logic in `search` so a hot-tier
      // hybrid query from inside applyColdFallbackPipeline still trips
      // the `hotPrimaryCalls === 0` assertion. (Codex review on PR #693.)
      if (collection === "engram-cold") {
        state.coldQmdCalls += 1;
      } else if (collection === undefined || collection === "engram-hot") {
        state.hotPrimaryCalls += 1;
      }
      return [] as QmdSearchResult[];
    },
  };

  // Stub the namespace-aware hot path so we can observe it without depending
  // on a live qmd binary or actual filesystem fixtures.
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async (
    _prompt: string,
    _qmdFetchLimit: number,
    _qmdHybridFetchLimit: number,
    o: { collection?: string },
  ): Promise<QmdSearchResult[]> => {
    state.observedCollections.push(o.collection);
    if (o.collection === "engram-cold") {
      state.coldQmdCalls += 1;
    } else {
      state.hotPrimaryCalls += 1;
    }
    return [];
  };

  // Stub query-aware fallback so the default cold path remains observable.
  orchestrator.searchQueryAwareFallback = async (): Promise<
    QmdSearchResult[]
  > => {
    state.queryAwareFallbackCalls += 1;
    return [];
  };

  return { orchestrator, state };
}

test("parseConfig: qmdColdTierEnabled defaults to false (cold tier opt-in)", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(
    cfg.qmdColdTierEnabled,
    false,
    "Default qmdColdTierEnabled must be false; cold tier is opt-in",
  );
});

test("applyColdFallbackPipeline: cold QMD collection NOT queried under default config", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-default-excluded-"),
  );
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-default-excluded-ws-"),
  );

  try {
    const { orchestrator, state } = await buildAuditedOrchestrator({
      memoryDir,
      workspaceDir,
      // qmdColdTierEnabled left unset → defaults to false.
    });

    // Under default config the cold-QMD branch is skipped; the query-aware
    // fallback is the only source consulted and returns empty per our stub.
    const results: QmdSearchResult[] = await orchestrator.applyColdFallbackPipeline(
      {
        prompt: "any query",
        recallNamespaces: ["default"],
        recallResultLimit: 4,
        recallMode: "full",
      },
    );

    assert.equal(results.length, 0);
    assert.equal(
      state.coldQmdCalls,
      0,
      "cold QMD collection must not be queried when qmdColdTierEnabled=false",
    );
    assert.equal(
      state.queryAwareFallbackCalls,
      1,
      "query-aware fallback should run once when cold-QMD is disabled",
    );
    // applyColdFallbackPipeline must not silently fall back to a hot-tier
    // QMD query when cold tier is disabled — that would defeat the purpose
    // of gating the fallback. (Codex review on PR #693.)
    assert.equal(
      state.hotPrimaryCalls,
      0,
      "hot QMD must not be re-queried from inside applyColdFallbackPipeline when cold is disabled; query-aware fallback is the only allowed fallback source",
    );
    assert.ok(
      !state.observedCollections.includes("engram-cold"),
      `cold collection must not appear in observed collections, got: ${JSON.stringify(state.observedCollections)}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("applyColdFallbackPipeline: cold QMD IS queried when explicitly opted in", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-optin-"),
  );
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-optin-ws-"),
  );

  try {
    const { orchestrator, state } = await buildAuditedOrchestrator({
      memoryDir,
      workspaceDir,
      qmdColdTierEnabled: true,
    });

    await orchestrator.applyColdFallbackPipeline({
      prompt: "any query",
      recallNamespaces: ["default"],
      recallResultLimit: 4,
      recallMode: "full",
    });

    assert.equal(
      state.coldQmdCalls,
      1,
      "cold QMD collection MUST be queried when qmdColdTierEnabled=true",
    );
    assert.ok(
      state.observedCollections.includes("engram-cold"),
      `cold collection should appear in observed collections, got: ${JSON.stringify(state.observedCollections)}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
