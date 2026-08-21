import test from "node:test";
import assert from "node:assert/strict";

import { scanSignals } from "./signal.js";

test("scanSignals skips invalid custom patterns without throwing", () => {
  const result = scanSignals("please always remember the deployment window", [
    "[",
    "deployment",
  ]);

  assert.equal(result.level, "high");
  assert.ok(result.patterns.some((pattern) => pattern === "custom:deployment"));
});
