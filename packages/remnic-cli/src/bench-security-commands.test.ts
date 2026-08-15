import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseBenchSecurityArgs } from "./bench-security-commands.js";
import { resolveHomeDir } from "./path-utils.js";

test("injection-suite parser requires --seeds and defaults outside the checkout", () => {
  const parsed = parseBenchSecurityArgs(["injection-suite", "--seeds", "1", "--limit", "2"]);
  assert.ok(!("help" in parsed));
  if ("help" in parsed) return;
  assert.equal(parsed.seeds, 1);
  assert.equal(parsed.limit, 2);
  assert.equal(parsed.variantsPerFamily, 25);
  assert.equal(
    parsed.outputDir,
    path.join(resolveHomeDir(), ".remnic", "bench", "results", "h5-injection-suite"),
  );
});

test("injection-suite --run implies resume", () => {
  const parsed = parseBenchSecurityArgs(["injection-suite", "--seeds", "1", "--run", "/tmp/h5-run"]);
  assert.ok(!("help" in parsed));
  if ("help" in parsed) return;
  assert.equal(parsed.resume, true);
  assert.equal(parsed.outputDir, "/tmp/h5-run");
});

test("unknown security subcommand is rejected", () => {
  assert.throws(() => parseBenchSecurityArgs(["nope"]), /unknown bench security subcommand/);
});
