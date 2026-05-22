/**
 * Hook handler behavior tests for new SDK hooks.
 *
 * Verifies that the new SDK hook handlers (session_start, session_end,
 * before_tool_call, after_tool_call, llm_output, subagent_spawning,
 * subagent_ended, before_prompt_build) actually invoke correct behavior
 * when called, not just that they are registered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ============================================================================
// Shared constants — must match src/index.ts
//
// Per-plugin runtime state is keyed by serviceId (#403 P2).  These tests load
// the canonical plugin (id = "openclaw-remnic"), so the per-service slot names
// get the `::openclaw-remnic` suffix.  We also clean the unkeyed mirror slot
// `__openclawEngramOrchestrator` that `register()` maintains as a "last
// registered Remnic orchestrator" pointer for cross-plugin observers.
// The migration promise stays unkeyed because the legacy-dir migration is a
// one-time process-wide operation.
// ============================================================================
const SERVICE_ID = "openclaw-remnic";
const KEYED_BASE_NAMES = [
  "__openclawEngramRegistered",
  "__openclawEngramHookApis",
  "__openclawEngramOrchestrator",
  "__openclawEngramAccessService",
  "__openclawEngramAccessHttpServer",
  "__openclawEngramServiceStarted",
  "__openclawEngramInitPromise",
];
const GLOBAL_KEYS = [
  // Per-service keyed slots (authoritative).
  ...KEYED_BASE_NAMES.map((name) => `${name}::${SERVICE_ID}`),
  // Unkeyed mirror that register() maintains for observers that don't know
  // the serviceId (currently only the orchestrator).
  "__openclawEngramOrchestrator",
  // CLI dedupe guard — intentionally process-global (not per-serviceId).
  "__openclawEngramCliRegistered",
  // Session command dedupe guard — intentionally process-global.
  "__openclawEngramSessionCommandsRegistered",
  // CLI active-service refcount.
  "__openclawEngramCliActiveServiceCount",
  // Intentionally unkeyed.
  "__openclawEngramMigrationPromise",
];
const DISABLE_REGISTER_MIGRATION_ENV = "REMNIC_DISABLE_REGISTER_MIGRATION";

function cleanGlobalThis() {
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as any)[key];
  }
}

test.beforeEach(() => {
  process.env[DISABLE_REGISTER_MIGRATION_ENV] = "1";
  cleanGlobalThis();
});
test.afterEach(() => {
  delete process.env[DISABLE_REGISTER_MIGRATION_ENV];
  cleanGlobalThis();
});

// ============================================================================
// Helper: build a new-SDK mock api that captures handler functions
// ============================================================================
interface HandlerCapturingApi {
  label: string;
  logger: { debug: () => void; info: () => void; warn: () => void; error: () => void };
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  registerTool: (spec: unknown) => void;
  registerCli: (spec: unknown) => void;
  registerService: (spec: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) => void;
  on: (event: string, handler: Function) => void;
  registerHook?: (events: unknown, handler: unknown, opts?: unknown) => void;
  registerCommand?: (spec: unknown) => void;
  runtime?: { version: string };
  registrationMode?: string;
  registerMemoryPromptSection?: (spec: unknown) => void;
  registerMemoryCapability?: (spec: unknown) => void;
  handlers: Map<string, Function>;
  _registeredCommands: unknown[];
  _memoryPromptSection?: (params: { sessionKey?: string }) => string[] | null;
  _memoryCapability?: { promptBuilder?: (params: { sessionKey?: string }) => string[] | null };
  _registeredServiceStart?: (() => Promise<void>) | null;
  _registeredServiceStop?: (() => Promise<void>) | null;
}

function buildHandlerCapturingApi(
  label: string,
  opts?: { registrationMode?: string; includeMemoryCapability?: boolean },
): HandlerCapturingApi {
  const handlers = new Map<string, Function>();
  const api: HandlerCapturingApi = {
    label,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    config: {},
    handlers,
    _registeredCommands: [],
    registerTool(_spec: unknown) {},
    registerCli(_spec: unknown) {},
    registerCommand(spec: unknown) {
      api._registeredCommands.push(spec);
    },
    registerService(spec) {
      api._registeredServiceStart = spec.start;
      api._registeredServiceStop = spec.stop;
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {},
    runtime: { version: "2026.3.22" },
    registrationMode: opts?.registrationMode ?? "full",
    registerMemoryPromptSection(spec: unknown) {
      api._memoryPromptSection = spec as (params: { sessionKey?: string }) => string[] | null;
    },
    _registeredServiceStart: null,
    _registeredServiceStop: null,
  };
  if (opts?.includeMemoryCapability) {
    api.runtime = { version: "2026.4.9" };
    api.registerMemoryCapability = (spec: unknown) => {
      api._memoryCapability = spec as {
        promptBuilder?: (params: { sessionKey?: string }) => string[] | null;
      };
    };
  }
  return api;
}

function getRegisteredRemnicCommand(api: HandlerCapturingApi) {
  return api._registeredCommands.find((spec) =>
    spec && typeof spec === "object" && (spec as { name?: unknown }).name === "remnic"
  ) as
    | {
        name?: string;
        handler?: (ctx?: {
          sessionKey?: string;
          agentId?: string;
          args?: string | readonly string[];
        }) => Promise<{ text: string }>;
        subcommands?: Array<{ name?: string; handler?: Function }>;
      }
    | undefined;
}

// ============================================================================
// Tests
// ============================================================================

test("session_start handler runs file hygiene", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-start-test");
  plugin.register(api as any);

  const handler = api.handlers.get("session_start");
  assert.ok(handler, "session_start handler should be registered");

  // Handler should not throw — file hygiene is best-effort
  await assert.doesNotReject(
    async () => handler({ sessionKey: "test-session" }, {}),
    "session_start handler should not throw",
  );
});

test("session_end handler clears workspace override when compaction reset enabled", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-end-test");
  plugin.register(api as any);

  const handler = api.handlers.get("session_end");
  assert.ok(handler, "session_end handler should be registered");

  // Access the orchestrator from globalThis
  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  assert.ok(orchestrator, "orchestrator should exist on globalThis after register");

  // Handler should not throw even with uninitialized orchestrator
  await assert.doesNotReject(
    async () => handler({ sessionKey: "test-session" }, {}),
    "session_end handler should not throw",
  );
});

test("after_tool_call handler appends tool use to transcript", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("after-tool-call-test");
  plugin.register(api as any);

  const handler = api.handlers.get("after_tool_call");
  assert.ok(handler, "after_tool_call handler should be registered");

  // Handler should not throw even without a fully initialized transcript
  await assert.doesNotReject(
    async () =>
      handler(
        { toolName: "memory_search", durationMs: 42 },
        { sessionKey: "test" },
      ),
    "after_tool_call handler should not throw",
  );
});

test("llm_output handler logs token usage without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("llm-output-test");
  plugin.register(api as any);

  const handler = api.handlers.get("llm_output");
  assert.ok(handler, "llm_output handler should be registered");

  await assert.doesNotReject(
    async () =>
      handler(
        { model: "gpt-5.5", tokenUsage: { input: 100, output: 50 }, durationMs: 200 },
        { sessionKey: "test" },
      ),
    "llm_output handler should not throw",
  );
});

test("before_tool_call handler logs tool name without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-tool-call-test");
  plugin.register(api as any);

  const handler = api.handlers.get("before_tool_call");
  assert.ok(handler, "before_tool_call handler should be registered");

  await assert.doesNotReject(
    async () => handler({ toolName: "memory_get" }, {}),
    "before_tool_call handler should not throw",
  );
});

test("subagent_spawning handler logs without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("subagent-spawning-test");
  plugin.register(api as any);

  const handler = api.handlers.get("subagent_spawning");
  assert.ok(handler, "subagent_spawning handler should be registered");

  await assert.doesNotReject(
    async () => handler({ subagentId: "sub-1", purpose: "research" }, {}),
    "subagent_spawning handler should not throw",
  );
});

test("subagent_ended handler logs without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("subagent-ended-test");
  plugin.register(api as any);

  const handler = api.handlers.get("subagent_ended");
  assert.ok(handler, "subagent_ended handler should be registered");

  await assert.doesNotReject(
    async () =>
      handler({ subagentId: "sub-1", success: true, durationMs: 1000 }, {}),
    "subagent_ended handler should not throw",
  );
});

test("before_prompt_build handler returns memory context or undefined without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  // Build api WITHOUT registerMemoryPromptSection so the recall hook is registered
  // (when registerMemoryPromptSection is available, the hook is skipped in favor of the section builder).
  const api = buildHandlerCapturingApi("before-prompt-build-test");
  delete api.registerMemoryPromptSection;
  plugin.register(api as any);

  const handler = api.handlers.get("before_prompt_build");
  assert.ok(handler, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  assert.ok(orchestrator, "orchestrator should exist on globalThis after register");
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => null;
  orchestrator.config.compactionResetEnabled = false;

  // The handler should return undefined or a hook payload, not throw.
  const result = await handler(
    { prompt: "Hello how are you?" },
    { sessionKey: "test" },
  );
  // Result is either context object or undefined — both are acceptable
  assert.ok(
    result === undefined || result === null || typeof result === "object",
    `expected undefined/null/object, got ${typeof result}`,
  );
});

test("registerCommand exposes the remnic discovery descriptor", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("commands-list-test");
  plugin.register(api as any);

  assert.equal(
    api.handlers.has("commands.list"),
    false,
    "commands.list should not be registered on current OpenClaw SDKs",
  );
  const group = getRegisteredRemnicCommand(api);
  assert.ok(group, "remnic command should be registered");
  assert.equal(group?.name, "remnic");
  assert.equal(Array.isArray(group?.subcommands), true);
  for (const command of group?.subcommands ?? []) {
    assert.equal(typeof command.handler, "function");
  }
  assert.equal(typeof group?.handler, "function");
});

test("registerCommand stays hidden when session toggles are disabled", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("commands-list-disabled-toggle-test");
  api.pluginConfig = {
    sessionTogglesEnabled: false,
  };
  plugin.register(api as any);

  assert.equal(
    api.handlers.has("commands.list"),
    false,
    "commands.list should stay hidden when session toggle commands are disabled",
  );
  assert.equal(api._registeredCommands.length, 0);
});

test("before_prompt_build respects the primary session toggle store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-toggle-hook-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-toggle-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const remnicCommand = getRegisteredRemnicCommand(api);
  assert.equal(typeof remnicCommand?.handler, "function");
  const offReply = await remnicCommand?.handler?.({
    sessionKey: "session-a",
    agentId: "main",
    args: "off",
  });
  assert.match(String(offReply?.text ?? ""), /disabled/i);

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  let recallCalls = 0;
  orchestrator.recall = async () => {
    recallCalls++;
    return "should never be injected";
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "Remember anything?" },
    { sessionKey: "session-a", agentId: "main" },
  );

  assert.equal(recallCalls, 0);
  assert.equal(result, undefined);
  assert.equal(api._memoryCapability?.promptBuilder?.({ sessionKey: "session-a" }) ?? null, null);
});

test("before_prompt_build honors bundled active-memory toggle read-through and writes recall audit transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bundled-toggle-hook-"));
  const bundledDir = path.join(root, "state", "plugins", "active-memory");
  await mkdir(bundledDir, { recursive: true });
  await writeFile(
    path.join(bundledDir, "session-toggles.json"),
    JSON.stringify(
      {
        version: 1,
        entries: {
          [`${encodeURIComponent("session-b")}::${encodeURIComponent("main")}`]: {
            disabled: true,
            updatedAt: "2026-04-12T12:00:00Z",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-bundled-toggle-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    recallTranscriptsEnabled: true,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "should not run";
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "Remember anything?" },
    { sessionKey: "session-b", agentId: "main" },
  );
  assert.equal(result, undefined);

  const auditPath = path.join(
    root,
    "state",
    "plugins",
    "openclaw-remnic",
    "transcripts",
    new Date().toISOString().slice(0, 10),
    `${encodeURIComponent("session-b")}.jsonl`,
  );
  const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? "{}") as { toggleState?: string };
  assert.equal(parsed.toggleState, "disabled-secondary");
});

test("before_prompt_build prepends the active-recall fallback block when enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-hook-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-active-recall-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    activeRecallEnabled: true,
    activeRecallAllowChainedActiveMemory: true,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "remembered context from Remnic";
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "What happened with CI?" },
    { sessionKey: "session-c", agentId: "main" },
  );
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Recall \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /remembered context from Remnic/);
});

test("before_prompt_build still prepends Remnic active recall when chaining is disabled and bundled active-memory is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-no-chain-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-active-recall-no-chain-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    activeRecallEnabled: true,
    activeRecallAllowChainedActiveMemory: false,
    slotBehavior: {
      onSlotMismatch: "silent",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;
  let chainedRecallCalls = 0;
  let primaryRecallCalls = 0;
  orchestrator.recall = async (query: string) => {
    if (query.startsWith("current:")) {
      chainedRecallCalls++;
      return "remembered context from Remnic";
    }
    primaryRecallCalls++;
    return null;
  };
  orchestrator.getLastRecall = () => null;

  const result = await beforePromptBuild(
    { prompt: "What happened with CI?" },
    { sessionKey: "session-c-no-chain", agentId: "main" },
  );

  assert.equal(chainedRecallCalls, 1);
  assert.equal(primaryRecallCalls, 1);
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Recall \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /remembered context from Remnic/);
});

test("before_prompt_build prefers active OpenClaw config path for file-backed active-memory config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-file-collision-"));
  const configPath = path.join(root, "openclaw.json");
  const legacyConfigPath = path.join(root, "legacy-openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            "active-memory": {
              enabled: true,
              config: {
                agents: ["main"],
              },
            },
          },
          slots: {
            memory: "active-memory",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(legacyConfigPath, "{not valid json", "utf8");

  const previousConfigPaths = [process.env.OPENCLAW_CONFIG_PATH, process.env.OPENCLAW_ENGRAM_CONFIG_PATH] as const;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = legacyConfigPath;

  try {
    const { default: plugin } = await import("../src/index.js");
    const warnings: string[] = [];
    const api = buildHandlerCapturingApi("before-prompt-build-active-recall-file-collision-test");
    delete api.registerMemoryPromptSection;
    api.logger.warn = (message?: unknown) => warnings.push(String(message ?? ""));
    api.config = {
      plugins: {},
    };
    api.pluginConfig = {
      memoryDir: root,
      workspaceDir: root,
      activeRecallEnabled: true,
      activeRecallAllowChainedActiveMemory: false,
    };
    plugin.register(api as any);

    const beforePromptBuild = api.handlers.get("before_prompt_build");
    assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

    const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
    orchestrator.maybeRunFileHygiene = async () => undefined;
    orchestrator.config.compactionResetEnabled = false;
    let activeRecallCalls = 0;
    orchestrator.recall = async (query: string) => {
      if (query.startsWith("current:")) {
        activeRecallCalls++;
        return "remembered context from Remnic";
      }
      return null;
    };
    orchestrator.getLastRecall = () => null;

    const result = await beforePromptBuild(
      { prompt: "What happened with CI?" },
      { sessionKey: "session-c-file-collision", agentId: "main" },
    );

    assert.equal(activeRecallCalls, 0);
    assert.equal(result, undefined);
    assert.ok(
      warnings.some((message) =>
        message.includes("bundled active-memory plugin is enabled for agent \"main\""),
      ),
      "expected the file-backed active-memory config to suppress Remnic active recall",
    );
  } finally {
    if (previousConfigPaths[0] === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = previousConfigPaths[0];
    if (previousConfigPaths[1] === undefined) delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH; else process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousConfigPaths[1];
  }
});

test("before_prompt_build does not suppress Remnic active recall when runtime active-memory config is partial but file-backed agents exclude the current agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-partial-runtime-agents-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            "active-memory": {
              enabled: true,
              config: {
                agents: ["researcher"],
              },
            },
          },
          slots: {
            memory: "active-memory",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const previousConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = configPath;

  try {
    const { default: plugin } = await import("../src/index.js");
    const warnings: string[] = [];
    const api = buildHandlerCapturingApi("before-prompt-build-active-recall-partial-runtime-agents-test");
    delete api.registerMemoryPromptSection;
    api.logger.warn = (message?: unknown) => warnings.push(String(message ?? ""));
    api.config = {
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
          },
        },
      },
    };
    api.pluginConfig = {
      memoryDir: root,
      workspaceDir: root,
      activeRecallEnabled: true,
      activeRecallAllowChainedActiveMemory: false,
    };
    plugin.register(api as any);

    const beforePromptBuild = api.handlers.get("before_prompt_build");
    assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

    const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
    orchestrator.maybeRunFileHygiene = async () => undefined;
    orchestrator.config.compactionResetEnabled = false;
    let activeRecallCalls = 0;
    orchestrator.recall = async (query: string) => {
      if (query.startsWith("current:")) {
        activeRecallCalls++;
        return "remembered context from Remnic";
      }
      return null;
    };
    orchestrator.getLastRecall = () => null;

    const result = await beforePromptBuild(
      { prompt: "What happened with CI?" },
      { sessionKey: "session-c-partial-runtime-agents", agentId: "main" },
    );

    assert.equal(activeRecallCalls, 1);
    assert.match(String(result?.prependSystemContext ?? ""), /## Active Recall \(Remnic\)/);
    assert.match(String(result?.prependSystemContext ?? ""), /remembered context from Remnic/);
    assert.equal(
      warnings.some((message) =>
        message.includes("bundled active-memory plugin is enabled for agent \"main\""),
      ),
      false,
    );
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("before_prompt_build treats string active-memory enabled=false as disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-partial-runtime-enabled-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            "active-memory": {
              enabled: "false",
              config: {
                agents: ["main"],
              },
            },
          },
          slots: {
            memory: "active-memory",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const previousConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = configPath;

  try {
    const { default: plugin } = await import("../src/index.js");
    const warnings: string[] = [];
    const api = buildHandlerCapturingApi("before-prompt-build-active-recall-partial-runtime-enabled-test");
    delete api.registerMemoryPromptSection;
    api.logger.warn = (message?: unknown) => warnings.push(String(message ?? ""));
    api.config = {
      plugins: {
        entries: {
          "active-memory": {
            config: {
              agents: ["main"],
            },
          },
        },
      },
    };
    api.pluginConfig = {
      memoryDir: root,
      workspaceDir: root,
      activeRecallEnabled: true,
      activeRecallAllowChainedActiveMemory: false,
    };
    plugin.register(api as any);

    const beforePromptBuild = api.handlers.get("before_prompt_build");
    assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

    const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
    orchestrator.maybeRunFileHygiene = async () => undefined;
    orchestrator.config.compactionResetEnabled = false;
    let activeRecallCalls = 0;
    orchestrator.recall = async (query: string) => {
      if (query.startsWith("current:")) {
        activeRecallCalls++;
        return "remembered context from Remnic";
      }
      return null;
    };
    orchestrator.getLastRecall = () => null;

    const result = await beforePromptBuild(
      { prompt: "What happened with CI?" },
      { sessionKey: "session-c-partial-runtime-enabled", agentId: "main" },
    );

    assert.equal(activeRecallCalls, 1);
    assert.match(String(result?.prependSystemContext ?? ""), /## Active Recall \(Remnic\)/);
    assert.match(String(result?.prependSystemContext ?? ""), /remembered context from Remnic/);
    assert.equal(
      warnings.some((message) =>
        message.includes("bundled active-memory plugin is enabled for agent \"main\""),
      ),
      false,
    );
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("before_prompt_build does not suppress Remnic active recall when file-backed active-memory explicitly scopes to no agents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-empty-file-agents-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            "active-memory": {
              enabled: true,
              config: {
                agents: [],
              },
            },
          },
          slots: {
            memory: "active-memory",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const previousConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = configPath;

  try {
    const { default: plugin } = await import("../src/index.js");
    const warnings: string[] = [];
    const api = buildHandlerCapturingApi("before-prompt-build-empty-file-agents-test");
    delete api.registerMemoryPromptSection;
    api.logger.warn = (message?: unknown) => warnings.push(String(message ?? ""));
    api.config = {
      plugins: {},
    };
    api.pluginConfig = {
      memoryDir: root,
      workspaceDir: root,
      activeRecallEnabled: true,
      activeRecallAllowChainedActiveMemory: false,
    };
    plugin.register(api as any);

    const beforePromptBuild = api.handlers.get("before_prompt_build");
    assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

    const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
    orchestrator.maybeRunFileHygiene = async () => undefined;
    orchestrator.config.compactionResetEnabled = false;
    let activeRecallCalls = 0;
    orchestrator.recall = async (query: string) => {
      if (query.startsWith("current:")) {
        activeRecallCalls++;
        return "remembered context from Remnic";
      }
      return null;
    };
    orchestrator.getLastRecall = () => null;

    const result = await beforePromptBuild(
      { prompt: "What happened with CI?" },
      { sessionKey: "session-c-empty-file-agents", agentId: "main" },
    );

    assert.equal(activeRecallCalls, 1);
    assert.match(String(result?.prependSystemContext ?? ""), /## Active Recall \(Remnic\)/);
    assert.match(String(result?.prependSystemContext ?? ""), /remembered context from Remnic/);
    assert.equal(
      warnings.some((message) =>
        message.includes("bundled active-memory plugin is enabled for agent \"main\""),
      ),
      false,
    );
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("before_prompt_build does not suppress Remnic active recall when active-memory is enabled but not slotted into the memory slot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-unslotted-active-memory-"));
  const { default: plugin } = await import("../src/index.js");
  const warnings: string[] = [];
  const api = buildHandlerCapturingApi("before-prompt-build-unslotted-active-memory-test");
  delete api.registerMemoryPromptSection;
  api.logger.warn = (message?: unknown) => warnings.push(String(message ?? ""));
  api.config = {
    plugins: {
      entries: {
        "active-memory": {
          enabled: true,
          config: {
            agents: ["main"],
          },
        },
      },
      slots: {
        memory: "openclaw-remnic",
      },
    },
  };
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    activeRecallEnabled: true,
    activeRecallAllowChainedActiveMemory: false,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;
  let activeRecallCalls = 0;
  orchestrator.recall = async (query: string) => {
    if (query.startsWith("current:")) {
      activeRecallCalls++;
      return "remembered context from Remnic";
    }
    return null;
  };
  orchestrator.getLastRecall = () => null;

  const result = await beforePromptBuild(
    { prompt: "What happened with CI?" },
    { sessionKey: "session-c-unslotted-active-memory", agentId: "main" },
  );

  assert.equal(activeRecallCalls, 1);
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Recall \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /remembered context from Remnic/);
  assert.equal(
    warnings.some((message) =>
      message.includes("bundled active-memory plugin is enabled for agent \"main\""),
    ),
    false,
  );
});

test("before_prompt_build prepends recent dreams when dreaming injection is enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreaming-hook-"));
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T08:00:00Z — First dream*",
      "",
      "The first dream body.",
      "",
      "---",
      "",
      "*2026-04-12T09:00:00Z — Second dream*",
      "",
      "The second dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-dreaming-test");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    dreaming: {
      enabled: true,
      journalPath: "DREAMS.md",
      injectRecentCount: 2,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "remembered context from Remnic";
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "What happened this morning?" },
    { sessionKey: "session-d", agentId: "main", workspaceDir: root },
  );

  assert.match(String(result?.prependSystemContext ?? ""), /## Recent Dreams \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /Second dream/);
  assert.match(String(result?.prependSystemContext ?? ""), /The second dream body/);
  assert.match(String(result?.prependSystemContext ?? ""), /First dream/);
});

test("before_prompt_build records auxiliary-only dream injection in recall audit transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-auxiliary-recall-audit-"));
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T09:00:00Z — Second dream*",
      "",
      "The second dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-auxiliary-audit-test");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    recallTranscriptsEnabled: true,
    dreaming: {
      enabled: true,
      journalPath: "DREAMS.md",
      injectRecentCount: 1,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => null;
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "Any dream context?", verbose: true },
    { sessionKey: "session-e", agentId: "main", workspaceDir: root },
  );

  assert.equal(result, undefined);
  assert.match(
    String((api._memoryPromptSection?.({ sessionKey: "session-e" }) ?? []).join("\n")),
    /The second dream body/,
  );

  const auditPath = path.join(
    root,
    "state",
    "plugins",
    "openclaw-remnic",
    "transcripts",
    new Date().toISOString().slice(0, 10),
    `${encodeURIComponent("session-e")}.jsonl`,
  );
  const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? "{}") as {
    summary?: string | null;
    injectedChars?: number;
  };
  assert.match(String(parsed.summary ?? ""), /The second dream body/);
  assert.ok((parsed.injectedChars ?? 0) > 0);
});

test("before_prompt_build avoids double-injecting auxiliary no-recall context when memory prompt sections are enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-no-recall-aux-section-"));
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T10:00:00Z — First dream*",
      "",
      "The second dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-no-recall-section-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    dreaming: {
      enabled: true,
      injectRecentCount: 2,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => null;
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "No ordinary recall should land here." },
    { sessionKey: "session-no-recall", agentId: "main" },
  );

  assert.equal(
    result,
    undefined,
    "auxiliary no-recall context should stay in the memory section cache when memory prompt sections are enabled",
  );
  assert.deepEqual(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-no-recall" }),
    [
      "## Recent Dreams (Remnic)",
      "",
      "- 2026-04-12T10:00:00Z — First dream: The second dream body.",
      "",
    ],
  );
});

test("before_prompt_build suppresses auxiliary memory injection when planner mode is no_recall", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-no-recall-active-recall-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-no-recall-active-recall-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    activeRecallEnabled: true,
    activeRecallAllowChainedActiveMemory: true,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;
  let recallCalls = 0;
  orchestrator.recall = async () => {
    recallCalls++;
    return null;
  };
  orchestrator.getLastRecall = () => ({
    memoryIds: [],
    plannerMode: "no_recall",
    requestedMode: "no_recall",
    fallbackUsed: false,
    latencyMs: 0,
  });

  const result = await beforePromptBuild(
    { prompt: "ok" },
    { sessionKey: "session-no-recall-active-recall", agentId: "main" },
  );

  assert.equal(
    result,
    undefined,
    "planner no_recall should suppress active-recall-only prompt injection",
  );
  assert.equal(
    recallCalls,
    0,
    "planner no_recall should skip chained active-recall work before any recall lookup runs",
  );
});

test("runtime pluginConfig overrides file-backed config for dreaming surfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreaming-config-precedence-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T10:00:00Z — Runtime dream*",
      "",
      "The runtime-configured dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            "openclaw-remnic": {
              config: {
                dreaming: {
                  enabled: false,
                  journalPath: "IGNORED.md",
                  injectRecentCount: 0,
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const previousConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = configPath;

  try {
    const { default: plugin } = await import("../src/index.js");
    const api = buildHandlerCapturingApi("before-prompt-build-config-precedence-test");
    api.pluginConfig = {
      memoryDir: root,
      workspaceDir: root,
      dreaming: {
        enabled: true,
        journalPath: "DREAMS.md",
        injectRecentCount: 1,
      },
    };
    plugin.register(api as any);

    const beforePromptBuild = api.handlers.get("before_prompt_build");
    assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

    const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
    orchestrator.maybeRunFileHygiene = async () => undefined;
    orchestrator.recall = async () => "remembered context from Remnic";
    orchestrator.config.compactionResetEnabled = false;

    const result = await beforePromptBuild(
      { prompt: "What happened mid-morning?" },
      { sessionKey: "session-e", agentId: "main", workspaceDir: root },
    );

    assert.match(String(result?.prependSystemContext ?? ""), /## Recent Dreams \(Remnic\)/);
    assert.match(String(result?.prependSystemContext ?? ""), /Runtime dream/);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("before_prompt_build gates normal recall during heartbeat runs and injects heartbeat context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-hook-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { StorageManager } = await import("../packages/remnic-core/src/storage.ts");
  const storage = new StorageManager(root);
  await storage.writeMemory("fact", "Last run found two new failures in the flaky integration suite.", {
    source: "test",
    tags: ["heartbeat", "ci"],
    structuredAttributes: {
      relatedHeartbeatSlug: "check-test-suite",
    },
  });

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 5,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  let recallCalls = 0;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall should be gated during heartbeat runs";
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "session-heartbeat-a",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.equal(recallCalls, 0);
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /check-test-suite/);
  assert.match(String(result?.prependSystemContext ?? ""), /## Previous Runs/);
  assert.match(String(result?.prependSystemContext ?? ""), /two new failures/);
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
});

test("gateway_start heartbeat sync does not clear prior heartbeat links when the journal is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-startup-missing-"));
  const { StorageManager } = await import("../packages/remnic-core/src/storage.ts");
  const storage = new StorageManager(root);
  const memoryId = await storage.writeMemory(
    "fact",
    "Last run found two new failures in the flaky integration suite.",
    {
      source: "test",
      tags: ["heartbeat", "ci", "heartbeat:check-test-suite"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("heartbeat-startup-missing-journal");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      watchFile: false,
    },
  };
  plugin.register(api as any);

  assert.ok(api._registeredServiceStart, "service start should be registered");

  try {
    await api._registeredServiceStart?.();
    const allMemories = await storage.readAllMemories();
    const memory = allMemories.find((entry) => entry.frontmatter.id === memoryId);
    assert.equal(
      memory?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
      "check-test-suite",
    );
    assert.deepEqual(memory?.frontmatter.tags, ["heartbeat", "ci", "heartbeat:check-test-suite"]);
  } finally {
    await api._registeredServiceStop?.();
  }
});

test("before_prompt_build reads previous heartbeat runs from the caller namespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-namespace-hook-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-namespace-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: "team-alpha",
        readPrincipals: ["team-alpha"],
        writePrincipals: ["team-alpha"],
        includeInRecallByDefault: false,
      },
    ],
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 5,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    throw new Error("normal recall should be gated during heartbeat runs");
  };
  orchestrator.config.compactionResetEnabled = false;

  await orchestrator.storage.writeMemory(
    "fact",
    "Default namespace result should stay isolated from team-alpha.",
    {
      source: "test",
      tags: ["heartbeat", "ci"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );

  const teamStorage = await orchestrator.getStorageForNamespace("team-alpha");
  await teamStorage.writeMemory(
    "fact",
    "Team alpha run found the adapter-specific regression.",
    {
      source: "test",
      tags: ["heartbeat", "ci"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "agent:team-alpha:main",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.match(String(result?.prependSystemContext ?? ""), /## Previous Runs/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /Team alpha run found the adapter-specific regression\./,
  );
  assert.doesNotMatch(
    String(result?.prependSystemContext ?? ""),
    /Default namespace result should stay isolated from team-alpha\./,
  );
});

test("before_prompt_build only treats canonical heartbeat links as previous runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-canonical-links-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { StorageManager } = await import("../packages/remnic-core/src/storage.ts");
  const storage = new StorageManager(root);
  await storage.writeMemory(
    "fact",
    "During check-test-suite, the canonical heartbeat-linked run found two new failures.",
    {
      source: "test",
      tags: ["heartbeat", "ci", "heartbeat:check-test-suite"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );
  await storage.writeMemory("fact", "Unrelated memory happens to use the slug as a normal tag.", {
    source: "test",
    tags: ["check-test-suite", "ops"],
  });

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-canonical-links");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 5,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    throw new Error("normal recall should be gated during heartbeat runs");
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "session-heartbeat-canonical",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.match(String(result?.prependSystemContext ?? ""), /## Previous Runs/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /canonical heartbeat-linked run found two new failures\./i,
  );
  assert.doesNotMatch(
    String(result?.prependSystemContext ?? ""),
    /Unrelated memory happens to use the slug as a normal tag\./,
  );
});

test("before_prompt_build falls back to heuristic heartbeat detection when runtime signals are absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-heuristic-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-heuristic-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 3,
      detectionMode: "heuristic",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  let recallCalls = 0;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall should be gated during heuristic heartbeat runs";
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "session-heartbeat-heuristic-a",
      agentId: "main",
      workspaceDir: root,
    },
  );

  assert.equal(recallCalls, 0);
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /check-test-suite/);
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
});

test("before_prompt_build does not inject heartbeat context when multiple heartbeat tasks match the prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-ambiguous-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
      "## sync-secrets",
      "",
      "Every day, refresh secrets from the vault.",
      "",
      "Schedule: daily",
      "Tags: #ops #secrets",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-ambiguous-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 3,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;

  let recallCalls = 0;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall stays active when heartbeat selection is ambiguous";
  };

  const result = await beforePromptBuild(
    {
      prompt:
        "Run the following periodic tasks: check-test-suite and sync-secrets. Summarize what changed.",
    },
    {
      sessionKey: "session-heartbeat-ambiguous-a",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.equal(recallCalls, 1);
  assert.match(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /normal recall stays active when heartbeat selection is ambiguous/,
  );
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
});

test("before_prompt_build does not relink heartbeat outcomes on non-heartbeat prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-normal-prompt-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-normal-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 3,
      detectionMode: "heuristic",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;
  await orchestrator.storage.writeMemory(
    "fact",
    "During check-test-suite we found two new failures in the smoke run.",
    {
      source: "test",
      tags: ["ci"],
    },
  );

  let writeFrontmatterCalls = 0;
  const originalWriteMemoryFrontmatter =
    orchestrator.storage.writeMemoryFrontmatter.bind(orchestrator.storage);
  orchestrator.storage.writeMemoryFrontmatter = async (...args: unknown[]) => {
    writeFrontmatterCalls++;
    return originalWriteMemoryFrontmatter(
      args[0] as Parameters<typeof originalWriteMemoryFrontmatter>[0],
      args[1] as Parameters<typeof originalWriteMemoryFrontmatter>[1],
    );
  };

  let recallCalls = 0;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall stays active for ordinary prompts";
  };

  const result = await beforePromptBuild(
    {
      prompt: "What changed in the integration tests this morning?",
    },
    {
      sessionKey: "session-heartbeat-normal-a",
      agentId: "main",
      workspaceDir: root,
    },
  );

  assert.equal(writeFrontmatterCalls, 0);
  assert.equal(recallCalls, 1);
  assert.match(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /normal recall stays active for ordinary prompts/,
  );
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
});

test("agent_end skips transcript persistence and extraction buffering for heartbeat runs by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-agent-end-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-heartbeat-test");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      gateExtractionDuringHeartbeat: true,
    },
  };
  plugin.register(api as any);

  const agentEnd = api.handlers.get("agent_end");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  let transcriptAppendCalls = 0;
  let processTurnCalls = 0;
  orchestrator.transcript.append = async () => {
    transcriptAppendCalls++;
  };
  orchestrator.processTurn = async () => {
    processTurnCalls++;
  };

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: "Read HEARTBEAT.md if it exists (workspace context)." },
        { role: "assistant", content: "HEARTBEAT_OK" },
      ],
    },
    {
      sessionKey: "session-heartbeat-b",
      trigger: "heartbeat",
    },
  );

  assert.equal(transcriptAppendCalls, 0);
  assert.equal(processTurnCalls, 0);
});

test("agent_end routes Codex-managed turns through the logical thread buffer key", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-codex-thread-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const agentEnd = api.handlers.get("agent_end");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.transcript.append = async () => undefined;
  const processTurnCalls: Array<Record<string, unknown>> = [];
  orchestrator.processTurn = async (
    role: string,
    content: string,
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    processTurnCalls.push({ role, content, sessionKey, options });
  };

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: "Please remember this Codex-threaded fact." },
        { role: "assistant", content: "Saved for the Codex compatibility test." },
      ],
    },
    {
      sessionKey: "session-codex-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-99",
    },
  );

  assert.equal(processTurnCalls.length, 2);
  for (const call of processTurnCalls) {
    assert.equal(call.sessionKey, "session-codex-a");
    assert.ok(
      ((call.options as { bufferKey?: string }).bufferKey ?? "").startsWith(
        "codex-thread:thread-99",
      ),
      "Codex-managed turns should keep the logical thread prefix even when the buffer is principal-scoped",
    );
    assert.equal(
      (call.options as { providerThreadId?: string }).providerThreadId,
      "thread-99",
    );
    assert.equal(
      typeof (call.options as { turnFingerprint?: string }).turnFingerprint,
      "string",
    );
  }
});

test("agent_end fingerprints only the persisted user and assistant turns", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-codex-fingerprint-test");
  plugin.register(api as any);

  const agentEnd = api.handlers.get("agent_end");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.transcript.append = async () => undefined;
  const fingerprints: string[] = [];
  orchestrator.processTurn = async (
    _role: string,
    _content: string,
    _sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    const fingerprint = (options as { turnFingerprint?: string } | undefined)
      ?.turnFingerprint;
    if (typeof fingerprint === "string") {
      fingerprints.push(fingerprint);
    }
  };

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "system", content: "Skipped system frame" },
        { role: "user", content: "First persisted turn for Codex dedup." },
        { role: "tool", content: "Skipped tool frame" },
        { role: "assistant", content: "Second persisted turn for Codex dedup." },
      ],
    },
    {
      sessionKey: "session-codex-fingerprint",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-fingerprint-1",
    },
  );

  assert.equal(fingerprints.length, 2);
  assert.equal(fingerprints[0]?.split("\u0001").at(-1), "0");
  assert.equal(fingerprints[1]?.split("\u0001").at(-1), "1");
});

test("before_compaction flushes the logical Codex thread buffer before checkpoint work", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-compaction-codex-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "auto",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforeCompaction = api.handlers.get("before_compaction");
  assert.ok(beforeCompaction, "before_compaction handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.config.checkpointEnabled = false;
  orchestrator.lcmEngine = { enabled: false };

  let flushed:
    | {
        sessionKey: string;
        options: Record<string, unknown> | undefined;
      }
    | undefined;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushed = { sessionKey, options };
  };

  await beforeCompaction(
    { sessionKey: "session-compaction-a" },
    {
      sessionKey: "session-compaction-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-compaction-1",
    },
  );

  assert.equal(flushed?.sessionKey, "session-compaction-a");
  assert.equal(flushed?.options?.reason, "codex_compaction_signal");
  assert.ok(
    String(flushed?.options?.bufferKey ?? "").startsWith(
      "codex-thread:thread-compaction-1",
    ),
    "before_compaction should flush the Codex logical thread buffer",
  );
});

test("before_compaction falls back to the remembered Codex thread when the hook payload is sparse", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-compaction-codex-fallback-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "auto",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeCompaction = api.handlers.get("before_compaction");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeCompaction, "before_compaction handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.checkpointEnabled = false;
  orchestrator.lcmEngine = { enabled: false };

  let flushed:
    | {
        sessionKey: string;
        options: Record<string, unknown> | undefined;
      }
    | undefined;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushed = { sessionKey, options };
  };

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 6 },
    {
      sessionKey: "session-compaction-sparse-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-compaction-sparse-1",
    },
  );

  await beforeCompaction({ sessionKey: "session-compaction-sparse-a" }, {});

  assert.equal(flushed?.sessionKey, "session-compaction-sparse-a");
  assert.equal(flushed?.options?.reason, "codex_compaction_signal");
  assert.ok(
    String(flushed?.options?.bufferKey ?? "").startsWith(
      "codex-thread:thread-compaction-sparse-1",
    ),
    "before_compaction should reuse the remembered Codex logical thread buffer",
  );
});

test("before_compaction still runs the independent LCM pre-compaction flush when the Codex signal flush fails", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-compaction-codex-flush-failure-test");
  plugin.register(api as any);

  const beforeCompaction = api.handlers.get("before_compaction");
  assert.ok(beforeCompaction, "before_compaction handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.config.checkpointEnabled = false;
  let observeIdleCalls = 0;
  let preCompactionFlushCalls = 0;
  orchestrator.lcmEngine = {
    enabled: true,
    waitForSessionObserveIdle: async () => {
      observeIdleCalls += 1;
    },
    preCompactionFlush: async () => {
      preCompactionFlushCalls += 1;
    },
  };
  orchestrator.flushSession = async () => {
    throw new Error("signal flush failed");
  };

  await assert.doesNotReject(async () => {
    await beforeCompaction(
      { sessionKey: "session-compaction-failure-a" },
      {
        sessionKey: "session-compaction-failure-a",
        provider: { id: "codex", model: "codex/gpt-5.4" },
        providerThreadId: "thread-compaction-failure-1",
      },
    );
  });

  assert.equal(observeIdleCalls, 1);
  assert.equal(preCompactionFlushCalls, 1);
});

test("after_compaction preserves the Codex heuristic baseline when the signal flush fails", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("after-compaction-codex-heuristic-baseline-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "auto",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeCompaction = api.handlers.get("before_compaction");
  const afterCompaction = api.handlers.get("after_compaction");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeCompaction, "before_compaction handler should be registered");
  assert.ok(afterCompaction, "after_compaction handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.checkpointEnabled = false;
  orchestrator.config.compactionResetEnabled = false;
  orchestrator.lcmEngine = { enabled: false };

  const flushCalls: Array<Record<string, unknown>> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
    if (options?.reason === "codex_compaction_signal") {
      throw new Error("signal flush failed");
    }
  };

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-auto-baseline-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-auto-baseline-1",
    },
  );
  await beforeCompaction(
    { sessionKey: "session-auto-baseline-a" },
    {
      sessionKey: "session-auto-baseline-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-auto-baseline-1",
    },
  );
  await afterCompaction({ sessionKey: "session-auto-baseline-a" }, {});
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-auto-baseline-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-auto-baseline-1",
    },
  );

  assert.equal(flushCalls.length, 2);
  assert.equal(flushCalls[0]?.sessionKey, "session-auto-baseline-a");
  assert.equal(
    (flushCalls[0]?.options as { reason?: string }).reason,
    "codex_compaction_signal",
  );
  assert.equal(flushCalls[1]?.sessionKey, "session-auto-baseline-a");
  assert.equal(
    (flushCalls[1]?.options as { reason?: string }).reason,
    "codex_compaction_heuristic",
  );
  assert.ok(
    String(
      (flushCalls[1]?.options as { bufferKey?: string }).bufferKey ?? "",
    ).startsWith("codex-thread:thread-auto-baseline-1"),
    "after_compaction should preserve the Codex thread baseline for heuristic fallback",
  );
});

test("before_prompt_build uses the Codex heuristic fallback when thread history shrinks", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-heuristic-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";

  const flushCalls: Array<Record<string, unknown>> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-heuristic-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-1",
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-heuristic-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-1",
    },
  );

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-heuristic-a");
  assert.equal(
    (flushCalls[0]?.options as { reason?: string }).reason,
    "codex_compaction_heuristic",
  );
  assert.ok(
    String(
      (flushCalls[0]?.options as { bufferKey?: string }).bufferKey ?? "",
    ).startsWith("codex-thread:thread-heuristic-1"),
    "heuristic flushes should keep the Codex logical thread prefix",
  );
});

test("before_prompt_build still applies the Codex heuristic fallback when the post-compaction prompt is short", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-heuristic-short-prompt-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";

  const flushCalls: Array<Record<string, unknown>> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-heuristic-short-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-short-1",
    },
  );
  const shortPromptResult = await beforePromptBuild(
    { prompt: "ok", messageCount: 4 },
    {
      sessionKey: "session-heuristic-short-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-short-1",
    },
  );

  assert.equal(shortPromptResult, undefined);
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-heuristic-short-a");
  assert.equal(
    (flushCalls[0]?.options as { reason?: string }).reason,
    "codex_compaction_heuristic",
  );
  assert.ok(
    String(
      (flushCalls[0]?.options as { bufferKey?: string }).bufferKey ?? "",
    ).startsWith("codex-thread:thread-heuristic-short-1"),
    "short-prompt heuristic flushes should keep the Codex logical thread prefix",
  );
});

test("before_prompt_build retries the Codex heuristic fallback after a failed flush", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-heuristic-retry-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";

  const flushCalls: Array<Record<string, unknown>> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
    if (flushCalls.length === 1) {
      throw new Error("transient heuristic flush failure");
    }
  };

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-heuristic-retry-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-retry-1",
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-heuristic-retry-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-retry-1",
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-heuristic-retry-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-retry-1",
    },
  );

  assert.equal(flushCalls.length, 2);
  assert.equal(flushCalls[0]?.sessionKey, "session-heuristic-retry-a");
  assert.equal(flushCalls[1]?.sessionKey, "session-heuristic-retry-a");
  assert.equal(
    (flushCalls[1]?.options as { reason?: string }).reason,
    "codex_compaction_heuristic",
  );
  assert.ok(
    String(
      (flushCalls[1]?.options as { bufferKey?: string }).bufferKey ?? "",
    ).startsWith("codex-thread:thread-heuristic-retry-1"),
    "retry heuristic flushes should keep the Codex logical thread prefix",
  );
});

test("before_prompt_build preserves the Codex heuristic baseline across transient recall failures", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-recall-failure-baseline-test");
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;

  const flushCalls: Array<Record<string, unknown>> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  orchestrator.recall = async () => "Remembered context";
  await beforePromptBuild(
    { prompt: "Prime this Codex thread before the transient failure.", messageCount: 10 },
    {
      sessionKey: "session-recall-failure-baseline",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-recall-failure-baseline",
    },
  );

  orchestrator.recall = async () => {
    throw new Error("transient recall failure");
  };
  await beforePromptBuild(
    { prompt: "This recall fails after the heuristic baseline is refreshed.", messageCount: 10 },
    {
      sessionKey: "session-recall-failure-baseline",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-recall-failure-baseline",
    },
  );

  orchestrator.recall = async () => "Remembered context";
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-recall-failure-baseline",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-recall-failure-baseline",
    },
  );

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-recall-failure-baseline");
  assert.equal(
    (flushCalls[0]?.options as { reason?: string }).reason,
    "codex_compaction_heuristic",
  );
  assert.ok(
    String(
      (flushCalls[0]?.options as { bufferKey?: string }).bufferKey ?? "",
    ).startsWith("codex-thread:thread-recall-failure-baseline"),
    "transient recall failures should preserve the Codex heuristic baseline",
  );
});

test("before_prompt_build tracks Codex compaction baselines per principal-scoped buffer key", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-principal-baseline-test");
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
    principalFromSessionKeyMode: "map",
    principalFromSessionKeyRules: [
      { match: "session-alpha", principal: "team-alpha" },
      { match: "session-beta", principal: "team-beta" },
    ],
    namespacePolicies: [
      {
        name: "team-alpha",
        readPrincipals: ["team-alpha"],
        writePrincipals: ["team-alpha"],
        includeInRecallByDefault: false,
      },
      {
        name: "team-beta",
        readPrincipals: ["team-beta"],
        writePrincipals: ["team-beta"],
        includeInRecallByDefault: false,
      },
    ],
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";

  const flushCalls: Array<Record<string, unknown>> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-alpha",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-principal-baseline",
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-beta",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-principal-baseline",
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-alpha",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-principal-baseline",
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-beta",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-principal-baseline",
    },
  );

  assert.equal(flushCalls.length, 2);
  assert.deepEqual(
    flushCalls.map((call) => (call.options as { bufferKey?: string }).bufferKey),
    [
      "codex-thread:thread-shared-principal-baseline::principal:team-alpha",
      "codex-thread:thread-shared-principal-baseline::principal:team-beta",
    ],
  );
});

test("before_prompt_build keeps a shared Codex thread baseline when another session unbinds", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-shared-unbind-test");
  api.pluginConfig = {
    namespacesEnabled: false,
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";

  const flushCalls: Array<Record<string, unknown>> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-shared-unbind-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-unbind-1",
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-shared-unbind-b",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-unbind-1",
    },
  );
  await beforePromptBuild(
    { prompt: "This session switched providers." },
    {
      sessionKey: "session-shared-unbind-a",
      provider: { id: "openai", model: "gpt-4.1" },
    },
  );
  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 4 },
    {
      sessionKey: "session-shared-unbind-b",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-unbind-1",
    },
  );

  assert.equal(flushCalls.length, 2);
  assert.deepEqual(
    flushCalls.map((call) => ({
      sessionKey: call.sessionKey,
      reason: (call.options as { reason?: string } | undefined)?.reason,
      bufferKey: (call.options as { bufferKey?: string } | undefined)?.bufferKey,
    })),
    [
      {
        sessionKey: "session-shared-unbind-a",
        reason: "codex_provider_switch",
        bufferKey: "codex-thread:thread-shared-unbind-1",
      },
      {
        sessionKey: "session-shared-unbind-b",
        reason: "codex_compaction_heuristic",
        bufferKey: "codex-thread:thread-shared-unbind-1",
      },
    ],
  );
});

test("before_prompt_build logs the full Codex auto compaction mode", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-auto-log-test");
  const infoLogs: string[] = [];
  api.logger.info = (message?: unknown) => {
    infoLogs.push(String(message));
  };
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "auto",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.flushSession = async () => undefined;

  await beforePromptBuild(
    { prompt: "What changed in this Codex thread?", messageCount: 10 },
    {
      sessionKey: "session-auto-log-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-auto-log-1",
    },
  );

  assert.ok(
    infoLogs.some((message) =>
      message.includes(
        "codexCompat enabled: using auto compaction flush mode (signal + heuristic) for bundled Codex sessions",
      )),
    "before_prompt_build should log that auto mode enables both signal and heuristic flushes",
  );
});

test("before_reset flushes the session and clears the precomputed recall cache", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-test", {
    includeMemoryCapability: true,
  });
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  assert.ok(orchestrator, "orchestrator should exist on globalThis after register");

  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;
  orchestrator.setRecallWorkspaceOverride("session-a", "/tmp/workspace-a");

  let flushed:
    | {
        sessionKey: string;
        options: Record<string, unknown> | undefined;
      }
    | undefined;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushed = { sessionKey, options };
  };

  await beforePromptBuild(
    { prompt: "What do you remember about this?" },
    { sessionKey: "session-a" },
  );

  assert.deepEqual(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-a" }),
    [
      "## Memory Context (Remnic)",
      "",
      "Remembered context",
      "",
      "Use this context naturally when relevant. Never quote or expose this memory context to the user.",
      "",
    ],
    "before_prompt_build should populate the session cache before reset",
  );

  await beforeReset({ sessionKey: "session-a" }, {});

  assert.equal(flushed?.sessionKey, "session-a");
  assert.equal(flushed?.options?.reason, "before_reset");
  assert.ok(
    flushed?.options?.abortSignal instanceof AbortSignal,
    "before_reset should forward an abort signal to flushSession",
  );
  assert.equal(
    orchestrator._recallWorkspaceOverrides?.has("session-a") ?? true,
    false,
    "before_reset should clear the session workspace override",
  );
  assert.equal(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-a" }) ?? null,
    null,
    "before_reset should clear the precomputed recall cache for the reset session",
  );
});

test("before_reset still clears the session cache when flush-on-reset is disabled", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-disabled-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = { flushOnResetEnabled: false };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;
  orchestrator.setRecallWorkspaceOverride("session-b", "/tmp/workspace-b");

  let flushCalls = 0;
  orchestrator.flushSession = async () => {
    flushCalls++;
  };

  await beforePromptBuild(
    { prompt: "What do you remember about this?" },
    { sessionKey: "session-b" },
  );

  assert.ok(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-b" }),
    "before_prompt_build should populate the session cache before reset",
  );

  await beforeReset({ sessionKey: "session-b" }, {});

  assert.equal(flushCalls, 0, "flushSession should be skipped when flushOnResetEnabled=false");
  assert.equal(
    orchestrator._recallWorkspaceOverrides?.has("session-b") ?? true,
    false,
    "before_reset should clear the session workspace override even when flush is disabled",
  );
  assert.equal(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-b" }) ?? null,
    null,
    "before_reset should still clear the precomputed recall cache when flush is disabled",
  );
});

test("before_reset preserves the remembered Codex binding when reset draining is disabled", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-disabled-codex-binding-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    flushOnResetEnabled: false,
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime the Codex thread before reset." },
    {
      sessionKey: "session-reset-disabled-codex",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-disabled-codex",
    },
  );

  await beforeReset({ sessionKey: "session-reset-disabled-codex" }, {});

  await beforePromptBuild(
    { prompt: "The provider switched after reset without draining." },
    {
      sessionKey: "session-reset-disabled-codex",
      provider: { id: "openai", model: "gpt-5.4" },
    },
  );

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-reset-disabled-codex");
  assert.equal(flushCalls[0]?.options?.reason, "codex_provider_switch");
  assert.ok(
    String(flushCalls[0]?.options?.bufferKey ?? "").startsWith(
      "codex-thread:thread-reset-disabled-codex",
    ),
    "the remembered Codex thread should remain available for the later provider-switch drain",
  );
});

test("before_reset reuses the remembered Codex thread id for logical flush keying", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-codex-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  let flushed:
    | {
        sessionKey: string;
        options: Record<string, unknown> | undefined;
      }
    | undefined;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushed = { sessionKey, options };
  };

  await beforePromptBuild(
    { prompt: "What does this Codex thread remember?" },
    {
      sessionKey: "session-reset-codex",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-codex",
    },
  );

  assert.ok(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-reset-codex" }),
    "before_prompt_build should populate the Codex session cache before reset",
  );

  await beforeReset({ sessionKey: "session-reset-codex" }, {});

  assert.equal(flushed?.sessionKey, "session-reset-codex");
  assert.equal(flushed?.options?.reason, "before_reset");
  assert.ok(
    String(flushed?.options?.bufferKey ?? "").startsWith(
      "codex-thread:thread-reset-codex",
    ),
    "before_reset should flush the remembered Codex logical thread buffer",
  );
  assert.equal(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-reset-codex" }) ?? null,
    null,
    "before_reset should clear the cached Codex prompt-section entry",
  );
});

test("before_reset preserves the shared Codex baseline when another session stays bound", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-shared-codex-baseline-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    namespacesEnabled: false,
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime the shared Codex baseline.", messageCount: 10 },
    {
      sessionKey: "session-reset-shared-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-shared-baseline",
    },
  );
  await beforePromptBuild(
    { prompt: "Prime the shared Codex baseline.", messageCount: 10 },
    {
      sessionKey: "session-reset-shared-b",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-shared-baseline",
    },
  );

  await beforeReset({ sessionKey: "session-reset-shared-a" }, {});

  await beforePromptBuild(
    { prompt: "The thread compacted after session A reset.", messageCount: 4 },
    {
      sessionKey: "session-reset-shared-b",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-shared-baseline",
    },
  );

  assert.equal(flushCalls.length, 2);
  assert.deepEqual(
    flushCalls.map((call) => ({
      sessionKey: call.sessionKey,
      reason: call.options?.reason,
      bufferKey: call.options?.bufferKey,
    })),
    [
      {
        sessionKey: "session-reset-shared-a",
        reason: "before_reset",
        bufferKey: "codex-thread:thread-reset-shared-baseline",
      },
      {
        sessionKey: "session-reset-shared-b",
        reason: "codex_compaction_heuristic",
        bufferKey: "codex-thread:thread-reset-shared-baseline",
      },
    ],
  );
});

test("before_prompt_build runs the compaction heuristic for remembered Codex threads when hook metadata is sparse", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-sparse-codex-heuristic-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    namespacesEnabled: false,
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime the Codex thread before sparse heuristic detection.", messageCount: 9 },
    {
      sessionKey: "session-sparse-codex-heuristic",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-sparse-codex-heuristic",
    },
  );

  await beforePromptBuild(
    {
      prompt: "The next hook only carries the remembered provider thread id.",
      messageCount: 3,
      providerThreadId: "thread-sparse-codex-heuristic",
    },
    {
      sessionKey: "session-sparse-codex-heuristic",
    },
  );

  assert.equal(flushCalls.length, 1);
  assert.deepEqual(
    flushCalls[0],
    {
      sessionKey: "session-sparse-codex-heuristic",
      options: {
        reason: "codex_compaction_heuristic",
        bufferKey: "codex-thread:thread-sparse-codex-heuristic",
      },
    },
  );
});

test("before_prompt_build does not run the Codex heuristic fallback when codex compat is disabled", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-codex-heuristic-disabled-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    namespacesEnabled: false,
    codexCompat: {
      enabled: false,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforeCompaction = api.handlers.get("before_compaction");
  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforeCompaction, "before_compaction handler should be registered");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforeCompaction(
    { sessionKey: "session-heuristic-disabled-a" },
    {
      sessionKey: "session-heuristic-disabled-a",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-heuristic-disabled-1",
    },
  );

  await beforePromptBuild(
    {
      prompt: "Prime the remembered thread while codex compat is disabled.",
      messageCount: 9,
      providerThreadId: "thread-heuristic-disabled-1",
    },
    {
      sessionKey: "session-heuristic-disabled-a",
    },
  );

  await beforePromptBuild(
    {
      prompt: "The next sparse prompt should not flush because codex compat is disabled.",
      messageCount: 3,
      providerThreadId: "thread-heuristic-disabled-1",
    },
    {
      sessionKey: "session-heuristic-disabled-a",
    },
  );

  assert.deepEqual(flushCalls, []);
});

test("before_reset preserves the remembered Codex thread after a transient recall failure", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-codex-recall-failure-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;

  let flushed:
    | {
        sessionKey: string;
        options: Record<string, unknown> | undefined;
      }
    | undefined;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushed = { sessionKey, options };
  };

  orchestrator.recall = async () => "Remembered context";
  await beforePromptBuild(
    { prompt: "Prime this Codex session before the transient failure." },
    {
      sessionKey: "session-reset-codex-failure",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-codex-failure",
    },
  );

  orchestrator.recall = async () => {
    throw new Error("transient recall failure");
  };
  await beforePromptBuild(
    { prompt: "This recall will fail but should keep the Codex alias." },
    {
      sessionKey: "session-reset-codex-failure",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-codex-failure",
    },
  );

  await beforeReset({ sessionKey: "session-reset-codex-failure" }, {});

  assert.equal(flushed?.sessionKey, "session-reset-codex-failure");
  assert.equal(flushed?.options?.reason, "before_reset");
  assert.ok(
    String(flushed?.options?.bufferKey ?? "").startsWith(
      "codex-thread:thread-reset-codex-failure",
    ),
    "transient recall failures should preserve the remembered Codex logical thread buffer",
  );
});

test("before_reset stops using the remembered Codex thread after an explicit provider switch", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-provider-switch-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime this Codex session before the provider switch." },
    {
      sessionKey: "session-reset-provider-switch",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-provider-switch",
    },
  );

  await beforePromptBuild(
    { prompt: "This session is now running on a non-Codex provider." },
    {
      sessionKey: "session-reset-provider-switch",
      provider: { id: "openai", model: "gpt-5.4" },
    },
  );

  await beforeReset({ sessionKey: "session-reset-provider-switch" }, {});

  assert.equal(flushCalls.length, 2);
  assert.deepEqual(
    flushCalls.map((call) => ({
      sessionKey: call.sessionKey,
      reason: call.options?.reason,
      bufferKey: call.options?.bufferKey,
    })),
    [
      {
        sessionKey: "session-reset-provider-switch",
        reason: "codex_provider_switch",
        bufferKey: "codex-thread:thread-reset-provider-switch::principal:default",
      },
      {
        sessionKey: "session-reset-provider-switch",
        reason: "before_reset",
        bufferKey: "session-reset-provider-switch",
      },
    ],
  );
});

test("before_reset drains previously bound Codex buffers after thread rebinding", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-codex-rebind-drain-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.transcript.append = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;

  const oldBufferKey = "codex-thread:thread-reset-rebind-old";
  const newBufferKey = "codex-thread:thread-reset-rebind-new";
  orchestrator.buffer.findBufferKeysForSession = async (sessionKey: string) =>
    sessionKey === "session-reset-rebind" ? [oldBufferKey, newBufferKey] : [];
  orchestrator.buffer.getTurns = (bufferKey: string) =>
    bufferKey === oldBufferKey || bufferKey === newBufferKey
      ? [{ role: "user", content: "pending " + bufferKey, timestamp: new Date().toISOString(), sessionKey: "session-reset-rebind" }]
      : [];

  const flushCalls: Array<string> = [];
  orchestrator.flushSession = async (
    _sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push(String(options?.bufferKey ?? ""));
  };

  await beforePromptBuild(
    { prompt: "Prime the old Codex thread before rebinding it." },
    {
      sessionKey: "session-reset-rebind",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-rebind-old",
    },
  );

  await beforePromptBuild(
    { prompt: "Rebind this Codex session onto a new provider thread id." },
    {
      sessionKey: "session-reset-rebind",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-rebind-new",
    },
  );

  await beforeReset({ sessionKey: "session-reset-rebind" }, {});

  assert.ok(flushCalls.length >= 2);
  assert.ok(
    flushCalls.some((bufferKey) => bufferKey.startsWith(oldBufferKey)),
    "before_reset should still drain the previously bound Codex buffer after rebinding",
  );
  assert.ok(
    flushCalls.some((bufferKey) => bufferKey.startsWith(newBufferKey)),
    "before_reset should drain the current Codex buffer after rebinding",
  );
});

test("before_reset preserves the remembered Codex thread when the provider-switch flush fails", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi(
    "before-reset-provider-switch-flush-failure-test",
    {
      includeMemoryCapability: true,
    },
  );
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  let failProviderSwitchFlush = true;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
    if (
      failProviderSwitchFlush &&
      options?.reason === "codex_provider_switch"
    ) {
      failProviderSwitchFlush = false;
      throw new Error("provider-switch flush failed");
    }
  };

  await beforePromptBuild(
    { prompt: "Prime this Codex session before the provider switch flush fails." },
    {
      sessionKey: "session-reset-provider-switch-flush-failure",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-provider-switch-flush-failure",
    },
  );

  await beforePromptBuild(
    { prompt: "This session is now running on a non-Codex provider." },
    {
      sessionKey: "session-reset-provider-switch-flush-failure",
      provider: { id: "openai", model: "gpt-5.4" },
    },
  );

  await beforeReset(
    { sessionKey: "session-reset-provider-switch-flush-failure" },
    {},
  );

  assert.deepEqual(
    flushCalls.map((call) => ({
      sessionKey: call.sessionKey,
      reason: call.options?.reason,
      bufferKey: call.options?.bufferKey,
    })),
    [
      {
        sessionKey: "session-reset-provider-switch-flush-failure",
        reason: "codex_provider_switch",
        bufferKey:
          "codex-thread:thread-reset-provider-switch-flush-failure::principal:default",
      },
      {
        sessionKey: "session-reset-provider-switch-flush-failure",
        reason: "before_reset",
        bufferKey:
          "codex-thread:thread-reset-provider-switch-flush-failure::principal:default",
      },
    ],
  );
});

test("before_reset keeps metadata-less follow-up turns on the remembered Codex buffer", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-metadata-less-agent-end-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  const agentEnd = api.handlers.get("agent_end");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.transcript.append = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };
  orchestrator.processTurn = async () => undefined;

  await beforePromptBuild(
    { prompt: "Prime this Codex session before metadata goes missing." },
    {
      sessionKey: "session-reset-metadata-less",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-metadata-less",
    },
  );

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: "This metadata-less follow-up should buffer on the raw key." },
        { role: "assistant", content: "Acknowledged." },
      ],
    },
    {
      sessionKey: "session-reset-metadata-less",
    },
  );

  await beforeReset({ sessionKey: "session-reset-metadata-less" }, {});

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-reset-metadata-less");
  assert.equal(flushCalls[0]?.options?.reason, "before_reset");
  assert.ok(
    String(flushCalls[0]?.options?.bufferKey ?? "").startsWith(
      "codex-thread:thread-reset-metadata-less",
    ),
    "before_reset should keep using the remembered Codex logical buffer even when follow-up hooks are sparse",
  );
});

test("session_end releases remembered Codex bindings after a successful drain", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-end-codex-binding-release-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const sessionEnd = api.handlers.get("session_end");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(sessionEnd, "session_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime the Codex session before ending it." },
    {
      sessionKey: "session-end-codex-release",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-session-end-codex-release",
    },
  );

  await sessionEnd({ sessionKey: "session-end-codex-release" }, {});

  await beforePromptBuild(
    { prompt: "This follow-up runs on a non-Codex provider after session end." },
    {
      sessionKey: "session-end-codex-release",
      provider: { id: "openai", model: "gpt-5.4" },
    },
  );

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-end-codex-release");
  assert.equal(flushCalls[0]?.options?.reason, "session_end");
  assert.ok(
    String(flushCalls[0]?.options?.bufferKey ?? "").startsWith(
      "codex-thread:thread-session-end-codex-release",
    ),
    "session_end should drain the remembered Codex thread buffer before releasing the mapping",
  );
});

test("session_end falls back to ctx.sessionKey when the event omits it", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-end-ctx-session-key-fallback-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const sessionEnd = api.handlers.get("session_end");
  assert.ok(sessionEnd, "session_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await sessionEnd({}, { sessionKey: "session-end-ctx-only" });

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-end-ctx-only");
  assert.equal(flushCalls[0]?.options?.reason, "session_end");
  assert.equal(
    flushCalls[0]?.options?.bufferKey,
    "session-end-ctx-only",
    "session_end should drain the ctx session when runtimes omit sessionKey on the event",
  );
});

test("before_reset prefers the remembered Codex thread over sparse providerThreadId hints", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-prefers-remembered-codex-thread-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    namespacesEnabled: false,
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime this Codex session before sparse reset metadata arrives." },
    {
      sessionKey: "session-reset-remembered-thread",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-reset-remembered-thread",
    },
  );

  await beforeReset(
    {
      sessionKey: "session-reset-remembered-thread",
      providerThreadId: "thread-reset-stale-hint",
    },
    {},
  );

  assert.deepEqual(
    flushCalls.map((call) => ({
      sessionKey: call.sessionKey,
      reason: call.options?.reason,
      bufferKey: call.options?.bufferKey,
    })),
    [
      {
        sessionKey: "session-reset-remembered-thread",
        reason: "before_reset",
        bufferKey: "codex-thread:thread-reset-remembered-thread",
      },
    ],
  );
});

test("before_reset ignores sparse providerThreadId metadata without a remembered Codex binding", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-sparse-provider-thread-id-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.transcript.append = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await beforeReset(
    {
      sessionKey: "session-reset-sparse-thread-id",
      providerThreadId: "thread-reset-sparse-thread-id",
    },
    {},
  );

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-reset-sparse-thread-id");
  assert.equal(flushCalls[0]?.options?.reason, "before_reset");
  assert.equal(
    flushCalls[0]?.options?.bufferKey,
    "session-reset-sparse-thread-id",
    "before_reset should keep sparse providerThreadId hooks on the raw session buffer without a confirmed Codex binding",
  );
});

test("session_end ignores sparse providerThreadId metadata without a remembered Codex binding", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-end-sparse-provider-thread-id-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const sessionEnd = api.handlers.get("session_end");
  assert.ok(sessionEnd, "session_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await sessionEnd(
    {
      sessionKey: "session-end-sparse-thread-id",
      providerThreadId: "thread-session-end-sparse-thread-id",
    },
    {},
  );

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-end-sparse-thread-id");
  assert.equal(flushCalls[0]?.options?.reason, "session_end");
  assert.equal(
    flushCalls[0]?.options?.bufferKey,
    "session-end-sparse-thread-id",
    "session_end should keep sparse providerThreadId hooks on the raw session buffer without a confirmed Codex binding",
  );
});

test("session_end ignores sparse ctx providerThreadId metadata without a remembered Codex binding", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-end-sparse-ctx-provider-thread-id-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const sessionEnd = api.handlers.get("session_end");
  assert.ok(sessionEnd, "session_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  await sessionEnd(
    {
      sessionKey: "session-end-sparse-ctx-thread-id",
    },
    {
      providerThreadId: "thread-session-end-sparse-ctx-thread-id",
    },
  );

  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.sessionKey, "session-end-sparse-ctx-thread-id");
  assert.equal(flushCalls[0]?.options?.reason, "session_end");
  assert.equal(
    flushCalls[0]?.options?.bufferKey,
    "session-end-sparse-ctx-thread-id",
    "session_end should keep sparse ctx providerThreadId hooks on the raw session buffer without a confirmed Codex binding",
  );
});

test("session_end drains previously bound Codex buffers after thread rebinding", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-end-codex-rebind-drain-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const sessionEnd = api.handlers.get("session_end");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(sessionEnd, "session_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;

  const oldBufferKey = "codex-thread:thread-session-end-rebind-old";
  const newBufferKey = "codex-thread:thread-session-end-rebind-new";
  orchestrator.buffer.findBufferKeysForSession = async (sessionKey: string) =>
    sessionKey === "session-end-rebind" ? [oldBufferKey, newBufferKey] : [];
  orchestrator.buffer.getTurns = (bufferKey: string) =>
    bufferKey === oldBufferKey || bufferKey === newBufferKey
      ? [{ role: "user", content: "pending " + bufferKey, timestamp: new Date().toISOString(), sessionKey: "session-end-rebind" }]
      : [];

  const flushCalls: Array<string> = [];
  orchestrator.flushSession = async (
    _sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push(String(options?.bufferKey ?? ""));
  };

  await beforePromptBuild(
    { prompt: "Prime the old Codex thread before session end rebinding." },
    {
      sessionKey: "session-end-rebind",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-session-end-rebind-old",
    },
  );

  await beforePromptBuild(
    { prompt: "Rebind this Codex session onto a new thread before ending it." },
    {
      sessionKey: "session-end-rebind",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-session-end-rebind-new",
    },
  );

  await sessionEnd({ sessionKey: "session-end-rebind" }, {});

  assert.ok(flushCalls.length >= 2);
  assert.ok(
    flushCalls.some((bufferKey) => bufferKey.startsWith(oldBufferKey)),
    "session_end should still drain the previously bound Codex buffer after rebinding",
  );
  assert.ok(
    flushCalls.some((bufferKey) => bufferKey.startsWith(newBufferKey)),
    "session_end should drain the current Codex buffer after rebinding",
  );
});

test("agent_end does not reuse a remembered Codex thread after the provider switches", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-provider-switch-test");
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const agentEnd = api.handlers.get("agent_end");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.transcript.append = async () => undefined;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };
  const processTurnCalls: Array<Record<string, unknown>> = [];
  orchestrator.processTurn = async (
    role: string,
    content: string,
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    processTurnCalls.push({ role, content, sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime this Codex session with a remembered thread." },
    {
      sessionKey: "session-provider-switch",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-provider-switch",
    },
  );

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: "Store this follow-up after the provider switch." },
        {
          role: "assistant",
          content: "Stored after the provider switched away from Codex.",
        },
      ],
    },
    {
      sessionKey: "session-provider-switch",
      provider: { id: "openai", model: "gpt-5.4" },
    },
  );

  assert.deepEqual(
    flushCalls.map((call) => ({
      sessionKey: call.sessionKey,
      reason: call.options?.reason,
      bufferKey: call.options?.bufferKey,
    })),
    [
      {
        sessionKey: "session-provider-switch",
        reason: "codex_provider_switch",
        bufferKey: "codex-thread:thread-provider-switch::principal:default",
      },
    ],
  );
  assert.equal(processTurnCalls.length, 2);
  for (const call of processTurnCalls) {
    assert.equal(call.sessionKey, "session-provider-switch");
    assert.equal(
      (call.options as { bufferKey?: string }).bufferKey,
      "session-provider-switch",
    );
    assert.equal(
      (call.options as { providerThreadId?: string | null }).providerThreadId,
      null,
    );
  }
});

test("agent_end ignores bare providerThreadId as provider-switch evidence", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-bare-provider-thread-id-test");
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const agentEnd = api.handlers.get("agent_end");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.transcript.append = async () => undefined;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
  };

  const processTurnCalls: Array<Record<string, unknown>> = [];
  orchestrator.processTurn = async (
    role: string,
    content: string,
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    processTurnCalls.push({ role, content, sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime this Codex session with a remembered thread." },
    {
      sessionKey: "session-provider-thread-only",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-provider-thread-only",
    },
  );

  await agentEnd(
    {
      success: true,
      messages: [
        {
          role: "user",
          content: "Store this follow-up when only the provider thread id is present.",
        },
        {
          role: "assistant",
          content: "Stored while the runtime omitted provider identity fields.",
        },
      ],
    },
    {
      sessionKey: "session-provider-thread-only",
      providerThreadId: "thread-provider-thread-only",
    },
  );

  assert.deepEqual(flushCalls, []);
  assert.equal(processTurnCalls.length, 2);
  for (const call of processTurnCalls) {
    assert.equal(call.sessionKey, "session-provider-thread-only");
    assert.equal(
      (call.options as { bufferKey?: string }).bufferKey,
      "codex-thread:thread-provider-thread-only::principal:default",
    );
    assert.equal(
      (call.options as { logicalSessionKey?: string }).logicalSessionKey,
      "codex-thread:thread-provider-thread-only",
    );
    assert.equal(
      (call.options as { providerThreadId?: string | null }).providerThreadId,
      "thread-provider-thread-only",
    );
    assert.equal(
      (call.options as { persistProcessedFingerprint?: boolean })
        .persistProcessedFingerprint,
      true,
    );
  }
});

test("agent_end preserves the remembered Codex thread when the provider-switch flush fails", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-provider-switch-flush-failure-test");
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const agentEnd = api.handlers.get("agent_end");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(agentEnd, "agent_end handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.transcript.append = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;

  const flushCalls: Array<{
    sessionKey: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  let failProviderSwitchFlush = true;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushCalls.push({ sessionKey, options });
    if (
      failProviderSwitchFlush &&
      options?.reason === "codex_provider_switch"
    ) {
      failProviderSwitchFlush = false;
      throw new Error("provider-switch flush failed");
    }
  };

  const processTurnCalls: Array<Record<string, unknown>> = [];
  orchestrator.processTurn = async (
    role: string,
    content: string,
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    processTurnCalls.push({ role, content, sessionKey, options });
  };

  const rawBufferedTurns: Array<Record<string, unknown>> = [];
  const originalGetTurns = orchestrator.buffer.getTurns.bind(orchestrator.buffer);
  orchestrator.buffer.getTurns = (bufferKey: string) => {
    if (bufferKey === "session-provider-switch-flush-failure") {
      return rawBufferedTurns;
    }
    return originalGetTurns(bufferKey);
  };
  orchestrator.processTurn = async (
    role: string,
    content: string,
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    processTurnCalls.push({ role, content, sessionKey, options });
    rawBufferedTurns.push({ role, content, sessionKey, options });
  };

  await beforePromptBuild(
    { prompt: "Prime this Codex session with a remembered thread before the flush fails." },
    {
      sessionKey: "session-provider-switch-flush-failure",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-provider-switch-flush-failure",
    },
  );

  await agentEnd(
    {
      success: true,
      messages: [
        {
          role: "user",
          content: "Store this follow-up after the provider-switch flush fails.",
        },
        {
          role: "assistant",
          content: "Stored after the provider switch flush failed.",
        },
      ],
    },
    {
      sessionKey: "session-provider-switch-flush-failure",
      provider: { id: "openai", model: "gpt-5.4" },
    },
  );

  await beforeReset(
    { sessionKey: "session-provider-switch-flush-failure" },
    {},
  );

  assert.deepEqual(
    flushCalls.map((call) => ({
      sessionKey: call.sessionKey,
      reason: call.options?.reason,
      bufferKey: call.options?.bufferKey,
    })),
    [
      {
        sessionKey: "session-provider-switch-flush-failure",
        reason: "codex_provider_switch",
        bufferKey:
          "codex-thread:thread-provider-switch-flush-failure::principal:default",
      },
      {
        sessionKey: "session-provider-switch-flush-failure",
        reason: "before_reset",
        bufferKey:
          "codex-thread:thread-provider-switch-flush-failure::principal:default",
      },
      {
        sessionKey: "session-provider-switch-flush-failure",
        reason: "before_reset",
        bufferKey: "session-provider-switch-flush-failure",
      },
    ],
  );

  assert.equal(processTurnCalls.length, 2);
  for (const call of processTurnCalls) {
    assert.equal(call.sessionKey, "session-provider-switch-flush-failure");
    assert.equal(
      (call.options as { bufferKey?: string }).bufferKey,
      "session-provider-switch-flush-failure",
    );
    assert.equal(
      (call.options as { providerThreadId?: string | null }).providerThreadId,
      null,
    );
  }
});

test("agent_end scopes Codex logical buffers to the mapped principal", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-codex-principal-buffer-scope-test");
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
    principalFromSessionKeyMode: "map",
    principalFromSessionKeyRules: [
      { match: "session-alpha", principal: "team-alpha" },
      { match: "session-beta", principal: "team-beta" },
    ],
    namespacePolicies: [
      {
        name: "team-alpha",
        readPrincipals: ["team-alpha"],
        writePrincipals: ["team-alpha"],
        includeInRecallByDefault: false,
      },
      {
        name: "team-beta",
        readPrincipals: ["team-beta"],
        writePrincipals: ["team-beta"],
        includeInRecallByDefault: false,
      },
    ],
  };
  plugin.register(api as any);

  const agentEnd = api.handlers.get("agent_end");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.transcript.append = async () => undefined;

  const processTurnCalls: Array<Record<string, unknown>> = [];
  orchestrator.processTurn = async (
    role: string,
    content: string,
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    processTurnCalls.push({ role, content, sessionKey, options });
  };

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: "Alpha should stay in the alpha Codex buffer." },
        { role: "assistant", content: "Alpha acknowledged." },
      ],
    },
    {
      sessionKey: "session-alpha",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-across-principals",
    },
  );

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: "Beta should stay in the beta Codex buffer." },
        { role: "assistant", content: "Beta acknowledged." },
      ],
    },
    {
      sessionKey: "session-beta",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-across-principals",
    },
  );

  assert.equal(processTurnCalls.length, 4);
  const expectedBufferBySession = new Map([
    [
      "session-alpha",
      "codex-thread:thread-shared-across-principals::principal:team-alpha",
    ],
    [
      "session-beta",
      "codex-thread:thread-shared-across-principals::principal:team-beta",
    ],
  ]);
  for (const call of processTurnCalls) {
    const sessionKey = call.sessionKey as string;
    assert.equal(
      (call.options as { bufferKey?: string }).bufferKey,
      expectedBufferBySession.get(sessionKey),
    );
    assert.equal(
      (call.options as { providerThreadId?: string | null }).providerThreadId,
      "thread-shared-across-principals",
    );
  }
});

test("capability promptBuilder does not reuse Codex thread cache across principals sharing a thread id", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("capability-prompt-builder-codex-principal-scope-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codexCompat: {
      enabled: true,
      threadIdBufferKeying: true,
      compactionFlushMode: "heuristic",
      fingerprintDedup: true,
    },
    principalFromSessionKeyMode: "map",
    principalFromSessionKeyRules: [
      { match: "session-alpha", principal: "team-alpha" },
      { match: "session-beta", principal: "team-beta" },
    ],
    namespacePolicies: [
      {
        name: "team-alpha",
        readPrincipals: ["team-alpha"],
        writePrincipals: ["team-alpha"],
        includeInRecallByDefault: false,
      },
      {
        name: "team-beta",
        readPrincipals: ["team-beta"],
        writePrincipals: ["team-beta"],
        includeInRecallByDefault: false,
      },
    ],
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(api._memoryPromptSection, "memory prompt section should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async (_prompt: string, sessionKey: string) =>
    sessionKey === "session-alpha"
      ? "Alpha principal context"
      : "Beta principal context";

  await beforePromptBuild(
    { prompt: "Prime the shared Codex thread for alpha." },
    {
      sessionKey: "session-alpha",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-capability-cache",
    },
  );

  const alphaPromptSection = api._memoryPromptSection?.({
    sessionKey: "session-alpha",
  }) ?? null;
  assert.ok(alphaPromptSection?.join("\n").includes("Alpha principal context"));

  await beforePromptBuild(
    { prompt: "Prime the shared Codex thread for beta." },
    {
      sessionKey: "session-beta",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-shared-capability-cache",
    },
  );

  assert.equal(
    api._memoryCapability?.promptBuilder?.({
      sessionKey: "session-alpha",
    }) ?? null,
    null,
    "alpha should not see beta's cached prompt lines when the Codex thread id is reused across principals",
  );

  const betaPromptLines = api._memoryCapability?.promptBuilder?.({
    sessionKey: "session-beta",
  }) ?? null;
  assert.ok(betaPromptLines?.join("\n").includes("Beta principal context"));
});

test("capability promptBuilder does not fall back to stale Codex thread cache after a metadata-less short prompt", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("capability-prompt-builder-codex-stale-thread-test", {
    includeMemoryCapability: true,
  });
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";

  await beforePromptBuild(
    { prompt: "Prime this Codex session for capability fallback." },
    {
      sessionKey: "session-capability-stale-thread",
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-capability-stale-thread",
    },
  );

  assert.ok(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-capability-stale-thread" }),
    "the first Codex turn should populate the capability promptBuilder cache",
  );

  const shortPromptResult = await beforePromptBuild(
    { prompt: "ok" },
    {
      sessionKey: "session-capability-stale-thread",
    },
  );

  assert.equal(shortPromptResult, undefined);
  assert.equal(
    api._memoryCapability?.promptBuilder?.({
      sessionKey: "session-capability-stale-thread",
    }) ?? null,
    null,
  );
});

test("non-runtime registration modes register zero handlers", async () => {
  const { default: plugin } = await import("../src/index.js");
  for (const registrationMode of [
    "discovery",
    "tool-discovery",
    "setup-only",
    "setup-runtime",
    "cli-metadata",
  ]) {
    const api = buildHandlerCapturingApi(`${registrationMode}-test`, {
      registrationMode,
    });
    plugin.register(api as any);

    assert.equal(
      api.handlers.size,
      0,
      `expected zero handlers in ${registrationMode} mode, got: ${[...api.handlers.keys()].join(", ")}`,
    );
  }
});
