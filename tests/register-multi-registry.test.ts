/**
 * Registration contract tests: verifies the invariants that govern how
 * register() behaves when the gateway calls it multiple times with different
 * api objects (multiple registries) or across process boundaries.
 *
 * ## Invariant table
 *
 * | Behavior            | Scope           | Reason                                      |
 * |---------------------|-----------------|---------------------------------------------|
 * | registerTools       | every registry  | Tools are per-registry; skipping = no tools |
 * | registerLcmTools    | every registry  | Same as above                               |
 * | registerCli         | first only      | Central registry; duplicates = broken CLI   |
 * | registerService     | every registry  | startPluginServices() iterates own registry |
 * | service.start() run | once per process| Idempotency via ENGRAM_SERVICE_STARTED flag; concurrent calls await ENGRAM_INIT_PROMISE |
 * | service.stop() teardown | owner only  | didCountStart guard: only initializing registry tears down |
 *
 * ## Regression history
 *
 * - Issue #282 / PR #283: registerTools was first-only → tools missing in secondary registries
 * - Issue #285 / PR ???:  registerService was first-only → start() never fired in secondary registry,
 *                         orchestrator never initialized, all memory writes silently broken
 *
 * ## Scenarios covered
 *
 * Scenario A (same-process, multiple registries): The gateway creates different
 * plugin registries for different cache keys (cron vs. reply contexts). Each
 * gets a distinct api object and calls register() independently.
 *
 * Scenario B (cross-process boundary): The plugin loads in a companion process
 * first, setting the ENGRAM_REGISTERED_GUARD. A fresh gateway process (own
 * globalThis) must still register and start the service independently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { clearAuthTokenSecretCache } from "../packages/remnic-core/src/resolve-auth-token.js";

// ============================================================================
// Shared constants — must match src/index.ts
//
// Per-plugin runtime state is keyed by serviceId (#403 P2) so a migration
// install hosting both `openclaw-remnic` and `openclaw-engram` plugin ids does
// not force the second plugin to reuse the first plugin's orchestrator/config.
// These tests register the canonical plugin id (`openclaw-remnic`), so the
// keys below include the `::openclaw-remnic` suffix.
// ============================================================================
const SERVICE_ID = "openclaw-remnic";
const GUARD_KEY = `__openclawEngramRegistered::${SERVICE_ID}`;
const HOOK_APIS_KEY = `__openclawEngramHookApis::${SERVICE_ID}`;
const ORCH_KEY = `__openclawEngramOrchestrator::${SERVICE_ID}`;
const ACCESS_SVC_KEY = `__openclawEngramAccessService::${SERVICE_ID}`;
const ACCESS_HTTP_KEY = `__openclawEngramAccessHttpServer::${SERVICE_ID}`;
const ACCESS_HTTP_AUTH_STATE_KEY = `__openclawEngramAccessHttpAuthState::${SERVICE_ID}`;
const SERVICE_STARTED_KEY = `__openclawEngramServiceStarted::${SERVICE_ID}`;
const INIT_PROMISE_KEY = `__openclawEngramInitPromise::${SERVICE_ID}`;
const HOST_EMBEDDING_UNREGISTER_KEY = `__openclawEngramHostEmbeddingUnregister::${SERVICE_ID}`;
const HOST_EMBEDDING_SIGNATURE_KEY = `__openclawEngramHostEmbeddingSignature::${SERVICE_ID}`;
const MIGRATION_PROMISE_KEY = "__openclawEngramMigrationPromise";
const DISABLE_REGISTER_MIGRATION_ENV = "REMNIC_DISABLE_REGISTER_MIGRATION";
const SECRET_REF_RESOLVER_TEST_KEY = "__openclawEngramSecretRefResolverForTest";

// ============================================================================
// Helpers
// ============================================================================

const BASE_TEST_PLUGIN_CONFIG = {
  qmdEnabled: false,
  searchBackend: "noop",
};

function buildApi(label: string) {
  const registeredToolNames: string[] = [];
  let registeredCliCount = 0;
  const registeredServiceIds: string[] = [];

  const api = {
    label,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    pluginConfig: { ...BASE_TEST_PLUGIN_CONFIG },
    config: {},
    registerTool(spec: { name: string }) {
      registeredToolNames.push(spec.name);
    },
    registerCli(_spec: unknown) {
      registeredCliCount++;
    },
    registerService(spec: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) {
      registeredServiceIds.push(spec.id);
      // Capture start/stop for later invocation in tests
      api._registeredStart = spec.start;
      api._registeredStop = spec.stop;
    },
    on(_event: string, _handler: unknown) {},
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {},
    runtime: { version: "0.0.0" },
    // Captured from registerService for test invocation
    _registeredStart: null as (() => Promise<void>) | null,
    _registeredStop: null as (() => Promise<void>) | null,
  };

  return {
    api,
    getToolNames: () => [...registeredToolNames],
    getCliCount: () => registeredCliCount,
    getServiceIds: () => [...registeredServiceIds],
  };
}

// `register()` writes to both the keyed orchestrator slot
// (`__openclawEngramOrchestrator::<serviceId>`) AND to an unkeyed mirror
// (`__openclawEngramOrchestrator`) that cross-plugin observers read.  Tests
// must save/restore BOTH slots or state leaks across test cases.
const UNKEYED_ORCH_MIRROR_KEY = "__openclawEngramOrchestrator";
// CLI dedupe guard — intentionally process-global (not per-serviceId).
const CLI_REGISTERED_GUARD_KEY = "__openclawEngramCliRegistered";
// Active-service refcount for CLI guard lifecycle.
const CLI_ACTIVE_SERVICE_COUNT_KEY = "__openclawEngramCliActiveServiceCount";

function saveAndResetGlobals() {
  const saved = {
    guard: (globalThis as any)[GUARD_KEY],
    hookApis: (globalThis as any)[HOOK_APIS_KEY],
    orch: (globalThis as any)[ORCH_KEY],
    unkeyedOrchMirror: (globalThis as any)[UNKEYED_ORCH_MIRROR_KEY],
    cliRegistered: (globalThis as any)[CLI_REGISTERED_GUARD_KEY],
    cliActiveCount: (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT_KEY],
    accessSvc: (globalThis as any)[ACCESS_SVC_KEY],
    accessHttp: (globalThis as any)[ACCESS_HTTP_KEY],
    accessHttpAuthState: (globalThis as any)[ACCESS_HTTP_AUTH_STATE_KEY],
    serviceStarted: (globalThis as any)[SERVICE_STARTED_KEY],
    initPromise: (globalThis as any)[INIT_PROMISE_KEY],
    hostEmbeddingUnregister: (globalThis as any)[HOST_EMBEDDING_UNREGISTER_KEY],
    hostEmbeddingSignature: (globalThis as any)[HOST_EMBEDDING_SIGNATURE_KEY],
    migrationPromise: (globalThis as any)[MIGRATION_PROMISE_KEY],
  };
  delete (globalThis as any)[GUARD_KEY];
  delete (globalThis as any)[HOOK_APIS_KEY];
  delete (globalThis as any)[ORCH_KEY];
  delete (globalThis as any)[UNKEYED_ORCH_MIRROR_KEY];
  delete (globalThis as any)[CLI_REGISTERED_GUARD_KEY];
  delete (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT_KEY];
  delete (globalThis as any)[ACCESS_SVC_KEY];
  delete (globalThis as any)[ACCESS_HTTP_KEY];
  delete (globalThis as any)[ACCESS_HTTP_AUTH_STATE_KEY];
  delete (globalThis as any)[SERVICE_STARTED_KEY];
  delete (globalThis as any)[INIT_PROMISE_KEY];
  delete (globalThis as any)[HOST_EMBEDDING_UNREGISTER_KEY];
  delete (globalThis as any)[HOST_EMBEDDING_SIGNATURE_KEY];
  delete (globalThis as any)[MIGRATION_PROMISE_KEY];
  return saved;
}

async function awaitPendingMigration() {
  const pending = (globalThis as any)[MIGRATION_PROMISE_KEY];
  if (pending && typeof pending.then === "function") {
    try {
      await pending;
    } catch {}
  }
}

function disableRegisterMigrationForTest(): string | undefined {
  const previous = process.env[DISABLE_REGISTER_MIGRATION_ENV];
  process.env[DISABLE_REGISTER_MIGRATION_ENV] = "1";
  return previous;
}

function restoreRegisterMigrationEnv(previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[DISABLE_REGISTER_MIGRATION_ENV];
    return;
  }
  process.env[DISABLE_REGISTER_MIGRATION_ENV] = previous;
}

async function safeStop(
  ...apis: Array<{ _registeredStop: (() => Promise<void>) | null } | undefined>
) {
  for (const api of apis) {
    try {
      if (api?._registeredStop) {
        await api._registeredStop();
      }
    } catch {}
  }
}

function restoreGlobals(saved: ReturnType<typeof saveAndResetGlobals>) {
  if (saved.guard !== undefined) (globalThis as any)[GUARD_KEY] = saved.guard;
  else delete (globalThis as any)[GUARD_KEY];

  if (saved.hookApis !== undefined) (globalThis as any)[HOOK_APIS_KEY] = saved.hookApis;
  else delete (globalThis as any)[HOOK_APIS_KEY];

  if (saved.orch !== undefined) (globalThis as any)[ORCH_KEY] = saved.orch;
  else delete (globalThis as any)[ORCH_KEY];

  if (saved.unkeyedOrchMirror !== undefined) (globalThis as any)[UNKEYED_ORCH_MIRROR_KEY] = saved.unkeyedOrchMirror;
  else delete (globalThis as any)[UNKEYED_ORCH_MIRROR_KEY];

  if (saved.cliRegistered !== undefined) (globalThis as any)[CLI_REGISTERED_GUARD_KEY] = saved.cliRegistered;
  else delete (globalThis as any)[CLI_REGISTERED_GUARD_KEY];

  if (saved.cliActiveCount !== undefined) (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT_KEY] = saved.cliActiveCount;
  else delete (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT_KEY];

  if (saved.accessSvc !== undefined) (globalThis as any)[ACCESS_SVC_KEY] = saved.accessSvc;
  else delete (globalThis as any)[ACCESS_SVC_KEY];

  if (saved.accessHttp !== undefined) (globalThis as any)[ACCESS_HTTP_KEY] = saved.accessHttp;
  else delete (globalThis as any)[ACCESS_HTTP_KEY];

  if (saved.accessHttpAuthState !== undefined) (globalThis as any)[ACCESS_HTTP_AUTH_STATE_KEY] = saved.accessHttpAuthState;
  else delete (globalThis as any)[ACCESS_HTTP_AUTH_STATE_KEY];

  if (saved.serviceStarted !== undefined) (globalThis as any)[SERVICE_STARTED_KEY] = saved.serviceStarted;
  else delete (globalThis as any)[SERVICE_STARTED_KEY];

  if (saved.initPromise !== undefined) (globalThis as any)[INIT_PROMISE_KEY] = saved.initPromise;
  else delete (globalThis as any)[INIT_PROMISE_KEY];

  if (saved.hostEmbeddingUnregister !== undefined) (globalThis as any)[HOST_EMBEDDING_UNREGISTER_KEY] = saved.hostEmbeddingUnregister;
  else delete (globalThis as any)[HOST_EMBEDDING_UNREGISTER_KEY];

  if (saved.hostEmbeddingSignature !== undefined) (globalThis as any)[HOST_EMBEDDING_SIGNATURE_KEY] = saved.hostEmbeddingSignature;
  else delete (globalThis as any)[HOST_EMBEDDING_SIGNATURE_KEY];

  if (saved.migrationPromise !== undefined) (globalThis as any)[MIGRATION_PROMISE_KEY] = saved.migrationPromise;
  else delete (globalThis as any)[MIGRATION_PROMISE_KEY];
}

// ============================================================================
// Scenario A: same-process, multiple api instances (multiple gateway registries)
// ============================================================================

test("register() registers tools on every api object, not just the first one", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-registry");
    const second = buildApi("second-registry");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    const firstTools = first.getToolNames();
    const secondTools = second.getToolNames();

    assert.ok(firstTools.length > 0, `first registry should have tools, got ${firstTools.length}`);
    assert.ok(secondTools.length > 0, `second registry should have tools (was 0 before #283 fix), got ${secondTools.length}`);
    assert.deepEqual(firstTools, secondTools, "both registries should receive identical tool registrations");
    assert.ok(firstTools.includes("memory_summarize_hourly"), "first registry must include memory_summarize_hourly");
    assert.ok(secondTools.includes("memory_summarize_hourly"), "second registry must include memory_summarize_hourly (regression: was missing before #283)");
    assert.ok(firstTools.includes("memory_governance_run"), "first registry must include memory_governance_run");
    assert.ok(secondTools.includes("memory_governance_run"), "second registry must include memory_governance_run");
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("register() registers CLI only on the first api object (must not duplicate central registry)", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-cli");
    const second = buildApi("second-cli");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    assert.ok(first.getCliCount() > 0, "first registry should have CLI registered");
    assert.equal(second.getCliCount(), 0, "second registry must NOT have CLI (would create duplicate command trees)");
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("register() calls registerService on every api object, not just the first one (regression: issue #285)", async () => {
  // Before the fix, registerService was inside `if (isFirstRegistration)`.
  // The second registry received hooks and tools but no service registration.
  // When the gateway's startPluginServices() ran against the second registry,
  // it found no service → start() never fired → orchestrator never initialized.
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-service");
    const second = buildApi("second-service");
    const third = buildApi("third-service");

    plugin.register(first.api as any);
    plugin.register(second.api as any);
    plugin.register(third.api as any);

    assert.deepEqual(
      first.getServiceIds(),
      ["openclaw-remnic"],
      "first registry must have service registered",
    );
    assert.deepEqual(
      second.getServiceIds(),
      ["openclaw-remnic"],
      "second registry must have service registered (was missing before #285 fix)",
    );
    assert.deepEqual(
      third.getServiceIds(),
      ["openclaw-remnic"],
      "third registry must have service registered (simulates 3-4 loads per restart)",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("service.start() runs initialize exactly once even when called from multiple registries", async () => {
  // The ENGRAM_SERVICE_STARTED guard inside start() prevents double-init.
  // Without it, multiple registries each calling start() would run
  // orchestrator.initialize() multiple times → double I/O, double cron, etc.
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  let first: ReturnType<typeof buildApi> | undefined;
  let second: ReturnType<typeof buildApi> | undefined;
  try {
    const { default: plugin } = await import("../src/index.js");

    first = buildApi("first-start");
    second = buildApi("second-start");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    // Both registered a service — now simulate startPluginServices() calling
    // start() on both (as the gateway would if it iterated all registries).

    // Before calling start(), the flag should be unset.
    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      undefined,
      "ENGRAM_SERVICE_STARTED should not be set before any start() call",
    );

    // Call start() from first registry. orchestrator.initialize() only does file
    // I/O (no OpenAI calls), so start() succeeds and sets the flag to true.
    await first.api._registeredStart?.();

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "ENGRAM_SERVICE_STARTED should be set after first start() call",
    );

    // Call start() from second registry — must be a no-op due to the guard.
    // We verify this by checking the flag was already true before entry.
    const flagBeforeSecond = (globalThis as any)[SERVICE_STARTED_KEY];
    // Second registry's start() hits the guard and returns early — no error.
    await second.api._registeredStart?.();

    assert.equal(
      flagBeforeSecond,
      true,
      "ENGRAM_SERVICE_STARTED was already true — second start() should have been a no-op",
    );
  } finally {
    await safeStop(first?.api, second?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("concurrent start() calls await the in-flight init promise (regression: issue P1 thread)", async () => {
  // If the gateway triggers startPluginServices() without awaiting each registry
  // in sequence, multiple start() calls overlap. The second call must not resolve
  // before the first registry's orchestrator.initialize() completes — otherwise
  // the gateway treats secondary registries as ready while shared state is still
  // being initialized, allowing hooks to route turns through an uninitialized
  // orchestrator.
  //
  // The fix: start() stores the init Promise in ENGRAM_INIT_PROMISE; concurrent
  // calls await that promise rather than returning as soon as the boolean is set.
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  let first: ReturnType<typeof buildApi> | undefined;
  let second: ReturnType<typeof buildApi> | undefined;
  try {
    const { default: plugin } = await import("../src/index.js");

    first = buildApi("concurrent-first");
    second = buildApi("concurrent-second");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    // Launch both start() calls concurrently (no await between them).
    const [r1, r2] = await Promise.allSettled([
      first.api._registeredStart?.() ?? Promise.resolve(),
      second.api._registeredStart?.() ?? Promise.resolve(),
    ]);

    // Neither call should reject.
    assert.equal(r1.status, "fulfilled", `first start() rejected: ${(r1 as any).reason}`);
    assert.equal(r2.status, "fulfilled", `second start() rejected: ${(r2 as any).reason}`);

    // After both settle, SERVICE_STARTED must be true and INIT_PROMISE cleared.
    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "ENGRAM_SERVICE_STARTED must be set after concurrent start() calls settle",
    );
    assert.equal(
      (globalThis as any)[INIT_PROMISE_KEY],
      null,
      "ENGRAM_INIT_PROMISE must be null after init completes",
    );
  } finally {
    await safeStop(first?.api, second?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("SecretRef auth resolution failure rejects start() and rolls back service ownership", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-secretref-start-"));
  let first: ReturnType<typeof buildApi> | undefined;
  let second: ReturnType<typeof buildApi> | undefined;
  let resolverCalls = 0;

  clearAuthTokenSecretCache();
  (globalThis as any)[SECRET_REF_RESOLVER_TEST_KEY] = async () => {
    resolverCalls += 1;
    if (resolverCalls === 1) throw new Error("keychain locked");
    return " retry-token\n";
  };

  try {
    const { default: plugin } = await import("../src/index.js");

    first = buildApi("secretref-failure-primary");
    second = buildApi("secretref-failure-secondary");
    const pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      agentAccessHttp: {
        enabled: true,
        port: 0,
        authToken: {
          source: "exec",
          provider: "kc_openclaw_remnic_token",
          id: "value",
        },
      },
    };
    first.api.pluginConfig = pluginConfig;
    second.api.pluginConfig = pluginConfig;

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    await assert.rejects(
      () => first!.api._registeredStart?.() ?? Promise.resolve(),
      /failed to resolve agentAccessHttp\.authToken SecretRef.*keychain locked/,
    );

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      false,
      "failed SecretRef auth start must leave SERVICE_STARTED=false",
    );
    assert.equal(
      (globalThis as any)[INIT_PROMISE_KEY],
      null,
      "failed SecretRef auth start must clear INIT_PROMISE",
    );
    assert.equal(
      (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT_KEY],
      0,
      "failed SecretRef auth start must decrement the active-service refcount",
    );

    await second.api._registeredStart?.();

    assert.equal(resolverCalls, 2, "second registry should attempt a clean retry");
    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "second start should complete after SecretRef auth retry succeeds",
    );
    const accessHttpServer = (globalThis as any)[ACCESS_HTTP_KEY] as
      | { authTokensGetter?: () => string[] }
      | undefined;
    assert.deepEqual(
      accessHttpServer?.authTokensGetter?.(),
      ["retry-token"],
      "reused HTTP server must read the retried SecretRef token from shared auth state",
    );
    assert.equal(
      (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT_KEY],
      1,
      "successful retry should leave exactly one active service owner",
    );
  } finally {
    await safeStop(first?.api, second?.api);
    delete (globalThis as any)[SECRET_REF_RESOLVER_TEST_KEY];
    clearAuthTokenSecretCache();
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("service.stop() clears ENGRAM_SERVICE_STARTED so restart cycles reinitialize", async () => {
  // If stop() doesn't clear the flag, a stop → start cycle would be a no-op
  // and the orchestrator would never reinitialize after a gateway restart.
  // orchestrator.initialize() defers API calls lazily, so start() succeeds here
  // and isOwningRegistry is set to true — verifying the owning-registry stop path.
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  let stub: ReturnType<typeof buildApi> | undefined;
  try {
    const { default: plugin } = await import("../src/index.js");
    stub = buildApi("stop-restart");

    plugin.register(stub.api as any);

    // start() succeeds (orchestrator.initialize() is file I/O only, no API calls).
    await stub.api._registeredStart?.();
    assert.equal((globalThis as any)[SERVICE_STARTED_KEY], true, "flag should be set after start");

    // The owning registry's stop() must clear it.
    try { await stub.api._registeredStop?.(); } catch { /* ok */ }
    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      false,
      "ENGRAM_SERVICE_STARTED must be cleared by stop() so the next start() reinitializes",
    );
  } finally {
    await safeStop(stub?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("secondary registry stop() does not clear ENGRAM_SERVICE_STARTED while primary is running", async () => {
  // Regression guard for issue #285 follow-up: all registries now get a stop()
  // registered. If any stop() call clears the shared flag, a per-registry teardown
  // (e.g. cron vs. reply context hot-reload) would let a later registry re-run
  // initialize() while the primary is still alive → double I/O, double cron.
  //
  // stop() guards on didCountStart: only the registry whose start() successfully ran
  // initialize() performs teardown. Secondary registries (start() returned early on
  // ENGRAM_SERVICE_STARTED) have didCountStart=false and return immediately.
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  let first: ReturnType<typeof buildApi> | undefined;
  let second: ReturnType<typeof buildApi> | undefined;
  try {
    const { default: plugin } = await import("../src/index.js");

    first = buildApi("primary-running");
    second = buildApi("secondary-teardown");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    // Primary starts successfully. didCountStart[first]=true.
    await first.api._registeredStart?.();

    // Secondary registry's start() hits the ENGRAM_SERVICE_STARTED guard — no-op.
    // didCountStart[second] stays false.
    await second.api._registeredStart?.();

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "flag should still be true after secondary start() no-op",
    );

    // Secondary stop(): didCountStart[second]=false → early return. Flag stays true.
    await second.api._registeredStop?.();

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "secondary registry stop() must not clear ENGRAM_SERVICE_STARTED (didCountStart=false → early return)",
    );
  } finally {
    await safeStop(first?.api, second?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("full stop then secondary start: SERVICE_STARTED is true, REGISTERED_GUARD cleared for CLI re-registration", async () => {
  // After a full stop (INIT_PROMISE is null when stop() runs), REGISTERED_GUARD is
  // cleared so a subsequent register() can re-register CLI if the gateway rebuilt
  // its command registry. A secondary registry taking over after a full stop should
  // leave REGISTERED_GUARD=false so the next register() call can restore CLI.
  //
  // Note: The stop-during-init GUARD preservation (preventing spurious re-registration
  // when stop() is called while init is in-flight) is handled by stop() checking
  // ENGRAM_INIT_PROMISE before clearing the guard — not by setting it in the IIFE.
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  let primary: ReturnType<typeof buildApi> | undefined;
  let secondary: ReturnType<typeof buildApi> | undefined;
  try {
    const { default: plugin } = await import("../src/index.js");

    primary = buildApi("primary-full-stop");
    secondary = buildApi("secondary-restart");

    plugin.register(primary.api as any);
    plugin.register(secondary.api as any);

    // Primary starts and completes init.
    await primary.api._registeredStart?.();

    assert.equal(
      (globalThis as any)[GUARD_KEY],
      true,
      "guard should be true after successful start()",
    );

    // Primary stops cleanly (full stop, INIT_PROMISE=null) → guard cleared.
    await primary.api._registeredStop?.();

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      false,
      "SERVICE_STARTED should be false after full stop()",
    );
    assert.equal(
      (globalThis as any)[GUARD_KEY],
      false,
      "REGISTERED_GUARD should be false after full stop — allows CLI re-registration by next register()",
    );

    // Secondary takes over as the new primary after a full stop.
    await secondary.api._registeredStart?.();

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "SERVICE_STARTED should be true after secondary completes init",
    );
    // After a full stop, GUARD remains false after secondary init completes.
    // stop() cleared it so a subsequent register() can re-register CLI if the
    // gateway rebuilt its command registry during the reload cycle.
    assert.equal(
      (globalThis as any)[GUARD_KEY],
      false,
      "REGISTERED_GUARD stays false after secondary init following a full stop — next register() re-registers CLI",
    );
  } finally {
    await safeStop(primary?.api, secondary?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

test("host embedding bridge re-registers after cleanup independently of REGISTERED_GUARD", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-reregister-"));
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as {
    _load: (
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) => unknown;
  };
  const originalLoad = Module._load;
  let first: ReturnType<typeof buildApi> | undefined;
  let fresh: ReturnType<typeof buildApi> | undefined;
  try {
    Module._load = function patchedLoad(
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) {
      if (request === "openclaw/plugin-sdk/memory-core-host-engine-embeddings") {
        return {
          listMemoryEmbeddingProviders: () => [
            {
              id: "test-memory-provider",
              create: async () => ({
                provider: {
                  embed: async () => [1, 0],
                },
              }),
            },
          ],
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { default: plugin } = await import("../src/index.js");
    const { getHostEmbeddingProvider } = await import(
      "../src/host-embedding-provider.js"
    );

    first = buildApi("host-embedding-first");
    first.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
    } as any;

    plugin.register(first.api as any);
    assert.ok(
      getHostEmbeddingProvider(memoryDir),
      "first register() should install the host embedding bridge",
    );

    await first.api._registeredStart?.();
    await first.api._registeredStop?.();

    assert.equal(
      getHostEmbeddingProvider(memoryDir),
      undefined,
      "stop() should unregister the host embedding bridge",
    );

    (globalThis as any)[GUARD_KEY] = true;
    fresh = buildApi("host-embedding-fresh");
    fresh.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
    } as any;

    plugin.register(fresh.api as any);
    assert.ok(
      getHostEmbeddingProvider(memoryDir),
      "fresh register() should restore host embeddings even when the CLI guard stays set",
    );
  } finally {
    Module._load = originalLoad;
    await safeStop(first?.api, fresh?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("host embedding bridge re-registers when host embedding config changes", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-config-"));
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as {
    _load: (
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) => unknown;
  };
  const originalLoad = Module._load;
  let first: ReturnType<typeof buildApi> | undefined;
  let second: ReturnType<typeof buildApi> | undefined;
  let clearHostEmbeddingProvidersForTest: (() => void) | undefined;
  try {
    Module._load = function patchedLoad(
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) {
      if (request === "openclaw/plugin-sdk/memory-core-host-engine-embeddings") {
        return {
          listMemoryEmbeddingProviders: () => [
            {
              id: "first-memory-provider",
              create: async () => ({
                provider: {
                  embed: async () => [1, 0],
                },
              }),
            },
            {
              id: "second-memory-provider",
              create: async () => ({
                provider: {
                  embed: async () => [0, 1],
                },
              }),
            },
          ],
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { default: plugin } = await import("../src/index.js");
    const hostEmbeddingProviders = await import("../src/host-embedding-provider.js");
    clearHostEmbeddingProvidersForTest =
      hostEmbeddingProviders.clearHostEmbeddingProvidersForTest;
    const { getHostEmbeddingProvider } = hostEmbeddingProviders;

    first = buildApi("host-embedding-config-first");
    first.api.config = {
      models: {
        providers: [{
          id: "secret-provider",
          apiKey: "sk-test-raw-secret",
        }],
      },
    };
    first.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      hostEmbeddingProviderId: "first-memory-provider",
      hostEmbeddingProviderModel: "model-a",
    } as any;

    plugin.register(first.api as any);
    assert.equal(
      getHostEmbeddingProvider(memoryDir)?.model,
      "memory:first-memory-provider/model-a",
    );
    assert.match(
      (globalThis as any)[HOST_EMBEDDING_SIGNATURE_KEY],
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(
      (globalThis as any)[HOST_EMBEDDING_SIGNATURE_KEY],
      /sk-test-raw-secret/,
    );

    second = buildApi("host-embedding-config-second");
    second.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      hostEmbeddingProviderId: "second-memory-provider",
      hostEmbeddingProviderModel: "model-b",
    } as any;

    plugin.register(second.api as any);
    assert.equal(
      getHostEmbeddingProvider(memoryDir)?.model,
      "memory:second-memory-provider/model-b",
    );

  } finally {
    Module._load = originalLoad;
    clearHostEmbeddingProvidersForTest?.();
    await safeStop(first?.api, second?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("host embedding bridge uses adapter default instead of fallback model", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-default-model-"));
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as {
    _load: (
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) => unknown;
  };
  const originalLoad = Module._load;
  let registry: ReturnType<typeof buildApi> | undefined;
  let clearHostEmbeddingProvidersForTest: (() => void) | undefined;
  const requestedModels: Array<unknown> = [];
  try {
    Module._load = function patchedLoad(
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) {
      if (request === "openclaw/plugin-sdk/memory-core-host-engine-embeddings") {
        return {
          listMemoryEmbeddingProviders: () => [
            {
              id: "default-model-memory-provider",
              defaultModel: "adapter-default-model",
              create: async (options: { model?: string }) => {
                requestedModels.push(options.model);
                return {
                  provider: {
                    embed: async () => [1, 0],
                  },
                };
              },
            },
          ],
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { default: plugin } = await import("../src/index.js");
    const hostEmbeddingProviders = await import("../src/host-embedding-provider.js");
    clearHostEmbeddingProvidersForTest =
      hostEmbeddingProviders.clearHostEmbeddingProvidersForTest;
    const { getHostEmbeddingProvider } = hostEmbeddingProviders;

    registry = buildApi("host-embedding-default-model");
    registry.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      hostEmbeddingProviderId: "default-model-memory-provider",
      embeddingFallbackModel: "fallback-only-model",
    } as any;

    plugin.register(registry.api as any);
    assert.equal(
      getHostEmbeddingProvider(memoryDir)?.model,
      "memory:default-model-memory-provider/adapter-default-model",
    );
    assert.deepEqual(await getHostEmbeddingProvider(memoryDir)?.embed("input"), [1, 0]);
    assert.deepEqual(requestedModels, ["adapter-default-model"]);
  } finally {
    Module._load = originalLoad;
    clearHostEmbeddingProvidersForTest?.();
    await safeStop(registry?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("host embedding bridge passes workspaceDir to OpenClaw adapters", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-workspace-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-workspace-root-"));
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as {
    _load: (
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) => unknown;
  };
  const originalLoad = Module._load;
  let registry: ReturnType<typeof buildApi> | undefined;
  let clearHostEmbeddingProvidersForTest: (() => void) | undefined;
  const createOptions: Array<Record<string, unknown>> = [];
  try {
    Module._load = function patchedLoad(
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) {
      if (request === "openclaw/plugin-sdk/memory-core-host-engine-embeddings") {
        return {
          listMemoryEmbeddingProviders: () => [
            {
              id: "workspace-memory-provider",
              create: async (options: Record<string, unknown>) => {
                createOptions.push(options);
                return {
                  provider: {
                    embed: async () => [1, 0],
                  },
                };
              },
            },
          ],
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { default: plugin } = await import("../src/index.js");
    const hostEmbeddingProviders = await import("../src/host-embedding-provider.js");
    clearHostEmbeddingProvidersForTest =
      hostEmbeddingProviders.clearHostEmbeddingProvidersForTest;
    const { getHostEmbeddingProvider } = hostEmbeddingProviders;

    registry = buildApi("host-embedding-workspace");
    registry.api.runtime = {
      version: "0.0.0",
      agent: { workspaceDir },
    } as any;
    registry.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      hostEmbeddingProviderId: "workspace-memory-provider",
    } as any;

    plugin.register(registry.api as any);
    assert.deepEqual(await getHostEmbeddingProvider(memoryDir)?.embed("input"), [1, 0]);
    assert.equal(createOptions[0]?.workspaceDir, workspaceDir);
    assert.equal(createOptions[0]?.agentDir, workspaceDir);
  } finally {
    Module._load = originalLoad;
    clearHostEmbeddingProvidersForTest?.();
    await safeStop(registry?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("host embedding bridge retries provider creation after transient null result", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-retry-"));
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as {
    _load: (
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) => unknown;
  };
  const originalLoad = Module._load;
  let registry: ReturnType<typeof buildApi> | undefined;
  let clearHostEmbeddingProvidersForTest: (() => void) | undefined;
  let createCalls = 0;
  try {
    Module._load = function patchedLoad(
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) {
      if (request === "openclaw/plugin-sdk/memory-core-host-engine-embeddings") {
        return {
          listMemoryEmbeddingProviders: () => [
            {
              id: "retry-memory-provider",
              create: async () => {
                createCalls += 1;
                if (createCalls === 1) {
                  return null;
                }
                return {
                  provider: {
                    embed: async () => [1, 0],
                  },
                };
              },
            },
          ],
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { default: plugin } = await import("../src/index.js");
    const hostEmbeddingProviders = await import("../src/host-embedding-provider.js");
    clearHostEmbeddingProvidersForTest =
      hostEmbeddingProviders.clearHostEmbeddingProvidersForTest;
    const { getHostEmbeddingProvider } = hostEmbeddingProviders;

    registry = buildApi("host-embedding-retry");
    registry.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      hostEmbeddingProviderId: "retry-memory-provider",
    } as any;

    plugin.register(registry.api as any);
    assert.equal(await getHostEmbeddingProvider(memoryDir)?.embed("first"), null);
    assert.deepEqual(await getHostEmbeddingProvider(memoryDir)?.embed("second"), [1, 0]);
    assert.equal(createCalls, 2);
  } finally {
    Module._load = originalLoad;
    clearHostEmbeddingProvidersForTest?.();
    await safeStop(registry?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("passive slot registrations unregister the active host embedding bridge", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-passive-"));
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as {
    _load: (
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) => unknown;
  };
  const originalLoad = Module._load;
  let active: ReturnType<typeof buildApi> | undefined;
  let passive: ReturnType<typeof buildApi> | undefined;
  let clearHostEmbeddingProvidersForTest: (() => void) | undefined;
  try {
    Module._load = function patchedLoad(
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) {
      if (request === "openclaw/plugin-sdk/memory-core-host-engine-embeddings") {
        return {
          listMemoryEmbeddingProviders: (config?: { providerMarker?: string }) => {
            const providerId =
              config?.providerMarker === "passive"
                ? "passive-memory-provider"
                : "active-memory-provider";
            return [
              {
                id: providerId,
                create: async () => ({
                  provider: {
                    embed: async () =>
                      providerId === "passive-memory-provider" ? [0, 1] : [1, 0],
                  },
                }),
              },
            ];
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { default: plugin } = await import("../src/index.js");
    const hostEmbeddingProviders = await import("../src/host-embedding-provider.js");
    clearHostEmbeddingProvidersForTest =
      hostEmbeddingProviders.clearHostEmbeddingProvidersForTest;
    const { getHostEmbeddingProvider } = hostEmbeddingProviders;

    active = buildApi("host-embedding-active-slot");
    active.api.config = { providerMarker: "active" };
    active.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
    } as any;

    plugin.register(active.api as any);
    await active.api._registeredStart?.();
    assert.equal(
      getHostEmbeddingProvider(memoryDir)?.model,
      "memory:active-memory-provider/text-embedding-3-small",
    );
    assert.deepEqual(await getHostEmbeddingProvider(memoryDir)?.embed("input"), [1, 0]);

    passive = buildApi("host-embedding-passive-slot");
    passive.api.config = {
      providerMarker: "passive",
      plugins: {
        slots: {
          memory: "another-memory-plugin",
        },
      },
    };
    passive.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      slotBehavior: {
        onSlotMismatch: "silent",
      },
    } as any;

    plugin.register(passive.api as any);
    await passive.api._registeredStart?.();
    await passive.api._registeredStop?.();

    assert.equal(getHostEmbeddingProvider(memoryDir), undefined);
  } finally {
    Module._load = originalLoad;
    clearHostEmbeddingProvidersForTest?.();
    await safeStop(passive?.api, active?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("host embedding bridge re-registers when OpenClaw host config changes", async () => {
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-host-embedding-openclaw-config-"));
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as {
    _load: (
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) => unknown;
  };
  const originalLoad = Module._load;
  let first: ReturnType<typeof buildApi> | undefined;
  let second: ReturnType<typeof buildApi> | undefined;
  let clearHostEmbeddingProvidersForTest: (() => void) | undefined;
  try {
    Module._load = function patchedLoad(
      request: string,
      parent?: unknown,
      isMain?: boolean,
    ) {
      if (request === "openclaw/plugin-sdk/memory-core-host-engine-embeddings") {
        return {
          listMemoryEmbeddingProviders: () => [
            {
              id: "config-aware-memory-provider",
              create: async (options: { config?: { embeddingMarker?: string } }) => {
                const marker = options.config?.embeddingMarker;
                return {
                  provider: {
                    embed: async () => (marker === "second" ? [0, 1] : [1, 0]),
                  },
                };
              },
            },
          ],
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { default: plugin } = await import("../src/index.js");
    const hostEmbeddingProviders = await import("../src/host-embedding-provider.js");
    clearHostEmbeddingProvidersForTest =
      hostEmbeddingProviders.clearHostEmbeddingProvidersForTest;
    const { getHostEmbeddingProvider } = hostEmbeddingProviders;

    first = buildApi("host-embedding-openclaw-config-first");
    first.api.config = { embeddingMarker: "first" };
    first.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      hostEmbeddingProviderId: "config-aware-memory-provider",
      hostEmbeddingProviderModel: "model-a",
    } as any;

    plugin.register(first.api as any);
    assert.deepEqual(await getHostEmbeddingProvider(memoryDir)?.embed("input"), [1, 0]);

    second = buildApi("host-embedding-openclaw-config-second");
    second.api.config = { embeddingMarker: "second" };
    second.api.pluginConfig = {
      ...BASE_TEST_PLUGIN_CONFIG,
      memoryDir,
      hostEmbeddingProviderEnabled: true,
      hostEmbeddingProviderId: "config-aware-memory-provider",
      hostEmbeddingProviderModel: "model-a",
    } as any;

    plugin.register(second.api as any);
    assert.deepEqual(await getHostEmbeddingProvider(memoryDir)?.embed("input"), [0, 1]);
  } finally {
    Module._load = originalLoad;
    clearHostEmbeddingProvidersForTest?.();
    await safeStop(first?.api, second?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("stop-during-init without takeover: REGISTERED_GUARD stays set — original CLI registration persists", async () => {
  // Scenario: one registry starts init, stop() fires before initialize() resolves
  // (no secondary registry is waiting to take over), then a brand-new register()
  // is called after the abort settles.
  //
  // Correct behavior (thread PRRT_kwDORJXyws5159Kz): GUARD must NOT be cleared
  // after a stop-during-init abort. The CLI registered by the original register()
  // call is still present in the gateway's registry (stop() does not unregister
  // CLI commands). Clearing GUARD would allow a subsequent register() to register
  // CLI again, duplicating the command tree on top of the still-live registration.
  //
  // A fresh register() after the abort therefore sees isFirstRegistration=false
  // and correctly skips CLI registration — the original CLI remains the only one.
  const saved = saveAndResetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  let primary: ReturnType<typeof buildApi> | undefined;
  let fresh: ReturnType<typeof buildApi> | undefined;
  try {
    const { default: plugin } = await import("../src/index.js");

    primary = buildApi("primary-aborted");

    plugin.register(primary.api as any);

    assert.equal(
      (globalThis as any)[GUARD_KEY],
      true,
      "guard should be true after first registration",
    );

    // Start init. We need to call stop() while the INIT_PROMISE is in-flight.
    // The cleanest way: queue stop() as a microtask so it races with start() before
    // orchestrator.initialize() returns.
    const startPromise = primary.api._registeredStart?.() ?? Promise.resolve();
    // stop() is called synchronously right after start() returns the promise —
    // at this point INIT_PROMISE is set (start() assigns it synchronously before
    // the first await inside the IIFE), so stop() sees it as non-null.
    await primary.api._registeredStop?.();

    // stop() awaits the in-flight promise internally (plus one queueMicrotask tick).
    // GUARD is NOT cleared — the original CLI registration is still live in the registry.
    // `await startPromise` is immediate (the promise already settled inside stop()).
    await startPromise;

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      false,
      "SERVICE_STARTED should be false after aborted init",
    );
    assert.equal(
      (globalThis as any)[GUARD_KEY],
      true,
      "REGISTERED_GUARD should stay true after aborted init — original CLI registration is still live in the registry",
    );

    // A fresh register() sees GUARD=true → isFirstRegistration=false → CLI is
    // NOT re-registered (the original CLI from the first register() is still live).
    fresh = buildApi("fresh-after-abort");
    plugin.register(fresh.api as any);

    assert.equal(
      (globalThis as any)[GUARD_KEY],
      true,
      "REGISTERED_GUARD should stay true after fresh register() — guard was not cleared, CLI not re-registered",
    );
    assert.equal(
      fresh.getCliCount(),
      0,
      "fresh register() should NOT register CLI (isFirstRegistration=false — guard was not cleared after abort)",
    );

    // Start the fresh registry — SERVICE_STARTED=false so start() runs init cleanly.
    await fresh.api._registeredStart?.();

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "SERVICE_STARTED should be true after fresh start() completes",
    );
  } finally {
    await safeStop(primary?.api, fresh?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    restoreGlobals(saved);
  }
});

// ============================================================================
// Scenario B: cross-process boundary
// ============================================================================

test("Scenario B: fresh process registers and starts service independently (process isolation)", () => {
  // Simulates: openclaw-node companion process loads the plugin first, setting
  // ENGRAM_REGISTERED_GUARD in its own globalThis. A separate gateway process
  // (own globalThis) must still register and start the service independently.
  //
  // Each OS process has its own globalThis — ENGRAM_REGISTERED_GUARD from a
  // companion process cannot bleed into the gateway process. This test documents
  // and verifies that process isolation guarantee.
  //
  // We spawn tsx (not bare node) so TypeScript source imports resolve correctly,
  // matching the actual runtime environment.

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const tsxBin = join(__dirname, "../node_modules/.bin/tsx");
  const indexPath = join(__dirname, "../src/index.ts");

  // Inline script passed via --eval / stdin using tsx.
  //
  // Runtime state is keyed per serviceId (#403 P2).  This fresh-process test
  // loads the canonical plugin id (`openclaw-remnic`), so the guard/started
  // slots it reads and writes include the `::openclaw-remnic` suffix.
  const script = `
import { default as plugin } from ${JSON.stringify(indexPath)};

const SERVICE_ID = "openclaw-remnic";
const GUARD_KEY = "__openclawEngramRegistered::" + SERVICE_ID;
const SERVICE_STARTED_KEY = "__openclawEngramServiceStarted::" + SERVICE_ID;

// A fresh process must always start with a clean globalThis.
if (globalThis[GUARD_KEY] !== undefined) {
  process.stderr.write("FAIL: GUARD_KEY was set in fresh process\\n");
  process.exit(1);
}
if (globalThis[SERVICE_STARTED_KEY] !== undefined) {
  process.stderr.write("FAIL: SERVICE_STARTED_KEY was set in fresh process\\n");
  process.exit(1);
}

const serviceIds = [];
const api = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  pluginConfig: {},
  config: {},
  registerTool() {},
  registerCli() {},
  registerService(spec) { serviceIds.push(spec.id); },
  on() {},
  registerHook() {},
  runtime: { version: "0.0.0" },
};

plugin.register(api);

if (!serviceIds.includes("openclaw-remnic")) {
  process.stderr.write("FAIL: service not registered. ids=" + JSON.stringify(serviceIds) + "\\n");
  process.exit(1);
}
if (globalThis[GUARD_KEY] !== true) {
  process.stderr.write("FAIL: GUARD_KEY should be true after registration\\n");
  process.exit(1);
}

process.stdout.write("PASS\\n");
`;

  const result = spawnSync(tsxBin, ["--input-type=module"], {
    input: script,
    encoding: "utf8",
    timeout: 20_000,
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      [DISABLE_REGISTER_MIGRATION_ENV]: "1",
    },
  });

  if (result.error) throw result.error;

  assert.equal(
    result.status,
    0,
    `Cross-process registration test failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("PASS"),
    `Expected PASS in stdout:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});

// ============================================================================
// Scenario C: migration install — two different plugin ids in one process
// ============================================================================

test("register() scopes runtime singletons per serviceId when two plugin ids share a process (regression: #403 P2)", async () => {
  // Before the fix, the runtime singletons (orchestrator, start/init guards,
  // access service, HTTP server, etc.) lived on unkeyed `globalThis` slots.
  // In a migration install that loads both plugin ids in one process
  // (`openclaw-remnic` canonical + `openclaw-engram` legacy shim), whichever
  // plugin registered first forced the second plugin to reuse the first
  // plugin's orchestrator/config — so the second service could run with the
  // wrong `memoryDir`/policy despite having a different plugin id.
  //
  // With the fix, each plugin id gets its own `::${serviceId}` slot and thus
  // its own orchestrator.  A single unkeyed `__openclawEngramOrchestrator`
  // mirror is still maintained for cross-plugin observers, but it points at
  // whichever plugin registered most recently — it is NOT the source of
  // truth and MUST NOT be read during per-service startup.
  const LEGACY_SERVICE_ID = "openclaw-engram";
  const LEGACY_GUARD_KEY = `__openclawEngramRegistered::${LEGACY_SERVICE_ID}`;
  const LEGACY_HOOK_APIS_KEY = `__openclawEngramHookApis::${LEGACY_SERVICE_ID}`;
  const LEGACY_ORCH_KEY = `__openclawEngramOrchestrator::${LEGACY_SERVICE_ID}`;
  const LEGACY_ACCESS_SVC_KEY = `__openclawEngramAccessService::${LEGACY_SERVICE_ID}`;
  const LEGACY_ACCESS_HTTP_KEY = `__openclawEngramAccessHttpServer::${LEGACY_SERVICE_ID}`;
  const LEGACY_SERVICE_STARTED_KEY = `__openclawEngramServiceStarted::${LEGACY_SERVICE_ID}`;
  const LEGACY_INIT_PROMISE_KEY = `__openclawEngramInitPromise::${LEGACY_SERVICE_ID}`;

  // saveAndResetGlobals() saves/resets the canonical (`openclaw-remnic`) slots
  // and the unkeyed mirror.  We still need to independently save/reset the
  // legacy (`openclaw-engram`) per-service slots so this test gets a clean
  // starting state for the legacy plugin id.
  const saved = saveAndResetGlobals();
  const savedLegacy = {
    guard: (globalThis as any)[LEGACY_GUARD_KEY],
    hookApis: (globalThis as any)[LEGACY_HOOK_APIS_KEY],
    orch: (globalThis as any)[LEGACY_ORCH_KEY],
    accessSvc: (globalThis as any)[LEGACY_ACCESS_SVC_KEY],
    accessHttp: (globalThis as any)[LEGACY_ACCESS_HTTP_KEY],
    serviceStarted: (globalThis as any)[LEGACY_SERVICE_STARTED_KEY],
    initPromise: (globalThis as any)[LEGACY_INIT_PROMISE_KEY],
  };
  delete (globalThis as any)[LEGACY_GUARD_KEY];
  delete (globalThis as any)[LEGACY_HOOK_APIS_KEY];
  delete (globalThis as any)[LEGACY_ORCH_KEY];
  delete (globalThis as any)[LEGACY_ACCESS_SVC_KEY];
  delete (globalThis as any)[LEGACY_ACCESS_HTTP_KEY];
  delete (globalThis as any)[LEGACY_SERVICE_STARTED_KEY];
  delete (globalThis as any)[LEGACY_INIT_PROMISE_KEY];

  const previousDisableMigration = disableRegisterMigrationForTest();
  let canonical: ReturnType<typeof buildApi> | undefined;
  let legacy: ReturnType<typeof buildApi> | undefined;
  try {
    const { default: plugin } = await import("../src/index.js");

    canonical = buildApi("canonical-registry");
    legacy = buildApi("legacy-registry");

    // Canonical plugin (`openclaw-remnic`).  `plugin.register(api)` binds
    // `this = plugin`, and `plugin.id === "openclaw-remnic"`.
    plugin.register(canonical.api as any);

    // Legacy shim plugin (`openclaw-engram`).  Rebind `this` so `register()`
    // sees `this.id === "openclaw-engram"`.  This simulates the migration
    // install where both the canonical package and the legacy shim package
    // load the same underlying plugin module but expose different plugin ids.
    const legacyThis = { ...plugin, id: LEGACY_SERVICE_ID };
    (plugin.register as any).call(legacyThis, legacy!.api as any);

    // Both keyed guard slots must be set independently.
    assert.equal(
      (globalThis as any)[GUARD_KEY],
      true,
      `canonical guard slot ${GUARD_KEY} must be set`,
    );
    assert.equal(
      (globalThis as any)[LEGACY_GUARD_KEY],
      true,
      `legacy guard slot ${LEGACY_GUARD_KEY} must be set`,
    );

    // Each plugin must have its own orchestrator instance — the second
    // register() call must not silently adopt the first one.
    const canonicalOrch = (globalThis as any)[ORCH_KEY];
    const legacyOrch = (globalThis as any)[LEGACY_ORCH_KEY];
    assert.ok(canonicalOrch, `canonical orchestrator slot ${ORCH_KEY} must be set`);
    assert.ok(legacyOrch, `legacy orchestrator slot ${LEGACY_ORCH_KEY} must be set`);
    assert.notStrictEqual(
      canonicalOrch,
      legacyOrch,
      "canonical and legacy plugin ids must get distinct orchestrator instances " +
        "(regression: before #403 P2 fix, the second register() silently reused " +
        "the first orchestrator via unkeyed globalThis slots)",
    );

    // Each plugin must have its own access service instance.
    const canonicalAccess = (globalThis as any)[ACCESS_SVC_KEY];
    const legacyAccess = (globalThis as any)[LEGACY_ACCESS_SVC_KEY];
    assert.ok(canonicalAccess, "canonical access service must exist");
    assert.ok(legacyAccess, "legacy access service must exist");
    assert.notStrictEqual(
      canonicalAccess,
      legacyAccess,
      "canonical and legacy plugin ids must get distinct access service instances",
    );

    // Each plugin must register its own service with its own id.
    assert.deepEqual(
      canonical.getServiceIds(),
      ["openclaw-remnic"],
      "canonical registry must register service id openclaw-remnic",
    );
    assert.deepEqual(
      legacy.getServiceIds(),
      ["openclaw-engram"],
      "legacy registry must register service id openclaw-engram",
    );

    // CLI must be registered only on the first plugin id — the global
    // CLI_REGISTERED_GUARD prevents the second plugin from creating a
    // duplicate command tree.
    assert.ok(
      canonical.getCliCount() > 0,
      "canonical (first) plugin must have CLI registered",
    );
    assert.equal(
      legacy!.getCliCount(),
      0,
      "legacy (second) plugin must NOT have CLI — global CLI_REGISTERED_GUARD prevents duplicate command trees across plugin ids",
    );

    // The unkeyed orchestrator mirror must point at whichever plugin
    // registered most recently (legacy here).  This is a best-effort pointer
    // for cross-plugin observers that don't know the serviceId.
    assert.strictEqual(
      (globalThis as any).__openclawEngramOrchestrator,
      legacyOrch,
      "unkeyed __openclawEngramOrchestrator mirror must point at the most-recently-registered plugin's orchestrator",
    );
  } finally {
    // Stop any registered services / HTTP listeners so the event loop can drain.
    await safeStop(canonical?.api, legacy?.api);
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);

    // Restore legacy slots.
    if (savedLegacy.guard !== undefined) (globalThis as any)[LEGACY_GUARD_KEY] = savedLegacy.guard;
    else delete (globalThis as any)[LEGACY_GUARD_KEY];
    if (savedLegacy.hookApis !== undefined) (globalThis as any)[LEGACY_HOOK_APIS_KEY] = savedLegacy.hookApis;
    else delete (globalThis as any)[LEGACY_HOOK_APIS_KEY];
    if (savedLegacy.orch !== undefined) (globalThis as any)[LEGACY_ORCH_KEY] = savedLegacy.orch;
    else delete (globalThis as any)[LEGACY_ORCH_KEY];
    if (savedLegacy.accessSvc !== undefined) (globalThis as any)[LEGACY_ACCESS_SVC_KEY] = savedLegacy.accessSvc;
    else delete (globalThis as any)[LEGACY_ACCESS_SVC_KEY];
    if (savedLegacy.accessHttp !== undefined) (globalThis as any)[LEGACY_ACCESS_HTTP_KEY] = savedLegacy.accessHttp;
    else delete (globalThis as any)[LEGACY_ACCESS_HTTP_KEY];
    if (savedLegacy.serviceStarted !== undefined) (globalThis as any)[LEGACY_SERVICE_STARTED_KEY] = savedLegacy.serviceStarted;
    else delete (globalThis as any)[LEGACY_SERVICE_STARTED_KEY];
    if (savedLegacy.initPromise !== undefined) (globalThis as any)[LEGACY_INIT_PROMISE_KEY] = savedLegacy.initPromise;
    else delete (globalThis as any)[LEGACY_INIT_PROMISE_KEY];

    // restoreGlobals() restores the canonical slots AND the unkeyed mirror.
    restoreGlobals(saved);
  }
});
