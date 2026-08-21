import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { ContinuityImprovementLoop } from "../src/types.ts";
import { registerTools } from "../src/tools.ts";
import { StorageManager } from "../src/storage.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function buildHarness(options?: {
  identityContinuityEnabled?: boolean;
  loops?: ContinuityImprovementLoop[];
}) {
  const tools = new Map<string, RegisteredTool>();
  let loops = [...(options?.loops ?? [])];

  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const storage = {
    readIdentity: async () => null,
    readProfile: async () => null,
    readAllEntities: async () => [],
    readIdentityAnchor: async () => null,
    writeIdentityAnchor: async () => {},
    appendContinuityIncident: async () => null,
    closeContinuityIncident: async () => null,
    readContinuityIncidents: async () => [],
    upsertIdentityImprovementLoop: async (input: {
      id: string;
      cadence: "daily" | "weekly" | "monthly" | "quarterly";
      purpose: string;
      status: "active" | "paused" | "retired";
      killCondition: string;
      lastReviewed?: string;
      notes?: string;
    }) => {
      const next: ContinuityImprovementLoop = {
        id: input.id,
        cadence: input.cadence,
        purpose: input.purpose,
        status: input.status,
        killCondition: input.killCondition,
        lastReviewed: input.lastReviewed ?? new Date().toISOString(),
        notes: input.notes,
      };
      loops = loops.filter((loop) => loop.id !== next.id);
      loops.push(next);
      return next;
    },
    reviewIdentityImprovementLoop: async (
      id: string,
      update: { status?: "active" | "paused" | "retired"; notes?: string; reviewedAt?: string },
    ) => {
      const existing = loops.find((loop) => loop.id === id);
      if (!existing) return null;
      const reviewed: ContinuityImprovementLoop = {
        ...existing,
        status: update.status ?? existing.status,
        notes: update.notes ?? existing.notes,
        lastReviewed: update.reviewedAt ?? new Date().toISOString(),
      };
      loops = loops.map((loop) => (loop.id === id ? reviewed : loop));
      return reviewed;
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      workspaceDir: "/tmp/workspace",
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      continuityIncidentLoggingEnabled: true,
      identityContinuityEnabled: options?.identityContinuityEnabled === true,
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    storage,
    getStorageForNamespace: async () => storage,
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      listSessionKeys: async () => [],
    },
    sharedContext: null,
    compounding: null,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
    appendMemoryActionEvent: async () => true,
  };

  registerTools(api as any, orchestrator as any);
  return { tools, getLoops: () => loops };
}

test("continuity loop tools are gated when identity continuity is disabled", async () => {
  const { tools } = buildHarness({ identityContinuityEnabled: false });
  const upsertTool = tools.get("continuity_loop_add_or_update");
  const reviewTool = tools.get("continuity_loop_review");
  assert.ok(upsertTool);
  assert.ok(reviewTool);

  const upsertResult = await upsertTool.execute("tc1", {
    id: "weekly-audit",
    cadence: "weekly",
    purpose: "Run weekly continuity audit",
    status: "active",
    killCondition: "No longer needed",
  });
  assert.match(toolText(upsertResult), /disabled/i);

  const reviewResult = await reviewTool.execute("tc2", { id: "weekly-audit" });
  assert.match(toolText(reviewResult), /disabled/i);
});

test("continuity_loop_add_or_update stores loop and continuity_loop_review updates metadata", async () => {
  const { tools, getLoops } = buildHarness({ identityContinuityEnabled: true });
  const upsertTool = tools.get("continuity_loop_add_or_update");
  const reviewTool = tools.get("continuity_loop_review");
  assert.ok(upsertTool);
  assert.ok(reviewTool);

  const saveResult = await upsertTool.execute("tc3", {
    id: "weekly-audit",
    cadence: "weekly",
    purpose: "Run weekly continuity audit",
    status: "active",
    killCondition: "Replace with automated monitor",
    notes: "Owner: ops",
  });
  assert.match(toolText(saveResult), /Continuity loop saved/);
  assert.equal(getLoops().length, 1);
  assert.equal(getLoops()[0]?.id, "weekly-audit");

  const reviewResult = await reviewTool.execute("tc4", {
    id: "weekly-audit",
    status: "paused",
    notes: "Paused while queue drains",
    reviewedAt: "2026-02-25T00:00:00.000Z",
  });
  assert.match(toolText(reviewResult), /Continuity loop reviewed/);
  assert.equal(getLoops()[0]?.status, "paused");
  assert.equal(getLoops()[0]?.lastReviewed, "2026-02-25T00:00:00.000Z");
  assert.equal(getLoops()[0]?.notes, "Paused while queue drains");
});

test("storage improvement-loop register upsert and review round-trip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-loop-register-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const upserted = await storage.upsertIdentityImprovementLoop({
      id: "weekly-audit",
      cadence: "weekly",
      purpose: "Run weekly continuity audit",
      status: "active",
      killCondition: "Retire when metrics are automatic",
      lastReviewed: "2026-02-25T00:00:00.000Z",
    });
    assert.equal(upserted.id, "weekly-audit");

    const reviewed = await storage.reviewIdentityImprovementLoop("weekly-audit", {
      status: "paused",
      notes: "Paused during incident backlog",
      reviewedAt: "2026-02-26T00:00:00.000Z",
    });
    assert.ok(reviewed);
    assert.equal(reviewed?.status, "paused");

    const loops = await storage.readIdentityImprovementLoopRegister();
    assert.equal(loops.length, 1);
    assert.equal(loops[0]?.lastReviewed, "2026-02-26T00:00:00.000Z");
    assert.equal(loops[0]?.notes, "Paused during incident backlog");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage upsert rejects invalid loop payloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-loop-invalid-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await assert.rejects(
      () =>
        storage.upsertIdentityImprovementLoop({
          id: "",
          cadence: "weekly",
          purpose: "x",
          status: "active",
          killCondition: "y",
        }),
      /Invalid continuity loop input/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage upsert preserves legacy freeform sections in improvement-loops markdown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-loop-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.writeIdentityImprovementLoops(
      [
        "# Continuity Improvement Loops",
        "",
        "## legacy-notes",
        "This block predates structured fields and must be preserved.",
        "",
        "## malformed-loop",
        "cadence: weekly",
        "purpose: missing required fields should not be dropped on rewrite",
        "",
      ].join("\n"),
    );

    await storage.upsertIdentityImprovementLoop({
      id: "weekly-audit",
      cadence: "weekly",
      purpose: "Run weekly continuity audit",
      status: "active",
      killCondition: "Retire when automated",
      lastReviewed: "2026-02-27T00:00:00.000Z",
    });

    const raw = await storage.readIdentityImprovementLoops();
    assert.ok(raw);
    assert.match(raw ?? "", /## legacy-notes/);
    assert.match(raw ?? "", /predates structured fields/);
    assert.match(raw ?? "", /## malformed-loop/);
    assert.match(raw ?? "", /missing required fields/);
    assert.match(raw ?? "", /## weekly-audit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review normalizes loop id spacing to match canonicalized upsert ids", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-loop-id-normalize-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.upsertIdentityImprovementLoop({
      id: "weekly   audit",
      cadence: "weekly",
      purpose: "Run weekly continuity audit",
      status: "active",
      killCondition: "Retire when automated",
      lastReviewed: "2026-02-26T00:00:00.000Z",
    });

    const reviewed = await storage.reviewIdentityImprovementLoop("weekly   audit", {
      notes: "reviewed with original spacing",
      reviewedAt: "2026-02-27T00:00:00.000Z",
    });
    assert.ok(reviewed);
    assert.equal(reviewed?.id, "weekly audit");
    assert.equal(reviewed?.notes, "reviewed with original spacing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upsert matches legacy section titles after id normalization", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-loop-legacy-id-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.writeIdentityImprovementLoops(
      [
        "# Continuity Improvement Loops",
        "",
        "## weekly   audit",
        "cadence: weekly",
        "purpose: Run weekly continuity audit",
        "status: active",
        "killCondition: Retire when automated",
        "lastReviewed: 2026-02-26T00:00:00.000Z",
        "",
      ].join("\n"),
    );

    await storage.upsertIdentityImprovementLoop({
      id: "weekly audit",
      cadence: "weekly",
      purpose: "Run weekly continuity audit (updated)",
      status: "active",
      killCondition: "Retire when automated",
      lastReviewed: "2026-02-27T00:00:00.000Z",
    });

    const raw = await storage.readIdentityImprovementLoops();
    assert.ok(raw);
    assert.equal((raw?.match(/^## /gm) ?? []).length, 1);
    assert.match(raw ?? "", /^## weekly audit$/m);
    assert.match(raw ?? "", /Run weekly continuity audit \(updated\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("continuity_loop_review returns fail-open error on storage exceptions", async () => {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      workspaceDir: "/tmp/workspace",
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      continuityIncidentLoggingEnabled: true,
      identityContinuityEnabled: true,
    },
    qmd: { search: async () => [], searchGlobal: async () => [] },
    lastRecall: { get: () => null, getMostRecent: () => null },
    storage: {
      readIdentity: async () => null,
      readProfile: async () => null,
      readAllEntities: async () => [],
      readIdentityAnchor: async () => null,
      writeIdentityAnchor: async () => {},
      appendContinuityIncident: async () => null,
      closeContinuityIncident: async () => null,
      readContinuityIncidents: async () => [],
      upsertIdentityImprovementLoop: async () => {
        throw new Error("disk unavailable");
      },
      reviewIdentityImprovementLoop: async () => {
        throw new Error("disk unavailable");
      },
    },
    getStorageForNamespace: async () => ({
      upsertIdentityImprovementLoop: async () => {
        throw new Error("disk unavailable");
      },
      reviewIdentityImprovementLoop: async () => {
        throw new Error("disk unavailable");
      },
    }),
    summarizer: { runHourly: async () => {} },
    transcript: { listSessionKeys: async () => [] },
    sharedContext: null,
    compounding: null,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
    appendMemoryActionEvent: async () => true,
  };

  registerTools(api as any, orchestrator as any);
  const reviewTool = tools.get("continuity_loop_review");
  assert.ok(reviewTool);
  const result = await reviewTool.execute("tc-fail-open", { id: "weekly-audit" });
  assert.match(toolText(result), /Failed to review continuity loop/);
});
