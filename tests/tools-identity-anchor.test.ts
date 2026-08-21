import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";

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

function buildHarness(options?: { identityContinuityEnabled?: boolean; initialAnchor?: string | null }) {
  const tools = new Map<string, RegisteredTool>();
  let anchor = options?.initialAnchor ?? null;
  const writes: string[] = [];

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
    storage: {
      readIdentity: async () => null,
      readProfile: async () => null,
      readAllEntities: async () => [],
      readIdentityAnchor: async () => anchor,
      writeIdentityAnchor: async (content: string) => {
        anchor = content;
        writes.push(content);
      },
    },
    getStorageForNamespace: async () => ({
      readIdentityAnchor: async () => anchor,
      writeIdentityAnchor: async (content: string) => {
        anchor = content;
        writes.push(content);
      },
    }),
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
  return { tools, writes, getAnchor: () => anchor };
}

test("identity anchor tools are gated when identity continuity is disabled", async () => {
  const { tools } = buildHarness({ identityContinuityEnabled: false });
  const getTool = tools.get("identity_anchor_get");
  const updateTool = tools.get("identity_anchor_update");
  assert.ok(getTool);
  assert.ok(updateTool);

  const getResult = await getTool.execute("tc1", {});
  const updateResult = await updateTool.execute("tc2", { identityTraits: "Reliable" });

  assert.match(toolText(getResult), /disabled/i);
  assert.match(toolText(updateResult), /disabled/i);
});

test("identity_anchor_get returns anchor content when present", async () => {
  const { tools } = buildHarness({
    identityContinuityEnabled: true,
    initialAnchor: "# Identity Continuity Anchor\n\n## Identity Traits\n\n- Consistent\n",
  });
  const getTool = tools.get("identity_anchor_get");
  assert.ok(getTool);

  const result = await getTool.execute("tc3", {});
  assert.match(toolText(result), /Identity Traits/);
  assert.match(toolText(result), /Consistent/);
});

test("identity_anchor_update creates and merges sections conservatively", async () => {
  const initial = [
    "# Identity Continuity Anchor",
    "",
    "## Identity Traits",
    "",
    "- Calm under pressure",
    "",
    "## Continuity Notes",
    "",
    "- Preserve operator context",
    "",
  ].join("\n");

  const { tools, writes, getAnchor } = buildHarness({
    identityContinuityEnabled: true,
    initialAnchor: initial,
  });
  const updateTool = tools.get("identity_anchor_update");
  assert.ok(updateTool);

  const result = await updateTool.execute("tc4", {
    identityTraits: "- Calm under pressure",
    communicationPreferences: "- Keep responses concise",
    operatingPrinciples: "- Prefer reversible changes",
    continuityNotes: "- Include verification evidence",
  });

  assert.match(toolText(result), /Identity anchor updated/);
  assert.equal(writes.length, 1);

  const merged = getAnchor() ?? "";
  assert.match(merged, /## Identity Traits/);
  assert.match(merged, /Calm under pressure/);
  assert.match(merged, /## Communication Preferences/);
  assert.match(merged, /Keep responses concise/);
  assert.match(merged, /## Operating Principles/);
  assert.match(merged, /Prefer reversible changes/);
  assert.match(merged, /## Continuity Notes/);
  assert.match(merged, /Preserve operator context/);
  assert.match(merged, /Include verification evidence/);
});

test("identity_anchor_update requires at least one section update", async () => {
  const { tools, writes } = buildHarness({ identityContinuityEnabled: true });
  const updateTool = tools.get("identity_anchor_update");
  assert.ok(updateTool);

  const result = await updateTool.execute("tc5", {});
  assert.match(toolText(result), /No updates provided/);
  assert.equal(writes.length, 0);
});

test("identity_anchor_update does not retain empty sentinel across staged updates", async () => {
  const { tools, getAnchor } = buildHarness({ identityContinuityEnabled: true });
  const updateTool = tools.get("identity_anchor_update");
  assert.ok(updateTool);

  await updateTool.execute("tc6", {
    identityTraits: "- Calm",
  });
  await updateTool.execute("tc7", {
    communicationPreferences: "- Keep it concise",
  });

  const anchor = getAnchor() ?? "";
  assert.doesNotMatch(anchor, /- \(empty\)/);
  assert.match(anchor, /## Communication Preferences/);
  assert.match(anchor, /Keep it concise/);
});

test("identity_anchor_update removes legacy empty sentinel from untouched sections", async () => {
  const initial = [
    "# Identity Continuity Anchor",
    "",
    "## Identity Traits",
    "",
    "- (empty)",
    "",
    "## Communication Preferences",
    "",
    "- (empty)",
    "",
  ].join("\n");

  const { tools, getAnchor } = buildHarness({
    identityContinuityEnabled: true,
    initialAnchor: initial,
  });
  const updateTool = tools.get("identity_anchor_update");
  assert.ok(updateTool);

  await updateTool.execute("tc8", {
    operatingPrinciples: "- Verify constraints",
  });

  const anchor = getAnchor() ?? "";
  assert.doesNotMatch(anchor, /- \(empty\)/);
  assert.match(anchor, /## Operating Principles/);
  assert.match(anchor, /Verify constraints/);
});
