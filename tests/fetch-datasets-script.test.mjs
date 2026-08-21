import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = "scripts/bench/fetch-datasets.sh";

test("fetch-datasets prints target-derived paths as escaped shell literals", () => {
  const target = "tmp/$(touch SHOULD_NOT_RUN)";
  const result = spawnSync("bash", [scriptPath, "--target", target], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /tmp\/\$\(touch SHOULD_NOT_RUN\)\/longmemeval/);
  assert.match(result.stdout, /mkdir -p -- tmp\/\\\$\\\(touch\\ SHOULD_NOT_RUN\\\)\/longmemeval/);
  assert.match(result.stdout, /--local-dir tmp\/\\\$\\\(touch\\ SHOULD_NOT_RUN\\\)\/locomo/);
  assert.match(result.stdout, /--dataset tmp\/\\\$\\\(touch\\ SHOULD_NOT_RUN\\\)\/beam\/data/);
});

test("fetch-datasets rejects an empty target path", () => {
  const result = spawnSync("bash", [scriptPath, "--target="], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /non-empty directory path/);
});
