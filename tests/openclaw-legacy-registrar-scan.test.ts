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

// ClawHub's publish gate fails any inspector-fixture registrar missing from
// the target OpenClaw. `registerMemoryPromptSection` was removed in OpenClaw
// 2.0 (2026.8.1), so listing it in plugin-inspector.config.json expected
// registrations breaks every plugin-openclaw publish.
const REMOVED_IN_OPENCLAW_2 = ["registerMemoryPromptSection"];

test("inspector expected registrations list no registrar removed in OpenClaw 2.0", () => {
  const file = "packages/plugin-openclaw/plugin-inspector.config.json";
  const config = JSON.parse(readFileSync(file, "utf8")) as {
    plugin?: { expect?: { registrations?: string[] } };
  };
  const names = config.plugin?.expect?.registrations ?? [];
  const blocked = REMOVED_IN_OPENCLAW_2.filter((name) => names.includes(name));
  assert.deepEqual(
    blocked,
    [],
    `${file}: ${blocked.join(", ")} was removed in OpenClaw 2.0; listing it fails ClawHub's unknown-registration-name gate`,
  );
});
