import assert from "node:assert/strict";
import test from "node:test";

import {
  RECALL_NAV_UNAVAILABLE_TAG,
  runRecallNavigate,
} from "./recall-navigate.js";

function capture(rest: string[]): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runRecallNavigate(rest, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

const chunkNode = JSON.stringify({
  id: "m1",
  disclosure: "chunk",
  payloads: { section: "full section body" },
  links: [
    { targetId: "m2", linkType: "supports", preview: "ally" },
    { targetId: "m3", linkType: "contradicts" },
  ],
});

test("expand --budget 0 prints tagged refusal and does not emit a node", () => {
  const result = capture(["expand", "--node", chunkNode, "--budget", "0"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [RECALL_NAV_UNAVAILABLE_TAG]);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.stdout.join("").includes("full section body"), false);
});

test("traverse --budget 0 prints tagged refusal", () => {
  const result = capture([
    "traverse",
    "--node",
    chunkNode,
    "--type",
    "supports",
    "--budget",
    "0",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [RECALL_NAV_UNAVAILABLE_TAG]);
  assert.equal(result.stdout.join("").includes("m2"), false);
});

test("unknown --type is rejected", () => {
  const result = capture([
    "traverse",
    "--node",
    chunkNode,
    "--type",
    "related",
    "--budget",
    "10",
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /unknown recall nav linkType/);
});

test("expand maps --node and --budget onto the next disclosure", () => {
  const result = capture(["expand", "--node", chunkNode, "--budget", "10"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout[0] ?? ""), {
    status: "ok",
    node: { id: "m1", disclosure: "section", text: "full section body" },
  });
});

test("traverse maps --type onto neighbors", () => {
  const result = capture([
    "traverse",
    "--node",
    chunkNode,
    "--type",
    "supports",
    "--budget",
    "10",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout[0] ?? ""), {
    status: "ok",
    neighbors: [{ id: "m2", linkType: "supports", preview: "ally" }],
  });
});
