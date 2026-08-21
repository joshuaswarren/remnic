import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  getCueAnchorStoreStatus,
  recordCueAnchor,
  resolveCueAnchorStoreDir,
  validateCueAnchor,
} from "../src/cue-anchors.js";
import { runCueAnchorStatusCliCommand } from "../src/cli.js";

test("cue-anchor config path resolves under abstraction-node storage by default", () => {
  assert.equal(
    resolveCueAnchorStoreDir("/tmp/engram-memory/state/abstraction-nodes"),
    path.join("/tmp/engram-memory/state/abstraction-nodes", "anchors"),
  );
  assert.equal(
    resolveCueAnchorStoreDir("/tmp/engram-memory/state/abstraction-nodes", "  /tmp/custom-cue-anchors  "),
    "/tmp/custom-cue-anchors",
  );
});

test("validateCueAnchor accepts the normalized cue-anchor contract", () => {
  const anchor = validateCueAnchor({
    schemaVersion: 1,
    anchorId: "project-openclaw-engram",
    anchorType: "entity",
    anchorValue: "project:openclaw-engram",
    normalizedCue: "project openclaw engram",
    recordedAt: "2026-03-07T23:10:00.000Z",
    sessionKey: "agent:main",
    nodeRefs: ["abstraction-1", "abstraction-2"],
    tags: ["harmonic-retrieval", "project"],
    metadata: {
      source: "roadmap",
    },
  });

  assert.equal(anchor.anchorType, "entity");
  assert.equal(anchor.anchorValue, "project:openclaw-engram");
  assert.deepEqual(anchor.nodeRefs, ["abstraction-1", "abstraction-2"]);
});

test("recordCueAnchor persists anchors into type-partitioned cue-anchor storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cue-anchor-record-"));
  const filePath = await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "tool-benchmark-status",
      anchorType: "tool",
      anchorValue: "benchmark-status",
      normalizedCue: "benchmark status",
      recordedAt: "2026-03-07T23:11:00.000Z",
      sessionKey: "agent:main",
      nodeRefs: ["abstraction-2"],
    },
  });

  assert.equal(
    filePath,
    path.join(
      memoryDir,
      "state",
      "abstraction-nodes",
      "anchors",
      "tool",
      "tool-benchmark-status.json",
    ),
  );
});

test("recordCueAnchor rejects unsafe ids and empty node refs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cue-anchor-reject-"));

  await assert.rejects(
    () =>
      recordCueAnchor({
        memoryDir,
        anchor: {
          schemaVersion: 1,
          anchorId: "../escape",
          anchorType: "entity",
          anchorValue: "project:openclaw-engram",
          normalizedCue: "project openclaw engram",
          recordedAt: "2026-03-07T23:12:00.000Z",
          sessionKey: "agent:main",
          nodeRefs: ["abstraction-1"],
        },
      }),
    /anchorId must be a safe path segment/i,
  );

  await assert.rejects(
    () =>
      recordCueAnchor({
        memoryDir,
        anchor: {
          schemaVersion: 1,
          anchorId: "empty-node-refs",
          anchorType: "constraint",
          anchorValue: "wait for cursor terminal state",
          normalizedCue: "wait for cursor terminal state",
          recordedAt: "2026-03-07T23:12:00.000Z",
          sessionKey: "agent:main",
          nodeRefs: [],
        },
      }),
    /nodeRefs must contain at least one node reference/i,
  );
});

test("cue-anchor status reports valid and invalid anchors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cue-anchor-status-"));
  await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "date-2026-03-07",
      anchorType: "date",
      anchorValue: "2026-03-07",
      normalizedCue: "2026 03 07",
      recordedAt: "2026-03-07T23:13:00.000Z",
      sessionKey: "agent:main",
      nodeRefs: ["abstraction-3", "abstraction-4"],
      tags: ["timeline"],
    },
  });

  const invalidDir = path.join(
    memoryDir,
    "state",
    "abstraction-nodes",
    "anchors",
    "entity",
  );
  await mkdir(invalidDir, { recursive: true });
  await writeFile(path.join(invalidDir, "invalid.json"), "{\"schemaVersion\":2}", "utf8");

  const status = await getCueAnchorStoreStatus({
    memoryDir,
    abstractionNodeStoreDir: undefined,
    enabled: true,
    anchorsEnabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.anchorsEnabled, true);
  assert.equal(status.anchors.total, 2);
  assert.equal(status.anchors.valid, 1);
  assert.equal(status.anchors.invalid, 1);
  assert.equal(status.anchors.byType.date, 1);
  assert.equal(status.anchors.totalNodeRefs, 2);
  assert.equal(status.latestAnchor?.anchorId, "date-2026-03-07");
  assert.match(status.invalidAnchors[0]?.path ?? "", /invalid\.json$/);
});

test("cue-anchor-status CLI command returns the cue-anchor summary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cue-anchor-cli-"));
  await recordCueAnchor({
    memoryDir,
    anchor: {
      schemaVersion: 1,
      anchorId: "constraint-terminal-cursor",
      anchorType: "constraint",
      anchorValue: "wait for cursor terminal state",
      normalizedCue: "wait for cursor terminal state",
      recordedAt: "2026-03-07T23:14:00.000Z",
      sessionKey: "agent:main",
      nodeRefs: ["abstraction-cli-1"],
    },
  });

  const status = await runCueAnchorStatusCliCommand({
    memoryDir,
    harmonicRetrievalEnabled: true,
    abstractionAnchorsEnabled: true,
    abstractionNodeStoreDir: undefined,
  });

  assert.equal(status.anchors.total, 1);
  assert.equal(status.latestAnchor?.anchorId, "constraint-terminal-cursor");
  assert.equal(status.anchors.byType.constraint, 1);
});
