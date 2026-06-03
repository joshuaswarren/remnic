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

test("OpenClaw generic embedding bridge uses embedQuery for query inputs", async () => {
  const { embedWithOpenClawProvider } = await import("../src/index.js");
  const calls: string[] = [];
  const provider = {
    async embedQuery() {
      calls.push("embedQuery");
      return [1, 0];
    },
    async embed() {
      calls.push("embed");
      return [0, 1];
    },
    async embedBatch() {
      calls.push("embedBatch");
      return [[0, 0]];
    },
  };

  const vector = await embedWithOpenClawProvider("generic", provider, "find launch", {
    inputType: "query",
  });

  assert.deepEqual(vector, [1, 0]);
  assert.deepEqual(calls, ["embedQuery"]);
});

test("OpenClaw memory embedding bridge uses embed for document inputs", async () => {
  const { embedWithOpenClawProvider } = await import("../src/index.js");
  const calls: string[] = [];
  const provider = {
    async embed(text: string, options?: { inputType?: string }) {
      calls.push(`embed:${text}:${options?.inputType ?? ""}`);
      return [0.4, 0.6];
    },
  };

  const vector = await embedWithOpenClawProvider("memory", provider, "index launch", {
    inputType: "document",
  });

  assert.deepEqual(vector, [0.4, 0.6]);
  assert.deepEqual(calls, ["embed:index launch:document"]);
});

test("OpenClaw memory embedding SDK selector prefers current subpath with legacy fallback", async () => {
  const { selectOpenClawMemoryEmbeddingSdk } = await import("../src/index.js");
  const current = {
    listMemoryEmbeddingProviders: () => [{ id: "current" }],
  };
  const legacy = {
    listMemoryEmbeddingProviders: () => [{ id: "legacy" }],
  };

  assert.equal(selectOpenClawMemoryEmbeddingSdk(current, legacy), current);
  assert.equal(selectOpenClawMemoryEmbeddingSdk(null, legacy), legacy);
  assert.equal(selectOpenClawMemoryEmbeddingSdk(null, null), null);
});

async function withScenarioRegistration(
  fn: (context: ScenarioContext) => Promise<void> | void,
  options: Parameters<typeof captureOpenClawRegistrationApi>[0] = {},
) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-scenario-"));
  const saved = saveAndResetOpenClawRegistrationGlobals();
  const previousMigration = disableRegisterMigrationForCaptureTest();
  let orchestrator: Record<string, any> | null = null;
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
    orchestrator = (globalThis as Record<string, any>)[ORCHESTRATOR_KEY] ?? null;
    if (options.registrationMode !== "setup-only") {
      assert.ok(orchestrator, "registration should expose the Remnic orchestrator");
    }

    await fn({ capture, orchestrator: orchestrator ?? {}, memoryDir });
  } finally {
    await orchestrator?.lcmEngine?.waitForObserveQueueIdle?.();
    orchestrator?.lcmEngine?.close?.();
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

function readAllText(root: string): string {
  if (!fs.existsSync(root)) return "";
  const chunks: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      chunks.push(readAllText(fullPath));
    } else if (entry.isFile()) {
      chunks.push(fs.readFileSync(fullPath, "utf-8"));
    }
  }
  return chunks.join("\n");
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
    if (typeof promptSectionBuilder !== "function") {
      assert.fail("expected registerMemoryPromptSection to receive a prompt section builder");
    }
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

test("scenario: message_received captures bounded thread and reply metadata in transcripts", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      await messageReceived(
        {
          content: "[OpenClaw user id:123 2026-06-02] Remember the launch channel preference [message_id: msg-1]",
          messageId: "msg-1",
          threadId: "thread-42",
          replyToId: "quoted-1",
          replyToBody: "Original launch thread context",
          replyToSender: "Ada",
        },
        { sessionKey: "agent:generalist:discord:channel:launch" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.match(transcriptText, /Remember the launch channel preference/);
      assert.doesNotMatch(transcriptText, /message_id: msg-1/);
      assert.match(transcriptText, /"messageId":"msg-1"/);
      assert.match(transcriptText, /"threadId":"thread-42"/);
      assert.match(transcriptText, /"replyToId":"quoted-1"/);
      assert.match(transcriptText, /"replyToBody":"Original launch thread context"/);
      assert.match(transcriptText, /"replyToSender":"Ada"/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
        openclawReplyMetadataCaptureEnabled: true,
      },
    },
  );
});

test("scenario: disabled channel envelope cleaning keeps legacy broad cleanup", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      await messageReceived(
        {
          content: "[Discord user id:123 2026-06-02] Remember the legacy envelope cleanup [message_id: discord-1]",
          messageId: "discord-1",
        },
        { sessionKey: "legacy-envelope-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.match(transcriptText, /Remember the legacy envelope cleanup/);
      assert.doesNotMatch(transcriptText, /Discord user id/);
      assert.doesNotMatch(transcriptText, /message_id: discord-1/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
        openclawChannelEnvelopeCleaningEnabled: false,
      },
    },
  );
});

test("scenario: message_received honors heartbeat transcript gating", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      await messageReceived(
        {
          trigger: "heartbeat",
          content: "Read HEARTBEAT.md and continue the maintenance run.",
          messageId: "heartbeat-msg-1",
        },
        { sessionKey: "heartbeat-session", trigger: "heartbeat" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.doesNotMatch(transcriptText, /HEARTBEAT/);
      assert.doesNotMatch(transcriptText, /maintenance run/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
        heartbeat: {
          enabled: true,
          gateExtractionDuringHeartbeat: true,
        },
      },
    },
  );
});

test("scenario: message_received strips inline explicit capture markup from transcripts", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      await messageReceived(
        {
          content: [
            "Remember the launch transcript preference.",
            "<memory_note>",
            "content: The launch transcript preference should be compact.",
            "category: preference",
            "</memory_note>",
          ].join("\n"),
          messageId: "msg-inline-1",
        },
        { sessionKey: "inline-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.match(transcriptText, /Remember the launch transcript preference/);
      assert.doesNotMatch(transcriptText, /memory_note/);
      assert.doesNotMatch(transcriptText, /launch transcript preference should be compact/);
    },
    {
      pluginConfig: {
        captureMode: "hybrid",
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received persists inline explicit captures without agent_end", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const maintenanceTools: string[] = [];
      orchestrator.requestQmdMaintenanceForTool = (tool: string) => {
        maintenanceTools.push(tool);
      };

      await messageReceived(
        {
          content: [
            "Remember the launch inbound note preference.",
            "<memory_note>",
            "content: The inbound launch note should survive without agent_end.",
            "category: preference",
            "</memory_note>",
          ].join("\n"),
          messageId: "msg-inline-persist-1",
        },
        { sessionKey: "inline-persist-session" },
      );

      const memoryText = readAllText(memoryDir);
      assert.match(memoryText, /inbound launch note should survive without agent_end/);
      assert.deepEqual(maintenanceTools, ["inline.memory_note"]);
    },
    {
      pluginConfig: {
        captureMode: "hybrid",
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received persists sparse inline explicit captures without agent_end", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const maintenanceTools: string[] = [];
      orchestrator.requestQmdMaintenanceForTool = (tool: string) => {
        maintenanceTools.push(tool);
      };

      await messageReceived(
        {
          content: [
            "Remember the sparse inbound note preference.",
            "<memory_note>",
            "content: The sparse inbound note should survive without agent_end.",
            "category: preference",
            "</memory_note>",
          ].join("\n"),
          threadId: "thread-sparse-inline-only",
        },
        { sessionKey: "inline-sparse-persist-session" },
      );

      const memoryText = readAllText(memoryDir);
      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.match(memoryText, /sparse inbound note should survive without agent_end/);
      assert.match(transcriptText, /Remember the sparse inbound note preference/);
      assert.doesNotMatch(transcriptText, /memory_note/);
      assert.deepEqual(maintenanceTools, ["inline.memory_note"]);
    },
    {
      pluginConfig: {
        captureMode: "hybrid",
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received persists inline explicit captures when transcripts are disabled", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const maintenanceTools: string[] = [];
      orchestrator.requestQmdMaintenanceForTool = (tool: string) => {
        maintenanceTools.push(tool);
      };

      await messageReceived(
        {
          content: [
            "Remember the launch inbound note preference without transcript.",
            "<memory_note>",
            "content: The inbound launch note should persist when transcripts are disabled.",
            "category: preference",
            "</memory_note>",
          ].join("\n"),
          messageId: "msg-inline-transcript-disabled-1",
        },
        { sessionKey: "inline-transcript-disabled-session" },
      );

      const memoryText = readAllText(memoryDir);
      assert.match(memoryText, /inbound launch note should persist when transcripts are disabled/);
      assert.doesNotMatch(memoryText, /Remember the launch inbound note preference without transcript/);
      assert.deepEqual(maintenanceTools, ["inline.memory_note"]);
    },
    {
      pluginConfig: {
        captureMode: "hybrid",
        transcriptEnabled: false,
      },
    },
  );
});

test("scenario: message_received inline captures are not duplicated by agent_end", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      const maintenanceTools: string[] = [];
      orchestrator.requestQmdMaintenanceForTool = (tool: string) => {
        maintenanceTools.push(tool);
      };
      const content = [
        "Remember the launch inline dedupe note.",
        "<memory_note>",
        "content: The inline dedupe note should only be processed once.",
        "category: preference",
        "</memory_note>",
      ].join("\n");

      await messageReceived(
        {
          content,
          messageId: "msg-inline-dedupe-1",
        },
        { sessionKey: "inline-dedupe-session" },
      );
      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content,
              messageId: "msg-inline-dedupe-1",
            },
            { role: "assistant", content: "I will remember that." },
          ],
        },
        { sessionKey: "inline-dedupe-session" },
      );

      assert.deepEqual(maintenanceTools, ["inline.memory_note"]);
    },
    {
      pluginConfig: {
        captureMode: "hybrid",
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: inline capture dedupe matches sparse thread and run metadata", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      const maintenanceTools: string[] = [];
      orchestrator.requestQmdMaintenanceForTool = (tool: string) => {
        maintenanceTools.push(tool);
      };
      const content = [
        "Remember the sparse inline dedupe note.",
        "<memory_note>",
        "content: The sparse inline note should only be processed once.",
        "category: preference",
        "</memory_note>",
      ].join("\n");

      await messageReceived(
        {
          content,
          messageId: "msg-inline-sparse-dedupe-1",
          threadId: "thread-only-on-message-received",
        },
        { sessionKey: "inline-sparse-dedupe-session" },
      );
      await agentEnd(
        {
          success: true,
          runId: "run-only-on-agent-end",
          messages: [
            {
              role: "user",
              content,
              messageId: "msg-inline-sparse-dedupe-1",
            },
            { role: "assistant", content: "I will remember that." },
          ],
        },
        { sessionKey: "inline-sparse-dedupe-session" },
      );

      assert.deepEqual(maintenanceTools, ["inline.memory_note"]);
    },
    {
      pluginConfig: {
        captureMode: "hybrid",
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received transcript append failures do not escape the hook", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const originalAppend = orchestrator.transcript.append;
      let appendAttempts = 0;
      orchestrator.transcript.append = async () => {
        appendAttempts += 1;
        throw new Error("transcript unavailable");
      };
      try {
        await messageReceived(
          {
            content: "Remember the launch transcript should fail open.",
            messageId: "msg-fail-open-1",
          },
          { sessionKey: "fail-open-session" },
        );
      } finally {
        orchestrator.transcript.append = originalAppend;
      }

      assert.equal(appendAttempts, 1);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received rejects invalid numeric timestamps before formatting", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const originalAppend = orchestrator.transcript.append;
      let appended: Record<string, unknown> | null = null;
      orchestrator.transcript.append = async (turn: Record<string, unknown>) => {
        appended = turn;
      };
      try {
        await messageReceived(
          {
            content: "Remember that invalid host timestamps should fail open.",
            messageId: "msg-invalid-timestamp-1",
            timestamp: Number.MAX_VALUE,
          },
          { sessionKey: "invalid-timestamp-session" },
        );
      } finally {
        orchestrator.transcript.append = originalAppend;
      }

      assert.ok(appended);
      const timestamp = (appended as Record<string, unknown>).timestamp;
      if (typeof timestamp !== "string") {
        assert.fail("expected transcript timestamp to be a string");
      }
      assert.ok(Number.isFinite(new Date(timestamp).getTime()));
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received dedupes agent_end transcript when metadata capture is disabled", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      const content = "Remember the launch dedupe preference.";

      await messageReceived(
        {
          content,
          messageId: "msg-dedupe-1",
        },
        { sessionKey: "dedupe-session" },
      );
      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content,
              messageId: "msg-dedupe-1",
            },
            { role: "assistant", content: "I will remember that." },
          ],
        },
        { sessionKey: "dedupe-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.equal(
        (transcriptText.match(/Remember the launch dedupe preference/g) ?? []).length,
        1,
      );
      assert.doesNotMatch(transcriptText, /"messageId":"msg-dedupe-1"/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
        openclawReplyMetadataCaptureEnabled: false,
      },
    },
  );
});

test("scenario: message_received dedupes agent_end transcript when agent_end omits messageId", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      const content = "Remember the no-id agent_end dedupe handoff.";
      const sharedTimestamp = 1_780_000_100_000;

      await messageReceived(
        {
          content,
          messageId: "msg-content-dedupe-1",
          runId: "content-dedupe-run",
          timestamp: sharedTimestamp,
        },
        { sessionKey: "content-dedupe-session" },
      );
      await agentEnd(
        {
          success: true,
          runId: "content-dedupe-run",
          timestamp: sharedTimestamp,
          messages: [
            {
              role: "user",
              content,
            },
            { role: "assistant", content: "I will keep the assistant reply." },
          ],
        },
        { sessionKey: "content-dedupe-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.equal(
        (transcriptText.match(/no-id agent_end dedupe handoff/g) ?? []).length,
        1,
      );
      assert.match(transcriptText, /keep the assistant reply/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received only dedupes after transcript append succeeds", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      type TranscriptEntry = Parameters<typeof orchestrator.transcript.append>[0];
      const appendTranscript = orchestrator.transcript.append.bind(orchestrator.transcript);
      let failNextAppend = true;
      orchestrator.transcript.append = async (entry: TranscriptEntry) => {
        if (failNextAppend) {
          failNextAppend = false;
          throw new Error("transient transcript failure");
        }
        await appendTranscript(entry);
      };

      await messageReceived(
        {
          content: "Remember the transient inbound append fallback.",
          messageId: "msg-transient-fail-1",
        },
        { sessionKey: "transient-append-session" },
      );
      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content: "Remember the transient inbound append fallback.",
              messageId: "msg-transient-fail-1",
            },
          ],
        },
        { sessionKey: "transient-append-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.match(transcriptText, /transient inbound append fallback/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: agent_end only dedupes after transcript append succeeds", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir, orchestrator }) => {
      const agentEnd = registeredHook(capture, "agent_end");
      type TranscriptEntry = Parameters<typeof orchestrator.transcript.append>[0];
      const appendTranscript = orchestrator.transcript.append.bind(orchestrator.transcript);
      let failNextAppend = true;
      orchestrator.transcript.append = async (entry: TranscriptEntry) => {
        if (failNextAppend) {
          failNextAppend = false;
          throw new Error("transient agent_end transcript failure");
        }
        await appendTranscript(entry);
      };

      const event = {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember the agent_end retry transcript fallback.",
            messageId: "agent-end-transient-fail-1",
          },
        ],
      };

      await agentEnd(event, { sessionKey: "agent-end-transient-session" });
      await agentEnd(event, { sessionKey: "agent-end-transient-session" });

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.equal(
        (transcriptText.match(/agent_end retry transcript fallback/g) ?? []).length,
        1,
      );
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: agent_end records repeated user transcript content without messageId", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const agentEnd = registeredHook(capture, "agent_end");
      const event = {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember the idless repeated agent_end transcript.",
          },
          {
            role: "assistant",
            content: "Recorded.",
          },
        ],
      };

      await agentEnd(event, { sessionKey: "agent-end-idless-dedupe-session" });
      await agentEnd(event, { sessionKey: "agent-end-idless-dedupe-session" });

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.equal(
        (transcriptText.match(/idless repeated agent_end transcript/g) ?? []).length,
        2,
      );
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received dedupes same delivery content with changed messageId", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const content = "Remember the same delivery changed id inbound message.";
      const sharedTimestamp = 1_780_000_000_000;

      await messageReceived(
        {
          content,
          messageId: "same-delivery-id-1",
          runId: "same-delivery-run",
          timestamp: sharedTimestamp,
        },
        { sessionKey: "same-delivery-inbound-session" },
      );
      await messageReceived(
        {
          content,
          messageId: "same-delivery-id-2",
          runId: "same-delivery-run",
          timestamp: sharedTimestamp,
        },
        { sessionKey: "same-delivery-inbound-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.equal(
        (transcriptText.match(/same delivery changed id inbound message/g) ?? []).length,
        1,
      );
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: inbound message dedupe is scoped per session", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      await messageReceived(
        {
          content: "Remember the first scoped inbound message.",
          messageId: "shared-openclaw-msg-id",
        },
        { sessionKey: "scoped-session-one" },
      );
      await messageReceived(
        {
          content: "Remember the second scoped inbound message.",
          messageId: "shared-openclaw-msg-id",
        },
        { sessionKey: "scoped-session-two" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.match(transcriptText, /first scoped inbound message/);
      assert.match(transcriptText, /second scoped inbound message/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: inbound message dedupe matches sparse thread and run metadata", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      const content = "Remember the sparse OpenClaw dedupe handoff.";

      await messageReceived(
        {
          content,
          messageId: "sparse-openclaw-msg-id",
          threadId: "thread-only-on-message-received",
        },
        { sessionKey: "sparse-dedupe-session" },
      );
      await agentEnd(
        {
          success: true,
          runId: "run-only-on-agent-end",
          messages: [
            {
              role: "user",
              content,
              messageId: "sparse-openclaw-msg-id",
            },
          ],
        },
        { sessionKey: "sparse-dedupe-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.equal(
        (transcriptText.match(/sparse OpenClaw dedupe handoff/g) ?? []).length,
        1,
      );
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: message_received without messageId defers transcript capture to agent_end", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      const content = "Remember the no-id inbound capture fallback.";

      await messageReceived(
        {
          content,
          threadId: "thread-without-message-id",
        },
        { sessionKey: "no-id-inbound-session" },
      );
      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content,
            },
          ],
        },
        { sessionKey: "no-id-inbound-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.equal(
        (transcriptText.match(/no-id inbound capture fallback/g) ?? []).length,
        1,
      );
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: agent_end does not dedupe assistant turns with inbound user message ids", async () => {
  await withScenarioRegistration(
    async ({ capture, memoryDir }) => {
      const agentEnd = registeredHook(capture, "agent_end");
      await agentEnd(
        {
          success: true,
          messageId: "inbound-user-msg",
          messages: [
            {
              role: "user",
              content: "Remember the inbound user id transcript regression.",
            },
            {
              role: "assistant",
              content: "I will preserve the assistant response in transcripts.",
            },
          ],
        },
        { sessionKey: "agent-end-inbound-id-session" },
      );

      const transcriptText = readAllText(path.join(memoryDir, "transcripts"));
      assert.match(transcriptText, /inbound user id transcript regression/);
      assert.match(transcriptText, /preserve the assistant response/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
      },
    },
  );
});

test("scenario: inbound message dedupe keeps a bounded recent window", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      const appended: Array<{ content: string }> = [];
      orchestrator.transcript.append = async (entry: { content: string }) => {
        appended.push(entry);
      };

      for (let i = 0; i < 1025; i++) {
        await messageReceived(
          {
            content: `Remember bounded dedupe ${i}`,
            messageId: `bounded-${i}`,
          },
          { sessionKey: "bounded-session" },
        );
      }

      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content: "Remember bounded dedupe 0",
              messageId: "bounded-0",
            },
          ],
        },
        { sessionKey: "bounded-session" },
      );

      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content: "Remember bounded dedupe 1024",
              messageId: "bounded-1024",
            },
          ],
        },
        { sessionKey: "bounded-session" },
      );

      assert.equal(
        appended.filter((entry) => entry.content === "Remember bounded dedupe 0").length,
        2,
      );
      assert.equal(
        appended.filter((entry) => entry.content === "Remember bounded dedupe 1024").length,
        1,
      );
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
        openclawReplyMetadataCaptureEnabled: false,
      },
    },
  );
});

test("scenario: reply extraction hints are opt-in and bounded", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const processed: Array<{ role: string; content: string }> = [];
      orchestrator.processTurn = async (role: string, content: string) => {
        processed.push({ role, content });
      };

      const agentEnd = registeredHook(capture, "agent_end");
      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content: "Please remember that the launch note belongs to the mobile rollout.",
              replyToBody: "The mobile rollout launch note lives in #launch.",
              replyToSender: "Ada",
            },
            { role: "assistant", content: "I will remember that." },
          ],
        },
        { sessionKey: "reply-hint-session" },
      );

      assert.match(processed[0].content, /^Reply context from Ada:/);
      assert.match(processed[0].content, /Current message: Please remember/);
      assert.match(processed[1].content, /^I will remember that\./);
    },
    {
      pluginConfig: {
        openclawReplyMetadataExtractionHintsEnabled: true,
        openclawReplyMetadataCaptureEnabled: false,
      },
    },
  );
});

test("scenario: reply extraction hints reuse inbound-only reply metadata", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const processed: Array<{ role: string; content: string }> = [];
      orchestrator.processTurn = async (role: string, content: string) => {
        processed.push({ role, content });
      };

      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      await messageReceived(
        {
          content: "Please remember that this note belongs to the mobile rollout.",
          messageId: "reply-inbound-only-1",
          replyToBody: "The quoted mobile rollout decision lives in #launch.",
          replyToSender: "Ada",
        },
        { sessionKey: "reply-inbound-only-session" },
      );
      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content: "Please remember that this note belongs to the mobile rollout.",
              messageId: "reply-inbound-only-1",
            },
            { role: "assistant", content: "I will remember that." },
          ],
        },
        { sessionKey: "reply-inbound-only-session" },
      );

      assert.match(processed[0].content, /^Reply context from Ada:/);
      assert.match(processed[0].content, /quoted mobile rollout decision/);
      assert.match(processed[0].content, /Current message: Please remember/);
    },
    {
      pluginConfig: {
        transcriptEnabled: true,
        openclawReplyMetadataCaptureEnabled: false,
        openclawReplyMetadataExtractionHintsEnabled: true,
      },
    },
  );
});

test("scenario: reply extraction hints reuse inbound metadata when transcripts are disabled", async () => {
  await withScenarioRegistration(
    async ({ capture, orchestrator }) => {
      const processed: Array<{ role: string; content: string }> = [];
      orchestrator.processTurn = async (role: string, content: string) => {
        processed.push({ role, content });
      };

      const messageReceived = registeredHook(capture, "message_received");
      const agentEnd = registeredHook(capture, "agent_end");
      await messageReceived(
        {
          content: "Please remember that this note belongs to the mobile rollout.",
          messageId: "reply-transcript-disabled-1",
          replyToBody: "The quoted mobile rollout decision lives in #launch.",
          replyToSender: "Ada",
        },
        { sessionKey: "reply-transcript-disabled-session" },
      );
      await agentEnd(
        {
          success: true,
          messages: [
            {
              role: "user",
              content: "Please remember that this note belongs to the mobile rollout.",
              messageId: "reply-transcript-disabled-1",
            },
          ],
        },
        { sessionKey: "reply-transcript-disabled-session" },
      );

      assert.match(processed[0].content, /^Reply context from Ada:/);
      assert.match(processed[0].content, /quoted mobile rollout decision/);
      assert.match(processed[0].content, /Current message: Please remember/);
    },
    {
      pluginConfig: {
        transcriptEnabled: false,
        openclawReplyMetadataCaptureEnabled: false,
        openclawReplyMetadataExtractionHintsEnabled: true,
      },
    },
  );
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
