import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import type { EngramTraceEvent } from "../src/types.js";

async function makeOrchestrator(prefix: string, overrides?: Record<string, unknown>): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    identityContinuityEnabled: true,
    continuityIncidentLoggingEnabled: true,
    identityInjectionMode: "recovery_only",
    identityMaxInjectChars: 1200,
    ...overrides,
  });
  return new Orchestrator(cfg);
}

test("recovery_only mode skips identity injection when prompt has no recovery intent", async () => {
  const orchestrator = await makeOrchestrator("engram-identity-skip-");
  await orchestrator.storage.writeIdentityAnchor("# Identity Continuity Anchor\n\n## Identity Traits\n\n- Calm\n");

  const events: EngramTraceEvent[] = [];
  const previous = (globalThis as any).__openclawEngramTrace;
  (globalThis as any).__openclawEngramTrace = (event: EngramTraceEvent) => events.push(event);

  try {
    const out = await (orchestrator as any).recallInternal("What did we decide for API retries?", "user:test:id-skip");
    assert.doesNotMatch(out, /Identity Continuity/);
  } finally {
    (globalThis as any).__openclawEngramTrace = previous;
  }

  const recallEvent = events.find((e) => e.kind === "recall_summary");
  assert.ok(recallEvent && recallEvent.kind === "recall_summary");
  assert.equal(recallEvent.identityInjectionMode, "none");
  assert.equal(recallEvent.identityInjectedChars, 0);
  assert.equal(recallEvent.identityInjectionTruncated, false);
});

test("recovery_only mode injects compact identity section for explicit recovery intent", async () => {
  const orchestrator = await makeOrchestrator("engram-identity-recovery-");
  await orchestrator.storage.writeIdentityAnchor(
    "# Identity Continuity Anchor\n\n## Identity Traits\n\n- Calm under pressure\n- Verifies before asserting\n",
  );
  await orchestrator.storage.writeIdentityImprovementLoops(
    "# Improvement Loops\n\n## Register\n\n- Keep retrieval evidence visible\n",
  );

  const out = await (orchestrator as any).recallInternal(
    "We had an identity continuity drift incident; recover the right anchor context",
    "user:test:id-recovery",
  );

  assert.match(out, /## Identity Continuity Signals/);
  assert.match(out, /incidents: 0 open/);
});

test("minimal recall mode downgrades full identity mode and enforces char cap with truncation telemetry", async () => {
  const orchestrator = await makeOrchestrator("engram-identity-cap-", {
    identityInjectionMode: "full",
    identityMaxInjectChars: 140,
  });

  const largeAnchor = [
    "# Identity Continuity Anchor",
    "",
    "## Identity Traits",
    "",
    "- " + "A".repeat(260),
    "",
    "## Continuity Notes",
    "",
    "- " + "B".repeat(260),
    "",
  ].join("\n");
  await orchestrator.storage.writeIdentityAnchor(largeAnchor);

  const events: EngramTraceEvent[] = [];
  const previous = (globalThis as any).__openclawEngramTrace;
  (globalThis as any).__openclawEngramTrace = (event: EngramTraceEvent) => events.push(event);

  try {
    const out = await (orchestrator as any).recallInternal("Reload gateway now", "user:test:id-cap");
    assert.match(out, /## Identity Continuity Signals/);
    assert.doesNotMatch(out, /## Identity Continuity\n/);
  } finally {
    (globalThis as any).__openclawEngramTrace = previous;
  }

  const recallEvent = events.find((e) => e.kind === "recall_summary");
  assert.ok(recallEvent && recallEvent.kind === "recall_summary");
  assert.equal(recallEvent.recallMode, "minimal");
  assert.equal(recallEvent.identityInjectionMode, "minimal");
  assert.equal(recallEvent.identityInjectionTruncated, true);
  assert.equal((recallEvent.identityInjectedChars ?? 0) <= 140, true);
});

test("identity injection never exceeds tiny non-zero caps", async () => {
  const orchestrator = await makeOrchestrator("engram-identity-tiny-cap-", {
    identityInjectionMode: "full",
    identityMaxInjectChars: 8,
  });
  await orchestrator.storage.writeIdentityAnchor(
    "# Identity Continuity Anchor\n\n## Identity Traits\n\n- " + "X".repeat(400) + "\n",
  );

  const events: EngramTraceEvent[] = [];
  const previous = (globalThis as any).__openclawEngramTrace;
  (globalThis as any).__openclawEngramTrace = (event: EngramTraceEvent) => events.push(event);

  try {
    await (orchestrator as any).recallInternal("Please recover continuity context", "user:test:id-tiny-cap");
  } finally {
    (globalThis as any).__openclawEngramTrace = previous;
  }

  const recallEvent = events.find((e) => e.kind === "recall_summary");
  assert.ok(recallEvent && recallEvent.kind === "recall_summary");
  assert.equal((recallEvent.identityInjectedChars ?? 0) <= 8, true);
  assert.equal(recallEvent.identityInjectionTruncated, true);
});
