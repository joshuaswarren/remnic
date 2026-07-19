/**
 * Extraction / turn-ingestion lifecycle subject for the scenario-matrix harness
 * (issue #1993, PR2). This is the #1852 surface — the highest-churn stateful
 * area — retrofitted as the reference `LifecycleSubject`. Every row drives the
 * REAL `Orchestrator` (recall / processTurn / flushSession / restart) with only
 * the LLM extraction client stubbed at the established field seam; storage,
 * buffering, dedupe, namespace routing, and the before_reset abort wiring are
 * all exercised for real.
 *
 * Falsifiable by design (acceptance #1993): the `before-reset` row asserts the
 * abort-before-clear guard in extraction-run.ts (`throwIfAborted
 * ("before_clear_buffer")`) — inverting that guard fails THIS row and only this
 * row, because it is the only row that fires an abort mid-extraction.
 */

import assert from "node:assert/strict";
import path from "node:path";

import { Orchestrator } from "../../orchestrator.js";
import { resolveNamespaceStorageRoot } from "../../namespaces/storage.js";
import type { BufferTurn, PluginConfig } from "../../types.js";
import {
  cleanupDir,
  makeLifecycleConfig,
  markdownFilesUnder,
  memoryFilesContaining,
  mkTempMemoryDir,
  seedFactFile,
  singleFactResult,
  stubExtraction,
} from "../orchestrator-lite.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  type MatrixRowId,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

interface ExtractionLifecycleState {
  memoryDir: string;
  cfg: PluginConfig;
  /** Every orchestrator built for the row; teardown destroys all of them. */
  orchestrators: Orchestrator[];
  /** The primary orchestrator's recorded extraction calls. */
  calls: BufferTurn[][];
  /** Second-instance drain calls (restart row). */
  restartCalls?: BufferTurn[][];
  /** Re-flush calls after an aborted before_reset flush (before-reset row). */
  secondFlushCalls?: BufferTurn[][];
  /** Extraction-call count captured right before the dedupe row's force flush. */
  callsBeforeForceFlush?: number;
}

/** Namespaces-on config with alice/bob principal prefix routing (identity rows). */
function namespacedConfig(memoryDir: string): PluginConfig {
  return makeLifecycleConfig(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [
      { match: "alice:", principal: "alice" },
      { match: "bob:", principal: "bob" },
    ],
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
      { name: "bob", readPrincipals: ["bob"], writePrincipals: ["bob"] },
    ],
  });
}

/**
 * A sparse, opaque session id remembered (bound) to alice from a PRIOR session.
 * The key does not encode alice; only the remembered map binding resolves it to
 * her namespace — so the with-binding row exercises the binding, not prefix
 * routing (review finding: a `alice:*` key resolves to alice regardless).
 */
const REMEMBERED_SESSION = "restored-session-9f2a";

/** Map-mode config where {@link REMEMBERED_SESSION} is bound to alice. */
function rememberedBindingConfig(memoryDir: string): PluginConfig {
  return makeLifecycleConfig(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "map",
    principalFromSessionKeyRules: [{ match: REMEMBERED_SESSION, principal: "alice" }],
    namespacePolicies: [{ name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
  });
}

const NAMESPACE_ROWS: Partial<Record<MatrixRowId, true>> = {
  "explicit-provider-identity": true,
  "sparse-metadata-with-binding": true,
  "sparse-metadata-without-binding": true,
  "provider-rebinding": true,
};

const subject: LifecycleSubject<ExtractionLifecycleState> = {
  async setup(row: MatrixRow): Promise<ExtractionLifecycleState> {
    const memoryDir = await mkTempMemoryDir(`extraction-${row.id}`);
    const cfg =
      row.id === "sparse-metadata-with-binding"
        ? rememberedBindingConfig(memoryDir)
        : NAMESPACE_ROWS[row.id]
          ? namespacedConfig(memoryDir)
          : row.id === "dedupe-replay"
            ? makeLifecycleConfig(memoryDir, {
                extractionDedupeEnabled: true,
                extractionDedupeWindowMs: 60_000,
              })
            : makeLifecycleConfig(memoryDir);
    const primary = new Orchestrator(cfg);
    const calls = stubExtraction(primary, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );
    return { memoryDir, cfg, orchestrators: [primary], calls };
  },

  async exercise(state: ExtractionLifecycleState, row: MatrixRow): Promise<void> {
    const primary = state.orchestrators[0];
    switch (row.id) {
      case "explicit-provider-identity": {
        await primary.processTurn(
          "user",
          "Please remember: alice uses the teal dashboard theme for staging telemetry.",
          "alice:chat",
        );
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "sparse-metadata-with-binding": {
        // A binding remembered on disk from a prior session (the namespace root)
        // is reused by a fresh sparse session — no explicit provider metadata
        // on the turn, yet recall resolves through the same remembered binding.
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        await seedFactFile(aliceRoot, "remembered-binding", "alice pins deploys to the us-east-2 region.");
        return;
      }
      case "sparse-metadata-without-binding": {
        // Sparse session, nothing remembered — recall must not fabricate a
        // binding or leave phantom writes behind.
        await primary.recall("Which region does alice pin deploys to?", "alice:chat");
        return;
      }
      case "provider-rebinding": {
        await primary.processTurn(
          "user",
          "Please remember: alice uses the teal dashboard theme for staging telemetry.",
          "alice:chat",
        );
        await primary.processTurn(
          "user",
          "Please remember: bob files quarterly billing reconciliation in the ledger spreadsheet.",
          "bob:chat",
        );
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "restart-reload-recovery": {
        await primary.processTurn(
          "user",
          "Please remember: the failover drill rehearses the read-replica promotion path.",
          "session-flushed",
        );
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        // Park a second session's turn WITHOUT flushing, then restart.
        await primary.processTurn(
          "user",
          "The quota reconciler defers negative balances to manual review.",
          "session-parked",
        );
        await primary.destroy();
        state.orchestrators.length = 0;

        const second = new Orchestrator(makeLifecycleConfig(state.memoryDir));
        state.orchestrators.push(second);
        state.restartCalls = stubExtraction(second, (turns) =>
          singleFactResult(turns.map((turn) => turn.content).join(" | ")),
        );
        // Drain the buffer that survived the restart (state/buffer.json).
        await second.flushSession("session-parked", { reason: "session_end" });
        return;
      }
      case "compaction-flush": {
        await primary.processTurn("user", "The deploy train departs at nine on Tuesdays.", "session-compact");
        await primary.processTurn("assistant", "Noted the Tuesday deploy train departure.", "session-compact");
        await primary.flushSession("session-compact", { reason: "compaction" });
        const before = state.calls.length;
        await primary.flushSession("session-compact", { reason: "compaction" });
        assert.equal(state.calls.length, before, "compacted buffer must not re-extract on a second flush");
        return;
      }
      case "before-reset": {
        // Buffer a low-signal turn, then fire a before_reset flush whose abort
        // trips mid-extraction. The abort wiring (the signal threaded from
        // flushSession into runExtraction, guarding `before_persist` and
        // `before_clear_buffer`) must abort BEFORE the buffer is cleared, so a
        // timed-out reset cannot drop turns. Falsifiable (acceptance #1993):
        // dropping the abortSignal threading fails THIS row and only this row.
        await primary.processTurn("user", "The replay ledger checkpoint compacts after five hundred entries.", "session-reset");
        const controller = new AbortController();
        // Rewire the seam: extraction succeeds but trips the abort mid-flight.
        stubExtraction(primary, (turns) => {
          controller.abort();
          return singleFactResult(turns.map((turn) => turn.content).join(" | "));
        });
        await primary
          .flushSession("session-reset", { reason: "before_reset", abortSignal: controller.signal })
          .catch(() => undefined);

        // A fresh, non-aborted flush must find the turn still buffered.
        state.secondFlushCalls = stubExtraction(primary, (turns) =>
          singleFactResult(turns.map((turn) => turn.content).join(" | ")),
        );
        await primary.flushSession("session-reset", { reason: "before_reset" }).catch(() => undefined);
        return;
      }
      case "session-end": {
        await primary.processTurn("user", "The nightly compaction sweep runs after the backup snapshot.", "session-end");
        await primary.flushSession("session-end", { reason: "session_end" });
        return;
      }
      case "dedupe-replay": {
        const content = "Please remember: the canary gate requires two green smoke runs.";
        await primary.processTurn("user", content, "session-dedupe");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        // An identical turn re-triggers but is suppressed inside the window.
        await primary.processTurn("user", content, "session-dedupe");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        // Record the count BEFORE the force flush: the in-window duplicate must
        // already be suppressed, so exactly one extraction has happened so far.
        state.callsBeforeForceFlush = state.calls.length;
        // Force-flush bypasses the dedupe fingerprint (skipDedupeCheck).
        await primary.flushSession("session-dedupe", { reason: "before_reset" });
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async invariants(state: ExtractionLifecycleState, row: MatrixRow): Promise<void> {
    const primary = state.orchestrators[0];
    switch (row.id) {
      case "explicit-provider-identity": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        assert.equal(state.calls.length, 1, "the explicit identity's turn extracts exactly once");
        assert.equal((await memoryFilesContaining(aliceRoot, "teal dashboard theme")).length, 1);
        assert.equal(
          (await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length,
          0,
          "an identity-routed write must not land in the default root",
        );
        const context = await primary.recall("Which dashboard theme is used for staging telemetry?", "alice:chat");
        assert.match(context, /teal dashboard theme/i);
        return;
      }
      case "sparse-metadata-with-binding": {
        const context = await primary.recall("Which region does alice pin deploys to?", REMEMBERED_SESSION);
        assert.match(
          context,
          /us-east-2/i,
          "a sparse session key that does not encode alice recalls her memory ONLY through the remembered binding",
        );
        return;
      }
      case "sparse-metadata-without-binding": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        const context = await primary.recall("Which region does alice pin deploys to?", "alice:chat");
        assert.doesNotMatch(context, /us-east-2/i, "no binding was remembered — recall must not fabricate one");
        assert.equal(
          (await markdownFilesUnder(aliceRoot)).length,
          0,
          "a recall with no binding must not create phantom memory files",
        );
        return;
      }
      case "provider-rebinding": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        const bobRoot = await resolveNamespaceStorageRoot(state.cfg, "bob");
        assert.equal((await memoryFilesContaining(aliceRoot, "teal dashboard theme")).length, 1);
        assert.equal((await memoryFilesContaining(bobRoot, "ledger spreadsheet")).length, 1);
        assert.equal((await memoryFilesContaining(aliceRoot, "ledger spreadsheet")).length, 0);
        const aliceContext = await primary.recall("Which dashboard theme is used for staging telemetry?", "alice:chat");
        assert.doesNotMatch(aliceContext, /ledger spreadsheet/i, "a rebind must not leak the prior identity's memory");
        return;
      }
      case "restart-reload-recovery": {
        const second = state.orchestrators[0];
        assert.ok(state.restartCalls, "the restarted instance must have a recorded drain");
        assert.equal(state.restartCalls.length, 1, "the new instance flushes the buffer parked before restart");
        assert.deepEqual(state.restartCalls[0]?.map((turn) => turn.content), [
          "The quota reconciler defers negative balances to manual review.",
        ]);
        const context = await second.recall("How does the failover drill handle read-replica promotion?", "reader");
        assert.match(context, /read-replica promotion/i, "prior persisted memory survives the restart");
        assert.equal(
          (await memoryFilesContaining(path.join(state.memoryDir, "facts"), "quota reconciler")).length,
          1,
          "the parked buffer's turn persists after the restart drain",
        );
        return;
      }
      case "compaction-flush": {
        assert.equal(state.calls.length, 1, "the flush compacts the buffered turns into one extraction");
        assert.deepEqual(state.calls[0]?.map((turn) => turn.content), [
          "The deploy train departs at nine on Tuesdays.",
          "Noted the Tuesday deploy train departure.",
        ]);
        assert.equal(
          (await memoryFilesContaining(path.join(state.memoryDir, "facts"), "deploy train departs")).length,
          1,
        );
        return;
      }
      case "before-reset": {
        assert.ok(state.secondFlushCalls, "a re-flush must have been recorded");
        assert.equal(
          state.secondFlushCalls.length,
          1,
          "a timed-out before_reset must NOT clear the buffer — the re-flush re-extracts the preserved turn",
        );
        assert.deepEqual(state.secondFlushCalls[0]?.map((turn) => turn.content), [
          "The replay ledger checkpoint compacts after five hundred entries.",
        ]);
        return;
      }
      case "session-end": {
        assert.equal(state.calls.length, 1, "session_end drains the buffer like before_reset");
        assert.equal(
          (await memoryFilesContaining(path.join(state.memoryDir, "facts"), "nightly compaction sweep")).length,
          1,
        );
        return;
      }
      case "dedupe-replay": {
        assert.equal(
          state.callsBeforeForceFlush,
          1,
          "the in-window duplicate must be suppressed — exactly one extraction before the force flush",
        );
        assert.equal(state.calls.length, 2, "the force flush bypasses the dedupe fingerprint and re-extracts");
        assert.match(
          (state.calls[1] ?? []).map((turn) => turn.content).join(" "),
          /canary gate/,
          "the second extraction is the force-flushed duplicate, not a no-op",
        );
        return;
      }
      default: {
        const exhaustive: never = row.id;
        throw new Error(`unhandled row ${String(exhaustive)}`);
      }
    }
  },

  async teardown(state: ExtractionLifecycleState): Promise<void> {
    for (const orchestrator of state.orchestrators) {
      await orchestrator.destroy().catch(() => undefined);
    }
    await cleanupDir(state.memoryDir);
  },
};

runLifecycleMatrix("extraction-lifecycle", subject);
