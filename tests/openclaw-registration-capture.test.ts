import test from "node:test";
import assert from "node:assert/strict";
import {
  captureOpenClawRegistrationApi,
  disableRegisterMigrationForCaptureTest,
  restoreOpenClawRegistrationGlobals,
  restoreRegisterMigrationForCaptureTest,
  saveAndResetOpenClawRegistrationGlobals,
} from "./helpers/openclaw-registration-harness.js";

async function withCapturedRegistration(
  fn: (plugin: { register(api: unknown): void }) => Promise<void> | void,
) {
  const saved = saveAndResetOpenClawRegistrationGlobals();
  const previousMigration = disableRegisterMigrationForCaptureTest();
  try {
    const { default: plugin } = await import("../src/index.js");
    await fn(plugin as { register(api: unknown): void });
  } finally {
    restoreRegisterMigrationForCaptureTest(previousMigration);
    restoreOpenClawRegistrationGlobals(saved);
  }
}

test("full modern registration captures hooks, commands, tools, memory capability, CLI, and service", async () => {
  await withCapturedRegistration((plugin) => {
    const capture = captureOpenClawRegistrationApi();

    plugin.register(capture.api);

    const hookNames = capture.hooks().map(([name]) => name).sort();
    assert.ok(hookNames.includes("before_prompt_build"));
    assert.ok(hookNames.includes("agent_end"));
    assert.ok(hookNames.includes("before_reset"));
    assert.ok(hookNames.includes("session_end"));

    assert.ok(
      capture.registrationNames("registerTool").includes("memory_search"),
      "registerTool should expose Remnic memory search",
    );
    assert.ok(
      capture.registrationNames("registerTool").includes("memory_get"),
      "registerTool should expose Remnic memory read",
    );
    assert.ok(
      capture.registrationNames("registerCommand").some((name) =>
        name === "remnic",
      ),
      "registerCommand should expose session memory commands",
    );
    assert.equal(capture.registrations("registerCli").length, 1);
    assert.deepEqual(capture.registrationNames("registerService"), [
      "openclaw-remnic",
    ]);

    const [memoryCapability] = capture.registrations("registerMemoryCapability");
    assert.ok(memoryCapability, "registerMemoryCapability should be called");
    const capability = memoryCapability[0] as Record<string, unknown>;
    assert.equal(typeof capability.promptBuilder, "function");
    assert.equal(typeof capability.flushPlanResolver, "function");
    assert.equal(typeof capability.runtime, "object");
    assert.equal(typeof capability.publicArtifacts, "object");

    assert.equal(
      capture.registrations("registerMemoryPromptSection").length,
      1,
      "modern SDKs should still receive the prompt-section registration",
    );
    assert.equal(
      capture.registrations("registerMemoryRuntime").length,
      1,
      "split SDKs should receive the same Remnic runtime surface",
    );
    assert.equal(
      capture.registrations("registerMemoryFlushPlan").length,
      1,
      "split SDKs should receive the same Remnic flush-plan surface",
    );
    const [flushPlanResolver] = capture.registrations("registerMemoryFlushPlan")[0] as [
      () => Record<string, unknown>,
    ];
    assert.equal(
      flushPlanResolver().relativePath,
      "state/plugins/openclaw-remnic/flush-plan.md",
    );
    assert.deepEqual(capture.registrationNames("registerMemoryCorpusSupplement"), [
      "openclaw-remnic:remnic-memory-corpus",
    ]);

    assert.equal(capture.registrations("registerMemoryEmbeddingProvider").length, 0);
    assert.equal(capture.registrations("registerCompactionProvider").length, 0);
  });
});

test("shim plugin ids keep flush-plan artifacts in their own plugin state namespace", async () => {
  await withCapturedRegistration((plugin) => {
    const capture = captureOpenClawRegistrationApi();

    plugin.register.call({ id: "openclaw-engram" }, capture.api);

    const [flushPlanResolver] = capture.registrations("registerMemoryFlushPlan")[0] as [
      () => Record<string, unknown>,
    ];
    assert.equal(
      flushPlanResolver().relativePath,
      "state/plugins/openclaw-engram/flush-plan.md",
    );
    assert.deepEqual(capture.registrationNames("registerMemoryCorpusSupplement"), [
      "openclaw-engram:remnic-memory-corpus",
    ]);
  });
});

test("split-only SDKs receive runtime and flush-plan registrations without unified capability", async () => {
  await withCapturedRegistration((plugin) => {
    const capture = captureOpenClawRegistrationApi({
      disabledMethods: ["registerMemoryCapability"],
    });

    plugin.register(capture.api);

    assert.equal(capture.registrations("registerMemoryCapability").length, 0);
    assert.equal(capture.registrations("registerMemoryRuntime").length, 1);
    assert.equal(capture.registrations("registerMemoryFlushPlan").length, 1);
  });
});

test("non-runtime registration modes do not register runtime hooks or services", async () => {
  await withCapturedRegistration((plugin) => {
    for (const registrationMode of [
      "discovery",
      "tool-discovery",
      "setup-only",
      "setup-runtime",
      "cli-metadata",
    ] as const) {
      const capture = captureOpenClawRegistrationApi({ registrationMode });

      plugin.register(capture.api);

      assert.deepEqual(capture.hooks(), [], registrationMode);
      assert.deepEqual(capture.registrations(), [], registrationMode);
    }
  });
});

test("passive slot mode suppresses active memory hooks and capability surfaces", async () => {
  await withCapturedRegistration((plugin) => {
    const capture = captureOpenClawRegistrationApi({
      config: {
        plugins: {
          slots: {
            memory: "another-memory-plugin",
          },
        },
      },
      pluginConfig: {
        slotBehavior: {
          onSlotMismatch: "silent",
        },
      },
    });

    plugin.register(capture.api);

    assert.deepEqual(
      capture.hooks(),
      [],
      "passive slot mode should not bind active memory lifecycle hooks",
    );
    assert.equal(capture.registrations("registerMemoryCapability").length, 0);
    assert.equal(capture.registrations("registerMemoryPromptSection").length, 0);
    assert.equal(capture.registrations("registerCommand").length, 0);
    assert.deepEqual(capture.registrationNames("registerMemoryCorpusSupplement"), [
      "openclaw-remnic:remnic-memory-corpus",
    ]);

    assert.ok(
      capture.registrationNames("registerTool").includes("memory_search"),
      "passive mode still exposes explicit tools",
    );
    assert.deepEqual(capture.registrationNames("registerService"), [
      "openclaw-remnic",
    ]);
  });
});

test("per-registry surfaces repeat while central command surfaces stay guarded", async () => {
  await withCapturedRegistration((plugin) => {
    const first = captureOpenClawRegistrationApi({ label: "first" });
    const second = captureOpenClawRegistrationApi({ label: "second" });

    plugin.register(first.api);
    plugin.register(second.api);

    assert.ok(first.registrations("registerTool").length > 0);
    assert.ok(second.registrations("registerTool").length > 0);
    assert.deepEqual(first.registrationNames("registerService"), [
      "openclaw-remnic",
    ]);
    assert.deepEqual(second.registrationNames("registerService"), [
      "openclaw-remnic",
    ]);
    assert.ok(first.registrations("registerMemoryCapability").length > 0);
    assert.ok(second.registrations("registerMemoryCapability").length > 0);

    assert.equal(first.registrations("registerCli").length, 1);
    assert.equal(
      second.registrations("registerCli").length,
      0,
      "CLI registration is process-global and must not duplicate",
    );
    assert.ok(first.registrations("registerCommand").length > 0);
    assert.equal(
      second.registrations("registerCommand").length,
      0,
      "session command descriptors are centrally guarded",
    );
  });
});
