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
  // Receiver forms: `api.`, `(api).`, `(api as X).`, `(<X>api).` — TypeScript
  // erases the casts, so all of them emit `api.registerX(` in dist.
  const receiver = String.raw`(?:\bapi|\(\s*api\s*\)|\(\s*api\s+as\s+[^)]+\)|\(\s*<[^>]+>\s*api\s*\))`;
  const pattern = new RegExp(String.raw`${receiver}\s*\??\.\s*(${LEGACY_ONLY.join("|")})\s*(?:\?\.)?\s*\(`);
  for (const file of FILES) {
    // Drop `//` line comments; the inspector strips comments too, and this
    // keeps prose mentioning the seams from tripping the guard.
    const source = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const match = pattern.exec(source);
    assert.equal(match, null, `${file}: '${match?.[0]}' would be flagged by ClawHub's unknown-registration-name check`);
  }
});
