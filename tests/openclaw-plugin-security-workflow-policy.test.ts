import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/openclaw-plugin-security.yml", "utf8");

test("OpenClaw plugin security workflow runs scanner from trusted source checkout", () => {
  assert.doesNotMatch(workflow, /pnpm\s+run\s+scan:openclaw-plugin/);

  const trustedCheckoutCount = (workflow.match(/name: Checkout trusted scanner source/g) ?? []).length;
  assert.equal(trustedCheckoutCount, 2);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/
  );
  assert.match(workflow, /path: trusted-scanner-source/);
  assert.match(workflow, /sparse-checkout:[\s\S]*scripts\/openclaw-plugin-security-scan\.mjs/);

  const trustedScannerCommand =
    /node "\$GITHUB_WORKSPACE\/trusted-scanner-source\/scripts\/openclaw-plugin-security-scan\.mjs" "\$SCANNED_PACKAGE_DIR"/g;
  assert.equal((workflow.match(trustedScannerCommand) ?? []).length, 2);
});
