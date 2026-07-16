import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "./diagnose-locomo-retrieval-trace-delta.js";

test("expands tilde paths for both inputs and the private output", () => {
  assert.deepEqual(parseArgs(["~/baseline.json", "~/real.json", "--out", "~/delta.json"]), {
    baselinePath: path.join(homedir(), "baseline.json"),
    realPath: path.join(homedir(), "real.json"),
    out: path.join(homedir(), "delta.json"),
  });
});

test("does not expand unsupported named-user prefixes", () => {
  assert.deepEqual(parseArgs(["~someone/baseline.json", "real.json"]), {
    baselinePath: "~someone/baseline.json",
    realPath: "real.json",
  });
});
