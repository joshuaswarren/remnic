
import assert from "node:assert/strict";
import path from "node:path";

import { Orchestrator } from "../../orchestrator.js";
import { BufferDrainRunner } from "../../orchestration/buffer-drain-runner.js";
import { resolveNamespaceStorageRoot } from "../../namespaces/storage.js";
import type { BufferTurn, PluginConfig } from "../../types.js";
import {
  cleanupDir,
  harmonicNodeStoreStatus,
  makeHarmonicLifecycleConfig,
  markdownFilesUnder,
  memoryFilesContaining,
  mkTempMemoryDir,
  seedFactFile,
  singleFactResult,
  stubExtraction,
} from "../orchestrator-lite.js";
import { type LifecycleSubject, type MatrixRow, type MatrixRowId, runLifecycleMatrix } from "../lifecycle-matrix.js";

interface ExtractionLifecycleState {
  memoryDir: string;
  cfg: PluginConfig;
  orchestrators: Orchestrator[];
  calls: BufferTurn[][];
  restartCalls?: BufferTurn[][];
  secondFlushCalls?: BufferTurn[][];
  abortFlushCalls?: BufferTurn[][];
  abortFlushRejected?: boolean;
  abortedWriteCount?: number;
  recoveredFactCount?: number;
  factCountAfterExtraFlush?: number;
  callsBeforeForceFlush?: number;
}

function namespacedConfig(memoryDir: string): PluginConfig {
  return makeHarmonicLifecycleConfig(memoryDir, {
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
    extraction: { spanMode: "on" },
  });
}

const REMEMBERED_SESSION = "restored-session-9f2a";

const UNBOUND_SESSION = "unbound-session-0000";

function rememberedBindingConfig(memoryDir: string): PluginConfig {
  return makeHarmonicLifecycleConfig(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    principalFromSessionKeyMode: "map",
    principalFromSessionKeyRules: [{ match: REMEMBERED_SESSION, principal: "alice" }],
    namespacePolicies: [{ name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    extraction: { spanMode: "on" },
  });
}

const NAMESPACE_ROWS: Partial<Record<MatrixRowId, true>> = {
  "explicit-provider-identity": true,
  "sparse-metadata-with-binding": true,
  "provider-rebinding": true,
};

function spanBearingResult(turns: BufferTurn[]) {
  const result = singleFactResult(turns.map((turn) => turn.content).join(" | "));
  const first = turns[0]?.content ?? "";
  const fact = result.facts[0];
  if (fact === undefined) return result;
  fact.span = {
    sourceMessageIndex: 0,
    charStart: 0,
    charEnd: first.length,
    frame: "Lifecycle probe",
  };
  return result;
}

async function assertHarmonicEpisode(memoryDir: string, sessionKey?: string): Promise<void> {
  const status = await harmonicNodeStoreStatus(memoryDir);
  assert.equal(status.nodes.invalid, 0, "harmonic persistence must write only valid abstraction nodes");
  assert.ok(status.nodes.valid > 0, "harmonic persistence must write an abstraction node");
  assert.ok((status.nodes.byKind.episode ?? 0) > 0, "harmonic persistence must write an episode node");
  assert.ok(
    (status.latestNode?.sourceMemoryIds?.length ?? 0) > 0,
    "the persisted episode must retain its source memory ids"
  );
  if (sessionKey) assert.equal(status.latestNode?.sessionKey, sessionKey);
}


async function exerciseBufferDrain(state: ExtractionLifecycleState): Promise<void> {
  const memoryDir = await mkTempMemoryDir("extraction-drain-row");
  const cfg = makeHarmonicLifecycleConfig(memoryDir, { extraction: { spanMode: "on" } });
  const orchestrator = new Orchestrator(cfg);
  state.orchestrators.push(orchestrator);
  stubExtraction(orchestrator, (turns) => spanBearingResult(turns));
  const sessionKey = "drain-row-session";
  const content = "The drain row retains the canary gate detail for the teal dashboard.";
  await orchestrator.buffer.addTurn(sessionKey, {
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    sessionKey,
  });
  await orchestrator.buffer.save();
  const runner = new BufferDrainRunner(orchestrator);
  assert.equal(await runner.claim(sessionKey, "subject-drain"), true, "the drain claims the buffered session");
  const outcome = await runner.drainSession(sessionKey, { ownerId: "subject-drain" });
  assert.equal(outcome.status, "drained", "the drain empties the claimed session");
  assert.equal(outcome.turnsRemaining, 0, "no turn is left claimed");
}

const subject: LifecycleSubject<ExtractionLifecycleState> = {
  async setup(row: MatrixRow): Promise<ExtractionLifecycleState> {
    const memoryDir = await mkTempMemoryDir(`extraction-${row.id}`);
    let primary: Orchestrator | undefined;
    try {
      const cfg =
        row.id === "sparse-metadata-with-binding" || row.id === "sparse-metadata-without-binding"
          ? rememberedBindingConfig(memoryDir)
          : NAMESPACE_ROWS[row.id]
            ? namespacedConfig(memoryDir)
            : row.id === "dedupe-replay"
              ? makeHarmonicLifecycleConfig(memoryDir, {
                  extractionDedupeEnabled: true,
                  extractionDedupeWindowMs: 60_000,
                  extraction: { spanMode: "on" },
                })
              : makeHarmonicLifecycleConfig(memoryDir, { extraction: { spanMode: "on" } });
      primary = new Orchestrator(cfg);
      const calls = stubExtraction(primary, (turns) => spanBearingResult(turns));
      return { memoryDir, cfg, orchestrators: [primary], calls };
    } catch (err) {
      await primary?.destroy().catch(() => undefined);
      await cleanupDir(memoryDir);
      throw err;
    }
  },

  async exercise(state: ExtractionLifecycleState, row: MatrixRow): Promise<void> {
    const primary = state.orchestrators[0];
    switch (row.id) {
      case "explicit-provider-identity": {
        await primary.processTurn(
          "user",
          "Please remember: alice uses the teal dashboard theme for staging telemetry.",
          "alice:chat"
        );
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "sparse-metadata-with-binding": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        await seedFactFile(aliceRoot, "remembered-binding", "alice pins deploys to the us-east-2 region.");
        await primary.processTurn(
          "user",
          "The harmonic lifecycle probe is retained for this sparse session.",
          REMEMBERED_SESSION
        );
        await primary.flushSession(REMEMBERED_SESSION, { reason: "before_reset" });
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "sparse-metadata-without-binding": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        await seedFactFile(aliceRoot, "unbound", "alice pins deploys to the us-east-2 region.");
        await primary.processTurn(
          "user",
          "The harmonic lifecycle probe is retained for this unbound session.",
          UNBOUND_SESSION
        );
        await primary.flushSession(UNBOUND_SESSION, { reason: "before_reset" });
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "provider-rebinding": {
        await primary.processTurn(
          "user",
          "Please remember: alice uses the teal dashboard theme for staging telemetry.",
          "alice:chat"
        );
        await primary.processTurn(
          "user",
          "Please remember: bob files quarterly billing reconciliation in the ledger spreadsheet.",
          "bob:chat"
        );
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        return;
      }
      case "restart-reload-recovery": {
        await primary.processTurn(
          "user",
          "Please remember: the failover drill rehearses the read-replica promotion path.",
          "session-flushed"
        );
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        await primary.processTurn(
          "user",
          "The quota reconciler defers negative balances to manual review.",
          "session-parked"
        );
        await primary.destroy();
        state.orchestrators.length = 0;
        const second = new Orchestrator(makeHarmonicLifecycleConfig(state.memoryDir, { extraction: { spanMode: "on" } }));
        state.orchestrators.push(second);
        state.restartCalls = stubExtraction(second, (turns) => spanBearingResult(turns));
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
        await exerciseBufferDrain(state);
        await primary.processTurn(
          "user",
          "The replay ledger checkpoint compacts after five hundred entries.",
          "session-reset"
        );
        const controller = new AbortController();
        state.abortFlushCalls = stubExtraction(primary, (turns) => {
          controller.abort();
          return spanBearingResult(turns);
        });
        let abortRejected = false;
        await primary
          .flushSession("session-reset", { reason: "before_reset", abortSignal: controller.signal })
          .catch(() => {
            abortRejected = true;
          });
        state.abortFlushRejected = abortRejected;

        state.abortedWriteCount = (await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length;

        state.secondFlushCalls = stubExtraction(primary, (turns) => spanBearingResult(turns));
        await primary.flushSession("session-reset", { reason: "before_reset" });
        state.recoveredFactCount = (
          await memoryFilesContaining(path.join(state.memoryDir, "facts"), "replay ledger checkpoint")
        ).length;
        await primary.flushSession("session-reset", { reason: "before_reset" });
        state.factCountAfterExtraFlush = (
          await memoryFilesContaining(path.join(state.memoryDir, "facts"), "replay ledger checkpoint")
        ).length;
        return;
      }
      case "session-end": {
        await primary.processTurn(
          "user",
          "The nightly compaction sweep runs after the backup snapshot.",
          "session-end"
        );
        await primary.flushSession("session-end", { reason: "session_end" });
        return;
      }
      case "dedupe-replay": {
        const content = "Please remember: the canary gate requires two green smoke runs.";
        await primary.processTurn("user", content, "session-dedupe");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        await primary.processTurn("user", content, "session-dedupe");
        assert.equal(await primary.waitForExtractionIdle(15_000), true);
        state.callsBeforeForceFlush = state.calls.length;
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
    assert.equal(state.cfg.harmonicRetrievalEnabled, true, "every lifecycle row enables harmonic persistence");
    switch (row.id) {
      case "explicit-provider-identity": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        assert.equal(state.calls.length, 1, "the explicit identity's turn extracts exactly once");
        assert.equal((await memoryFilesContaining(aliceRoot, "teal dashboard theme")).length, 1);
        assert.equal(
          (await markdownFilesUnder(path.join(state.memoryDir, "facts"))).length,
          0,
          "an identity-routed write must not land in the default root"
        );
        const context = await primary.recall("Which dashboard theme is used for staging telemetry?", "alice:chat");
        assert.match(context, /teal dashboard theme/i);
        await assertHarmonicEpisode(aliceRoot);
        return;
      }
      case "sparse-metadata-with-binding": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        const context = await primary.recall("Which region does alice pin deploys to?", REMEMBERED_SESSION);
        assert.match(
          context,
          /us-east-2/i,
          "a sparse session key that does not encode alice recalls her memory ONLY through the remembered binding"
        );
        await assertHarmonicEpisode(aliceRoot);
        return;
      }
      case "sparse-metadata-without-binding": {
        const aliceRoot = await resolveNamespaceStorageRoot(state.cfg, "alice");
        const seededFiles = (await markdownFilesUnder(aliceRoot)).length;
        const context = await primary.recall("Which region does alice pin deploys to?", UNBOUND_SESSION);
        assert.doesNotMatch(
          context,
          /us-east-2/i,
          "an unbound sparse session must NOT reach alice's memory — no binding may be fabricated"
        );
        assert.equal(
          (await markdownFilesUnder(aliceRoot)).length,
          seededFiles,
          "a recall with no binding must not create phantom memory files"
        );
        await assertHarmonicEpisode(state.memoryDir);
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
        await assertHarmonicEpisode(aliceRoot);
        await assertHarmonicEpisode(bobRoot);
        return;
      }
      case "restart-reload-recovery": {
        const second = state.orchestrators[0];
        assert.ok(state.restartCalls, "the restarted instance must have a recorded drain");
        assert.equal(state.restartCalls.length, 1, "the new instance flushes the buffer parked before restart");
        assert.deepEqual(
          state.restartCalls[0]?.map((turn) => turn.content),
          ["The quota reconciler defers negative balances to manual review."]
        );
        const context = await second.recall("How does the failover drill handle read-replica promotion?", "reader");
        assert.match(context, /read-replica promotion/i, "prior persisted memory survives the restart");
        assert.equal(
          (await memoryFilesContaining(path.join(state.memoryDir, "facts"), "quota reconciler")).length,
          1,
          "the parked buffer's turn persists after the restart drain"
        );
        await assertHarmonicEpisode(state.memoryDir);
        return;
      }
      case "compaction-flush": {
        assert.equal(state.calls.length, 1, "the flush compacts the buffered turns into one extraction");
        assert.deepEqual(
          state.calls[0]?.map((turn) => turn.content),
          ["The deploy train departs at nine on Tuesdays.", "Noted the Tuesday deploy train departure."]
        );
        assert.equal(
          (await memoryFilesContaining(path.join(state.memoryDir, "facts"), "deploy train departs")).length,
          1
        );
        await assertHarmonicEpisode(state.memoryDir);
        return;
      }
      case "before-reset": {
        await exerciseBufferDrain(state);
        assert.equal(
          state.abortFlushRejected,
          true,
          "the aborted before_reset flush must reject — the abort tripped mid-flush, not a silent success"
        );
        assert.ok(state.abortFlushCalls, "the aborting flush's extraction calls must be recorded");
        assert.equal(
          state.abortFlushCalls.length,
          1,
          "the abort must trip AFTER exactly one extraction attempt — a reject before extraction ran (length 0) would mean the mid-extraction abort path was never exercised"
        );
        assert.equal(
          state.abortedWriteCount,
          0,
          "the aborted before_reset flush must persist nothing — the abort guards before_persist, so no fact is written before the buffer-preserving recovery flush"
        );
        assert.ok(state.secondFlushCalls, "a re-flush must have been recorded");
        assert.equal(
          state.secondFlushCalls.length,
          1,
          "a timed-out before_reset must NOT clear the buffer — the re-flush re-extracts the preserved turn"
        );
        assert.deepEqual(
          state.secondFlushCalls[0]?.map((turn) => turn.content),
          ["The replay ledger checkpoint compacts after five hundred entries."]
        );
        assert.equal(
          state.recoveredFactCount,
          1,
          "the recovery flush must PERSIST the preserved turn as exactly one fact"
        );
        assert.equal(
          state.factCountAfterExtraFlush,
          1,
          "a further before_reset flush with an empty buffer must NOT duplicate the recovered fact"
        );
        await assertHarmonicEpisode(state.memoryDir);
        return;
      }
      case "session-end": {
        assert.equal(state.calls.length, 1, "session_end drains the buffer like before_reset");
        assert.equal(
          (await memoryFilesContaining(path.join(state.memoryDir, "facts"), "nightly compaction sweep")).length,
          1
        );
        await assertHarmonicEpisode(state.memoryDir);
        return;
      }
      case "dedupe-replay": {
        assert.equal(
          state.callsBeforeForceFlush,
          1,
          "the in-window duplicate must be suppressed — exactly one extraction before the force flush"
        );
        assert.equal(state.calls.length, 2, "the force flush bypasses the dedupe fingerprint and re-extracts");
        assert.match(
          (state.calls[1] ?? []).map((turn) => turn.content).join(" "),
          /canary gate/,
          "the second extraction is the force-flushed duplicate, not a no-op"
        );
        await assertHarmonicEpisode(state.memoryDir);
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
