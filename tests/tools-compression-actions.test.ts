import test from "node:test";
import { sealedWriteToLegacyArgs, type SealedMemoryEnvelope } from "../src/write-envelope.js";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function buildHarness(options?: {
  contextCompressionActionsEnabled?: boolean;
  appendMemoryActionEventResult?: boolean;
  appendMemoryActionEvent?: (event: any) => Promise<boolean> | boolean;
  previewMemoryActionEvent?: (event: any) => any;
  writeMemory?: (category: string, content: string, options?: Record<string, unknown>) => Promise<string> | string;
  writeArtifact?: (content: string, options?: Record<string, unknown>) => Promise<string> | string;
  updateMemory?: (
    memoryId: string,
    content: string,
    options?: Record<string, unknown>,
  ) => Promise<boolean> | boolean;
  readAllMemories?: () => Promise<any[]> | any[];
  readArchivedMemories?: () => Promise<any[]> | any[];
  writeMemoryFrontmatter?: (memory: any, patch: Record<string, unknown>, options?: Record<string, unknown>) => Promise<void> | void;
  addLinksToMemory?: (
    memoryId: string,
    links: any[],
    options?: Record<string, unknown>,
  ) => Promise<boolean> | boolean;
  createCheckpoint?: (sessionKey: string, turns: any[], ttlHours?: number) => any;
  saveCheckpoint?: (checkpoint: any) => Promise<void> | void;
}) {
  const tools = new Map<string, RegisteredTool>();
  const capturedEvents: any[] = [];
  const capturedWrites: Array<{ category: string; content: string; options?: Record<string, unknown> }> = [];
  const capturedArtifactWrites: Array<{ content: string; options?: Record<string, unknown> }> = [];
  const capturedUpdateWrites: Array<{ memoryId: string; content: string; options?: Record<string, unknown> }> = [];
  const capturedFrontmatterWrites: Array<{ memory: any; patch: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const capturedLinkWrites: Array<{ memoryId: string; links: any[]; options?: Record<string, unknown> }> = [];
  const createdCheckpoints: Array<{ sessionKey: string; turns: any[]; ttlHours?: number }> = [];
  const savedCheckpoints: any[] = [];
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const storage = {
    readIdentity: async () => null,
    readProfile: async () => null,
    readAllEntities: async () => [],
    writeMemory: async (category: string, content: string, writeOptions?: Record<string, unknown>) => {
      capturedWrites.push({ category, content, options: writeOptions });
      if (options?.writeMemory) {
        return await options.writeMemory(category, content, writeOptions);
      }
      return { id: "fact-stored", tombstoneBlocked: false };
    },
    // Production mapper keeps the legacy recorder faithful (§21).
    writeSealedMemory: async (envelope: SealedMemoryEnvelope, extras: Record<string, unknown>) => {
      const { category, content, options: writeOptions } = sealedWriteToLegacyArgs(envelope, extras);
      // Drop explicit-undefined mapper keys: writeMemory treats them as
      // absent, and the assertions compare against the meaningful set.
      const definedOptions = Object.fromEntries(
        Object.entries(writeOptions).filter(([, value]) => value !== undefined),
      );
      capturedWrites.push({ category, content, options: definedOptions });
      if (options?.writeMemory) {
        return await options.writeMemory(category, content, writeOptions);
      }
      return { id: "fact-stored", tombstoneBlocked: false };
    },
    writeArtifact: async (content: string, writeOptions?: Record<string, unknown>) => {
      capturedArtifactWrites.push({ content, options: writeOptions });
      if (options?.writeArtifact) {
        return await options.writeArtifact(content, writeOptions);
      }
      return "artifact-stored";
    },
    updateMemory: async (memoryId: string, content: string, updateOptions?: Record<string, unknown>) => {
      capturedUpdateWrites.push({ memoryId, content, options: updateOptions });
      if (options?.updateMemory) {
        return await options.updateMemory(memoryId, content, updateOptions);
      }
      return true;
    },
    readAllMemories: async () => {
      if (options?.readAllMemories) {
        return await options.readAllMemories();
      }
      return [];
    },
    readArchivedMemories: async () => {
      if (options?.readArchivedMemories) {
        return await options.readArchivedMemories();
      }
      return [];
    },
    writeMemoryFrontmatter: async (memory: any, patch: Record<string, unknown>, writeOptions?: Record<string, unknown>) => {
      capturedFrontmatterWrites.push({ memory, patch, options: writeOptions });
      await options?.writeMemoryFrontmatter?.(memory, patch, writeOptions);
    },
    addLinksToMemory: async (memoryId: string, links: any[], writeOptions?: Record<string, unknown>) => {
      capturedLinkWrites.push({ memoryId, links, options: writeOptions });
      if (options?.addLinksToMemory) {
        return await options.addLinksToMemory(memoryId, links, writeOptions);
      }
      return true;
    },
  };

  const transcript = {
    listSessionKeys: async () => [],
    createCheckpoint: (sessionKey: string, turns: any[], ttlHours?: number) => {
      createdCheckpoints.push({ sessionKey, turns, ttlHours });
      if (options?.createCheckpoint) {
        return options.createCheckpoint(sessionKey, turns, ttlHours);
      }
      return {
        sessionKey,
        capturedAt: "2026-03-11T00:00:00.000Z",
        ttl: "2026-03-12T00:00:00.000Z",
        turns,
      };
    },
    saveCheckpoint: async (checkpoint: any) => {
      savedCheckpoints.push(checkpoint);
      await options?.saveCheckpoint?.(checkpoint);
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      contextCompressionActionsEnabled: options?.contextCompressionActionsEnabled === true,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
    },
    previewMemoryActionEvent:
      options?.previewMemoryActionEvent ??
      ((event: any) => ({
        ...event,
        namespace: event.namespace ?? "default",
        outcome: event.outcome ?? "applied",
        policyDecision: "allow",
      })),
    appendMemoryActionEvent: async (event: unknown) => {
      capturedEvents.push(event);
      if (options?.appendMemoryActionEvent) {
        return await options.appendMemoryActionEvent(event);
      }
      return options?.appendMemoryActionEventResult ?? true;
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => storage,
    storage,
    summarizer: {
      runHourly: async () => {},
    },
    transcript,
    sharedContext: null,
    compounding: null,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
  };

  registerTools(api as any, orchestrator as any);
  return {
    tools,
    capturedEvents,
    capturedWrites,
    capturedArtifactWrites,
    capturedUpdateWrites,
    capturedFrontmatterWrites,
    capturedLinkWrites,
    createdCheckpoints,
    savedCheckpoints,
  };
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

test("context_checkpoint is gated off when context compression actions are disabled", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: false,
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const result = await tool.execute("tc1", { summary: "checkpoint summary" });
  assert.match(toolText(result), /disabled/i);
  assert.equal(capturedEvents.length, 0);
});

test("memory_action_apply records telemetry event when enabled", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc2", {
    action: "store_note",
    sourcePrompt: "trim this context",
  });

  assert.match(toolText(result), /Recorded memory action telemetry/i);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0].action, "store_note");
  assert.equal(capturedEvents[0].outcome, "applied");
  assert.equal(capturedEvents[0].namespace, "default");
  assert.equal(typeof capturedEvents[0].promptHash, "string");
  assert.equal(capturedEvents[0].promptHash.length, 16);
});

test("context_checkpoint logs summarize_node telemetry in requested namespace", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const result = await tool.execute("tc3", {
    summary: "trimmed low-signal context",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Recorded context checkpoint telemetry/i);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0].action, "summarize_node");
  assert.equal(capturedEvents[0].namespace, "team-alpha");
  assert.match(capturedEvents[0].reason, /^context_checkpoint:/);
});

test("memory_action_apply dryRun reports without writing telemetry", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc4", {
    action: "link_graph",
    dryRun: true,
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Dry run:/i);
  assert.match(toolText(result), /policy=allow/i);
  assert.equal(capturedEvents.length, 0);
});

test("memory_action_apply fails open when telemetry write fails", async () => {
  const { tools } = buildHarness({
    contextCompressionActionsEnabled: true,
    appendMemoryActionEventResult: false,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc5", {
    action: "discard",
    outcome: "failed",
  });

  assert.match(toolText(result), /fail-open/i);
});

test("memory_action_apply reports normalized outcome for persisted telemetry", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: "skipped",
      policyDecision: "deny",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc6", {
    action: "discard",
    outcome: "applied",
  });

  assert.match(toolText(result), /outcome=skipped/i);
  assert.equal(capturedEvents.length, 1);
});

test("context_checkpoint reuses the transcript checkpoint model and logs checkpoint metadata", async () => {
  const { tools, capturedEvents, createdCheckpoints, savedCheckpoints } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const turns = [
    {
      timestamp: "2026-03-11T10:00:00.000Z",
      role: "user",
      content: "Please compress the noisy setup discussion.",
      sessionKey: "agent:engram:main",
      turnId: "turn-1",
    },
  ];

  const result = await tool.execute("tc7", {
    summary: "checkpoint before compaction",
    sessionKey: "agent:engram:main",
    turns,
    ttlHours: 12,
    dryRun: false,
  });

  assert.match(toolText(result), /checkpoint/i);
  assert.equal(createdCheckpoints.length, 1);
  assert.deepEqual(createdCheckpoints[0], {
    sessionKey: "agent:engram:main",
    turns,
    ttlHours: 12,
  });
  assert.equal(savedCheckpoints.length, 1);
  assert.equal(savedCheckpoints[0]?.sessionKey, "agent:engram:main");
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.sourceSessionKey, "agent:engram:main");
  assert.equal(capturedEvents[0]?.inputSummary, "checkpoint before compaction");
  assert.equal(capturedEvents[0]?.dryRun, false);
});

test("context_checkpoint respects policy gates before saving checkpoints", async () => {
  const { tools, capturedEvents, createdCheckpoints, savedCheckpoints } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: "skipped",
      status: "rejected",
      policyDecision: "defer",
      policyRationale: "maxCompressionTokensPerHour=0",
    }),
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const result = await tool.execute("tc7b", {
    summary: "checkpoint before compaction",
    sessionKey: "agent:engram:main",
    turns: [
      {
        timestamp: "2026-03-11T10:00:00.000Z",
        role: "user",
        content: "Please compress the noisy setup discussion.",
        sessionKey: "agent:engram:main",
        turnId: "turn-1",
      },
    ],
    dryRun: false,
  });

  assert.match(toolText(result), /blocked by policy/i);
  assert.equal(createdCheckpoints.length, 0);
  assert.equal(savedCheckpoints.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.action, "summarize_node");
});

test("context_checkpoint dryRun policy denials persist rejected status instead of validated", async () => {
  const persistedEvents: any[] = [];
  const { tools, createdCheckpoints, savedCheckpoints } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: "skipped",
      status: event.status ?? "rejected",
      policyDecision: "deny",
      policyRationale: "contextCompressionActionsEnabled=false",
    }),
    appendMemoryActionEvent: async (event: any) => {
      persistedEvents.push({
        ...event,
        namespace: event.namespace ?? "default",
        outcome: "skipped",
        status: event.status ?? "rejected",
        policyDecision: "deny",
      });
      return true;
    },
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const result = await tool.execute("tc7c", {
    summary: "checkpoint before compaction",
    sessionKey: "agent:engram:main",
    turns: [
      {
        timestamp: "2026-03-11T10:00:00.000Z",
        role: "user",
        content: "Please compress the noisy setup discussion.",
        sessionKey: "agent:engram:main",
        turnId: "turn-1",
      },
    ],
    dryRun: true,
  });

  assert.match(toolText(result), /blocked by policy/i);
  assert.equal(createdCheckpoints.length, 0);
  assert.equal(savedCheckpoints.length, 0);
  assert.equal(persistedEvents.length, 1);
  assert.equal(persistedEvents[0]?.status, "rejected");
  assert.equal(persistedEvents[0]?.dryRun, true);
});

test("memory_action_apply executes store_note through storage paths and records output ids", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc8", {
    action: "store_note",
    category: "fact",
    content: "Persist the compaction decision through the normal storage path.",
    namespace: "team-alpha",
    sessionKey: "agent:team-alpha:main",
  });

  assert.match(toolText(result), /memoryId=/i);
  assert.equal(capturedWrites.length, 1);
  assert.deepEqual(capturedWrites[0], {
    category: "fact",
    content: "Persist the compaction decision through the normal storage path.",
    options: {
      actor: "tool.memory_action_apply",
      source: "memory_action_apply",
    },
  });
  assert.equal(capturedEvents.length, 1);
  assert.deepEqual(capturedEvents[0]?.outputMemoryIds, ["fact-stored"]);
  assert.equal(capturedEvents[0]?.status, "applied");
  assert.equal(capturedEvents[0]?.actor, "tool.memory_action_apply");
});

test("memory_action_apply dryRun logs the validated action without mutating storage", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc9", {
    action: "store_note",
    category: "fact",
    content: "Validate without writing this memory.",
    dryRun: true,
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /validated/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.dryRun, true);
  assert.deepEqual(capturedEvents[0]?.outputMemoryIds, []);
});

test("memory_action_apply dryRun reports policy blocks instead of validated success", async () => {
  const persistedEvents: any[] = [];
  const { tools, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: "skipped",
      status: "rejected",
      policyDecision: "deny",
      policyRationale: "lifecycle_state_archived_restricted",
    }),
    appendMemoryActionEvent: async (event: any) => {
      persistedEvents.push({
        ...event,
        namespace: event.namespace ?? "default",
        outcome: "skipped",
        status: "rejected",
        policyDecision: "deny",
        policyRationale: "lifecycle_state_archived_restricted",
      });
      return true;
    },
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc9a", {
    action: "create_artifact",
    memoryId: "fact-archived",
    content: "Artifact body",
    artifactType: "checkpoint",
    dryRun: true,
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /blocked by policy/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(persistedEvents.length, 1);
  assert.equal(persistedEvents[0]?.status, "rejected");
  assert.equal(persistedEvents[0]?.dryRun, true);
});

test("memory_action_apply dryRun appends the raw structured event instead of a pre-previewed event", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      reason: event.reason ? `${event.reason}|previewed` : "previewed",
      namespace: event.namespace ?? "default",
      outcome: event.outcome ?? "applied",
      status: "validated",
      policyDecision: "allow",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  await tool.execute("tc9b", {
    action: "store_note",
    category: "fact",
    content: "Validate without writing this memory.",
    dryRun: true,
    reason: "seed",
    namespace: "team-alpha",
  });

  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.reason, "seed");
});

test("memory_action_apply logs validation rejections for missing required action inputs", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10", {
    action: "store_note",
    category: "fact",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /validation/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.status, "rejected");
  assert.equal(capturedEvents[0]?.outcome, "failed");
  assert.match(capturedEvents[0]?.reason ?? "", /validation/i);
});

test("memory_action_apply respects policy gates before mutating storage", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: "skipped",
      status: "rejected",
      policyDecision: "defer",
      policyRationale: "maxCompressionTokensPerHour=0",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10b", {
    action: "summarize_node",
    category: "fact",
    content: "Summarize this node even though compression is disabled.",
    namespace: "team-alpha",
    sessionKey: "agent:team-alpha:main",
  });

  assert.match(toolText(result), /blocked by policy/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.action, "summarize_node");
  assert.equal(capturedEvents[0]?.dryRun, false);
});

test("memory_action_apply derives discard policy eligibility from the target memory before gating", async () => {
  const { tools, capturedEvents, capturedFrontmatterWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
    readAllMemories: async () => [
      {
        path: "/tmp/fact-important.md",
        frontmatter: {
          id: "fact-important",
          confidence: 0.92,
          lifecycleState: "active",
          importance: { score: 0.96, level: "critical", reasons: [], keywords: [] },
          source: "manual",
        },
        content: "Keep this important note unless policy explicitly allows removal.",
      },
    ],
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: event.policyEligibility?.importance >= 0.8 ? "skipped" : "applied",
      status: event.policyEligibility?.importance >= 0.8 ? "rejected" : "applied",
      policyDecision: event.policyEligibility?.importance >= 0.8 ? "deny" : "allow",
      policyRationale:
        event.policyEligibility?.importance >= 0.8 ? "importance_too_high_for_discard" : "eligible",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10b-discard-eligibility", {
    action: "discard",
    memoryId: "fact-important",
    namespace: "team-alpha",
    execute: true,
  });

  assert.match(toolText(result), /blocked by policy/i);
  assert.equal(capturedFrontmatterWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.deepEqual(capturedEvents[0]?.policyEligibility, {
    confidence: 0.92,
    lifecycleState: "active",
    importance: 0.96,
    source: "manual",
  });
});

test("memory_action_apply derives source-memory eligibility for create_artifact policy gates", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
    readAllMemories: async () => [
      {
        path: "/tmp/fact-active.md",
        frontmatter: {
          id: "fact-active",
          confidence: 0.44,
          lifecycleState: "candidate",
          importance: { score: 0.12, level: "low", reasons: [], keywords: [] },
          source: "manual",
          status: "active",
        },
        content: "Active note for baseline coverage.",
      },
    ],
    readArchivedMemories: async () => [
      {
        path: "/tmp/archive/2026-03-01/fact-archived.md",
        frontmatter: {
          id: "fact-archived",
          confidence: 0.61,
          lifecycleState: "candidate",
          importance: { score: 0.33, level: "low", reasons: [], keywords: [] },
          source: "manual",
          status: "archived",
        },
        content: "Archived note that should not produce new artifacts.",
      },
    ],
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: event.policyEligibility?.lifecycleState === "archived" ? "skipped" : "applied",
      status: event.policyEligibility?.lifecycleState === "archived" ? "rejected" : "applied",
      policyDecision: event.policyEligibility?.lifecycleState === "archived" ? "deny" : "allow",
      policyRationale:
        event.policyEligibility?.lifecycleState === "archived"
          ? "lifecycle_state_archived_restricted"
          : "eligible",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10b-artifact-eligibility", {
    action: "create_artifact",
    memoryId: "fact-archived",
    content: "Artifact body",
    artifactType: "checkpoint",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /blocked by policy/i);
  assert.equal(capturedEvents.length, 1);
  assert.deepEqual(capturedEvents[0]?.policyEligibility, {
    confidence: 0.61,
    lifecycleState: "archived",
    importance: 0.33,
    source: "manual",
  });
});

test("memory_action_apply rejects invalid structured categories before writing memory", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10c", {
    action: "store_note",
    category: "../secrets",
    content: "Reject unsafe categories before they reach storage.",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /invalid category/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.status, "rejected");
  assert.equal(capturedEvents[0]?.outcome, "failed");
});

test("memory_action_apply preserves dryRun on invalid category rejections", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10c-dryrun", {
    action: "store_note",
    category: "../secrets",
    content: "Reject unsafe categories before they reach storage.",
    namespace: "team-alpha",
    dryRun: true,
  });

  assert.match(toolText(result), /invalid category/i);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.dryRun, true);
  assert.equal(capturedEvents[0]?.status, "rejected");
});

test("memory_action_apply keeps legacy telemetry calls with memoryId in compatibility mode", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10c", {
    action: "discard",
    memoryId: "fact-legacy",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Recorded memory action telemetry/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.memoryId, "fact-legacy");
  assert.equal(capturedEvents[0]?.outcome, "applied");
});

test("memory_action_apply keeps legacy telemetry calls with sessionKey in compatibility mode", async () => {
  const { tools, capturedEvents, capturedFrontmatterWrites, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
    readAllMemories: async () => [
      {
        path: "/tmp/fact-legacy.md",
        frontmatter: { id: "fact-legacy" },
        content: "legacy",
      },
    ],
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10c-session", {
    action: "discard",
    memoryId: "fact-legacy",
    namespace: "team-alpha",
    sessionKey: "agent:team-alpha:main",
  });

  assert.match(toolText(result), /Recorded memory action telemetry/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedFrontmatterWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.memoryId, "fact-legacy");
  assert.equal(capturedEvents[0]?.sourceSessionKey, "agent:team-alpha:main");
});

test("memory_action_apply rejects out-of-range link strengths before writing links", async () => {
  const { tools, capturedEvents, capturedLinkWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10d-link", {
    action: "link_graph",
    memoryId: "fact-source",
    linkTargetId: "fact-target",
    linkType: "supports",
    linkStrength: -0.5,
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /linkStrength/i);
  assert.equal(capturedLinkWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.status, "rejected");
  assert.equal(capturedEvents[0]?.outcome, "failed");
});

test("memory_action_apply rejects empty artifact ids from storage", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
    writeArtifact: async () => "",
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10d", {
    action: "create_artifact",
    content: "Artifact content",
    artifactType: "checkpoint",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /unable to create artifact/i);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.status, "rejected");
  assert.equal(capturedEvents[0]?.outcome, "failed");
});

test("memory_action_apply records applied outcome after successful structured mutations", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10e", {
    action: "store_note",
    category: "fact",
    content: "Persist this note and normalize telemetry outcome.",
    outcome: "failed",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Applied memory action/i);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.status, "applied");
  assert.equal(capturedEvents[0]?.outcome, "applied");
});

test("memory_action_apply passes explicit actor metadata to update_note writes", async () => {
  const { tools, capturedEvents, capturedUpdateWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
    readAllMemories: async () => [
      {
        path: "/tmp/fact-existing.md",
        frontmatter: {
          id: "fact-existing",
          confidence: 0.58,
          lifecycleState: "active",
          importance: { score: 0.27, level: "low", reasons: [], keywords: [] },
          source: "manual",
        },
        content: "Existing note for update coverage.",
      },
    ],
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10e-update", {
    action: "update_note",
    memoryId: "fact-existing",
    content: "Update this note with structured action audit metadata.",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Applied memory action/i);
  assert.equal(capturedUpdateWrites.length, 1);
  assert.deepEqual(capturedUpdateWrites[0], {
    memoryId: "fact-existing",
    content: "Update this note with structured action audit metadata.",
    options: {
      actor: "tool.memory_action_apply",
    },
  });
  assert.equal(capturedEvents.length, 1);
  assert.deepEqual(capturedEvents[0]?.outputMemoryIds, ["fact-existing"]);
  assert.deepEqual(capturedEvents[0]?.policyEligibility, {
    confidence: 0.58,
    lifecycleState: "active",
    importance: 0.27,
    source: "manual",
  });
});

test("memory_action_apply passes explicit actor metadata to create_artifact writes", async () => {
  const { tools, capturedArtifactWrites, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10e-artifact", {
    action: "create_artifact",
    memoryId: "fact-existing",
    content: "Artifact body",
    artifactType: "checkpoint",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Applied memory action/i);
  assert.equal(capturedArtifactWrites.length, 1);
  assert.deepEqual(capturedArtifactWrites[0], {
    content: "Artifact body",
    options: {
      actor: "tool.memory_action_apply",
      artifactType: "checkpoint",
      sourceMemoryId: "fact-existing",
    },
  });
  assert.equal(capturedEvents.length, 1);
  assert.deepEqual(capturedEvents[0]?.outputMemoryIds, ["artifact-stored"]);
});

test("memory_action_apply rejects unrecognized actions instead of reporting false success", async () => {
  const { tools, capturedEvents, capturedLinkWrites, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10f", {
    action: "made_up_action",
    content: "Do not silently accept unknown actions.",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /invalid action/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedLinkWrites.length, 0);
  assert.equal(capturedEvents.length, 0);
});
