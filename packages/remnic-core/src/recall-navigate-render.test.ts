import assert from "node:assert/strict";
import test from "node:test";

import { renderNavigateResult } from "./recall-navigate-render.js";

test("expand empty children prints (empty)", () => {
  assert.equal(
    renderNavigateResult({
      action: "expand",
      nodeId: "m1",
      children: [],
      stopReason: "empty",
    }),
    [
      "# Navigate",
      "",
      "- action: expand",
      "- nodeId: m1",
      "- children: (empty)",
      "- stop: empty",
      "",
    ].join("\n"),
  );
});

test("traverse path lists node ids in order", () => {
  assert.equal(
    renderNavigateResult({
      action: "traverse",
      nodeId: "m1",
      path: ["a-mem", "z-mem"],
      stopReason: "ok",
    }),
    [
      "# Navigate",
      "",
      "- action: traverse",
      "- nodeId: m1",
      "- path: a-mem, z-mem",
      "- stop: ok",
      "",
    ].join("\n"),
  );
});

test("error prints the stop reason", () => {
  assert.equal(
    renderNavigateResult({
      action: "expand",
      nodeId: "missing",
      stopReason: "node_not_found",
    }),
    [
      "# Navigate",
      "",
      "- action: expand",
      "- nodeId: missing",
      "- children: (empty)",
      "- stop: node_not_found",
      "",
    ].join("\n"),
  );
});
