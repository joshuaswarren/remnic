import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

type HelperWorkflow = {
  jobs: { publish: { steps: Array<{ id?: string; run?: string }> } };
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// SAFETY: the checked-in workflow owns the publish step contract.
const helper = parse(readFileSync(resolve(repoRoot, ".github/workflows/capture-native-helper.yml"), "utf8")) as HelperWorkflow;

test("native helper dispatch admits stable tags and refuses invalid refs", (t) => {
  const validation = helper.jobs.publish.steps.find((step) => step.id === "ref_check");
  assert.ok(validation?.run);
  const directory = mkdtempSync(resolve(tmpdir(), "native-ref-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = resolve(directory, "output");
  for (const [ref, admitted] of [
    ["refs/tags/v9.69.96", true],
    ["refs/tags/v9.69.96-rc.1", false],
    ["refs/tags/v9.69.96+build.5", false],
    ["refs/tags/v9.69.96-rc.1+build.5", false],
    ["refs/tags/v9.69", false],
    ["refs/tags/v9", false],
    ["refs/tags/9.69.96", false],
    ["refs/heads/main", false],
  ] as const) {
    const result = spawnSync("bash", ["-c", validation.run], {
      env: { ...process.env, EVENT_NAME: "workflow_dispatch", DISPATCH_REF: ref, GITHUB_OUTPUT: output },
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, admitted ? 0 : 1, ref);
    assert.equal(readFileSync(output, "utf8"), `is_release_tag=${admitted}\n`, ref);
    rmSync(output, { force: true });
  }
});
