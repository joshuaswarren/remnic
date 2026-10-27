/**
 * Issue #3251 regressions: an ACCEPTED `observe` (202) must leave a durably
 * pending capture. Pre-#3251, `observe` handed its turns to
 * `TurnIngestionCoordinator.ingestReplayBatch`, which queued them directly
 * into the serial extraction queue WITHOUT appending them to the SmartBuffer;
 * `queueBufferedExtraction` settled such a queued task on abort or queue-wait
 * deadline and the closure then no-opped, so the turns existed nowhere
 * durable and a later `flushSession` returned empty (silent extraction loss).
 *
 * Every observe-path call below requests buffered ingestion explicitly
 * (`extractionMode: "buffered"`, the API the observe surface invokes). The
 * tests pin the whole acceptance contract: durable capture before the ack,
 * bounded admission without eviction, scope isolation by namespace / owner /
 * scope profile, identity metadata surviving restart, and background
 * extraction that never delays or gates the acceptance.
 *
 * All tests drive the REAL orchestrator — real SmartBuffer, real serial
 * queue, real `ingestReplayBatch` / `flushSession` / `flushPendingSave` —
 * with only the LLM extraction client stubbed at the established field seam.
 * The stub produces no claimed extraction output: the wedged first call is a
 * gate the test controls, so every assertion targets capture durability, not
 * extraction success.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Orchestrator } from "./orchestrator.js";
import { SmartBuffer } from "./buffer.js";
import { ExtractionDeadlineError } from "./orchestration/extraction-run.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./orchestration/turn-ingestion.js";
import { resolveScopeProfilePlan } from "./namespaces/scope-profiles.js";
import { resolveCodingNamespaceOverlay } from "./coding/coding-namespace.js";
import type { ResolvedScopeProfilePlan } from "./namespaces/scope-profiles.js";
import type { ReplayTurn } from "./replay/types.js";
import type { BufferState, BufferTurn, PluginConfig, ScopeProfileConfig } from "./types.js";
import { parseConfig } from "./config.js";
import type { StorageManager } from "./storage.js";
import {
  cleanupDir,
  eventually,
  makeLifecycleConfig,
  mkTempMemoryDir,
  singleFactResult,
  sleep,
  stubExtraction,
} from "./testing/orchestrator-lite.js";

/** Inline storage for direct-SmartBuffer fixtures: durable in-memory, no disk. */
class SeedStorage {
  async loadBuffer(): Promise<BufferState> {
    return { turns: [], lastExtractionAt: null, extractionCount: 0 };
  }
  async saveBuffer(_state: BufferState): Promise<void> {}
}


function makeReplayTurn(sessionKey: string, content: string, sourceValidAt?: string): ReplayTurn {
  return {
    source: "openclaw",
    sessionKey,
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    sourceValidAt,
  };
}

/**
 * The observe surface's buffered-ingestion request (#3251): `extractionMode:
 * "buffered"` is the API the observe surface invokes explicitly. The wedge
 * filler calls stay in the default immediate mode — they only occupy the
 * queue.
 */
function bufferedObserveOptions(
  options: {
    abortSignal?: AbortSignal;
    deadlineMs?: number;
    writeNamespaceOverride?: string;
    principalOverride?: string;
    sessionOwnerPrincipal?: string;
    scopeProfileWritePlan?: ResolvedScopeProfilePlan;
    codingContext?: import("./types.js").CodingContext;
    onExtractionQueued?: (extraction: Promise<void>) => void;
  } = {},
): Parameters<Orchestrator["ingestReplayBatch"]>[1] {
  return { archiveLcm: false, extractionMode: "buffered", ...options };
}

/** One trigger-queued background extraction observed by a test. */
interface QueuedExtractionSlot {
  extraction?: Promise<void>;
}

/** Activate a minimal scope profile on a test config (native resolver reads it). */
function activateProfile(config: PluginConfig, profileId: string): void {
  config.scopeProfiles = {
    ...(config.scopeProfiles ?? {}),
    [profileId]: {
      readOrder: ["userGlobal"],
      writeDefault: "userGlobal",
      promotionTargets: [],
      autoPromote: { enabled: false, targets: [], categories: [], minConfidenceTier: "speculative" },
    },
  };
  config.defaultScopeProfile = profileId;
}

/** Fill the serial extraction queue with a gated extraction; returns its idempotent release. */
async function wedgeExtractionQueue(orchestrator: Orchestrator): Promise<() => void> {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const calls = stubExtraction(orchestrator, (_turns, call) =>
    call === 1 ? gate.then(() => singleFactResult("wedge probe fact")) : singleFactResult("drain probe fact"),
  );
  void orchestrator
    .ingestReplayBatch([makeReplayTurn("wedge-session", "queue wedge payload")], { archiveLcm: false })
    .catch(() => {});
  await eventually(async () => (calls.length >= 1 ? true : null), "wedge extraction started");
  return release;
}

test("#3251 accepted observe capture survives queue cancellation and drains after restart", async () => {
  const memoryDir = await mkTempMemoryDir("observe-durable");
  const orchestrator = new Orchestrator(makeLifecycleConfig(memoryDir, { bufferMaxTurns: 1, bufferSaveDebounceMs: 0 }));
  let restarted: Orchestrator | null = null;
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);

    // The exact call the observe surface makes; the pending-observe tracker
    // aborts this controller on lifecycle deadline or disconnect (#3251).
    const controller = new AbortController();
    let backgroundExtraction: Promise<void> | undefined;
    const replay = orchestrator.ingestReplayBatch(
      [makeReplayTurn("sess-a", "observe payload that must stay durable")],
      bufferedObserveOptions({
        abortSignal: controller.signal,
        onExtractionQueued: (extraction) => {
          // Mark handled early: the rejection itself is asserted below, and
          // an unhandled rejection between abort and assert must not fail
          // the run.
          extraction.catch(() => {});
          backgroundExtraction = extraction;
        },
      }),
    );
    controller.abort(new Error("pending observe extraction deadline exceeded"));

    // #3251 contract: the CAPTURE settles (accepted + durable) even when the
    // tracker cancels; only the background extraction rejects.
    await replay;
    assert.ok(backgroundExtraction, "native trigger must queue background extraction");
    await assert.rejects(backgroundExtraction);

    // THE REGRESSION: the accepted capture must be durably pending in the
    // extraction buffer, not tied to the settled queue task.
    const bufferKeys = await orchestrator.buffer.findBufferKeysForSession("sess-a");
    assert.ok(
      bufferKeys.length > 0,
      "accepted observe turns must remain buffered after the queued extraction was cancelled",
    );
    const pending = bufferKeys.flatMap((key) => orchestrator.buffer.getTurns(key));
    assert.ok(
      pending.some((turn) => turn.sessionKey === "sess-a" && turn.content.includes("observe payload")),
    );

    release();
    await orchestrator.waitForExtractionIdle(10_000);

    // Restart on the same memory dir: the capture must survive process death.
    restarted = new Orchestrator(makeLifecycleConfig(memoryDir, { bufferMaxTurns: 1, bufferSaveDebounceMs: 0 }));
    const drainCalls = stubExtraction(restarted, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );
    await restarted.flushSession("sess-a", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
    });
    assert.ok(
      drainCalls.some((batch) => batch.some((turn) => turn.content.includes("observe payload"))),
      "force flush after restart must drain the accepted observe capture",
    );
  } finally {
    // Idempotent: a failing assertion must never leave the gate unresolved
    // into destroy(), or the harness reports a timeout instead of the failure.
    release?.();
    await restarted?.destroy().catch(() => undefined);
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 same session+owner observes under different namespaces stay isolated when durably pending", async () => {
  const memoryDir = await mkTempMemoryDir("observe-scope-durable");
  const makeConfig = () =>
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [
        { name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] },
        { name: "ns-b", readPrincipals: ["alice"], writePrincipals: ["alice"] },
      ],
    });
  const orchestrator = new Orchestrator(makeConfig());
  let restarted: Orchestrator | null = null;
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);

    // Two observes for the SAME sessionKey + SAME owner under DIFFERENT
    // explicit namespaces — exactly the shapes the observe surface passes to
    // ingestReplayBatch (writeNamespaceOverride / principalOverride /
    // sessionOwnerPrincipal). One is dropped by tracker cancellation, the
    // other by a queue-wait deadline.
    const controllerA = new AbortController();
    const backgroundA: QueuedExtractionSlot = {};
    const backgroundB: QueuedExtractionSlot = {};
    const trackBackground =
      (slot: QueuedExtractionSlot) =>
      (extraction: Promise<void>): void => {
        // Mark handled early: rejections are asserted below.
        extraction.catch(() => {});
        slot.extraction = extraction;
      };
    const replayA = orchestrator.ingestReplayBatch(
      [makeReplayTurn("proj-sess", "project A observation")],
      bufferedObserveOptions({
        abortSignal: controllerA.signal,
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        onExtractionQueued: trackBackground(backgroundA),
      }),
    );
    const replayB = orchestrator.ingestReplayBatch(
      [makeReplayTurn("proj-sess", "project B observation")],
      bufferedObserveOptions({
        deadlineMs: Date.now() + 40,
        writeNamespaceOverride: "ns-b",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        onExtractionQueued: trackBackground(backgroundB),
      }),
    );
    controllerA.abort(new Error("pending observe extraction cancelled"));
    // #3251 contract: both captures settle durably; only the background
    // extractions reject (abort for A, queue-wait deadline for B).
    await Promise.all([replayA, replayB]);
    assert.ok(backgroundA.extraction, "trigger must queue background extraction for A");
    assert.ok(backgroundB.extraction, "trigger must queue background extraction for B");
    await assert.rejects(backgroundA.extraction);
    await assert.rejects(backgroundB.extraction, ExtractionDeadlineError);

    const bufferKeys = await orchestrator.buffer.findBufferKeysForSession("proj-sess");
    assert.ok(
      bufferKeys.length > 0,
      "both accepted observe captures must remain buffered after cancellation/deadline",
    );
    const pending = bufferKeys.flatMap((key) => orchestrator.buffer.getTurns(key));
    assert.ok(pending.some((turn) => turn.content.includes("project A observation")));
    assert.ok(pending.some((turn) => turn.content.includes("project B observation")));

    release();
    await orchestrator.waitForExtractionIdle(10_000);

    const second = new Orchestrator(makeConfig());
    restarted = second;
    const drainCalls = stubExtraction(second, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );
    await second.flushSession("proj-sess", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: "ns-a",
      principalOverride: "alice",
    });
    const drainedUnderA = drainCalls.flat().map((turn) => turn.content);
    assert.ok(
      drainedUnderA.some((content) => content.includes("project A observation")),
      "scoped ns-a flush must drain ns-a's capture",
    );
    assert.ok(
      !drainedUnderA.some((content) => content.includes("project B observation")),
      "scoped ns-a flush must NOT drain ns-b's pending capture (scope isolation)",
    );

    const stillPending = (await second.buffer.findBufferKeysForSession("proj-sess")).flatMap((key) =>
      second.buffer.getTurns(key),
    );
    assert.ok(
      stillPending.some((turn) => turn.content.includes("project B observation")),
      "ns-b's capture must still be pending after the ns-a drain",
    );

    await second.flushSession("proj-sess", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: "ns-b",
      principalOverride: "alice",
    });
    const drainedUnderB = drainCalls.flat().map((turn) => turn.content);
    assert.ok(
      drainedUnderB.some((content) => content.includes("project B observation")),
      "scoped ns-b flush must drain ns-b's capture",
    );
  } finally {
    release?.();
    await restarted?.destroy().catch(() => undefined);
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 buffered observe append is durable before accept: a failed save rejects instead of acking", async () => {
  const memoryDir = await mkTempMemoryDir("observe-save-failure");
  const orchestrator = new Orchestrator(makeLifecycleConfig(memoryDir, { bufferSaveDebounceMs: 0 }));
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);
    stubExtraction(orchestrator, () => singleFactResult("save-failure probe fact"));

    // Force every durable buffer write to fail (issue #1909 seam). The
    // capture path must surface this to the caller — an observe whose save
    // failed is NOT accepted and must reject, never ack 202 over non-durable
    // turns.
    const failingStorage = {
      async loadBuffer(): Promise<BufferState> {
        return { turns: [], lastExtractionAt: null, extractionCount: 0 };
      },
      async saveBuffer(_state: BufferState): Promise<void> {
        throw new Error("simulated durable buffer save failure");
      },
    };
    // SAFETY: `storage` is a private SmartBuffer field, structurally replaced
    // in place to force durable-write failures. Named cast per rule.
    const bufferSeam = orchestrator.buffer as any;
    bufferSeam.storage = failingStorage;

    // Bounded settle: a regression that queues instead of rejecting must fail
    // the assertion fast, never hang the harness.
    const settled = await Promise.race([
      orchestrator
        .ingestReplayBatch(
          [makeReplayTurn("sess-save-fail", "observe payload over failing storage")],
          bufferedObserveOptions({ sessionOwnerPrincipal: "alice" }),
        )
        .then(
          () => null,
          (err: Error) => err,
        ),
      sleep(2000).then(() => "timeout" as const),
    ]);
    assert.ok(settled !== "timeout", "buffered append must settle promptly, not hang acceptance");
    assert.ok(settled instanceof Error, "a failed durable save must reject the capture, never ack it");
    assert.match(settled.message, /simulated durable buffer save failure/);
  } finally {
    release?.();
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 durable observe admission is bounded: at the entry cap a new session is refused, not evicted", async () => {
  // Real SmartBuffer + real coordinator, NO Orchestrator background actors —
  // background eviction sweeps would make a 200-entry fixture nondeterministic.
  class SeedStorage {
    async loadBuffer(): Promise<BufferState> {
      return { turns: [], lastExtractionAt: null, extractionCount: 0 };
    }
    async saveBuffer(_state: BufferState): Promise<void> {}
  }
  const config = parseConfig({
    memoryDir: join(tmpdir(), "remnic-observe-capacity"),
    bufferSaveDebounceMs: 0,
    bufferMaxTurns: 1000,
    extractionMinChars: 1_000_000,
    extractionMinUserTurns: 1000,
  });
  const buffer = new SmartBuffer(
    config,
    // SAFETY: SeedStorage implements SmartBuffer's storage seam (loadBuffer/
    // saveBuffer); the wider StorageManager surface is unused here.
    new SeedStorage() as StorageManager,
  );
  const queued: BufferTurn[][] = [];
  // SAFETY: capacity fixture exercises only buffered admission — the queue
  // is recorded, never executed; the remaining deps are unreachable here.
  const deps = { buffer, config } as any;
  deps.queueBufferedExtraction = async (turns: BufferTurn[]) => {
    queued.push(turns);
  };
  const coordinator = new TurnIngestionCoordinator(deps);
    // (buffer.ts), each holding an accepted, durably pending capture. The
    // seed turns are PINNED accepted captures — cap pressure must refuse new
    // captures, never evict these (#3251 eviction guard; the pre-existing
    // `default` mirror entry also occupies the entries map).
    for (let index = 0; index < 200; index += 1) {
      const key = `seed-${index}`;
      await buffer.addTurn(key, {
        role: "user",
        content: `accepted seed capture ${index}`,
        timestamp: new Date().toISOString(),
        sessionKey: key,
        sessionOwnerPrincipal: "alice",
        acceptedCapture: true,
        writeNamespaceOverride: "seed-store",
      } satisfies BufferTurn);
    }

    // A NEW observe session at the cap must be REFUSED before acceptance —
    // bounded backpressure, not silent eviction of previously accepted
    // pending captures. Bounded settle so a regression that queues instead
    // of refusing fails fast instead of hanging the harness.
    const settled = await Promise.race([
      coordinator
        .ingestReplayBatch(
          [makeReplayTurn("fresh-observe-session", "late observe at capacity")],
          bufferedObserveOptions({ sessionOwnerPrincipal: "alice" }),
        )
        .then(
          () => null,
          (err: Error) => err,
        ),
      sleep(2000).then(() => "timeout" as const),
    ]);
    assert.ok(settled !== "timeout", "at-cap observe must settle promptly");
    assert.ok(settled instanceof Error, "at-cap observe must be refused, not accepted");
    assert.match(
      settled instanceof Error ? settled.message : "",
      /capacity/,
    );
    assert.equal(queued.length, 0, "refused capture must not queue extraction");

    const snapshot = await buffer.getBufferSnapshot();
    assert.equal(snapshot.bufferedSessionCount, 200, "refusal must not evict accepted captures");
    assert.ok(
      buffer.getTurns("seed-0").some((turn) => turn.content.includes("accepted seed capture 0")),
    );

    // Appending to an ALREADY accepted session stays admitted (bounded by the
    // same entry, no new eviction pressure).
    await coordinator.ingestReplayBatch(
      [makeReplayTurn("seed-0", "append to accepted session")],
      bufferedObserveOptions({ sessionOwnerPrincipal: "alice" }),
    );
    assert.ok(
      buffer.getTurns("seed-0").some((turn) => turn.content.includes("append to accepted session")),
    );
});

test("#3251 same session+owner across scope profiles never combine; sourceValidAt identity survives restart", async () => {
  const memoryDir = await mkTempMemoryDir("observe-profile-durable");
  const makeConfig = () =>
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    });
  const orchestrator = new Orchestrator(makeConfig());
  let restarted: Orchestrator | null = null;
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);

    const sourceValidAtA = "2026-10-26T10:00:00.000Z";

    // SAME raw session + owner + namespace; profiles switch BETWEEN captures,
    // so each durable capture pins the profile that was active when accepted.
    activateProfile(orchestrator.config, "profile-team");
    const planP1 = resolveScopeProfilePlan({ config: orchestrator.config, principal: "alice" });
    assert.ok(planP1, "active profile must resolve");
    const controllerP1 = new AbortController();
    const backgroundP1: QueuedExtractionSlot = {};
    const backgroundP2: QueuedExtractionSlot = {};
    const trackBackground =
      (slot: QueuedExtractionSlot) =>
      (extraction: Promise<void>): void => {
        extraction.catch(() => {});
        slot.extraction = extraction;
      };
    const replayP1 = orchestrator.ingestReplayBatch(
      [makeReplayTurn("proj-sess", "profile P1 observation", sourceValidAtA)],
      bufferedObserveOptions({
        abortSignal: controllerP1.signal,
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        scopeProfileWritePlan: planP1,
        onExtractionQueued: trackBackground(backgroundP1),
      }),
    );
    controllerP1.abort(new Error("pending observe extraction cancelled"));

    activateProfile(orchestrator.config, "profile-personal");
    const planP2 = resolveScopeProfilePlan({ config: orchestrator.config, principal: "alice" });
    assert.ok(planP2, "switched profile must resolve");
    const replayP2 = orchestrator.ingestReplayBatch(
      [makeReplayTurn("proj-sess", "profile P2 observation")],
      bufferedObserveOptions({
        deadlineMs: Date.now() + 40,
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        scopeProfileWritePlan: planP2,
        onExtractionQueued: trackBackground(backgroundP2),
      }),
    );
    // #3251 contract: both captures settle durably; only the background
    // extractions reject (abort for P1, queue-wait deadline for P2).
    await Promise.all([replayP1, replayP2]);
    assert.ok(backgroundP1.extraction, "trigger must queue background extraction for P1");
    assert.ok(backgroundP2.extraction, "trigger must queue background extraction for P2");
    await assert.rejects(backgroundP1.extraction);
    await assert.rejects(backgroundP2.extraction, ExtractionDeadlineError);

    const bufferKeys = await orchestrator.buffer.findBufferKeysForSession("proj-sess");
    const pending = bufferKeys.flatMap((key) => orchestrator.buffer.getTurns(key));
    assert.ok(pending.some((turn) => turn.content.includes("profile P1 observation")));
    assert.ok(pending.some((turn) => turn.content.includes("profile P2 observation")));

    release();
    await orchestrator.waitForExtractionIdle(10_000);

    const second = new Orchestrator(makeConfig());
    restarted = second;
    activateProfile(second.config, "profile-team");
    const drainCalls = stubExtraction(second, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );

    // Metadata identity check on the durable capture after restart: the
    // sourceValidAt anchor must round-trip so deferred extraction keeps its
    // bi-temporal identity.
    const restartedPending = (await second.buffer.findBufferKeysForSession("proj-sess")).flatMap((key) =>
      second.buffer.getTurns(key),
    );
    const durableTurn = restartedPending.find((turn) => turn.content.includes("profile P1 observation"));
    assert.ok(durableTurn, "P1 capture must be durably pending after restart");
    assert.equal(durableTurn?.sourceValidAt, sourceValidAtA, "sourceValidAt identity must survive the durable roundtrip");

    // Profile isolation: a flush pinned to plan P1 drains ONLY P1's turns.
    await second.flushSession("proj-sess", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: "ns-a",
      principalOverride: "alice",
      scopeProfileWritePlan: planP1,
    });
    const drainedUnderP1 = drainCalls.flat().map((turn) => turn.content);
    assert.ok(
      drainedUnderP1.some((content) => content.includes("profile P1 observation")),
      "plan-P1 flush must drain P1's capture",
    );
    assert.ok(
      !drainedUnderP1.some((content) => content.includes("profile P2 observation")),
      "same session+owner under a different scope profile must NOT combine",
    );

    const stillPending = (await second.buffer.findBufferKeysForSession("proj-sess")).flatMap((key) =>
      second.buffer.getTurns(key),
    );
    assert.ok(
      stillPending.some((turn) => turn.content.includes("profile P2 observation")),
      "P2's capture must stay pending after the P1 drain",
    );

    // Switch the active profile: P2's pinned plan becomes current and drains;
    // P1 is already gone.
    activateProfile(second.config, "profile-personal");
    await second.flushSession("proj-sess", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: "ns-a",
      principalOverride: "alice",
      scopeProfileWritePlan: planP2,
    });
    const drainedUnderP2 = drainCalls.flat().map((turn) => turn.content);
    assert.ok(
      drainedUnderP2.some((content) => content.includes("profile P2 observation")),
      "pinned P2 capture drains once its own profile is active",
    );
  } finally {
    release?.();
    await restarted?.destroy().catch(() => undefined);
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 cancellation before admission still leaves the capture durably pending", async () => {
  const memoryDir = await mkTempMemoryDir("observe-cancelled");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, { bufferMaxTurns: 1, bufferSaveDebounceMs: 0 }),
  );
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);
    const controller = new AbortController();
    const background: QueuedExtractionSlot = {};
    controller.abort(new Error("cancelled before admission"));
    const replay = orchestrator.ingestReplayBatch(
      [makeReplayTurn("sess-cancel", "cancelled observe payload")],
      bufferedObserveOptions({
        abortSignal: controller.signal,
        onExtractionQueued: (extraction) => {
          extraction.catch(() => {});
          background.extraction = extraction;
        },
      }),
    );
    // Cancellation applies to extraction, never to the durable capture.
    await replay;
    assert.ok(background.extraction, "cancelled capture still queues (and aborts) its extraction");
    await assert.rejects(background.extraction);
    const pending = (await orchestrator.buffer.findBufferKeysForSession("sess-cancel")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    assert.ok(pending.some((turn) => turn.content.includes("cancelled observe payload")));
  } finally {
    release?.();
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 unscoped session_end drains the default store and never clears another pinned namespace's capture", async () => {
  const memoryDir = await mkTempMemoryDir("observe-session-end");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    }),
  );
  const drainCalls = stubExtraction(orchestrator, (turns) =>
    singleFactResult(turns.map((turn) => turn.content).join(" | ")),
  );
  try {
    const controller = new AbortController();
    const replay = orchestrator.ingestReplayBatch(
      [makeReplayTurn("mix-sess", "pinned namespace capture")],
      bufferedObserveOptions({
        abortSignal: controller.signal,
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
      }),
    );
    controller.abort(new Error("keep the capture pending"));
    await replay;
    assert.ok(
      (await orchestrator.buffer.findBufferKeysForSession("mix-sess")).length > 0,
    );

    await orchestrator.flushSession("mix-sess", { reason: "session_end" });

    const drained = drainCalls.flat().map((turn) => turn.content);
    assert.ok(
      !drained.some((content) => content.includes("pinned namespace capture")),
      "unqualified session_end must not drain another namespace's durable capture",
    );
    const stillPending = (await orchestrator.buffer.findBufferKeysForSession("mix-sess")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    assert.ok(
      stillPending.some((turn) => turn.content.includes("pinned namespace capture")),
      "pinned capture survives the unscoped lifecycle drain",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 a pinned capture whose scope profile is revoked stays pending instead of extracting", async () => {
  const memoryDir = await mkTempMemoryDir("observe-revoked-plan");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    }),
  );
  activateProfile(orchestrator.config, "profile-team");
  const pinnedPlan = resolveScopeProfilePlan({ config: orchestrator.config, principal: "alice" });
  assert.ok(pinnedPlan, "active profile must resolve before capture");
  let release: (() => void) | undefined;
  try {
    // Wedge the queue so the capture's trigger-queued drain executes only
    // AFTER the revocation below.
    release = await wedgeExtractionQueue(orchestrator);
    // Own stub for post-wedge calls (replaces the wedge's recorder).
    const drainCalls = stubExtraction(orchestrator, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );
    const background: QueuedExtractionSlot = {};
    const replay = orchestrator.ingestReplayBatch(
      [makeReplayTurn("revoked-sess", "revoked plan capture")],
      bufferedObserveOptions({
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        scopeProfileWritePlan: pinnedPlan,
        onExtractionQueued: (extraction) => {
          extraction.catch(() => {});
          background.extraction = extraction;
        },
      }),
    );
    await replay;
    assert.ok(background.extraction, "authorized trigger queues the drain");

    // Revoke AFTER capture: the active profile no longer matches the pinned
    // identity — the execution boundary must skip the LLM and keep the
    // capture pending, never retarget or clear.
    activateProfile(orchestrator.config, "profile-other");

    release();
    if (background.extraction) await background.extraction;
    await orchestrator.waitForExtractionIdle(10_000);
    const pending = (await orchestrator.buffer.findBufferKeysForSession("revoked-sess")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    assert.ok(
      pending.some((turn) => turn.content.includes("revoked plan capture")),
      "capture stays pending while its plan is unauthorized",
    );
    assert.equal(drainCalls.length, 0, "no extraction ran under revoked policy");
  } finally {
    release?.();
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 a pinned capture outlives a namespaces-disabled config without flattening into the default store", async () => {
  const memoryDir = await mkTempMemoryDir("observe-ns-off");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    }),
  );
  const drainCalls = stubExtraction(orchestrator, (turns) =>
    singleFactResult(turns.map((turn) => turn.content).join(" | ")),
  );
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);
    const background: QueuedExtractionSlot = {};
    const replay = orchestrator.ingestReplayBatch(
      [makeReplayTurn("ns-off-sess", "pinned store capture")],
      bufferedObserveOptions({
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        onExtractionQueued: (extraction) => {
          extraction.catch(() => {});
          background.extraction = extraction;
        },
      }),
    );
    await replay;
    assert.ok(background.extraction, "trigger queues the drain while namespaces honor the pin");

    // Disable namespaces AFTER capture: the pinned non-default store can no
    // longer be honored — skip the LLM, keep the capture pending, never
    // flatten.
    orchestrator.config.namespacesEnabled = false;

    release();
    if (background.extraction) await background.extraction;
    await orchestrator.waitForExtractionIdle(10_000);
    assert.equal(
      drainCalls.length,
      0,
      "pinned store capture must not extract into a flattened default store",
    );
    const pending = (await orchestrator.buffer.findBufferKeysForSession("ns-off-sess")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    assert.ok(
      pending.some((turn) => turn.content.includes("pinned store capture")),
      "capture stays pending until its pinned store is honored again",
    );
  } finally {
    release?.();
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

// ---------------------------------------------------------------------------
// #3251 follow-up: retained-turn cleanup honors plan identity + original
// project binding — flush A must not delete project B's retained context.
// ---------------------------------------------------------------------------

test("#3251 retained-turn cleanup honors plan+binding: flush A leaves project B's retained turns", async () => {
  const memoryDir = await mkTempMemoryDir("observe-retained-cleanup");
  const config = parseConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
  });
  const buffer = new SmartBuffer(
    config,
    // SAFETY: inline seed storage satisfies SmartBuffer's storage needs.
    {
      async loadBuffer(): Promise<BufferState> {
        return { turns: [], lastExtractionAt: null, extractionCount: 0 };
      },
      async saveBuffer(_state: BufferState): Promise<void> {},
    } as StorageManager,
  );
  activateProfile(config, "profile-global");
  const planP = resolveScopeProfilePlan({ config, principal: "alice" });
  assert.ok(planP, "active profile must resolve");
  const ctxA = { projectId: "proj-a", branch: null, rootPath: "/repo-proj-a", defaultBranch: null };
  const ctxB = { projectId: "proj-b", branch: null, rootPath: "/repo-proj-b", defaultBranch: null };
  const retainedTurn = (content: string, ctx: typeof ctxA): BufferTurn => ({
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    sessionKey: "shared-sess",
    sessionOwnerPrincipal: "alice",
    writeNamespaceOverride: "ns-a",
    acceptedCapture: true,
    scopeProfileWritePlan: planP,
    codingContext: ctx,
  });
  await buffer.retainDeferredTurns("shared-sess", [
    retainedTurn("project A retained context", ctxA),
    retainedTurn("project B retained context", ctxB),
  ], 10);

  // Flush A's cleanup: same namespace + plan, DIFFERENT project binding —
  // project A's retained context is cleaned, project B's survives.
  await buffer.clearRetainedTurnsForSession("shared-sess", "alice", {
    writeNamespaceOverride: "ns-a",
    scopeProfileWritePlan: planP,
    codingContext: ctxA,
  });
  const retainedAfterA = buffer.getRetainedDeferredTurns("shared-sess").map((turn) => turn.content);
  assert.equal(
    retainedAfterA.some((content) => content.includes("project A retained context")),
    false,
    "own-scope retained turns are still cleaned",
  );
  assert.ok(
    retainedAfterA.some((content) => content.includes("project B retained context")),
    "retained turns bound to a DIFFERENT project survive plan+binding-scoped cleanup",
  );
});


/** The plan produced by the native resolver for a project-scoped capture. */
interface ProjectPlanProbe {
  plan: ResolvedScopeProfilePlan;
}

/** Native plan for a project-scoped capture: resolver + real coding context. */
function projectProfilePlan(config: PluginConfig, projectId: string): ProjectPlanProbe {
  const codingContext = {
    projectId,
    branch: null,
    rootPath: `/repo-${projectId}`,
    defaultBranch: null,
  };
  const codingOverlay = resolveCodingNamespaceOverlay(
    codingContext,
    { projectScope: true, branchScope: false, globalFallback: false },
    "default",
  );
  assert.ok(codingOverlay, "project scope must produce an overlay");
  const plan = resolveScopeProfilePlan({
    config,
    principal: "alice",
    codingContext,
    codingOverlay,
  });
  assert.ok(plan, "project profile must resolve");
  return { plan };
}

function withProjectWriteLayer(config: PluginConfig, profileId: string): void {
  const profile = config.scopeProfiles?.[profileId];
  if (profile) {
    profile.readOrder = ["userProject", "userGlobal"];
    profile.writeDefault = "userProject";
  }
}

test("#3251 a project-profile capture survives restart and extracts under its original project binding", async () => {
  const memoryDir = await mkTempMemoryDir("observe-project-restart");
  const makeConfig = () =>
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    });
  const orchestrator = new Orchestrator(makeConfig());
  activateProfile(orchestrator.config, "profile-project");
  withProjectWriteLayer(orchestrator.config, "profile-project");
  const probe = projectProfilePlan(orchestrator.config, "proj-a");
  const projectContext = {
    projectId: "proj-a",
    branch: null,
    rootPath: "/repo-proj-a",
    defaultBranch: null,
  };
  let restarted: Orchestrator | null = null;
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);
    const controller = new AbortController();
    const replay = orchestrator.ingestReplayBatch(
      [makeReplayTurn("proj-bind-sess", "project binding capture")],
      bufferedObserveOptions({
        abortSignal: controller.signal,
        writeNamespaceOverride: probe.plan.writeNamespace,
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        scopeProfileWritePlan: probe.plan,
        codingContext: projectContext,
      }),
    );
    controller.abort(new Error("keep the capture pending"));
    await replay;
    assert.ok(
      (await orchestrator.buffer.findBufferKeysForSession("proj-bind-sess")).length > 0,
    );

    release();
    await orchestrator.waitForExtractionIdle(10_000);

    const second = new Orchestrator(makeConfig());
    restarted = second;
    activateProfile(second.config, "profile-project");
    withProjectWriteLayer(second.config, "profile-project");
    const drainCalls = stubExtraction(second, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );
    await second.flushSession("proj-bind-sess", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: probe.plan.writeNamespace,
      principalOverride: "alice",
      scopeProfileWritePlan: probe.plan,
      codingContext: projectContext,
    });
    const drained = drainCalls.flat().map((turn) => turn.content);
    assert.ok(
      drained.some((content) => content.includes("project binding capture")),
      "restart re-resolution must honor the ORIGINAL project binding and drain the capture",
    );
  } finally {
    release?.();
    await restarted?.destroy().catch(() => undefined);
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 same userGlobal profile across different projects never combines and keeps promotion bindings", async () => {
  const memoryDir = await mkTempMemoryDir("observe-project-isolation");
  // Thresholds force keep_buffering: no trigger tasks, so the scoped flush
  // alone decides what drains — deterministic isolation check.
  const makeConfig = () =>
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1000,
      bufferSaveDebounceMs: 0,
      extractionMinChars: 1_000_000,
      extractionMinUserTurns: 1000,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    });
  const orchestrator = new Orchestrator(makeConfig());
  activateProfile(orchestrator.config, "profile-global");
  const probeA = projectProfilePlan(orchestrator.config, "proj-a");
  const probeB = projectProfilePlan(orchestrator.config, "proj-b");
  const drainCalls = stubExtraction(orchestrator, (turns) =>
    singleFactResult(turns.map((turn) => turn.content).join(" | ")),
  );
  try {
    await orchestrator.ingestReplayBatch(
      [makeReplayTurn("proj-sess", "project A promotion binding")],
      bufferedObserveOptions({
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        scopeProfileWritePlan: probeA.plan,
        codingContext: { projectId: "proj-a", branch: null, rootPath: "/repo-proj-a", defaultBranch: null },
      }),
    );
    await orchestrator.ingestReplayBatch(
      [makeReplayTurn("proj-sess", "project B promotion binding")],
      bufferedObserveOptions({
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        scopeProfileWritePlan: probeB.plan,
        codingContext: { projectId: "proj-b", branch: null, rootPath: "/repo-proj-b", defaultBranch: null },
      }),
    );

    await orchestrator.flushSession("proj-sess", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: "ns-a",
      principalOverride: "alice",
      scopeProfileWritePlan: probeA.plan,
      codingContext: { projectId: "proj-a", branch: null, rootPath: "/repo-proj-a", defaultBranch: null },
    });
    const drainedUnderA = drainCalls.flat().map((turn) => turn.content);
    assert.ok(
      drainedUnderA.some((content) => content.includes("project A promotion binding")),
      "plan-A flush must drain project A's capture",
    );
    assert.ok(
      !drainedUnderA.some((content) => content.includes("project B promotion binding")),
      "same profile/userGlobal write namespace across DIFFERENT projects must NOT combine",
    );
    const stillPending = (await orchestrator.buffer.findBufferKeysForSession("proj-sess")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    assert.ok(
      stillPending.some((turn) => turn.content.includes("project B promotion binding")),
      "project B's capture stays pending under its own binding",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("#3251 a revoked namespace write grant preserves the accepted capture without LLM work", async () => {
  const memoryDir = await mkTempMemoryDir("observe-ns-revoked");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    }),
  );
  const drainCalls = stubExtraction(orchestrator, (turns) =>
    singleFactResult(turns.map((turn) => turn.content).join(" | ")),
  );
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);
    const background: QueuedExtractionSlot = {};
    const replay = orchestrator.ingestReplayBatch(
      [makeReplayTurn("ns-revoke-sess", "revoked namespace capture")],
      bufferedObserveOptions({
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
        onExtractionQueued: (extraction) => {
          extraction.catch(() => {});
          background.extraction = extraction;
        },
      }),
    );
    await replay;
    assert.ok(background.extraction, "authorized trigger queues the drain");

    // Revoke alice's WRITE grant on ns-a AFTER capture: the drain must skip
    // and preserve, never write into a namespace the principal can no longer
    // write.
    orchestrator.config.namespacePolicies = [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: [] }];

    release();
    if (background.extraction) await background.extraction;
    await orchestrator.waitForExtractionIdle(10_000);
    assert.equal(drainCalls.length, 0, "no extraction under a revoked namespace write grant");
    const pending = (await orchestrator.buffer.findBufferKeysForSession("ns-revoke-sess")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    assert.ok(
      pending.some((turn) => turn.content.includes("revoked namespace capture")),
      "capture stays pending until write access is restored",
    );
  } finally {
    release?.();
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

// ---------------------------------------------------------------------------
// #3251 native trigger scope routing: processTurn / heartbeat must never run
// mixed accepted scopes under one policy.
// ---------------------------------------------------------------------------

function makeTurnIngestionDouble(config: PluginConfig, buffer: SmartBuffer, queued: BufferTurn[][]): TurnIngestionCoordinator {
  // SAFETY: these fixtures exercise only buffered admission + trigger
  // routing; the remaining deps are never reached on this path.
  const deps = { buffer, config } as any;
  deps.queueBufferedExtraction = async (turns: BufferTurn[]) => {
    queued.push(turns);
  };
  return new TurnIngestionCoordinator(deps);
}

test("#3251 native processTurn routes mixed accepted scopes as separate scope groups", async () => {
  const memoryDir = await mkTempMemoryDir("observe-native-trigger");
  const config = parseConfig({
    memoryDir,
    bufferMaxTurns: 1,
    bufferSaveDebounceMs: 0,
    namespacesEnabled: true,
    defaultNamespace: "default",
  });
    // SAFETY: SeedStorage implements SmartBuffer's storage seam; the wider
  // StorageManager surface is unused in this fixture.
  // SAFETY: SeedStorage implements SmartBuffer's storage seam; the wider
  // StorageManager surface is unused in this fixture.
  const buffer = new SmartBuffer(config, new SeedStorage() as StorageManager);
  const queued: BufferTurn[][] = [];
  const coordinator = makeTurnIngestionDouble(config, buffer, queued);
  try {
    // Two accepted captures already durable in the entry, different pins.
    for (const [content, namespace, projectId] of [
      ["scope A native capture", "ns-a", "proj-a"],
      ["scope B native capture", "ns-b", "proj-b"],
    ] as const) {
      await buffer.addTurn("mixed-sess", {
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        sessionKey: "mixed-sess",
        sessionOwnerPrincipal: "alice",
        acceptedCapture: true,
        writeNamespaceOverride: namespace,
        codingContext: { projectId, branch: null, rootPath: `/repo-${projectId}`, defaultBranch: null },
      } satisfies BufferTurn);
    }

    await coordinator.processTurn("user", "native trigger turn", "mixed-sess");

    assert.equal(queued.length, 3, "mixed scopes queue separately; the unpinned trigger turn is its own group");
    const seen = queued.map((batch) => batch.map((turn) => turn.content.slice(0, 6)).join(","));
    const scopesPerCall = queued.map(
      (batch) => new Set(batch.map((turn) => turn.writeNamespaceOverride ?? "-")).size,
    );
    assert.deepEqual(
      scopesPerCall.filter((size) => size > 1),
      [],
      "no extraction batch may mix accepted scopes",
    );
    const allQueued = queued.flat().map((turn) => turn.content);
    assert.ok(allQueued.some((content) => content.includes("scope A native capture")));
    assert.ok(allQueued.some((content) => content.includes("scope B native capture")));
    assert.ok(seen.length >= 2);
  } finally {
    await cleanupDir(memoryDir);
  }
});

test("#3251 heartbeat observer routes mixed accepted scopes as separate scope groups", async () => {
  const memoryDir = await mkTempMemoryDir("observe-heartbeat-trigger");
  const config = parseConfig({
    memoryDir,
    bufferMaxTurns: 1000,
    bufferSaveDebounceMs: 0,
    extractionMinChars: 1_000_000,
    extractionMinUserTurns: 1000,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sessionObserverEnabled: true,
  });
  // SAFETY: SeedStorage implements SmartBuffer's storage seam; the wider
  // StorageManager surface is unused in this fixture.
  const buffer = new SmartBuffer(config, new SeedStorage() as StorageManager);
  const queued: BufferTurn[][] = [];
  // SAFETY: heartbeat fixture exercises only the observer trigger routing;
  // the remaining deps are unreachable on this path.
  const deps = { buffer, config } as any;
  deps.queueBufferedExtraction = async (turns: BufferTurn[]) => {
    queued.push(turns);
  };
  deps.heartbeatObserverChains = new Map();
  deps.shouldQueueExtraction = () => true;
  // SAFETY: transcript double — remaining TranscriptManager members are
  // unreachable from the heartbeat observer trigger path.
  deps.transcript = {
    estimateSessionFootprint: async () => ({ bytes: 1, tokens: 1 }),
    getTranscriptPath: (sessionKey: string) => ({
      dir: join(memoryDir, "transcripts"),
      alternateDir: undefined,
      legacyDir: undefined,
      readbackDirs: [],
      primaryPath: join(memoryDir, "transcripts", sessionKey),
    }),
  } as never;
  // SAFETY: session observer double — only observe() is called.
  deps.sessionObserver = {
    observe: async () => ({ triggered: true, deltaBytes: 1, deltaTokens: 1 }),
  } as never;
  const coordinator = new TurnIngestionCoordinator(deps);
  try {
    for (const [content, namespace, projectId] of [
      ["heartbeat scope A capture", "ns-a", "proj-a"],
      ["heartbeat scope B capture", "ns-b", "proj-b"],
    ] as const) {
      await buffer.addTurn("hb-sess", {
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        sessionKey: "hb-sess",
        sessionOwnerPrincipal: "alice",
        acceptedCapture: true,
        writeNamespaceOverride: namespace,
        codingContext: { projectId, branch: null, rootPath: `/repo-${projectId}`, defaultBranch: null },
      } satisfies BufferTurn);
    }

    await coordinator.observeSessionHeartbeat("hb-sess");

    assert.equal(queued.length, 2, "heartbeat mixed accepted scopes queue as separate scope groups");
    const scopesPerCall = queued.map(
      (batch) => new Set(batch.map((turn) => turn.writeNamespaceOverride ?? "-")).size,
    );
    assert.deepEqual(
      scopesPerCall.filter((size) => size > 1),
      [],
      "no heartbeat extraction batch may mix accepted scopes",
    );
  } finally {
    await cleanupDir(memoryDir);
  }
});

test("#3251 policy-revoked retained capture: forceflush rejects before clearing, grant restore allows retry", async () => {
  const memoryDir = await mkTempMemoryDir("observe-retained-revoked");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    }),
  );
  activateProfile(orchestrator.config, "profile-global");
  const drainCalls = stubExtraction(orchestrator, (turns) =>
    singleFactResult(turns.map((turn) => turn.content).join(" | ")),
  );
  let release: (() => void) | undefined;
  try {
    release = await wedgeExtractionQueue(orchestrator);

    // Accept a capture pinned to ns-a and place it in RETAINED turns (native
    // defer retention path), so clearRetainedTurnsForSession is the deletion
    // vector after a flush.
    const retainedCapture: BufferTurn = {
      role: "user",
      content: "retained policy-revoked capture",
      timestamp: new Date().toISOString(),
      sessionKey: "retained-sess",
      sessionOwnerPrincipal: "alice",
      acceptedCapture: true,
      writeNamespaceOverride: "ns-a",
    };
    await buffer_addRetained(orchestrator, retainedCapture);

    // Queue the flush behind the wedge, then revoke alice's write grant.
    const flushPromise = orchestrator
      .flushSession("retained-sess", {
        reason: "access_force_flush",
        failOnExtractionFailure: true,
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
      })
      .then(
        () => "resolved" as const,
        (err: Error) => `rejected:${err.message}` as const,
      );
    orchestrator.config.namespacePolicies = [
      { name: "ns-a", readPrincipals: ["alice"], writePrincipals: [] },
    ];

    release();
    await orchestrator.waitForExtractionIdle(10_000);
    const flushOutcome = await flushPromise;

    // The flush must REJECT (failOnExtractionFailure), not silently resolve.
    assert.ok(
      flushOutcome.startsWith("rejected"),
      `forceflush must reject when a policy-revoked accepted capture is skipped: got ${flushOutcome}`,
    );

    // The retained capture must survive on disk despite the flush attempt.
    const stillRetained = orchestrator.buffer.getRetainedDeferredTurns("ns-a");
    const activePending = (await orchestrator.buffer.findBufferKeysForSession("retained-sess")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    const allPending = [...stillRetained, ...activePending].map((turn) => turn.content);
    assert.ok(
      allPending.some((content) => content.includes("retained policy-revoked capture")),
      "retained capture must survive the rejected flush",
    );

    // Restore the grant: retry flush drains the capture. Reinstall the drain
    // recorder (the wedge's stub is no longer needed after release).
    orchestrator.config.namespacePolicies = [
      { name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ];
    const retryDrainCalls = stubExtraction(orchestrator, (turns) =>
      singleFactResult(turns.map((turn) => turn.content).join(" | ")),
    );
    await orchestrator.flushSession("retained-sess", {
      reason: "access_force_flush",
      failOnExtractionFailure: true,
      writeNamespaceOverride: "ns-a",
      principalOverride: "alice",
    });
    assert.ok(
      retryDrainCalls.some((batch) => batch.some((turn) => turn.content.includes("retained policy-revoked capture"))),
      "capture drains after write access is restored",
    );
  } finally {
    release?.();
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

/** Place a turn in the buffer's retained slot for a namespace key (#562 defer retention). */
async function buffer_addRetained(orchestrator: Orchestrator, turn: BufferTurn): Promise<void> {
  const key = turn.writeNamespaceOverride ?? turn.sessionKey ?? "default";
  await orchestrator.buffer.addTurn(key, turn);
  await orchestrator.buffer.retainDeferredTurns(key, [turn], 10);
}

test("#3251 namespaces-disabled flush with failOnExtractionFailure rejects and preserves the capture", async () => {
  const memoryDir = await mkTempMemoryDir("observe-ns-off-fail");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      bufferMaxTurns: 1,
      bufferSaveDebounceMs: 0,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [{ name: "ns-a", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    }),
  );
  const drainCalls = stubExtraction(orchestrator, (turns) =>
    singleFactResult(turns.map((turn) => turn.content).join(" | ")),
  );
  try {
    await orchestrator.ingestReplayBatch(
      [makeReplayTurn("ns-off-fail-sess", "pinned capture before ns-off")],
      bufferedObserveOptions({
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
        sessionOwnerPrincipal: "alice",
      }),
    );
    orchestrator.config.namespacesEnabled = false;

    // failOnExtractionFailure=true must reject the flush, not silently skip.
    await assert.rejects(
      orchestrator.flushSession("ns-off-fail-sess", {
        reason: "access_force_flush",
        failOnExtractionFailure: true,
        writeNamespaceOverride: "ns-a",
        principalOverride: "alice",
      }),
      /pinned_namespace_unavailable/,
    );
    assert.equal(drainCalls.length, 0, "no LLM under unavailable pinned namespace with failOn");

    // The capture survives.
    const pending = (await orchestrator.buffer.findBufferKeysForSession("ns-off-fail-sess")).flatMap((key) =>
      orchestrator.buffer.getTurns(key),
    );
    assert.ok(pending.some((turn) => turn.content.includes("pinned capture before ns-off")));
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});
