// Model-boundary integration tests for the claim drain: a REAL loopback
// OpenAI-compatible model boundary stands in for the extraction model so the
// ACTUAL chat input (renderer + truncation included) is what gets asserted —
// no extraction seam swap, no stub bookkeeping.
//
//   1. Large pinned accepted claim group spanning the configured window
//      budget: every source marker (early/middle/last) must appear in the
//      actual chat inputs and every request must respect the budget the
//      drain chunked on — no truncate-and-ack.
//   2. Legacy unpinned native claim groups under an ACTIVE scope profile
//      whose write layer is unwritable: the CURRENT profile gate must refuse
//      the write (a flattened plan=null would bypass it and persist) and the
//      canonical turns stay claimed.
//   3. A malformed/null extraction result is a retained failure: the claim's
//      canonical turns survive repeated attempts above the drop threshold.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Orchestrator, parseConfig } from "./index.js";
import { resolveScopeProfilePlan } from "./namespaces/scope-profiles.js";
import { BufferDrainRunner } from "./orchestration/buffer-drain-runner.js";
import type { ExtractionRunResult } from "./orchestration/extraction-run.js";
import type { BufferTurn, PluginConfig } from "./types.js";

interface ModelBoundary {
  url: string;
  /** Prompt strings actually sent as the extraction user input. */
  prompts: string[];
  close(): Promise<void>;
}

/** Loopback OpenAI-compatible boundary: records every completion prompt. */
async function startModelBoundary(): Promise<ModelBoundary> {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST") {
        try {
          // SAFETY: the loopback model posts OpenAI-compatible JSON; the shape
          // named here is the only part the probe reads.
          const parsed = JSON.parse(raw) as { messages?: { role?: string; content?: string }[] };
          const user =
            parsed.messages
              ?.filter((m) => m.role === "user")
              .map((m) => m.content ?? "")
              .join("\n") ?? "";
          if (user) prompts.push(user);
          // The model returns the user text VERBATIM as a grounded, quoted
          // fact — the shape source grounding requires to keep a fact.
          const extractionJson = JSON.stringify({
            facts: [{ content: user.trim(), category: "fact", confidence: 0.9, tags: [], quote: user.trim() }],
            entities: [],
            relationships: [],
            questions: [],
            profileUpdates: [],
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: extractionJson } }] }));
          return;
        } catch {
          // non-JSON probe request: fall through to the plain response
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address instanceof Object ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  // Real pipeline (daemon poll cadence + model round-trips) — platform clock.
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

async function findFactPath(dir: string, needle: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFactPath(child, needle);
      if (found) return found;
    } else if (
      entry.name.endsWith(".md") &&
      (await readFile(child, "utf8").then(
        (c) => c.includes(needle),
        () => false
      ))
    ) {
      return child;
    }
  }
  return undefined;
}

async function hasFactFile(dir: string, needle: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasFactFile(child, needle)) return true;
    } else if (
      entry.name.endsWith(".md") &&
      (await readFile(child, "utf8").then(
        (c) => c.includes(needle),
        () => false
      ))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * SAFETY: test seams bridge to orchestrator-private internals whose shape is
 * locally declared and exercised by the test itself; this is the single
 * trusted cast point for those seams.
 */
function asTestSeam<T>(cause: unknown): T {
  // SAFETY: the caller supplies the locally-declared seam contract; the cast
  // re-labels the orchestrator-private instance to that contract.
  return cause as T;
}

async function initializedOrchestrator(config: PluginConfig): Promise<Orchestrator> {
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  return orchestrator;
}

/** The verdict fields the drain boundary reads off an extraction result. */
interface DrainExtractionStubResult {
  status: "completed" | "skipped";
  reason?: string;
  persistedCount: number;
  durableOutputCount: number;
}

const NAMESPACED_FIXTURE = {
  namespacesEnabled: true,
  defaultNamespace: "default",
  principalFromSessionKeyMode: "prefix",
  namespacePolicies: [
    { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    { name: "default", readPrincipals: ["default"], writePrincipals: ["default"] },
  ],
};

test("a large pinned accepted claim group sends every turn to the ACTUAL chat input within the budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-budget-boundary-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      // FINITE window budget for the local path so chunking is exercised
      // against the REAL renderer/truncation, not a stubbed seam.
      modelSource: "local",
      localLlmEnabled: true,
      localLlmModel: "test-local-model",
      localLlmUrl: model.url,
      localLlmMaxContext: 2_000,
      localLlmTimeoutMs: 30_000,
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
    });
    orchestrator = new Orchestrator(config);
    // The real daemon initializes before serving; the model-input budget
    // (model registry) only exists after that.
    await orchestrator.initialize();
    const runner = new BufferDrainRunner(orchestrator);

    const contents = [
      "EARLY-MARKER budget probe with padding padding padding",
      ...Array.from({ length: 120 }, (_, i) => `MIDDLE-MARKER-${i} budget probe filler filler filler filler`),
      "LAST-MARKER budget probe tail padding padding",
    ];
    for (const [index, content] of contents.entries()) {
      await orchestrator.buffer.addTurn("budget-sess", {
        role: "user",
        // Connector-tagged: the renderer prepends a "Source: <connector>"
        // header for these, so the conversation-only budget measure must
        // include the same gate/margin the engine applies.
        sourceConnector: "omp",
        content,
        timestamp: `2026-11-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        sessionKey: "budget-sess",
        // A pinned ACCEPTED capture in the mix: the exact class that used to
        // bypass chunking and truncate-and-ack.
        acceptedCapture: true,
        writeNamespaceOverride: "alice",
        principalOverride: "alice",
      });
    }
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("budget-sess", "drain-budget"), true);

    const outcome = await runner.drainSession("budget-sess", { ownerId: "drain-budget" });
    assert.equal(outcome.status, "drained", `expected a full drain, got ${outcome.reason ?? "deferred"}`);

    // ACTUAL chat inputs: ALL source markers reached the model, and every
    // request's USER conversation respects the EXACT house budget helper
    // (ModelRegistry.calculateContextSizes with the configured maxContext —
    // the same derivation extractionWindowBudgetChars uses). System
    // instructions are legitimately outside the conversation budget.
    const { ModelRegistry } = await import("./model-registry.js");
    const maxInputChars = new ModelRegistry(memoryDir).calculateContextSizes("test-local-model", 2_000).maxInputChars;
    assert.ok(
      maxInputChars > 0 && Number.isFinite(maxInputChars),
      "the house budget helper yields a finite input budget"
    );
    const allPrompts = model.prompts.join("\n");
    for (const marker of contents) {
      assert.ok(allPrompts.includes(marker), `source marker never reached the actual chat input: ${marker}`);
    }
    // The recorded user message = fixed instruction block + the conversation
    // after the "Conversation:" label. The helper budget governs exactly that
    // conversation portion — assert it directly, self-derived per prompt.
    for (const [index, prompt] of model.prompts.entries()) {
      const label = "Conversation:\n";
      const labelIndex = prompt.lastIndexOf(label);
      assert.ok(labelIndex >= 0, `model call ${index} lacks the conversation section`);
      const conversationChars = prompt.length - (labelIndex + label.length);
      assert.ok(
        conversationChars <= maxInputChars,
        `model call ${index} conversation ${conversationChars} exceeds the helper budget ${maxInputChars}`
      );
    }
    assert.ok(
      model.prompts.length >= 2,
      `the window actually chunked (prompts=${model.prompts.length}, renderedSample=${model.prompts[0]?.length ?? 0})`
    );
    const claim = await runner.claims.load("budget-sess");
    assert.equal(claim?.entry.turns.length ?? 0, 0, "the claim empties only after every chunk extracted");
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("legacy unpinned claim groups refuse under an active profile with no writable layer and retain their claim", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-profile-legacy-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config: PluginConfig = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      debug: true,
      openaiApiKey: "sk-test",
      // The controlled boundary serves the extraction — no network fallback.
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
      // House scope-profile fixture (orchestrator-flush "no writable layer"
      // shape): an ACTIVE profile whose write layer cannot resolve —
      // userProject without any project context is unwritable. The current
      // policy therefore REFUSES this scope's write.
      scopeProfiles: {
        "denied-profile": {
          readOrder: ["userProject"],
          writeDefault: "userProject",
          promotionTargets: [],
          autoPromote: { enabled: false, targets: [], categories: [], minConfidenceTier: "speculative" },
        },
      },
      defaultScopeProfile: "denied-profile",
    });
    orchestrator = new Orchestrator(config);
    // The real daemon initializes before serving; the model-input budget
    // (model registry) only exists after that.
    await orchestrator.initialize();
    const runner = new BufferDrainRunner(orchestrator);

    await orchestrator.buffer.addTurn("alice:legacy", {
      role: "user",
      content: "legacy unpinned profile probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "alice:legacy",
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("alice:legacy", "drain-legacy"), true);

    const outcome = await runner.drainSession("alice:legacy", { ownerId: "drain-legacy" });

    // Current policy refuses the scope: the drain must NOT flatten the
    // legacy group to plan=null (which would bypass the profile gate and
    // write the fact into the principal's default namespace) — it must
    // refuse, keep the canonical turn in the claim, and report the denial.
    assert.equal(
      outcome.status,
      "deferred",
      `a denied scope is pending backlog, not drained (${outcome.reason ?? ""})`
    );
    assert.equal(outcome.reason, "scope_profile_no_writable_layer");
    assert.deepEqual(outcome.denied, [{ reason: "scope_profile_no_writable_layer", turns: 1 }]);

    // The refusal happens at the policy gate, before any model call — a
    // flattened plan=null WOULD have called the model and persisted.
    assert.equal(model.prompts.length, 0, "the denied scope must never reach the model");
    assert.equal(
      await hasFactFile(memoryDir, "legacy unpinned profile probe"),
      false,
      "a refused scope writes no fact anywhere"
    );

    // Canonical data untouched: the turn stays claimed and pending.
    const claim = await runner.claims.load("alice:legacy");
    assert.equal(claim?.entry.turns.length ?? 0, 1, "the denied turn stays in the claim");
    assert.equal(claim?.entry.turns[0]?.content, "legacy unpinned profile probe");
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a malformed extraction result keeps the canonical claim turns above the failure threshold", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-invalid-result-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
      // Drive the malformed attempts ABOVE the drop threshold: the no-drop
      // claim drain must never drop or side-file the content regardless.
      extractionChunkDropAfterFailures: 1,
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);

    await orchestrator.buffer.addTurn("invalid-result-sess", {
      role: "user",
      content: "malformed model output probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "invalid-result-sess",
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("invalid-result-sess", "drain-invalid"), true);

    // The actual run boundary receives null and malformed collection results
    // from the extractor — both real failure shapes the shared callee must
    // retain (never clear). The engine field is orchestrator-private; the
    // stub goes through this named test seam.
    const extractorResults: unknown[] = [
      null,
      { facts: "not-an-array", entities: [], questions: [], profileUpdates: [] },
      null,
    ];
    const extractionSeam = asTestSeam<{ extraction: { extract: () => Promise<ExtractionRunResult | null> } }>(
      orchestrator
    );
    extractionSeam.extraction = {
      // SAFETY: the queue re-drives malformed/null extractor output through
      // the boundary; the stub result is cast to the named verdict shape.
      extract: async () => extractorResults.shift() as ExtractionRunResult | null,
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await runner.drainSession("invalid-result-sess", { ownerId: "drain-invalid" });
      assert.notEqual(outcome.status, "drained", `attempt ${attempt}: a failed extraction is not a drain`);
      assert.equal(outcome.reason, "invalid_extraction_result", `attempt ${attempt}: the failure reason surfaces`);
      const claim = await runner.claims.load("invalid-result-sess");
      assert.equal(claim?.entry.turns.length ?? 0, 1, `attempt ${attempt}: the canonical turn stays in the claim`);
      assert.equal(
        claim?.entry.turns[0]?.content,
        "malformed model output probe",
        `attempt ${attempt}: content intact`
      );
    }
    // No-drop: no recovery side file may move the content aside.
    await assert.rejects(() => readdir(path.join(memoryDir, "state", "dropped")), { code: "ENOENT" });
    assert.equal(await hasFactFile(memoryDir, "malformed model output probe"), false);
  } finally {
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a live task queued while its session becomes claimed settles as claimed, never extracting the stale snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-claim-race-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
      extractionQueueConcurrency: 1,
    });
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    let engineCalls = 0;
    const extractionSeam = asTestSeam<{ extraction: { extract: () => Promise<DrainExtractionStubResult | null> } }>(
      orchestrator
    );
    extractionSeam.extraction = {
      extract: async (): Promise<DrainExtractionStubResult | null> => {
        engineCalls += 1;
        return { status: "completed", persistedCount: 0, durableOutputCount: 0 };
      },
    };

    const probe = {
      role: "user" as const,
      content: "claim race probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "race-sess",
    };
    await orchestrator.buffer.addTurn("race-sess", probe);
    await orchestrator.buffer.save();

    // Occupy the queue's only slot, then enqueue the LIVE task behind it: the
    // enqueue-time claim gate passes (the session is unclaimed) and the task
    // waits. While it waits, the scheduler's claim decision completes.
    let releaseBarrier: () => void = () => undefined;
    // A KEYED task occupies the concurrency-1 slot: raw tasks bypass the slot,
    // which would let the live task start before the claim decision.
    void orchestrator.extractionQueueCoordinator.enqueue(
      async () => {
        await new Promise<void>((done) => {
          releaseBarrier = done;
        });
      },
      { key: "race-barrier" }
    );

    const settled = Promise.withResolvers<{ reason?: string }>();
    // Test seam: enqueueing a LIVE buffered extraction directly is the only
    // way to interleave it with the claim decision; the coordinator method is
    // orchestrator-private.
    const queueSeam = asTestSeam<{
      queueBufferedExtraction: (
        turns: unknown[],
        reason: string,
        options: {
          bufferKey: string;
          skipDedupeCheck: boolean;
          clearBufferAfterExtraction: boolean;
          onTaskSettled: (error?: Error, result?: { reason?: string }) => void;
        }
      ) => Promise<void>;
    }>(orchestrator);
    void queueSeam
      .queueBufferedExtraction([probe], "trigger_mode", {
        bufferKey: "race-sess",
        skipDedupeCheck: true,
        clearBufferAfterExtraction: true,
        onTaskSettled: (error, result) => settled.resolve({ reason: result?.reason }),
      })
      .catch(() => undefined);
    const runner = new BufferDrainRunner(orchestrator);
    assert.equal(
      await runner.claim("race-sess", "race-owner"),
      true,
      "the scheduler's claim decision completes while the live task waits"
    );

    releaseBarrier();
    const settledResult = await settled.promise;
    assert.equal(
      settledResult.reason,
      "claimed_by_buffer_drain",
      "the queued live task must re-apply the claim gate at execution time"
    );
    assert.equal(engineCalls, 0, "the stale live snapshot must never reach the model");
    assert.equal(model.prompts.length, 0);
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a planless accepted claim group pins null: it stays unprofiled under the CURRENT profile", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-plan-null-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    // Active profile with NO writable layer (house "denied" shape): if the
    // drain failed to pin null for this planless ACCEPTED capture, the
    // current profile would refuse the write and the capture would strand.
    const config: PluginConfig = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
      scopeProfiles: {
        "denied-profile": {
          readOrder: ["userProject"],
          writeDefault: "userProject",
          promotionTargets: [],
          autoPromote: { enabled: false, targets: [], categories: [], minConfidenceTier: "speculative" },
        },
      },
      defaultScopeProfile: "denied-profile",
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);

    // NO writeNamespaceOverride: the null pin (not an explicit-namespace
    // override) is what keeps this capture outside the current profile gate.
    await orchestrator.buffer.addTurn("planless-sess", {
      role: "user",
      content: "planless accepted capture probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "planless-sess",
      acceptedCapture: true,
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("planless-sess", "drain-null"), true);

    const outcome = await runner.drainSession("planless-sess", { ownerId: "drain-null" });
    assert.equal(outcome.status, "drained", "the pinned null keeps the accepted capture unprofiled and writable");
    assert.ok(
      model.prompts.some((p) => p.includes("planless accepted capture probe")),
      "the capture reached the model"
    );
    assert.ok(
      await hasFactFile(memoryDir, "planless accepted capture probe"),
      "the fact persisted to the pinned namespace"
    );
    const claim = await runner.claims.load("planless-sess");
    assert.equal(claim?.entry.turns.length ?? 0, 0, "the claim empties after extraction");
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a pinned accepted claim group forwards its captured plan; flattening it to null loses the identity gate", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-plan-pin-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config: PluginConfig = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
      scopeProfiles: {
        "pinned-profile": {
          readOrder: ["userGlobal"],
          writeDefault: "userGlobal",
          promotionTargets: [],
          autoPromote: { enabled: false, targets: [], categories: [], minConfidenceTier: "speculative" },
        },
      },
      defaultScopeProfile: "pinned-profile",
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);

    // The capture pinned a plan captured under an OLDER policy: the CURRENT
    // resolution differs, so forwarding the plan (never flattening it to
    // null) is what lets the identity re-check refuse the scope.
    const resolved = resolveScopeProfilePlan({ config, principal: "alice", codingContext: null, codingOverlay: null });
    assert.ok(resolved, "the active profile resolves a plan");
    const stalePlan = { ...resolved, writeNamespace: "stale-captured-ns" };

    await orchestrator.buffer.addTurn("alice:pinned", {
      role: "user",
      content: "pinned plan identity probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "alice:pinned",
      acceptedCapture: true,
      writeNamespaceOverride: "alice",
      principalOverride: "alice",
      scopeProfileWritePlan: stalePlan,
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("alice:pinned", "drain-pin"), true);

    const outcome = await runner.drainSession("alice:pinned", { ownerId: "drain-pin" });
    assert.equal(outcome.status, "deferred", "a stale pinned plan is refused, not drained");
    assert.equal(outcome.reason, "scope_profile_revoked");
    assert.deepEqual(outcome.denied, [{ reason: "scope_profile_revoked", turns: 1 }]);
    assert.equal(model.prompts.length, 0, "the stale-pinned scope never reaches the model");
    assert.equal(await hasFactFile(memoryDir, "pinned plan identity probe"), false);
    const claim = await runner.claims.load("alice:pinned");
    assert.equal(claim?.entry.turns.length ?? 0, 1, "the denied turn stays claimed");
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("explicit capture mode denies ordinary backlog turns and still drains accepted captures", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-explicit-mode-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      captureMode: "explicit",
      openaiApiKey: "sk-test",
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);

    await orchestrator.buffer.addTurn("ordinary-sess", {
      role: "user",
      content: "ordinary explicit-mode probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "ordinary-sess",
    });
    await orchestrator.buffer.addTurn("accepted-sess", {
      role: "user",
      content: "accepted explicit-mode probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "accepted-sess",
      acceptedCapture: true,
      writeNamespaceOverride: "alice",
      principalOverride: "alice",
    });
    await orchestrator.buffer.save();

    // Ordinary conversation backlog: denied, retained, never extracted.
    assert.equal(await runner.claim("ordinary-sess", "drain-explicit"), true);
    const ordinary = await runner.drainSession("ordinary-sess", { ownerId: "drain-explicit" });
    assert.equal(ordinary.status, "deferred", "explicit mode keeps ordinary turns pending");
    assert.deepEqual(ordinary.denied, [{ reason: "capture_mode_explicit", turns: 1 }]);
    const ordinaryClaim = await runner.claims.load("ordinary-sess");
    assert.equal(ordinaryClaim?.entry.turns[0]?.content, "ordinary explicit-mode probe");

    // A deliberately accepted capture still drains under explicit mode.
    assert.equal(await runner.claim("accepted-sess", "drain-explicit"), true);
    const accepted = await runner.drainSession("accepted-sess", { ownerId: "drain-explicit" });
    assert.equal(accepted.status, "drained", "accepted captures drain under explicit mode");
    assert.ok(await hasFactFile(memoryDir, "accepted explicit-mode probe"), "the accepted capture persisted");

    // The ordinary scope never reached the model.
    assert.equal(
      model.prompts.some((p) => p.includes("ordinary explicit-mode probe")),
      false,
      "ordinary turns must not be extracted in explicit mode"
    );
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a mixed accepted+ordinary group splits: the accepted capture drains, the ordinary turn stays denied", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-mixed-group-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      captureMode: "explicit",
      openaiApiKey: "sk-test",
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);

    // IDENTICAL scope pins (same namespace + principal), differing ONLY in
    // acceptedCapture: the scope group key must not merge them — otherwise
    // the accepted capture's group drags the ordinary turn through the gate.
    await orchestrator.buffer.addTurn("mixed-sess", {
      role: "user",
      content: "accepted mixed probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "mixed-sess",
      acceptedCapture: true,
      writeNamespaceOverride: "alice",
      principalOverride: "alice",
    });
    await orchestrator.buffer.addTurn("mixed-sess", {
      role: "user",
      content: "ordinary mixed probe",
      timestamp: "2026-11-01T00:00:05.000Z",
      sessionKey: "mixed-sess",
      writeNamespaceOverride: "alice",
      principalOverride: "alice",
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("mixed-sess", "drain-mixed"), true);

    const outcome = await runner.drainSession("mixed-sess", { ownerId: "drain-mixed" });
    assert.equal(outcome.status, "deferred", "the ordinary turn keeps the session pending");
    assert.deepEqual(outcome.denied, [{ reason: "capture_mode_explicit", turns: 1 }]);

    // The accepted capture drained and persisted.
    assert.ok(await hasFactFile(memoryDir, "accepted mixed probe"), "the accepted capture persisted");

    // The ordinary turn's canonical copy stays in the claim, untouched.
    const claim = await runner.claims.load("mixed-sess");
    assert.deepEqual(
      claim?.entry.turns.map((turn) => turn.content),
      ["ordinary mixed probe"],
      "exactly the ordinary turn stays claimed"
    );

    // The ordinary content never reached the model.
    assert.equal(
      model.prompts.some((p) => p.includes("ordinary mixed probe")),
      false,
      "ordinary content must not be extracted in explicit mode"
    );
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scan reports claimed, unclaimed, and orphaned tombstone sessions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-scan-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);

    const turn = (key: string, content: string): BufferTurn => ({
      role: "user",
      content,
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: key,
    });
    await orchestrator.buffer.addTurn("scan-unclaimed", turn("scan-unclaimed", "unclaimed body"));
    await orchestrator.buffer.addTurn("scan-claimed", turn("scan-claimed", "claimed body"));
    await orchestrator.buffer.save();

    const before = await runner.scan();
    assert.deepEqual(
      before.find((entry) => entry.key === "scan-unclaimed"),
      { key: "scan-unclaimed", turns: 1, claimed: false }
    );

    assert.equal(await runner.claim("scan-claimed", "scan-owner"), true);
    const claimed = await runner.scan();
    const claimedEntry = claimed.find((entry) => entry.key === "scan-claimed");
    assert.equal(claimedEntry?.claimed, true, "a claimed session reports claimed");
    assert.equal(claimedEntry?.turns, 1);

    // Draining the claimed session leaves an ack tombstone: still listed so
    // an operator sees the drained claim exists (the live copy is gone).
    await runner.drainSession("scan-claimed", { ownerId: "scan-owner" });
    const after = await runner.scan();
    assert.ok(
      after.some((entry) => entry.key === "scan-claimed"),
      "the claimed key stays visible across the scan"
    );
    assert.ok(after.some((entry) => entry.key === "scan-unclaimed"));
  } finally {
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("drainSession skips a key with no claim, a busy lease, and an emptied claim", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-skip-paths-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);
    const claims = runner.claims;

    // Not claimed: nothing to drain.
    const notClaimed = await runner.drainSession("ghost-sess", { ownerId: "drain-skips" });
    assert.equal(notClaimed.status, "skipped");
    assert.equal(notClaimed.reason, "not_claimed");

    // Busy: another drainer holds the lease.
    await orchestrator.buffer.addTurn("busy-sess", {
      role: "user",
      content: "busy body",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "busy-sess",
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("busy-sess", "first-owner"), true);
    const busy = await runner.drainSession("busy-sess", { ownerId: "second-owner" });
    assert.equal(busy.status, "skipped");
    assert.equal(busy.reason, "claimed_by_another_drain");
    assert.equal(busy.turnsRemaining, 1);

    // Emptied claim: the ack verdict is honored (drained). The emptied entry
    // is written by the CURRENT lease holder (first-owner).
    const claimsEntry = await claims.load("busy-sess");
    await claims.writeEntry(
      "busy-sess",
      "first-owner",
      {
        ...claimsEntry!.entry,
        turns: [],
        retainedTurns: undefined,
        lastExtractionAt: new Date().toISOString(),
        extractionCount: (claimsEntry!.entry.extractionCount ?? 0) + 1,
      },
      claimsEntry!.entry
    );
    await claims.releaseLease("busy-sess", "first-owner");
    const emptied = await runner.drainSession("busy-sess", { ownerId: "second-owner" });
    assert.equal(emptied.status, "drained", "an emptied claim acks cleanly");
  } finally {
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an aborted drain waits for the in-flight persist before releasing the lease", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-abort-persist-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      ...NAMESPACED_FIXTURE,
      memoryDir,
      openaiApiKey: "sk-test",
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
    });
    orchestrator = await initializedOrchestrator(config);
    const runner = new BufferDrainRunner(orchestrator);

    // The persist runs until the abort lands: the abort settles the task
    // (abort listener) while the persist is still in flight.
    let persistStarted: () => void = () => undefined;
    let persistCompleted = false;
    const sequence: string[] = [];
    const persistStartedPromise = new Promise<void>((resolve) => {
      persistStarted = resolve;
    });
    const persistSeam = asTestSeam<{
      persistExtraction: (...cause: unknown[]) => Promise<{
        persistedIds: string[];
        memoryPathById: Map<string, string>;
        deferredCount: number;
        pendingReviewIds: string[];
      }>;
    }>(orchestrator);
    persistSeam.persistExtraction = async () => {
      persistStarted();
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      persistCompleted = true;
      sequence.push("persist-done");
      return { persistedIds: ["persisted-1"], memoryPathById: new Map(), deferredCount: 0, pendingReviewIds: [] };
    };

    // Releasing the lease while the gated persist is still in flight is
    // exactly the lease-loss window under review.
    const claimsStore = runner.claims;
    const realRelease = claimsStore.releaseLease.bind(claimsStore);
    claimsStore.releaseLease = async (leaseKey: string, ownerId: string) => {
      sequence.push(persistCompleted ? "release" : "release-early");
      return realRelease(leaseKey, ownerId);
    };

    await orchestrator.buffer.addTurn("abort-persist-sess", {
      role: "user",
      content: "abort persist probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "abort-persist-sess",
      acceptedCapture: true,
      writeNamespaceOverride: "alice",
      principalOverride: "alice",
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("abort-persist-sess", "drain-abort"), true);

    const controller = new AbortController();
    const drain = runner.drainSession("abort-persist-sess", { ownerId: "drain-abort", signal: controller.signal });
    await persistStartedPromise;
    controller.abort(new Error("shutdown"));
    const outcome = await drain;
    console.log(
      "MARK sequence",
      JSON.stringify(sequence),
      "outcome",
      outcome.status,
      outcome.reason,
      "turns",
      outcome.turnsRemaining,
      "denied",
      JSON.stringify(outcome.denied ?? [])
    );

    // The lease-loss window: releasing the lease while the gated persist is
    // still in flight (release-early) lets the closure's post-persist claim
    // write fail its ownership check, stranding already-persisted turns.
    assert.ok(
      !sequence.includes("release-early"),
      `the lease must not be released while the queued closure is still persisting (sequence: ${JSON.stringify(sequence)})`
    );
    assert.equal(sequence[0], "persist-done", "the in-flight persist completes before any lease bookkeeping");
    assert.equal(persistCompleted, true);
    assert.notEqual(outcome.reason, "not_claimed", "the drain accounted for the aborted session");
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});
