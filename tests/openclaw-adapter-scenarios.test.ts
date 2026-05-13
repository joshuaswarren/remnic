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
} from "./helpers/openclaw-registration-harness.js";

const SERVICE_ID = "openclaw-remnic";
const ORCHESTRATOR_KEY = `__openclawEngramOrchestrator::${SERVICE_ID}`;

type ToolSpec = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

type ScenarioContext = {
  capture: ReturnType<typeof captureOpenClawRegistrationApi>;
  orchestrator: Record<string, any>;
  memoryDir: string;
};

async function withScenarioRegistration(
  fn: (context: ScenarioContext) => Promise<void> | void,
  options: Parameters<typeof captureOpenClawRegistrationApi>[0] = {},
) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-scenario-"));
  const saved = saveAndResetOpenClawRegistrationGlobals();
  const previousMigration = disableRegisterMigrationForCaptureTest();
  try {
    const { default: plugin } = await import("../src/index.js");
    const capture = captureOpenClawRegistrationApi({
      ...options,
      pluginConfig: {
        memoryDir,
        modelSource: "gateway",
        qmdEnabled: false,
        transcriptEnabled: false,
        hourlySummariesEnabled: false,
        ...options.pluginConfig,
      },
    });

    (plugin as { register(api: unknown): void }).register(capture.api);
    const orchestrator = (globalThis as Record<string, any>)[ORCHESTRATOR_KEY];
    if (options.registrationMode !== "setup-only") {
      assert.ok(orchestrator, "registration should expose the Remnic orchestrator");
    }

    await fn({ capture, orchestrator: orchestrator ?? {}, memoryDir });
  } finally {
    restoreRegisterMigrationForCaptureTest(previousMigration);
    restoreOpenClawRegistrationGlobals(saved);
    fs.rmSync(memoryDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  }
}

function listJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

test("scenario: memory_store writes through the registered tool and memory_search routes through active memory search", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    const store = registeredTool(capture, "memory_store");
    const storeResult = await store.execute("store-1", {
      content: "The user prefers compact dashboards for operational tools.",
      category: "preference",
      tags: ["scenario"],
    });

    assert.match(resultText(storeResult), /Memory stored:/);

    let searched = false;
    orchestrator.searchAcrossNamespaces = async (params: Record<string, unknown>) => {
      searched = true;
      assert.equal(params.query, "compact dashboards");
      assert.deepEqual(params.namespaces, ["default"]);
      return [
        {
          id: "memory-dashboard-preference",
          score: 0.97,
          snippet: "The user prefers compact dashboards for operational tools.",
          metadata: { source: "scenario" },
        },
      ];
    };

    const search = registeredTool(capture, "memory_search");
    const searchResult = await search.execute(
      "search-1",
      { query: "compact dashboards", limit: 1 },
      undefined,
      { sessionKey: "scenario-session" },
    );
    const payload = JSON.parse(resultText(searchResult));

    assert.equal(searched, true);
    assert.equal(payload.results[0].id, "memory-dashboard-preference");
    assert.match(payload.results[0].text, /compact dashboards/);
  });
});

test("scenario: native corpus supplement searches and reads Remnic memory", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator, memoryDir }) => {
    const corpus = capture.registrations("registerMemoryCorpusSupplement")[0]?.[0] as
      | {
          search(params: {
            query: string;
            maxResults?: number;
            agentSessionKey?: string;
          }): Promise<Array<Record<string, unknown>>>;
          get(params: {
            lookup: string;
            fromLine?: number;
            lineCount?: number;
          }): Promise<Record<string, unknown> | null>;
        }
      | undefined;
    assert.equal(typeof corpus?.search, "function");
    assert.equal(typeof corpus?.get, "function");

    orchestrator.searchAcrossNamespaces = async (params: Record<string, unknown>) => {
      assert.equal(params.query, "compact dashboards");
      assert.equal(params.maxResults, 2);
      assert.deepEqual(params.namespaces, ["default"]);
      return [
        {
          id: "memory-dashboard-preference",
          path: "facts/dashboard.md",
          score: 0.91,
          snippet: "Dashboards should stay compact.",
          metadata: { updatedAt: "2026-05-04T12:00:00.000Z" },
        },
      ];
    };

    const searchResults = await corpus!.search({
      query: "compact dashboards",
      maxResults: 2,
      agentSessionKey: "corpus-session",
    });

    assert.deepEqual(searchResults[0], {
      corpus: "remnic",
      path: "facts/dashboard.md",
      title: "memory-dashboard-preference",
      kind: "memory",
      score: 0.91,
      snippet: "Dashboards should stay compact.",
      id: "memory-dashboard-preference",
      startLine: 1,
      endLine: 1,
      citation: "facts/dashboard.md",
      source: "remnic",
      provenanceLabel: "Remnic",
      sourceType: "memory",
      sourcePath: "facts/dashboard.md",
      updatedAt: "2026-05-04T12:00:00.000Z",
    });

    orchestrator.storage.readAllMemories = async () => [
      {
        path: path.join(memoryDir, "facts", "dashboard.md"),
        frontmatter: {
          id: "memory-dashboard-preference",
          category: "preference",
          updated: "2026-05-04T12:00:00.000Z",
        },
        content: "first line\nsecond line\nthird line",
      },
    ];
    orchestrator.getStorageForNamespace = async () => orchestrator.storage;

    const readResult = await corpus!.get({
      lookup: String(searchResults[0].path),
      fromLine: 2,
      lineCount: 1,
    });

    assert.deepEqual(readResult, {
      corpus: "remnic",
      path: "facts/dashboard.md",
      title: "memory-dashboard-preference",
      kind: "preference",
      content: "second line",
      fromLine: 2,
      lineCount: 1,
      id: "memory-dashboard-preference",
      provenanceLabel: "Remnic",
      sourceType: "memory",
      sourcePath: "facts/dashboard.md",
      updatedAt: "2026-05-04T12:00:00.000Z",
    });

    orchestrator.storage.readAllMemories = async () => [
      {
        path: path.join(memoryDir, "artifacts", "private.md"),
        frontmatter: {
          id: "artifact-by-id",
          category: "preference",
          updated: "2026-05-04T12:00:00.000Z",
        },
        content: "private artifact content",
      },
    ];
    assert.equal(await corpus!.get({ lookup: "artifact-by-id" }), null);

    orchestrator.searchAcrossNamespaces = async () => {
      throw new Error("search unavailable");
    };
    await assert.rejects(
      corpus!.search({ query: "compact dashboards" }),
      /Remnic corpus search failed: search unavailable/,
    );

    orchestrator.storage.readAllMemories = async () => {
      throw new Error("store locked");
    };
    await assert.rejects(
      corpus!.get({ lookup: "facts/dashboard.md" }),
      /Remnic corpus get failed: store locked/,
    );
  });
});

test("scenario: prompt injection precomputes recall and serves the cached prompt-section builder", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    let recallCount = 0;
    orchestrator.recall = async (query: string, sessionKey: string) => {
      recallCount += 1;
      assert.match(query, /dashboard/);
      assert.equal(sessionKey, "prompt-session");
      return "Remember that the user prefers compact dashboards.";
    };

    const beforePromptBuild = registeredHook(capture, "before_prompt_build");
    const hookResult = await beforePromptBuild(
      { prompt: "Please design a dashboard for repeated operational review." },
      { sessionKey: "prompt-session" },
    );

    const promptSectionBuilder = capture.registrations("registerMemoryPromptSection")[0]?.[0] as
      | ((params: { availableTools: Set<string> }) => string[])
      | undefined;
    assert.equal(typeof promptSectionBuilder, "function");
    const lines = promptSectionBuilder({
      availableTools: new Set(["memory_search"]),
      sessionKey: "prompt-session",
    } as never);

    assert.equal(recallCount, 1);
    assert.equal(hookResult, undefined);
    assert.match(lines.join("\n"), /Memory Context \(Remnic\)/);
    assert.match(lines.join("\n"), /compact dashboards/);
  });
});

test("scenario: agent_end buffers the last user and assistant turns without live extraction", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    const processed: Array<{
      role: string;
      content: string;
      sessionKey: string;
      options: Record<string, unknown>;
    }> = [];
    orchestrator.processTurn = async (
      role: string,
      content: string,
      sessionKey: string,
      options: Record<string, unknown>,
    ) => {
      processed.push({ role, content, sessionKey, options });
    };

    const agentEnd = registeredHook(capture, "agent_end");
    await agentEnd(
      {
        success: true,
        messages: [
          { role: "system", content: "system metadata should be ignored" },
          { role: "user", content: "Please remember the compact dashboard preference." },
          { role: "assistant", content: "I will keep the dashboard compact." },
        ],
      },
      { sessionKey: "agent-session" },
    );

    assert.deepEqual(processed.map((turn) => turn.role), ["user", "assistant"]);
    assert.deepEqual(processed.map((turn) => turn.sessionKey), [
      "agent-session",
      "agent-session",
    ]);
    assert.match(processed[0].content, /compact dashboard preference/);
    assert.equal(processed[0].options.logicalSessionKey, "agent-session");
    assert.equal(processed[0].options.bufferKey, "agent-session");
  });
});

test("scenario: agent_end objective-state snapshots use namespaced configured store overrides", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator, memoryDir }) => {
    const namespace = "project-a";
    const namespaceDir = path.join(memoryDir, "namespaces", namespace);
    const overrideDir = path.join(memoryDir, "objective-override");
    orchestrator.config.namespacesEnabled = true;
    orchestrator.config.objectiveStateMemoryEnabled = true;
    orchestrator.config.objectiveStateSnapshotWritesEnabled = true;
    orchestrator.config.objectiveStateStoreDir = overrideDir;
    orchestrator.resolveSelfNamespace = () => namespace;
    orchestrator.getStorageForNamespace = async (requestedNamespace: string) => {
      assert.equal(requestedNamespace, namespace);
      return { dir: namespaceDir };
    };
    orchestrator.processTurn = async () => {};

    const agentEnd = registeredHook(capture, "agent_end");
    await agentEnd(
      {
        success: true,
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-agent-end-test",
                function: {
                  name: "exec_command",
                  arguments: JSON.stringify({ cmd: "npm test" }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call-agent-end-test",
            name: "exec_command",
            content: JSON.stringify({ exitCode: 0, stdout: "ok" }),
          },
          { role: "user", content: "Please remember that tests passed." },
          { role: "assistant", content: "Tests passed." },
        ],
      },
      { sessionKey: "agent-session" },
    );

    const snapshotsRoot = path.join(
      overrideDir,
      "namespaces",
      namespace,
      "snapshots",
    );
    const snapshotFiles = listJsonFiles(snapshotsRoot);
    assert.equal(snapshotFiles.length, 1);
    const snapshot = JSON.parse(
      fs.readFileSync(snapshotFiles[0]!, "utf8"),
    ) as { sessionKey?: string; kind?: string; scope?: string };
    assert.equal(snapshot.sessionKey, "agent-session");
    assert.equal(snapshot.kind, "process");
    assert.equal(snapshot.scope, "npm test");
    assert.equal(fs.existsSync(path.join(overrideDir, "snapshots")), false);
  });
});

test("scenario: before_reset and session_end drain discovered buffers with explicit reasons", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    const flushes: Array<{ sessionKey: string; reason: string; bufferKey: string }> = [];
    orchestrator.buffer.findBufferKeysForSession = async () => ["lifecycle-session", "secondary-buffer"];
    orchestrator.buffer.getTurns = (bufferKey: string) =>
      bufferKey === "secondary-buffer" ? [{ role: "user", content: "buffered" }] : [];
    orchestrator.flushSession = async (
      sessionKey: string,
      options: { reason: string; bufferKey: string },
    ) => {
      flushes.push({ sessionKey, reason: options.reason, bufferKey: options.bufferKey });
    };

    await registeredHook(capture, "before_reset")(
      { sessionKey: "lifecycle-session" },
      {},
    );
    await registeredHook(capture, "session_end")(
      { sessionKey: "lifecycle-session" },
      {},
    );

    assert.deepEqual(flushes, [
      {
        sessionKey: "lifecycle-session",
        reason: "before_reset",
        bufferKey: "lifecycle-session",
      },
      {
        sessionKey: "lifecycle-session",
        reason: "before_reset",
        bufferKey: "secondary-buffer",
      },
      {
        sessionKey: "lifecycle-session",
        reason: "session_end",
        bufferKey: "lifecycle-session",
      },
      {
        sessionKey: "lifecycle-session",
        reason: "session_end",
        bufferKey: "secondary-buffer",
      },
    ]);
  }, {
    pluginConfig: {
      flushOnResetEnabled: true,
      beforeResetTimeoutMs: 1000,
    },
  });
});

test("scenario: passive slot and setup-only registrations stay inert for active memory hooks", async () => {
  await withScenarioRegistration(({ capture }) => {
    assert.deepEqual(capture.hooks(), []);
    assert.equal(capture.registrations("registerMemoryCapability").length, 0);
    assert.ok(capture.registrationNames("registerTool").includes("memory_search"));
  }, {
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

  await withScenarioRegistration(({ capture }) => {
    assert.deepEqual(capture.hooks(), []);
    assert.deepEqual(capture.registrations(), []);
  }, {
    registrationMode: "setup-only",
  });
});

function registeredTool(
  capture: ReturnType<typeof captureOpenClawRegistrationApi>,
  name: string,
): ToolSpec {
  const tool = capture
    .registrations("registerTool")
    .map(([spec]) => spec as ToolSpec)
    .find((spec) => spec.name === name);
  assert.ok(tool, `expected registered tool ${name}`);
  return tool;
}

function registeredHook(
  capture: ReturnType<typeof captureOpenClawRegistrationApi>,
  name: string,
) {
  const handler = capture.hooks(name)[0]?.[1];
  assert.equal(typeof handler, "function", `expected registered hook ${name}`);
  return handler as (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<unknown>;
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}
