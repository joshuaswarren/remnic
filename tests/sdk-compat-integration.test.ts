/**
 * SDK compatibility integration tests.
 *
 * Verifies that register() correctly routes hook registration based on SDK
 * capabilities detected at runtime:
 *
 * - New SDK api: gets before_prompt_build, session/tool/llm/subagent hooks,
 *   registerMemoryPromptSection, and service registration.
 * - Legacy SDK api: gets before_agent_start and core hooks only.
 * - Non-runtime registration modes: skip all registration entirely.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ============================================================================
// Shared constants — must match src/index.ts
//
// Per-plugin runtime state is keyed by serviceId (#403 P2) so a migration
// install hosting both `openclaw-remnic` and `openclaw-engram` plugin ids does
// not force the second plugin to reuse the first plugin's orchestrator/config.
// These tests register the canonical plugin id (`openclaw-remnic`), so the
// keys below include the `::openclaw-remnic` suffix.  The migration promise
// remains unkeyed because `~/.engram` → `~/.remnic` migration is a one-time
// process-wide operation.
// ============================================================================
const SERVICE_ID = "openclaw-remnic";
const GUARD_KEY = `__openclawEngramRegistered::${SERVICE_ID}`;
const HOOK_APIS_KEY = `__openclawEngramHookApis::${SERVICE_ID}`;
const ORCH_KEY = `__openclawEngramOrchestrator::${SERVICE_ID}`;
const ACCESS_SVC_KEY = `__openclawEngramAccessService::${SERVICE_ID}`;
const ACCESS_HTTP_KEY = `__openclawEngramAccessHttpServer::${SERVICE_ID}`;
const SERVICE_STARTED_KEY = `__openclawEngramServiceStarted::${SERVICE_ID}`;
const INIT_PROMISE_KEY = `__openclawEngramInitPromise::${SERVICE_ID}`;
const MIGRATION_PROMISE_KEY = "__openclawEngramMigrationPromise";
// Unkeyed mirror that register() maintains as a "last registered Remnic
// orchestrator" pointer for cross-plugin observers (notably the orchestrator
// itself).  Must be cleaned alongside the keyed slots so per-test state does
// not leak across cases.
const UNKEYED_ORCH_MIRROR_KEY = "__openclawEngramOrchestrator";
// CLI dedupe guard — intentionally process-global (not per-serviceId).
const CLI_REGISTERED_GUARD_KEY = "__openclawEngramCliRegistered";
const SESSION_COMMANDS_REGISTERED_GUARD_KEY =
  "__openclawEngramSessionCommandsRegistered";
// CLI active-service refcount.
const CLI_ACTIVE_SERVICE_COUNT_KEY = "__openclawEngramCliActiveServiceCount";
const DISABLE_REGISTER_MIGRATION_ENV = "REMNIC_DISABLE_REGISTER_MIGRATION";

// ============================================================================
// Helpers
// ============================================================================

async function makeMemoryFixture(): Promise<{ memoryDir: string; workspaceDir: string; cleanup: () => Promise<void> }> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-public-artifacts-"));
  const memoryDir = path.join(tmpRoot, "memory");
  const workspaceDir = path.join(tmpRoot, "workspace");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  // At least one public fact so the provider always returns a non-empty array,
  // making the agentIds assertions non-vacuous.
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "facts", "sample-fact.md"),
    "---\ntitle: sample\n---\n\nHello world.\n",
    "utf8",
  );
  return {
    memoryDir,
    workspaceDir,
    cleanup: async () => {
      try {
        await rm(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
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

function resetGlobals() {
  for (const key of [
    GUARD_KEY,
    HOOK_APIS_KEY,
    ORCH_KEY,
    UNKEYED_ORCH_MIRROR_KEY,
    CLI_REGISTERED_GUARD_KEY,
    SESSION_COMMANDS_REGISTERED_GUARD_KEY,
    CLI_ACTIVE_SERVICE_COUNT_KEY,
    ACCESS_SVC_KEY,
    ACCESS_HTTP_KEY,
    SERVICE_STARTED_KEY,
    INIT_PROMISE_KEY,
    MIGRATION_PROMISE_KEY,
  ]) {
    delete (globalThis as any)[key];
  }
}

interface MockApi {
  label: string;
  logger: { debug: () => void; info: () => void; warn: () => void; error: () => void };
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  registerTool: (spec: unknown) => void;
  registerCli: (spec: unknown) => void;
  registerService: (spec: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) => void;
  on: (event: string, handler: unknown, opts?: unknown) => void;
  registerHook?: (events: unknown, handler: unknown, opts?: unknown) => void;
  runtime?: { version: string; agent?: { id?: string; workspaceDir?: string } };
  registrationMode?: string;
  registerMemoryPromptSection?: (spec: unknown) => void;
  registerMemoryCapability?: (spec: unknown) => void;
  registerCommand?: (spec: unknown) => void;
  _registeredHooks: string[];
  _hookHandlers: Map<string, unknown>;
  _hookOptions: Map<string, unknown>;
  _registeredToolCount: number;
  _registeredToolNames: string[];
  _registeredToolSpecs: unknown[];
  _registeredServiceIds: string[];
  _memoryPromptSectionRegistered: boolean;
  _registeredMemoryCapability?: any;
  _registeredCommands: unknown[];
}

function validateOpenClawPluginTool(tool: unknown): string | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return "tool must be an object";
  }
  const spec = tool as { name?: unknown; execute?: unknown; parameters?: unknown };
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    return "missing non-empty name";
  }
  if (typeof spec.execute !== "function") {
    return `${spec.name} missing execute function`;
  }
  if (!spec.parameters || typeof spec.parameters !== "object" || Array.isArray(spec.parameters)) {
    return `${spec.name} missing parameters object`;
  }
  return null;
}

function buildNewSdkApi(label: string): MockApi {
  const api: MockApi = {
    label,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    config: {},
    _registeredHooks: [],
    _hookHandlers: new Map(),
    _hookOptions: new Map(),
    _registeredToolCount: 0,
    _registeredToolNames: [],
    _registeredToolSpecs: [],
    _registeredServiceIds: [],
    _memoryPromptSectionRegistered: false,
    _registeredCommands: [],
    registerTool(spec: unknown) {
      api._registeredToolCount++;
      api._registeredToolSpecs.push(spec);
      if (spec && typeof spec === "object" && typeof (spec as { name?: unknown }).name === "string") {
        api._registeredToolNames.push((spec as { name: string }).name);
      }
    },
    registerCommand(this: MockApi, spec: unknown) {
      this._registeredCommands.push(spec);
    },
    registerCli(_spec: unknown) {},
    registerService(spec) {
      api._registeredServiceIds.push(spec.id);
    },
    on(event: string, _handler: unknown, opts?: unknown) {
      api._registeredHooks.push(event);
      api._hookHandlers.set(event, _handler);
      api._hookOptions.set(event, opts);
    },
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {},
    runtime: { version: "2026.3.22" },
    registrationMode: "full",
    registerMemoryPromptSection(_spec: unknown) {
      api._memoryPromptSectionRegistered = true;
    },
  };
  return api;
}

function buildLegacySdkApi(label: string): MockApi {
  const api: MockApi = {
    label,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    config: {},
    _registeredHooks: [],
    _hookHandlers: new Map(),
    _hookOptions: new Map(),
    _registeredToolCount: 0,
    _registeredToolNames: [],
    _registeredToolSpecs: [],
    _registeredServiceIds: [],
    _memoryPromptSectionRegistered: false,
    _registeredCommands: [],
    registerTool(spec: unknown) {
      api._registeredToolCount++;
      api._registeredToolSpecs.push(spec);
      if (spec && typeof spec === "object" && typeof (spec as { name?: unknown }).name === "string") {
        api._registeredToolNames.push((spec as { name: string }).name);
      }
    },
    registerCli(_spec: unknown) {},
    registerService(spec) {
      api._registeredServiceIds.push(spec.id);
    },
    on(event: string, _handler: unknown, opts?: unknown) {
      api._registeredHooks.push(event);
      api._hookHandlers.set(event, _handler);
      api._hookOptions.set(event, opts);
    },
    // No runtime, no registrationMode, no registerMemoryPromptSection
  };
  return api;
}

// ============================================================================
// Test 1: New SDK api gets all new hooks + memory section
// ============================================================================
test("new SDK api gets all new hooks + memory section", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("new-sdk-test");
    api.pluginConfig = { initGateTimeoutMs: 30_000 };
    plugin.register(api as any);

    // When registerMemoryPromptSection is available (new SDK), before_prompt_build
    // IS registered for async pre-computation (the synchronous builder reads
    // the cached result).  The recall hook handler itself is skipped.
    assert.ok(
      api._registeredHooks.includes("before_prompt_build"),
      "before_prompt_build should be registered for async pre-compute when registerMemoryPromptSection is available",
    );
    assert.deepEqual(
      api._hookOptions.get("before_prompt_build"),
      { timeoutMs: 30_000 },
      "before_prompt_build should register Remnic's init-gate timeout with OpenClaw",
    );

    // before_agent_start should NOT be registered (legacy path)
    assert.ok(
      !api._registeredHooks.includes("before_agent_start"),
      "before_agent_start should NOT be registered on new SDK",
    );

    // Core hooks present on both paths
    assert.ok(
      api._registeredHooks.includes("agent_end"),
      "agent_end should be registered",
    );
    assert.ok(
      api._registeredHooks.includes("before_compaction"),
      "before_compaction should be registered",
    );
    assert.ok(
      api._registeredHooks.includes("after_compaction"),
      "after_compaction should be registered",
    );
    assert.ok(
      api._registeredHooks.includes("before_reset"),
      "before_reset should be registered on new SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("commands.list"),
      "commands.list should NOT be registered on new SDK; command discovery uses registerCommand()",
    );

    // New SDK-only hooks
    assert.ok(
      api._registeredHooks.includes("session_start"),
      "session_start should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("session_end"),
      "session_end should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("before_tool_call"),
      "before_tool_call should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("after_tool_call"),
      "after_tool_call should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("llm_output"),
      "llm_output should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("subagent_spawning"),
      "subagent_spawning should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("subagent_ended"),
      "subagent_ended should be registered on new SDK",
    );

    // registerMemoryPromptSection was called
    assert.ok(
      api._memoryPromptSectionRegistered,
      "registerMemoryPromptSection should have been called on new SDK",
    );

    // Service was registered
    assert.ok(
      api._registeredServiceIds.includes("openclaw-remnic"),
      "service should be registered",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("new SDK before_prompt_build hook uses configured initGateTimeoutMs", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("new-sdk-timeout-config");
    api.pluginConfig = { initGateTimeoutMs: "45000" };
    plugin.register(api as any);

    assert.deepEqual(
      api._hookOptions.get("before_prompt_build"),
      { timeoutMs: 45_000 },
      "before_prompt_build should use the configured Remnic init-gate timeout",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("new SDK runtime loader expands tilde in explicit OpenClaw config path", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const previousOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousLegacyConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  const previousHome = process.env.HOME;
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-config-home-"));

  try {
    const memoryDir = path.join(tmpRoot, "memory");
    const workspaceDir = path.join(tmpRoot, "workspace");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(tmpRoot, "openclaw.json"),
      JSON.stringify({
        plugins: {
          entries: {
            "openclaw-remnic": {
              config: {
                initGateTimeoutMs: 47_000,
                memoryDir,
                workspaceDir,
              },
            },
          },
        },
      }),
      "utf8",
    );
    process.env.HOME = tmpRoot;
    process.env.OPENCLAW_CONFIG_PATH = "~/openclaw.json";
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;

    const { default: plugin } = await import("../src/index.js");
    const api = buildNewSdkApi("tilde-config-path");
    plugin.register(api as any);

    assert.deepEqual(
      api._hookOptions.get("before_prompt_build"),
      { timeoutMs: 47_000 },
      "file-backed plugin config should load through a tilde-expanded OPENCLAW_CONFIG_PATH",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    if (previousOpenClawConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousOpenClawConfigPath;
    }
    if (previousLegacyConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousLegacyConfigPath;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(tmpRoot, { recursive: true, force: true });
    resetGlobals();
  }
});

test("slot mismatch warn mode suppresses hook registration but still registers tools and service", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("slot-mismatch-passive");
    api.config = {
      plugins: {
        slots: {
          memory: "other-memory-plugin",
        },
      },
    };
    api.pluginConfig = {
      slotBehavior: {
        onSlotMismatch: "warn",
      },
    };

    plugin.register(api as any);

    assert.equal(api._registeredHooks.length, 0, "passive mode should not register hooks");
    assert.equal(
      api._registeredCommands.length,
      0,
      "passive mode should not register session command descriptors",
    );
    assert.ok(api._registeredToolCount > 0, "tools should still register in passive mode");
    assert.ok(
      api._registeredServiceIds.includes("openclaw-remnic"),
      "service should still register in passive mode",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("new SDK tolerates unbound register(api) calls from cli metadata loaders", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("unbound-register");
    const unboundRegister = plugin.register;

    assert.doesNotThrow(
      () => unboundRegister(api as any),
      "register(api) should tolerate an unbound call and fall back to the canonical OpenClaw plugin id",
    );
    assert.ok(
      api._memoryPromptSectionRegistered,
      "registerMemoryPromptSection should still be called for new SDK",
    );
    assert.ok(
      api._registeredServiceIds.includes("openclaw-remnic"),
      "service should still register under the canonical plugin id",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("new SDK registers active-memory tool names and slash commands", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("active-memory-tools-test");
    plugin.register(api as any);

    assert.ok(
      api._registeredToolNames.includes("memory_search"),
      "memory_search should be registered for OpenClaw active-memory routing",
    );
    assert.ok(
      api._registeredToolNames.includes("memory_get"),
      "memory_get should be registered for OpenClaw active-memory routing",
    );
    for (const tool of api._registeredToolSpecs) {
      const name =
        tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
          ? (tool as { name: string }).name
          : "<unknown>";
      assert.equal(
        validateOpenClawPluginTool(tool),
        null,
        `${name} should satisfy OpenClaw's plugin tool validator`,
      );
    }
    for (const toolName of ["memory_search", "memory_get"]) {
      const tool = api._registeredToolSpecs.find((spec) =>
        spec && typeof spec === "object" && (spec as { name?: unknown }).name === toolName
      );
      assert.equal(
        validateOpenClawPluginTool(tool),
        null,
        `${toolName} should satisfy OpenClaw's plugin tool validator`,
      );
    }
    assert.ok(
      api._registeredCommands.length > 0,
      "registerCommand should be used when available for session-scoped recall toggles",
    );
    const remnicCommand = api._registeredCommands.find((spec) =>
      spec && typeof spec === "object" && (spec as { name?: unknown }).name === "remnic"
    ) as
      | {
          handler?: (ctx?: {
            sessionKey?: string;
            agentId?: string;
            args?: string;
          }) => Promise<{ text: string }>;
        }
      | undefined;
    assert.equal(typeof remnicCommand?.handler, "function");
    const reply = await remnicCommand?.handler?.({
      sessionKey: "session-command-test",
      agentId: "main",
      args: "status",
    });
    assert.match(String(reply?.text ?? ""), /Remnic recall is/);
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("new SDK hides session command registration when session toggles are disabled", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("active-memory-tools-disabled-toggle-test");
    api.pluginConfig = {
      sessionTogglesEnabled: false,
    };
    plugin.register(api as any);

    assert.equal(
      api._registeredHooks.includes("commands.list"),
      false,
      "commands.list should not be registered when session toggle commands are disabled",
    );
    assert.equal(
      api._registeredCommands.length,
      0,
      "registerCommand should not expose session toggle commands when the toggle system is disabled",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("new SDK hides session command registration when commandsListEnabled is false", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("active-memory-tools-disabled-commands-list-test");
    api.pluginConfig = {
      commandsListEnabled: false,
    };
    plugin.register(api as any);

    assert.equal(
      api._registeredCommands.length,
      0,
      "registerCommand should stay hidden when commandsListEnabled is false",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("new SDK registerCommand is deduped across multi-registry registration", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildNewSdkApi("new-sdk-register-command-first");
    const second = buildNewSdkApi("new-sdk-register-command-second");

    plugin.register(first as any);
    plugin.register(second as any);

    assert.ok(
      first._registeredCommands.length > 0,
      "first registry should register session command descriptors",
    );
    assert.equal(
      second._registeredCommands.length,
      0,
      "secondary registries must not duplicate process-global session command trees",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

// ============================================================================
// Test 2: Legacy SDK api gets legacy hooks only
// ============================================================================
test("legacy SDK api gets legacy hooks only", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildLegacySdkApi("legacy-sdk-test");
    plugin.register(api as any);

    // before_agent_start should be registered (legacy path)
    assert.ok(
      api._registeredHooks.includes("before_agent_start"),
      `expected before_agent_start in hooks, got: ${api._registeredHooks.join(", ")}`,
    );

    // before_prompt_build should NOT be registered (new SDK path)
    assert.ok(
      !api._registeredHooks.includes("before_prompt_build"),
      "before_prompt_build should NOT be registered on legacy SDK",
    );

    assert.ok(
      !api._registeredHooks.includes("commands.list"),
      "commands.list should not be registered on legacy SDKs because it is a gateway RPC surface, not a typed hook",
    );
    assert.equal(
      api._registeredCommands.length,
      0,
      "legacy SDKs without registerCommand should not expose session command descriptors",
    );

    // Core hooks still present
    assert.ok(
      api._registeredHooks.includes("agent_end"),
      "agent_end should be registered on legacy SDK",
    );
    assert.ok(
      api._registeredHooks.includes("before_compaction"),
      "before_compaction should be registered on legacy SDK",
    );
    assert.ok(
      api._registeredHooks.includes("after_compaction"),
      "after_compaction should be registered on legacy SDK",
    );

    // New SDK-only hooks should NOT be present
    assert.ok(
      !api._registeredHooks.includes("session_start"),
      "session_start should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("session_end"),
      "session_end should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("before_tool_call"),
      "before_tool_call should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("after_tool_call"),
      "after_tool_call should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("llm_output"),
      "llm_output should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("subagent_spawning"),
      "subagent_spawning should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("subagent_ended"),
      "subagent_ended should NOT be registered on legacy SDK",
    );

    // registerMemoryPromptSection should not have been called (not available)
    assert.ok(
      !api._memoryPromptSectionRegistered,
      "registerMemoryPromptSection should NOT be called on legacy SDK",
    );

    // Service still registered
    assert.ok(
      api._registeredServiceIds.includes("openclaw-remnic"),
      "service should still be registered on legacy SDK",
    );
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

// ============================================================================
// Test 3: tryDefinePluginEntry fallback produces correct plugin shape
// ============================================================================
test("tryDefinePluginEntry: fallback produces correct plugin shape when SDK module unavailable", async () => {
  const mod = await import("../src/index.js");
  const plugin = mod.default;
  assert.equal(plugin.id, "openclaw-remnic");
  assert.equal(plugin.name, "Remnic (Local Memory)");
  assert.equal(plugin.kind, "memory");
  assert.equal(typeof plugin.register, "function");
});

// ============================================================================
// Test 4: Non-runtime registration modes skip all registration
// ============================================================================
test("non-runtime registration modes skip all registration", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    for (const mode of [
      "discovery",
      "tool-discovery",
      "setup-only",
      "setup-runtime",
      "cli-metadata",
    ]) {
      const api = buildNewSdkApi(`${mode}-test`);
      api.registrationMode = mode;
      plugin.register(api as any);

      assert.equal(
        api._registeredHooks.length,
        0,
        `expected zero hooks in ${mode} mode, got: ${api._registeredHooks.join(", ")}`,
      );

      assert.equal(
        api._registeredToolCount,
        0,
        `expected zero tools in ${mode} mode`,
      );

      assert.equal(
        api._registeredServiceIds.length,
        0,
        `expected zero services in ${mode} mode`,
      );

      assert.ok(
        !api._memoryPromptSectionRegistered,
        `registerMemoryPromptSection should NOT be called in ${mode} mode`,
      );
    }
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

// ============================================================================
// Test 5: publicArtifacts.listArtifacts derives agentIds from runtime
// ============================================================================
test("publicArtifacts.listArtifacts derives agentIds from api.runtime.agent.id", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const fixture = await makeMemoryFixture();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("capability-runtime-agent-test");
    // Point the orchestrator at the fixture so publicArtifacts actually
    // enumerates files (otherwise the assertion loop is vacuous).
    api.pluginConfig = { memoryDir: fixture.memoryDir, workspaceDir: fixture.workspaceDir };
    // Capture info log output so we can assert SDK detection reports the new
    // memoryCapability flag.
    const infoLogs: string[] = [];
    api.logger = {
      debug: () => {},
      info: (...args: unknown[]) => {
        infoLogs.push(args.map((a) => String(a)).join(" "));
      },
      warn: () => {},
      error: () => {},
    } as any;
    // Simulate a new SDK runtime that supplies an agent id out-of-band.
    api.runtime = {
      version: "2026.4.9",
      agent: { id: "wiki-bridge-agent", workspaceDir: "/tmp/wiki-ws" },
    };
    api.registerMemoryCapability = (spec: any) => {
      api._registeredMemoryCapability = spec;
    };

    plugin.register(api as any);

    // SDK detection log must include the memoryCapability flag so diagnosing
    // capability-only runtimes doesn't require guessing the detection result.
    const detectionLog = infoLogs.find((msg) => msg.includes("SDK detection:"));
    assert.ok(
      detectionLog && /memoryCapability=true/.test(detectionLog),
      `SDK detection log must report memoryCapability=true, got: ${detectionLog ?? "<missing>"}`,
    );

    // Capability must have been registered
    assert.ok(
      api._registeredMemoryCapability,
      "registerMemoryCapability should have been called on a new SDK that exposes it",
    );
    const cap = api._registeredMemoryCapability;
    assert.ok(cap.publicArtifacts, "capability must expose publicArtifacts");
    assert.equal(typeof cap.publicArtifacts.listArtifacts, "function");

    const result = await cap.publicArtifacts.listArtifacts({ cfg: {} });
    assert.ok(Array.isArray(result), "listArtifacts must return an array");
    // Fixture guarantees at least one artifact so the agentIds assertion is
    // never vacuous.
    assert.ok(
      result.length > 0,
      "expected the fixture sample-fact.md to produce at least one artifact",
    );
    for (const artifact of result) {
      assert.deepStrictEqual(
        artifact.agentIds,
        ["wiki-bridge-agent"],
        "agentIds should be derived from api.runtime.agent.id, not hardcoded",
      );
    }
  } finally {
    await fixture.cleanup();
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("capability-only SDK with allowPromptInjection=false skips recall hook registration", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const fixture = await makeMemoryFixture();
  try {
    const { default: plugin } = await import("../src/index.js");

    // Capability-only new SDK: registerMemoryCapability present,
    // registerMemoryPromptSection absent.
    const api = buildNewSdkApi("capability-only-policy-off");
    api.pluginConfig = { memoryDir: fixture.memoryDir, workspaceDir: fixture.workspaceDir };
    delete api.registerMemoryPromptSection;
    api.registerMemoryCapability = (spec: any) => {
      api._registeredMemoryCapability = spec;
    };
    // Policy disables prompt injection — the plugin must NOT register the
    // recall hook (before_prompt_build for new SDK / before_agent_start for
    // legacy) because the hook handler would otherwise still emit
    // `prependSystemContext` and silently bypass the policy.
    api.config = {
      plugins: {
        entries: {
          "openclaw-remnic": { hooks: { allowPromptInjection: false } },
        },
      },
    };

    plugin.register(api as any);

    assert.ok(
      !api._registeredHooks.includes("before_prompt_build"),
      "before_prompt_build must NOT be registered when allowPromptInjection=false on capability-only SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("before_agent_start"),
      "before_agent_start must NOT be registered when allowPromptInjection=false",
    );
    // The capability is still registered, but without a promptBuilder — the
    // capability's existing policy gate already enforces that.
    assert.ok(
      api._registeredMemoryCapability,
      "registerMemoryCapability should still have been called — publicArtifacts is policy-independent",
    );
    const cap = api._registeredMemoryCapability;
    assert.ok(
      cap.promptBuilder === undefined,
      "capability.promptBuilder must be omitted when allowPromptInjection=false",
    );
    assert.ok(
      cap.publicArtifacts,
      "publicArtifacts must still be registered — policy only gates prompt injection",
    );
  } finally {
    await fixture.cleanup();
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("capability-only SDK treats string allowPromptInjection=false as disabled", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const fixture = await makeMemoryFixture();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("capability-only-string-policy-off");
    api.pluginConfig = { memoryDir: fixture.memoryDir, workspaceDir: fixture.workspaceDir };
    delete api.registerMemoryPromptSection;
    api.registerMemoryCapability = (spec: any) => {
      api._registeredMemoryCapability = spec;
    };
    api.config = {
      plugins: {
        entries: {
          "openclaw-remnic": { hooks: { allowPromptInjection: "false" } },
        },
      },
    };

    plugin.register(api as any);

    assert.equal(api._registeredHooks.includes("before_prompt_build"), false);
    assert.equal(api._registeredHooks.includes("before_agent_start"), false);
    assert.ok(api._registeredMemoryCapability);
    assert.equal(api._registeredMemoryCapability.promptBuilder, undefined);
  } finally {
    await fixture.cleanup();
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("capability-only before_prompt_build hook uses configured initGateTimeoutMs", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const fixture = await makeMemoryFixture();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("capability-only-timeout-config");
    api.pluginConfig = {
      initGateTimeoutMs: 60_000,
      memoryDir: fixture.memoryDir,
      workspaceDir: fixture.workspaceDir,
    };
    delete api.registerMemoryPromptSection;
    api.registerMemoryCapability = (spec: any) => {
      api._registeredMemoryCapability = spec;
    };

    plugin.register(api as any);

    assert.deepEqual(
      api._hookOptions.get("before_prompt_build"),
      { timeoutMs: 60_000 },
      "capability-only before_prompt_build should pass the configured timeout to OpenClaw",
    );
  } finally {
    await fixture.cleanup();
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("publicArtifacts.listArtifacts falls back to default agent id when runtime agent is absent", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  const fixture = await makeMemoryFixture();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("capability-no-runtime-agent-test");
    api.pluginConfig = { memoryDir: fixture.memoryDir, workspaceDir: fixture.workspaceDir };
    // runtime is present but without an agent.id — older new-SDK shape.
    api.runtime = { version: "2026.4.9" };
    api.registerMemoryCapability = (spec: any) => {
      api._registeredMemoryCapability = spec;
    };

    plugin.register(api as any);

    assert.ok(api._registeredMemoryCapability);
    const cap = api._registeredMemoryCapability;
    const result = await cap.publicArtifacts.listArtifacts({ cfg: {} });
    assert.ok(Array.isArray(result));
    // Fixture guarantees a non-empty result so the fallback assertion runs.
    assert.ok(
      result.length > 0,
      "expected the fixture sample-fact.md to produce at least one artifact",
    );
    for (const artifact of result) {
      assert.deepStrictEqual(
        artifact.agentIds,
        ["generalist"],
        "agentIds should fall back to 'generalist' when runtime agent is absent",
      );
    }
  } finally {
    await fixture.cleanup();
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});
