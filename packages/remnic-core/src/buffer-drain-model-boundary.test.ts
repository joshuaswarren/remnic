//
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Orchestrator, parseConfig } from "./index.js";
import { namespaceIdentityToken } from "./namespaces/identity.js";
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
          const parsed = JSON.parse(raw) as { messages?: { role?: string; content?: string }[] };
          const user =
            parsed.messages
              ?.filter((m) => m.role === "user")
              .map((m) => m.content ?? "")
              .join("\n") ?? "";
          if (user) prompts.push(user);
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

function asTestSeam<T>(cause: unknown): T {
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
        sourceConnector: "omp",
        content,
        timestamp: `2026-11-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        sessionKey: "budget-sess",
        acceptedCapture: true,
        writeNamespaceOverride: "alice",
        principalOverride: "alice",
      });
    }
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("budget-sess", "drain-budget"), true);

    const outcome = await runner.drainSession("budget-sess", { ownerId: "drain-budget" });
    assert.equal(outcome.status, "drained", `expected a full drain, got ${outcome.reason ?? "deferred"}`);

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
    orchestrator = new Orchestrator(config);
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

    assert.equal(
      outcome.status,
      "deferred",
      `a denied scope is pending backlog, not drained (${outcome.reason ?? ""})`
    );
    assert.equal(outcome.reason, "scope_profile_no_writable_layer");
    assert.deepEqual(outcome.denied, [{ reason: "scope_profile_no_writable_layer", turns: 1 }]);

    assert.equal(model.prompts.length, 0, "the denied scope must never reach the model");
    assert.equal(
      await hasFactFile(memoryDir, "legacy unpinned profile probe"),
      false,
      "a refused scope writes no fact anywhere"
    );

    const claim = await runner.claims.load("alice:legacy");
    assert.equal(claim?.entry.turns.length ?? 0, 1, "the denied turn stays in the claim");
    assert.equal(claim?.entry.turns[0]?.content, "legacy unpinned profile probe");
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unpinned legacy drain writes under the ACTIVE profile namespace, never the principal default", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "drain-profile-namespace-"));
  const model = await startModelBoundary();
  let orchestrator: Orchestrator | undefined;
  try {
    const config: PluginConfig = parseConfig({
      ...NAMESPACED_FIXTURE,
      sharedNamespace: "shared",
      namespacePolicies: [
        { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
        { name: "default", readPrincipals: ["default"], writePrincipals: ["default"] },
        { name: "shared", readPrincipals: ["default"], writePrincipals: ["default"] },
      ],
      memoryDir,
      debug: true,
      openaiApiKey: "sk-test",
      openaiBaseUrl: model.url,
      qmdEnabled: false,
      workspaceDir: path.join(memoryDir, "workspace"),
      extractionMinChars: 0,
      extractionMinUserTurns: 1,
      scopeProfiles: {
        "sharedProfile": {
          readOrder: ["serverShared"],
          writeDefault: "serverShared",
          promotionTargets: ["serverShared"],
          autoPromote: { enabled: false, targets: [], categories: [], minConfidenceTier: "speculative" },
        },
      },
      defaultScopeProfile: "sharedProfile",
    });
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const runner = new BufferDrainRunner(orchestrator);

    await orchestrator.buffer.addTurn("bob:legacy", {
      role: "user",
      content: "profile namespace probe",
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionKey: "bob:legacy",
    });
    await orchestrator.buffer.save();
    assert.equal(await runner.claim("bob:legacy", "drain-namespace"), true);

    const outcome = await runner.drainSession("bob:legacy", { ownerId: "drain-namespace" });
    assert.equal(outcome.status, "drained", `expected a full drain, got ${outcome.reason ?? "deferred"}`);

    const factPath = await findFactPath(memoryDir, "profile namespace probe");
    assert.ok(factPath, "the drained fact was persisted");
    const plan = resolveScopeProfilePlan({ config, principal: "default", codingContext: null, codingOverlay: null });
    assert.equal(plan?.writeNamespace, "shared", "the active profile writes to the shared namespace");
    assert.ok(
      factPath.includes(path.join("namespaces", namespaceIdentityToken("shared"))),
      `the fact belongs to the ACTIVE profile namespace, not the default one: ${factPath}`
    );
    assert.equal(
      factPath.includes(path.join("namespaces", namespaceIdentityToken("default"))),
      false,
      `a flattened plan=null must not write into the default namespace: ${factPath}`
    );
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

    const extractorResults: unknown[] = [
      null,
      { facts: "not-an-array", entities: [], questions: [], profileUpdates: [] },
      null,
    ];
    interface DrainSeam {
      extraction: { extract: () => Promise<ExtractionRunResult | null> };
      drainExtraction: { extract: () => Promise<ExtractionRunResult | null> } | undefined;
    }
    const extractionSeam = asTestSeam<DrainSeam>(orchestrator);
    extractionSeam.extraction = {
      extract: async () => extractorResults.shift() as ExtractionRunResult | null,
    };
    // Claim drains extract on their own engine; stub it with the same results.
    extractionSeam.drainExtraction = extractionSeam.extraction;

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

    let releaseBarrier: () => void = () => undefined;
    void orchestrator.extractionQueueCoordinator.enqueue(
      async () => {
        await new Promise<void>((done) => {
          releaseBarrier = done;
        });
      },
      { key: "race-barrier" }
    );

    const settled = Promise.withResolvers<{ reason?: string }>();
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

    assert.equal(await runner.claim("ordinary-sess", "drain-explicit"), true);
    const ordinary = await runner.drainSession("ordinary-sess", { ownerId: "drain-explicit" });
    assert.equal(ordinary.status, "deferred", "explicit mode keeps ordinary turns pending");
    assert.deepEqual(ordinary.denied, [{ reason: "capture_mode_explicit", turns: 1 }]);
    const ordinaryClaim = await runner.claims.load("ordinary-sess");
    assert.equal(ordinaryClaim?.entry.turns[0]?.content, "ordinary explicit-mode probe");

    assert.equal(await runner.claim("accepted-sess", "drain-explicit"), true);
    const accepted = await runner.drainSession("accepted-sess", { ownerId: "drain-explicit" });
    assert.equal(accepted.status, "drained", "accepted captures drain under explicit mode");
    assert.ok(await hasFactFile(memoryDir, "accepted explicit-mode probe"), "the accepted capture persisted");

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

    assert.ok(await hasFactFile(memoryDir, "accepted mixed probe"), "the accepted capture persisted");

    const claim = await runner.claims.load("mixed-sess");
    assert.deepEqual(
      claim?.entry.turns.map((turn) => turn.content),
      ["ordinary mixed probe"],
      "exactly the ordinary turn stays claimed"
    );

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

    const notClaimed = await runner.drainSession("ghost-sess", { ownerId: "drain-skips" });
    assert.equal(notClaimed.status, "skipped");
    assert.equal(notClaimed.reason, "not_claimed");

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
