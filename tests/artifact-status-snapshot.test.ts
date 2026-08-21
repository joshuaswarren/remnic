import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

function makeOrchestrator(tmpBase: string): Orchestrator {
  const cfg = parseConfig({
    memoryDir: path.join(tmpBase, "memory"),
    workspaceDir: path.join(tmpBase, "workspace"),
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    conversationIndexEnabled: false,
    sharedContextEnabled: false,
    compoundingEnabled: false,
    intentRoutingEnabled: false,
    verbatimArtifactsEnabled: false,
  });
  return new Orchestrator(cfg);
}

test("artifact source status snapshot caches only stable version reads", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "engram-status-snapshot-"));
  const orchestrator = makeOrchestrator(tmp);
  const cache = (orchestrator as any).artifactSourceStatusCache as WeakMap<object, unknown>;

  let stableVersion = 7;
  const stableStorage = {
    getMemoryStatusVersion: () => stableVersion,
    readAllMemories: async () => [
      { frontmatter: { id: "m-stable", status: "active" } },
    ],
  };

  const stable = await (orchestrator as any).resolveArtifactSourceStatuses(stableStorage, ["m-stable"]);
  assert.equal(stable.get("m-stable"), "active");
  assert.notEqual(cache.get(stableStorage), undefined);

  let churnVersion = 0;
  const churnStorage = {
    getMemoryStatusVersion: () => {
      churnVersion += 1;
      return churnVersion;
    },
    readAllMemories: async () => [
      { frontmatter: { id: "m-churn", status: "archived" } },
    ],
  };

  const churn = await (orchestrator as any).resolveArtifactSourceStatuses(churnStorage, ["m-churn"]);
  assert.equal(churn.get("m-churn"), "archived");
  assert.equal(cache.get(churnStorage), undefined);
});
