import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/gitleaks.yml", "utf8");

test("Gitleaks workflow verifies downloaded scanner before extraction", () => {
  assert.match(
    workflow,
    /EXPECTED_SHA256="9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c"/,
  );
  assert.match(workflow, /sha256sum -c -/);

  const checksumIndex = workflow.indexOf("sha256sum -c -");
  const extractIndex = workflow.indexOf("tar -xzf gitleaks.tar.gz");
  const installIndex = workflow.indexOf("sudo install -m 0755 gitleaks");

  assert.ok(checksumIndex > -1, "checksum verification is missing");
  assert.ok(extractIndex > -1, "archive extraction is missing");
  assert.ok(installIndex > -1, "binary install is missing");
  assert.ok(checksumIndex < extractIndex, "checksum must run before extraction");
  assert.ok(checksumIndex < installIndex, "checksum must run before install");
});
