/**
 * Tests for the --since flag guard in cmdBriefing.
 *
 * Verifies that a valueless --since flag is detected as an input error
 * rather than silently falling back to the default window.
 *
 * All fixtures are synthetic — no real user data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Dynamically import the CLI helpers from the standalone helper file so that
// this test does not trigger @remnic/core/dist resolution (which may not be
// built in CI when running root-level tsx --test).
async function loadCliHelpers() {
  const mod = (await import(
    path.join(ROOT, "packages/remnic-cli/src/cli-args.ts")
  )) as { hasFlag: (args: string[], flag: string) => boolean; resolveFlag: (args: string[], flag: string) => string | undefined };
  return { hasFlag: mod.hasFlag, resolveFlag: mod.resolveFlag };
}

// ──────────────────────────────────────────────────────────────────────────
// hasFlag — presence detection independent of trailing value
// ──────────────────────────────────────────────────────────────────────────

test("hasFlag returns true when flag is present with a trailing value", async () => {
  const { hasFlag } = await loadCliHelpers();
  assert.equal(hasFlag(["--since", "yesterday"], "--since"), true);
  assert.equal(hasFlag(["briefing", "--since", "24h"], "--since"), true);
});

test("hasFlag returns true when flag is present without a trailing value", async () => {
  const { hasFlag } = await loadCliHelpers();
  // --since appears as the last element — no value follows
  assert.equal(hasFlag(["briefing", "--since"], "--since"), true);
});

test("hasFlag returns false when flag is absent", async () => {
  const { hasFlag } = await loadCliHelpers();
  assert.equal(hasFlag(["briefing", "--format", "json"], "--since"), false);
  assert.equal(hasFlag([], "--since"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveFlag — value retrieval
// ──────────────────────────────────────────────────────────────────────────

test("resolveFlag returns the trailing value when present", async () => {
  const { resolveFlag } = await loadCliHelpers();
  assert.equal(resolveFlag(["--since", "yesterday"], "--since"), "yesterday");
  assert.equal(resolveFlag(["briefing", "--since", "48h"], "--since"), "48h");
});

test("resolveFlag returns undefined when flag is absent", async () => {
  const { resolveFlag } = await loadCliHelpers();
  assert.equal(resolveFlag(["briefing"], "--since"), undefined);
  assert.equal(resolveFlag([], "--since"), undefined);
});

test("resolveFlag returns undefined when flag is the last token (no trailing value)", async () => {
  const { resolveFlag } = await loadCliHelpers();
  // This is the bug scenario: --since with no value should NOT silently
  // resolve to undefined and fall through to the default window.
  assert.equal(resolveFlag(["briefing", "--since"], "--since"), undefined);
});

// ──────────────────────────────────────────────────────────────────────────
// Guard logic — combined hasFlag + resolveFlag
// ──────────────────────────────────────────────────────────────────────────

test("guard condition triggers when --since is present but has no value", async () => {
  const { hasFlag, resolveFlag } = await loadCliHelpers();
  // Simulates: hasFlag(rest, "--since") && resolveFlag(rest, "--since") === undefined
  const args = ["briefing", "--since"];
  const shouldError = hasFlag(args, "--since") && resolveFlag(args, "--since") === undefined;
  assert.equal(
    shouldError,
    true,
    "--since without a value must be treated as an input error, not silently use the default window",
  );
});

test("guard condition does not trigger when --since is absent", async () => {
  const { hasFlag, resolveFlag } = await loadCliHelpers();
  const args = ["briefing"];
  const shouldError = hasFlag(args, "--since") && resolveFlag(args, "--since") === undefined;
  assert.equal(shouldError, false, "absent --since must not trigger the error guard");
});

test("guard condition does not trigger when --since has a valid value", async () => {
  const { hasFlag, resolveFlag } = await loadCliHelpers();
  const args = ["briefing", "--since", "yesterday"];
  const shouldError = hasFlag(args, "--since") && resolveFlag(args, "--since") === undefined;
  assert.equal(shouldError, false, "--since with a value must not trigger the error guard");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding B (#396) — --format guard mirrors --since guard behaviour
// ──────────────────────────────────────────────────────────────────────────

test("guard condition triggers when --format is present but has no value", async () => {
  const { hasFlag, resolveFlag } = await loadCliHelpers();
  const args = ["briefing", "--format"];
  const shouldError = hasFlag(args, "--format") && resolveFlag(args, "--format") === undefined;
  assert.equal(
    shouldError,
    true,
    "--format without a value must be treated as an input error, not silently fall back to default",
  );
});

test("guard condition does not trigger when --format is absent", async () => {
  const { hasFlag, resolveFlag } = await loadCliHelpers();
  const args = ["briefing"];
  const shouldError = hasFlag(args, "--format") && resolveFlag(args, "--format") === undefined;
  assert.equal(shouldError, false, "absent --format must not trigger the error guard");
});

test("guard condition does not trigger when --format has a valid value", async () => {
  const { hasFlag, resolveFlag } = await loadCliHelpers();
  const args = ["briefing", "--format", "json"];
  const shouldError = hasFlag(args, "--format") && resolveFlag(args, "--format") === undefined;
  assert.equal(shouldError, false, "--format with a value must not trigger the error guard");
});

test("guard condition does not trigger when --format has value 'markdown'", async () => {
  const { hasFlag, resolveFlag } = await loadCliHelpers();
  const args = ["briefing", "--format", "markdown"];
  const shouldError = hasFlag(args, "--format") && resolveFlag(args, "--format") === undefined;
  assert.equal(shouldError, false, "--format markdown must not trigger the error guard");
});
