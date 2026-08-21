import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  getAbstractionNodeStoreStatus,
  recordAbstractionNode,
  resolveAbstractionNodeStoreDir,
  validateAbstractionNode,
} from "../src/abstraction-nodes.js";
import { runAbstractionNodeStatusCliCommand } from "../src/cli.js";

test("abstraction-node config path resolves under memoryDir by default", () => {
  assert.equal(
    resolveAbstractionNodeStoreDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "abstraction-nodes"),
  );
  assert.equal(
    resolveAbstractionNodeStoreDir("/tmp/engram-memory", "  /tmp/custom-abstraction-nodes  "),
    "/tmp/custom-abstraction-nodes",
  );
});

test("validateAbstractionNode accepts the normalized abstraction-node contract", () => {
  const node = validateAbstractionNode({
    schemaVersion: 1,
    nodeId: "abstraction-1",
    recordedAt: "2026-03-07T21:00:00.000Z",
    sessionKey: "agent:main",
    kind: "workflow",
    abstractionLevel: "meso",
    title: "PR loop recovery pattern",
    summary: "Summarizes the stable PR-loop recovery workflow for review-driven Engram slices.",
    sourceMemoryIds: ["mem-1", "mem-2"],
    entityRefs: ["project:openclaw-engram"],
    tags: ["harmonic-retrieval", "workflow"],
    metadata: {
      source: "roadmap",
    },
  });

  assert.equal(node.kind, "workflow");
  assert.equal(node.abstractionLevel, "meso");
  assert.deepEqual(node.sourceMemoryIds, ["mem-1", "mem-2"]);
});

test("recordAbstractionNode persists nodes into dated abstraction-node storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-abstraction-node-record-"));
  const filePath = await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "abstraction-2",
      recordedAt: "2026-03-07T21:01:00.000Z",
      sessionKey: "agent:main",
      kind: "topic",
      abstractionLevel: "macro",
      title: "Agentic memory benchmark strategy",
      summary: "Captures the benchmark-first memory operating system direction.",
      tags: ["roadmap"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "abstraction-nodes", "nodes", "2026-03-07", "abstraction-2.json"),
  );
});

test("recordAbstractionNode rejects unsafe ids and malformed timestamps", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-abstraction-node-reject-"));

  await assert.rejects(
    () =>
      recordAbstractionNode({
        memoryDir,
        node: {
          schemaVersion: 1,
          nodeId: "../escape",
          recordedAt: "2026-03-07T21:01:00.000Z",
          sessionKey: "agent:main",
          kind: "topic",
          abstractionLevel: "macro",
          title: "invalid id",
          summary: "invalid id",
        },
      }),
    /nodeId must be a safe path segment/i,
  );

  await assert.rejects(
    () =>
      recordAbstractionNode({
        memoryDir,
        node: {
          schemaVersion: 1,
          nodeId: "abstraction-bad-date",
          recordedAt: "not-a-date",
          sessionKey: "agent:main",
          kind: "topic",
          abstractionLevel: "macro",
          title: "invalid recordedAt",
          summary: "invalid date",
        },
      }),
    /recordedAt must be an ISO timestamp/i,
  );
});

test("abstraction-node status reports valid and invalid nodes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-abstraction-node-status-"));
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "abstraction-3",
      recordedAt: "2026-03-07T21:02:00.000Z",
      sessionKey: "agent:main",
      kind: "constraint",
      abstractionLevel: "micro",
      title: "Wait for Cursor terminal state",
      summary: "Captures the repo rule that open PRs stay live until Cursor is terminal.",
      tags: ["pr-loop"],
    },
  });

  const invalidDir = path.join(memoryDir, "state", "abstraction-nodes", "nodes", "2026-03-07");
  await mkdir(invalidDir, { recursive: true });
  await writeFile(path.join(invalidDir, "invalid.json"), "{\"schemaVersion\":2}", "utf8");

  const status = await getAbstractionNodeStoreStatus({
    memoryDir,
    enabled: true,
    anchorsEnabled: false,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.anchorsEnabled, false);
  assert.equal(status.nodes.total, 2);
  assert.equal(status.nodes.valid, 1);
  assert.equal(status.nodes.invalid, 1);
  assert.equal(status.nodes.byKind.constraint, 1);
  assert.equal(status.nodes.byLevel.micro, 1);
  assert.equal(status.latestNode?.nodeId, "abstraction-3");
  assert.match(status.invalidNodes[0]?.path ?? "", /invalid\.json$/);
});

test("abstraction-node-status CLI command returns the store summary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-abstraction-node-cli-"));
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "abstraction-cli-1",
      recordedAt: "2026-03-07T21:03:00.000Z",
      sessionKey: "agent:main",
      kind: "project",
      abstractionLevel: "macro",
      title: "Engram memory OS",
      summary: "Project-level abstraction for the memory operating system roadmap.",
      entityRefs: ["project:openclaw-engram"],
    },
  });

  const status = await runAbstractionNodeStatusCliCommand({
    memoryDir,
    harmonicRetrievalEnabled: true,
    abstractionAnchorsEnabled: false,
    abstractionNodeStoreDir: undefined,
  });

  assert.equal(status.nodes.total, 1);
  assert.equal(status.latestNode?.nodeId, "abstraction-cli-1");
  assert.equal(status.nodes.byKind.project, 1);
});
