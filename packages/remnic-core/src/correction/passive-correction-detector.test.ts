/**
 * passive-correction-detector.test.ts — fixture matrix for passive correction
 * detection (issue #1581 PR 1).
 *
 * Positive fixtures (≥12): direct update, retraction, stop-storing, tense/
 * morphology variants, correction embedded mid-paragraph, handle-referenced.
 * Anti-fixtures (≥8): quoting someone else's correction; correcting a third
 * party; hypothetical; self-correction within the same turn that resolves
 * itself; the agent being corrected about a tool output, not stored memory.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  detectPassiveCorrections,
  extractHandles,
  type DetectorTurn,
} from "./passive-correction-detector.js";

function user(content: string): DetectorTurn[] {
  return [{ role: "user", content }];
}

test("positive: direct update — actually we use PostgreSQL now", () => {
  const results = detectPassiveCorrections(user("actually we use PostgreSQL now, not MySQL"));
  assert.ok(results.length >= 1, `expected >=1 correction, got ${results.length}`);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: direct update — no, we renamed that service", () => {
  const results = detectPassiveCorrections(user("no, we renamed that service to auth-svc"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: retraction — we don't use Redis anymore", () => {
  const results = detectPassiveCorrections(user("we don't use Redis anymore"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "retract"));
});

test("positive: retraction — that's wrong", () => {
  const results = detectPassiveCorrections(user("that's wrong, I never said that"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "retract"));
});

test("positive: stop-storing — stop suggesting Vim", () => {
  const results = detectPassiveCorrections(user("stop suggesting Vim, I switched to Helix months ago"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "stop_storing"));
});

test("positive: stop-storing — don't bring up that project", () => {
  const results = detectPassiveCorrections(user("don't bring up that project anymore"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "stop_storing"));
});

test("positive: tense variant — we switched to (past)", () => {
  const results = detectPassiveCorrections(user("we switched to GitHub Actions for CI"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: tense variant — we're switching to (progressive)", () => {
  const results = detectPassiveCorrections(user("we're switching to pnpm from npm"));
  assert.ok(results.length >= 1, `expected >=1, got ${results.length}`);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: tense variant — we've migrated to (present perfect)", () => {
  const results = detectPassiveCorrections(user("we've migrated to PostgreSQL"));
  assert.ok(results.length >= 1, `expected >=1, got ${results.length}`);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: no longer phrasing", () => {
  const results = detectPassiveCorrections(user("I no longer work on that project"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: that's outdated phrasing", () => {
  const results = detectPassiveCorrections(user("that's outdated, the API changed last week"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: correction embedded mid-paragraph", () => {
  const results = detectPassiveCorrections(
    user("I was reviewing the architecture and noticed the docs say we use AWS. Actually, we moved to GCP last quarter, so those docs need updating."),
  );
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: deadline moved to Friday", () => {
  const results = detectPassiveCorrections(user("the deadline moved to Friday"));
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("positive: handle-referenced [m:4f2a] is wrong", () => {
  const results = detectPassiveCorrections(user("that's wrong, [m:4f2a] is incorrect — the real value is 42"));
  assert.ok(results.length >= 1);
  assert.ok(results[0].handles.includes("[m:4f2a]"));
});

test("positive: multiple handles extracted", () => {
  const results = detectPassiveCorrections(
    user("actually, [m:4f2a] and [m:8b1c] are both outdated"),
  );
  assert.ok(results.length >= 1, `expected >=1, got ${results.length}`);
  assert.ok(results[0].handles.includes("[m:4f2a]"));
  assert.ok(results[0].handles.includes("[m:8b1c]"));
});

// ── Anti-fixtures ──────────────────────────────────────────────────────────

test("anti-fixture: quoting someone else's correction", () => {
  const results = detectPassiveCorrections(
    user('Bob told me "that\'s wrong" about the deployment process'),
  );
  const retracts = results.filter((r) => r.polarity === "retract");
  assert.strictEqual(retracts.length, 0, `expected 0 retract corrections, got ${retracts.length}`);
});

test("anti-fixture: correcting a third party", () => {
  const results = detectPassiveCorrections(
    user("tell Bob he's wrong about the API design"),
  );
  assert.strictEqual(results.length, 0);
});

test("anti-fixture: hypothetical — if we ever moved to MySQL", () => {
  const results = detectPassiveCorrections(
    user("if we ever moved to MySQL, we'd need to rewrite the migrations"),
  );
  assert.strictEqual(results.length, 0);
});

test("anti-fixture: hypothetical — what if we switch", () => {
  const results = detectPassiveCorrections(
    user("what if we switch to a different framework?"),
  );
  assert.strictEqual(results.length, 0);
});

test("anti-fixture: self-resolving — actually wait, the original was right", () => {
  const results = detectPassiveCorrections(
    user("actually, wait, never mind, the original was right"),
  );
  assert.strictEqual(results.length, 0);
});

test("anti-fixture: self-resolving — scratch that", () => {
  const results = detectPassiveCorrections(
    user("actually we moved to... no, scratch that, we're still on the old system"),
  );
  assert.strictEqual(results.length, 0);
});

test("anti-fixture: tool output correction", () => {
  const results = detectPassiveCorrections(
    user("the output is wrong, the test results don't match"),
  );
  assert.strictEqual(results.length, 0);
});

test("anti-fixture: agent corrected about code, not stored memory", () => {
  const results = detectPassiveCorrections(
    user("your code has a bug in the error handler"),
  );
  assert.strictEqual(results.length, 0);
});

test("anti-fixture: suppose / hypothetical scenario", () => {
  const results = detectPassiveCorrections(
    user("suppose we changed the database — what would break?"),
  );
  assert.strictEqual(results.length, 0);
});

// ── Characterization ───────────────────────────────────────────────────────

test("characterization: assistant turns are not scanned", () => {
  const results = detectPassiveCorrections([
    { role: "assistant", content: "actually, we moved to PostgreSQL" },
  ]);
  assert.strictEqual(results.length, 0);
});

test("characterization: empty content produces no corrections", () => {
  const results = detectPassiveCorrections([{ role: "user", content: "" }]);
  assert.strictEqual(results.length, 0);
});

test("characterization: non-corrective user text produces no corrections", () => {
  const results = detectPassiveCorrections(
    user("Can you help me write a function to parse JSON?"),
  );
  assert.strictEqual(results.length, 0);
});

test("characterization: confidence is in [0, 1]", () => {
  const results = detectPassiveCorrections(user("we switched to Go"));
  for (const r of results) {
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
});

test("characterization: sourceExcerpt is populated", () => {
  const results = detectPassiveCorrections(user("we switched to Go"));
  for (const r of results) {
    assert.ok(r.sourceExcerpt.length > 0);
  }
});

// ── extractHandles ─────────────────────────────────────────────────────────

test("extractHandles: extracts [m:xxxx] handles", () => {
  assert.deepStrictEqual(extractHandles("see [m:4f2a] and [m:8b1c]"), ["[m:4f2a]", "[m:8b1c]"]);
});

test("extractHandles: returns empty for no handles", () => {
  assert.deepStrictEqual(extractHandles("no handles here"), []);
});

test("contraction does not suppress a correction phrase (review: apostrophe quote detection)", () => {
  // OLD isWithinQuotes treated the ASCII apostrophe as a quote opener. A single
  // contraction with no closing apostrophe ("We've switched to Postgres") left
  // the scanner in quoted mode and suppressed the correction — a false negative.
  // Only double quotes delimit quoted speech; apostrophes are contractions.
  const results = detectPassiveCorrections(user("We've switched to Postgres"));
  assert.ok(results.length > 0, "contraction-led correction must be detected");
  assert.ok(results.some((r) => r.polarity === "update"));
});

test("double-quoted correction is still suppressed (isWithinQuotes uses double quotes only)", () => {
  // After dropping single-quote handling, real double-quoted speech must STILL
  // be suppressed — only the delimiter set changed, not the suppression itself.
  const results = detectPassiveCorrections(
    user('Bob told me "that\'s wrong" about the deployment process'),
  );
  const retracts = results.filter((r) => r.polarity === "retract");
  assert.strictEqual(retracts.length, 0, "double-quoted speech must still be suppressed");
});

test("overlapping cues dedup: 'actually, we don't use Redis anymore' emits one correction (review)", () => {
  // Both the "actually" (update) and "don't use X anymore" (retract) patterns
  // match the same targetHint. Polarity-agnostic dedup keeps one correction.
  const results = detectPassiveCorrections(
    user("actually, we don't use Redis anymore for caching"),
  );
  const redisCorrections = results.filter((r) =>
    r.targetHint.toLowerCase().includes("redis"),
  );
  assert.ok(
    redisCorrections.length <= 1,
    `overlapping cues for same target must emit at most one correction, got ${redisCorrections.length}`,
  );
});
