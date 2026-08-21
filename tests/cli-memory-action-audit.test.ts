import test from "node:test";
import assert from "node:assert/strict";
import { runMemoryActionAuditCliCommand } from "../src/cli.js";
import type { MemoryActionEvent } from "../src/types.js";

function buildEvent(overrides: Partial<MemoryActionEvent>): MemoryActionEvent {
  return {
    timestamp: "2026-02-27T00:00:00.000Z",
    action: "store_note",
    outcome: "applied",
    namespace: "default",
    ...overrides,
  };
}

test("runMemoryActionAuditCliCommand aggregates namespace-aware action policy outcomes", async () => {
  const storageByNamespace = new Map<string, MemoryActionEvent[]>([
    [
      "default",
      [
        buildEvent({ action: "store_note", outcome: "applied", policyDecision: "allow", namespace: "default" }),
        buildEvent({ action: "summarize_node", outcome: "skipped", policyDecision: "defer", namespace: "default" }),
      ],
    ],
    [
      "shared",
      [
        buildEvent({ action: "discard", outcome: "skipped", policyDecision: "deny", namespace: "shared" }),
      ],
    ],
    ["team-alpha", []],
  ]);

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacesEnabled: true,
      namespacePolicies: [{ name: "team-alpha" }],
    },
    async getStorage(namespace?: string) {
      return {
        async readMemoryActionEvents(limit?: number) {
          const events = storageByNamespace.get(namespace ?? "default") ?? [];
          const capped = Math.max(0, Math.floor(limit ?? events.length));
          return events.slice(0, capped);
        },
      };
    },
  };

  const report = await runMemoryActionAuditCliCommand(orchestrator, { limit: 10 });

  assert.equal(report.limit, 10);
  assert.equal(report.totals.eventCount, 3);
  assert.equal(report.totals.actions.store_note, 1);
  assert.equal(report.totals.actions.summarize_node, 1);
  assert.equal(report.totals.actions.discard, 1);
  assert.equal(report.totals.policyDecisions.allow, 1);
  assert.equal(report.totals.policyDecisions.defer, 1);
  assert.equal(report.totals.policyDecisions.deny, 1);

  const namespaces = report.namespaces.map((item) => item.namespace).sort();
  assert.deepEqual(namespaces, ["default", "shared", "team-alpha"]);
});

test("runMemoryActionAuditCliCommand supports namespace filter and zero-limit semantics", async () => {
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacesEnabled: true,
      namespacePolicies: [{ name: "team-alpha" }],
    },
    async getStorage(namespace?: string) {
      return {
        async readMemoryActionEvents(limit?: number) {
          const all = [
            buildEvent({ action: "store_episode", outcome: "applied", policyDecision: "allow", namespace }),
          ];
          const capped = Math.max(0, Math.floor(limit ?? all.length));
          return all.slice(0, capped);
        },
      };
    },
  };

  const report = await runMemoryActionAuditCliCommand(orchestrator, {
    namespace: "team-alpha",
    limit: 0,
  });

  assert.equal(report.namespaces.length, 1);
  assert.equal(report.namespaces[0]?.namespace, "team-alpha");
  assert.equal(report.namespaces[0]?.eventCount, 0);
  assert.equal(report.totals.eventCount, 0);
});
