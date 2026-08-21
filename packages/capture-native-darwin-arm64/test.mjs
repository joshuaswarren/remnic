import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";

import { helperBinaryPath } from "./index.js";

assert.equal(typeof helperBinaryPath, "string");
assert.ok(helperBinaryPath.length > 0, "helperBinaryPath must be non-empty");
assert.ok(
  helperBinaryPath.endsWith("bin/remnic-capture-helper"),
  "helperBinaryPath must point at the packaged binary",
);

try {
  await access(helperBinaryPath, constants.X_OK);
  console.log(`ok: ${helperBinaryPath} present and executable`);
} catch (err) {
  // The real binary is produced by macOS CI (swift build -c release) and staged
  // into bin/. Only its ABSENCE (ENOENT) on Linux / pre-build checkouts is a
  // benign skip; a present-but-not-executable binary (EACCES) is a real failure.
  if (err?.code !== "ENOENT") throw err;
  console.log(`note: CI-built binary absent at ${helperBinaryPath}; skipping -x check`);
}
