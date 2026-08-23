import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prepareBench = "node ../../scripts/ensure-cli-bench-build-deps.mjs";

test("bench-ui prepares @remnic/bench for every direct entry command", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };

  for (const hook of ["predev", "pretest", "precheck-types", "prebuild"]) {
    assert.equal(pkg.scripts?.[hook], prepareBench, `${hook} must prepare @remnic/bench in a clean checkout`);
  }
  assert.match(pkg.scripts?.test ?? "", /--conditions=remnic-source/);
});
