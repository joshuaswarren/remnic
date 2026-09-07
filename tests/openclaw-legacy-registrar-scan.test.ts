import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ClawHub's Plugin Inspector statically scans the packed dist for
// `api.register*(` and flags any registrar the target OpenClaw lacks as a
// publish-blocking breakage. These seams exist only on OpenClaw 1.x
// (removed in 2026.8.x) and are feature-detected at runtime, so they must be
// invoked through a local binding, never as `api.registerX(`.
const LEGACY_ONLY = ["registerMemoryPromptSection", "registerMemoryRuntime", "registerMemoryFlushPlan"];
const FILES = [
  "src/index.ts",
  "packages/plugin-openclaw/src/delegate-runtime.ts",
  "packages/plugin-openclaw/src/delegate-capability.ts",
];

test("OpenClaw 1.x-only registrars are never called as api.registerX( (ClawHub inspector scan)", () => {
  const pattern = new RegExp(String.raw`\bapi\s*\)?\s*\.\s*(${LEGACY_ONLY.join("|")})\s*(?:\?\.)?\s*\(`);
  for (const file of FILES) {
    const source = readFileSync(file, "utf8");
    const match = pattern.exec(source);
    assert.equal(match, null, `${file}: '${match?.[0]}' would be flagged by ClawHub's unknown-registration-name check`);
  }
});
