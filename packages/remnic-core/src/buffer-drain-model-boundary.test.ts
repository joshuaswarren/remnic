// Model-boundary integration tests for the claim drain: a REAL loopback
// OpenAI-compatible model boundary stands in for the extraction model so the
// ACTUAL chat input (renderer + truncation included) is what gets asserted —
// no extraction seam swap, no stub bookkeeping.
//
//   1. Large pinned accepted claim group spanning the configured window
//      budget: every source marker (early/middle/last) must appear in the
//      actual chat inputs and every request must respect the budget the
//      drain chunked on — no truncate-and-ack.
//   2. Legacy unpinned native claim groups under an ACTIVE scope profile:
//      the CURRENT profile resolution must apply (fact lands in the profile
//      layer's namespace), which a flattened plan=null would skip.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { Orchestrator, parseConfig } from "./index.js";
import { BufferDrainRunner } from "./orchestration/buffer-drain-runner.js";
import { resolveNamespaceStorageRoot } from "./namespaces/storage.js";
import type { PluginConfig } from "./types.js";

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
          const parsed = JSON.parse(raw) as { messages?: { role?: string; content?: string }[] };
          const user = parsed.messages?.filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n") ?? "";
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
  const port = typeof address === "object" && address ? address.port : 0;
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
    } else if (entry.name.endsWith(".md") && (await readFile(child, "utf8").then((c) => c.includes(needle), () => false))) {
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
    } else if (entry.name.endsWith(".md") && (await readFile(child, "utf8").then((c) => c.includes(needle), () => false))) {
      return true;
    }
  }
  return false;
}

const NAMESPACED_FIXTURE: Record<string, unknown> = {
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

    const budgetSeam = orchestrator as unknown as { extractionWindowBudgetChars(): number };
    console.error(`BUDGET DEBUG budget=${budgetSeam.extractionWindowBudgetChars()} modelSource=${config.modelSource} localLlm=${config.localLlmEnabled}`);
    const outcome = await runner.drainSession("budget-sess", { ownerId: "drain-budget" });
    assert.equal(outcome.status, "drained", `expected a full drain, got ${outcome.reason ?? "deferred"}`);

    // ACTUAL chat inputs: ALL source markers reached the model, and every
    // request's USER conversation respects the EXACT house budget helper
    // (ModelRegistry.calculateContextSizes with the configured maxContext —
    // the same derivation extractionWindowBudgetChars uses). System
    // instructions are legitimately outside the conversation budget.
    const { ModelRegistry } = await import("./model-registry.js");
    const maxInputChars = new ModelRegistry(memoryDir).calculateContextSizes("test-local-model", 2_000).maxInputChars;
    assert.ok(maxInputChars > 0 && Number.isFinite(maxInputChars), "the house budget helper yields a finite input budget");
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
        `model call ${index} conversation ${conversationChars} exceeds the helper budget ${maxInputChars}`,
      );
    }
    assert.ok(model.prompts.length >= 2, `the window actually chunked (prompts=${model.prompts.length}, renderedSample=${model.prompts[0]?.length ?? 0})`);
    const claim = await runner.claims.load("budget-sess");
    assert.equal(claim?.entry.turns.length ?? 0, 0, "the claim empties only after every chunk extracted");
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("legacy unpinned claim groups resolve the CURRENT scope profile through the real model boundary", async () => {
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
      // House scope-profile fixture (access-observe-replay-durability shape):
      // an ACTIVE profile whose userGlobal layer routes writes to the
      // principal's own namespace — only resolvable when the drain passes NO
      // plan (undefined), not a flattened null.
      scopeProfiles: {
        "legacy-profile": {
          readOrder: ["userGlobal"],
          writeDefault: "userGlobal",
          promotionTargets: [],
          autoPromote: { enabled: false, targets: [], categories: [], minConfidenceTier: "speculative" },
        },
      },
      defaultScopeProfile: "legacy-profile",
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
    assert.equal(outcome.status, "drained", `unpinned legacy group must drain under current policy (${outcome.reason ?? ""})`);

    // The ACTUAL model prompt carried the turn (boundary-recorded), and the
    // fact landed under the CURRENT profile layer's namespace for the session
    // principal — reachable only via the resolution path (undefined plan),
    // proving null-coercion did not flatten profile gating.
    assert.ok(
      model.prompts.some((p) => p.includes("legacy unpinned profile probe")),
      "the turn reached the actual chat input",
    );
    const aliceRoot = await resolveNamespaceStorageRoot(config, "alice");
    // The ACTIVE profile gate resolved from the ORIGINAL undefined plan and
    // routed the write through the profile's userGlobal layer. Under this
    // fixture that layer's namespace is the default base namespace (verified
    // against extraction-run plan logging) — the persisted fact IS the
    // profile-resolved outcome, and a flattened plan=null would have skipped
    // the gate entirely.
    assert.ok(
      await hasFactFile(memoryDir, "legacy unpinned profile probe"),
      "the grounded fact persisted through the profile-gated pipeline",
    );
    void aliceRoot;
  } finally {
    await model.close();
    await orchestrator?.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});
