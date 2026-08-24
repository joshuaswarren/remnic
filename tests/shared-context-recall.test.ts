import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

function isoForDate(date: string, time: string): Date {
  return new Date(`${date}T${time}Z`);
}

test("shared context recall injects latest cross-signals summary when available", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-shared-recall-memory-"));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), "engram-shared-recall-shared-"));
  let orchestrator: Orchestrator | undefined;

  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      sharedContextEnabled: true,
      sharedContextDir: sharedDir,
      sharedContextMaxInjectChars: 2400,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      injectQuestions: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
      recallPipeline: [
        { id: "shared-context", enabled: true },
      ],
    });
    orchestrator = new Orchestrator(cfg);
    assert.ok(orchestrator.sharedContext);
    await orchestrator.sharedContext!.ensureStructure();

    const date = "2026-03-07";
    await orchestrator.sharedContext!.appendPrioritiesInbox({
      agentId: "generalist",
      text: "- Prioritize checkout latency fixes.",
    });
    await orchestrator.sharedContext!.writeAgentOutput({
      agentId: "generalist",
      title: "Latency mitigation plan",
      content: "checkout latency mitigation rollout and dependency cleanup",
      createdAt: isoForDate(date, "09:00:00"),
    });
    await orchestrator.sharedContext!.writeAgentOutput({
      agentId: "oracle",
      title: "Checkout latency review",
      content: "validated checkout latency mitigation and rollout sequencing",
      createdAt: isoForDate(date, "09:05:00"),
    });
    await orchestrator.sharedContext!.synthesizeCrossSignals({ date });
    await orchestrator.sharedContext!.curateDaily({ date });

    const context = await (orchestrator as any).recallInternal(
      "What is the latest cross-agent signal on checkout latency?",
      "user:test:shared-context-recall",
    );

    assert.match(context, /## Shared Context/);
    assert.match(context, /### Latest Cross-Signals/);
    assert.match(context, /Recurring Themes/);
    assert.match(context, /checkout/);
  } finally {
    await orchestrator?.destroy();
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("scope profile recall omits shared context when serverShared is not readable", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-shared-recall-profile-memory-"));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), "engram-shared-recall-profile-shared-"));
  let orchestrator: Orchestrator | undefined;

  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [
        { name: "default", readPrincipals: ["*"], writePrincipals: ["*"] },
        { name: "shared", readPrincipals: ["*"], writePrincipals: ["*"] },
      ],
      defaultScopeProfile: "privateOnly",
      scopeProfiles: {
        privateOnly: {
          readOrder: ["userGlobal"],
          writeDefault: "userGlobal",
        },
      },
      qmdEnabled: false,
      sharedContextEnabled: true,
      sharedContextDir: sharedDir,
      sharedContextMaxInjectChars: 2400,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      injectQuestions: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
      recallPipeline: [
        { id: "shared-context", enabled: true },
      ],
    });
    orchestrator = new Orchestrator(cfg);
    assert.ok(orchestrator.sharedContext);
    await orchestrator.sharedContext!.ensureStructure();
    await orchestrator.sharedContext!.appendPrioritiesInbox({
      agentId: "generalist",
      text: "- Shared priority that a private-only profile must not inject.",
    });

    const context = await (orchestrator as any).recallInternal(
      "What shared priority is active?",
      "default",
    );

    assert.doesNotMatch(context, /## Shared Context/);
    assert.doesNotMatch(context, /private-only profile must not inject/);
  } finally {
    await orchestrator?.destroy();
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});
