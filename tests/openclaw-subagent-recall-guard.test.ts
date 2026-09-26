import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureOpenClawRegistrationApi,
  disableRegisterMigrationForCaptureTest,
  restoreOpenClawRegistrationGlobals,
  restoreRegisterMigrationForCaptureTest,
  saveAndResetOpenClawRegistrationGlobals,
  type CapturedOpenClawApi,
} from "./helpers/openclaw-registration-harness.js";

interface SubagentGuardContext {
  capture: CapturedOpenClawApi;
  orchestrator: Record<string, any>;
}

const ORCHESTRATOR_KEY = "__openclawEngramOrchestrator::openclaw-remnic";

async function withRegistration(fn: (context: SubagentGuardContext) => Promise<void> | void) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-subagent-"));
  const saved = saveAndResetOpenClawRegistrationGlobals();
  const previousMigration = disableRegisterMigrationForCaptureTest();
  try {
    // Dynamic import is required: the plugin entry reads and mutates the
    // registration globals this harness resets per test, so the module must
    // load after the reset, like tests/openclaw-hook-privacy.test.ts.
    const { default: plugin } = await import("../src/index.js");
    const capture = captureOpenClawRegistrationApi({
      pluginConfig: {
        memoryDir,
        modelSource: "gateway",
        qmdEnabled: false,
        debug: true,
      },
    });
    (plugin as { register(api: unknown): void }).register(capture.api);
    const orchestrator = (globalThis as Record<string, any>)[ORCHESTRATOR_KEY];
    assert.ok(orchestrator, "registration should expose the Remnic orchestrator");
    await fn({ capture, orchestrator });
  } finally {
    restoreRegisterMigrationForCaptureTest(previousMigration);
    restoreOpenClawRegistrationGlobals(saved);
    fs.rmSync(memoryDir, { force: true, recursive: true });
  }
}

function registeredHook(capture: CapturedOpenClawApi, name: string) {
  const handler = capture.hooks(name)[0]?.[1];
  assert.equal(typeof handler, "function", `expected registered hook ${name}`);
  return handler as (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<unknown>;
}

function injectedText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.prependSystemContext === "string") return record.prependSystemContext;
  if (Array.isArray(record.memoryLines)) return record.memoryLines.join("\n");
  return "";
}

type MemorySectionBuilder = (params: { sessionKey?: string }) => string[] | null;

function capturedSectionBuilder(capture: CapturedOpenClawApi): MemorySectionBuilder | undefined {
  const registration = capture.registrations("registerMemoryPromptSection")[0]?.[0];
  return typeof registration === "function"
    ? (registration as MemorySectionBuilder)
    : undefined;
}

/** On section-builder hosts the hook only pre-computes; the builder is the
 * injection surface. On hook-return hosts the hook result carries the text. */
function turnText(
  builder: MemorySectionBuilder | undefined,
  sessionKey: string,
  hookResult: unknown,
): string {
  if (!builder) return injectedText(hookResult);
  return (builder({ sessionKey }) ?? []).join("\n");
}

test("before_prompt_build never recalls for spawned subagent sessions (#3142)", async () => {
  await withRegistration(async ({ capture, orchestrator }) => {
    let recallCalls = 0;
    orchestrator.recall = async () => {
      recallCalls += 1;
      return "stale review opinions from an earlier pass";
    };

    const result = await registeredHook(capture, "before_prompt_build")(
      { prompt: "review this diff with fresh eyes" },
      { sessionKey: "agent:reviewer:subagent:abc123" },
    );

    assert.equal(result, undefined, "spawn-child session gets no memory injection");
    assert.equal(recallCalls, 0, "orchestrator recall never runs for a spawn-child session");
  });
});

test("before_prompt_build keeps recalling for main and unknown-key sessions", async () => {
  await withRegistration(async ({ capture, orchestrator }) => {
    let recallCalls = 0;
    orchestrator.recall = async () => {
      recallCalls += 1;
      return "Remember the rollout decision from last week.";
    };
    orchestrator.getLastRecall = () => undefined;
    const handler = registeredHook(capture, "before_prompt_build");
    const builder = capturedSectionBuilder(capture);

    const main = await handler(
      { prompt: "what did we decide about the rollout?" },
      { sessionKey: "agent:main:main" },
    );
    assert.match(
      turnText(builder, "agent:main:main", main),
      /Remember the rollout decision/,
      "main session still receives recall context",
    );

    const missingCtx = await handler(
      { prompt: "follow-up on the rollout decision" },
      {},
    );
    assert.match(
      turnText(builder, "default", missingCtx),
      /Remember the rollout decision/,
      "missing ctx sessionKey behaves like a normal session",
    );

    const emptyKey = await handler(
      { prompt: "one more rollout question" },
      { sessionKey: "" },
    );
    assert.match(
      turnText(builder, "", emptyKey),
      /Remember the rollout decision/,
      "empty sessionKey must not be misread as a subagent skip",
    );

    assert.equal(recallCalls, 3, "exactly the three non-subagent turns recalled");
  });
});
