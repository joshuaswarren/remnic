import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";
import type { ContinuityIncidentRecord } from "../src/types.ts";

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
  continuityIncidentLoggingEnabled?: boolean;
}) {
  const tools = new Map<string, RegisteredTool>();
  const incidents = new Map<string, ContinuityIncidentRecord>();
  let counter = 0;

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
    appendContinuityIncident: async (input: { symptom: string; triggerWindow?: string; suspectedCause?: string }) => {
      counter += 1;
      const id = `incident-${counter}`;
      const now = new Date(2026, 1, counter).toISOString();
      const record: ContinuityIncidentRecord = {
        id,
        state: "open",
        openedAt: now,
        updatedAt: now,
        triggerWindow: input.triggerWindow,
        symptom: input.symptom,
        suspectedCause: input.suspectedCause,
        filePath: `/tmp/${id}.md`,
      };
      incidents.set(id, record);
      return record;
    },
    closeContinuityIncident: async (
      id: string,
      closure: { fixApplied: string; verificationResult: string; preventiveRule?: string },
    ) => {
      const existing = incidents.get(id);
      if (!existing) return null;
      const closed: ContinuityIncidentRecord = {
        ...existing,
        state: "closed",
        updatedAt: new Date(2026, 1, 28).toISOString(),
        closedAt: new Date(2026, 1, 28).toISOString(),
        fixApplied: closure.fixApplied,
        verificationResult: closure.verificationResult,
        preventiveRule: closure.preventiveRule,
      };
      incidents.set(id, closed);
      return closed;
    },
    readContinuityIncidents: async (limit: number, state: "open" | "closed" | "all" = "all") =>
      [...incidents.values()]
        .filter((incident) => state === "all" || incident.state === state)
        .slice(0, Math.max(0, Math.floor(limit))),
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
      identityContinuityEnabled: options?.identityContinuityEnabled === true,
      continuityIncidentLoggingEnabled: options?.continuityIncidentLoggingEnabled === true,
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
  return { tools, incidents };
}

test("continuity incident tools are gated when identity continuity is disabled", async () => {
  const { tools } = buildHarness({
    identityContinuityEnabled: false,
    continuityIncidentLoggingEnabled: true,
  });
  const openTool = tools.get("continuity_incident_open");
  assert.ok(openTool);
  const result = await openTool.execute("tc1", { symptom: "missing memory" });
  assert.match(toolText(result), /disabled/i);
});

test("continuity_incident_open creates incident and continuity_incident_list returns it", async () => {
  const { tools } = buildHarness({
    identityContinuityEnabled: true,
    continuityIncidentLoggingEnabled: true,
  });
  const openTool = tools.get("continuity_incident_open");
  const listTool = tools.get("continuity_incident_list");
  assert.ok(openTool);
  assert.ok(listTool);

  const openResult = await openTool.execute("tc2", {
    symptom: "identity context missing",
    suspectedCause: "budget truncation",
  });
  assert.match(toolText(openResult), /opened/i);
  assert.match(toolText(openResult), /incident-1/);

  const listResult = await listTool.execute("tc3", { state: "open", limit: 10 });
  assert.match(toolText(listResult), /Continuity Incidents/);
  assert.match(toolText(listResult), /incident-1/);
  assert.match(toolText(listResult), /identity context missing/);
});

test("continuity_incident_close validates required fields and closes incident", async () => {
  const { tools } = buildHarness({
    identityContinuityEnabled: true,
    continuityIncidentLoggingEnabled: true,
  });
  const openTool = tools.get("continuity_incident_open");
  const closeTool = tools.get("continuity_incident_close");
  const listTool = tools.get("continuity_incident_list");
  assert.ok(openTool);
  assert.ok(closeTool);
  assert.ok(listTool);

  await openTool.execute("tc4", { symptom: "bad continuity state" });

  const missingFields = await closeTool.execute("tc5", { id: "incident-1", fixApplied: "patched" });
  assert.match(toolText(missingFields), /verificationResult/);

  const closeResult = await closeTool.execute("tc6", {
    id: "incident-1",
    fixApplied: "patched update path",
    verificationResult: "anchor now injected",
    preventiveRule: "keep regression tests",
  });
  assert.match(toolText(closeResult), /closed/i);
  assert.match(toolText(closeResult), /anchor now injected/);

  const closedList = await listTool.execute("tc7", { state: "closed", limit: 10 });
  assert.match(toolText(closedList), /incident-1/);
  assert.match(toolText(closedList), /closed/);
});

test("continuity_incident_list applies limit after state filtering", async () => {
  const { tools } = buildHarness({
    identityContinuityEnabled: true,
    continuityIncidentLoggingEnabled: true,
  });
  const openTool = tools.get("continuity_incident_open");
  const closeTool = tools.get("continuity_incident_close");
  const listTool = tools.get("continuity_incident_list");
  assert.ok(openTool);
  assert.ok(closeTool);
  assert.ok(listTool);

  await openTool.execute("tc8", { symptom: "old closed incident" });
  await closeTool.execute("tc9", {
    id: "incident-1",
    fixApplied: "fixed",
    verificationResult: "verified",
  });
  await openTool.execute("tc10", { symptom: "new open incident" });

  const closedOnly = await listTool.execute("tc11", { state: "closed", limit: 1 });
  const text = toolText(closedOnly);
  assert.match(text, /incident-1/);
  assert.doesNotMatch(text, /incident-2/);
});
