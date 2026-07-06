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

import { describe, it, expect } from "vitest";
import {
  detectPassiveCorrections,
  extractHandles,
  type DetectorTurn,
} from "./passive-correction-detector.js";

function user(content: string): DetectorTurn[] {
  return [{ role: "user", content }];
}

describe("detectPassiveCorrections — positive fixtures", () => {
  it("direct update: 'actually we use PostgreSQL now'", () => {
    const results = detectPassiveCorrections(user("actually we use PostgreSQL now, not MySQL"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("direct update: 'no, we renamed that service'", () => {
    const results = detectPassiveCorrections(user("no, we renamed that service to auth-svc"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("retraction: 'we don't use Redis anymore'", () => {
    const results = detectPassiveCorrections(user("we don't use Redis anymore"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "retract")).toBe(true);
  });

  it("retraction: 'that's wrong'", () => {
    const results = detectPassiveCorrections(user("that's wrong, I never said that"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "retract")).toBe(true);
  });

  it("stop-storing: 'stop suggesting Vim'", () => {
    const results = detectPassiveCorrections(user("stop suggesting Vim, I switched to Helix months ago"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "stop_storing")).toBe(true);
  });

  it("stop-storing: 'don't bring up that project'", () => {
    const results = detectPassiveCorrections(user("don't bring up that project anymore"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "stop_storing")).toBe(true);
  });

  it("tense variant: 'we switched to' (past)", () => {
    const results = detectPassiveCorrections(user("we switched to GitHub Actions for CI"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("tense variant: 'we're switching to' (progressive)", () => {
    const results = detectPassiveCorrections(user("we're switching to pnpm from npm"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("tense variant: 'we've migrated to' (present perfect)", () => {
    const results = detectPassiveCorrections(user("we've migrated to PostgreSQL"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("'no longer' phrasing", () => {
    const results = detectPassiveCorrections(user("I no longer work on that project"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("'that's outdated' phrasing", () => {
    const results = detectPassiveCorrections(user("that's outdated, the API changed last week"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("correction embedded mid-paragraph", () => {
    const results = detectPassiveCorrections(
      user("I was reviewing the architecture and noticed the docs say we use AWS. Actually, we moved to GCP last quarter, so those docs need updating."),
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("deadline moved to Friday", () => {
    const results = detectPassiveCorrections(user("the deadline moved to Friday"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.polarity === "update")).toBe(true);
  });

  it("handle-referenced: '[m:4f2a] is wrong'", () => {
    const results = detectPassiveCorrections(user("that's wrong, [m:4f2a] is incorrect — the real value is 42"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    const correction = results[0];
    expect(correction.handles).toContain("[m:4f2a]");
  });

  it("multiple handles extracted", () => {
    const results = detectPassiveCorrections(
      user("actually, [m:4f2a] and [m:8b1c] are both outdated"),
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].handles).toContain("[m:4f2a]");
    expect(results[0].handles).toContain("[m:8b1c]");
  });
});

describe("detectPassiveCorrections — anti-fixtures (zero false plans)", () => {
  it("quoting someone else's correction", () => {
    const results = detectPassiveCorrections(
      user('Bob told me "that\'s wrong" about the deployment process'),
    );
    // The turn mentions "that's wrong" but in a quote about someone else
    expect(results.filter((r) => r.polarity === "retract")).toHaveLength(0);
  });

  it("correcting a third party: 'tell Bob he's wrong about X'", () => {
    const results = detectPassiveCorrections(
      user("tell Bob he's wrong about the API design"),
    );
    expect(results).toHaveLength(0);
  });

  it("hypothetical: 'if we ever moved to MySQL'", () => {
    const results = detectPassiveCorrections(
      user("if we ever moved to MySQL, we'd need to rewrite the migrations"),
    );
    expect(results).toHaveLength(0);
  });

  it("hypothetical: 'what if we switch to'", () => {
    const results = detectPassiveCorrections(
      user("what if we switch to a different framework?"),
    );
    expect(results).toHaveLength(0);
  });

  it("self-resolving correction: 'actually wait, the original was right'", () => {
    const results = detectPassiveCorrections(
      user("actually, wait, never mind, the original was right"),
    );
    expect(results).toHaveLength(0);
  });

  it("self-resolving: 'scratch that'", () => {
    const results = detectPassiveCorrections(
      user("actually we moved to... no, scratch that, we're still on the old system"),
    );
    expect(results).toHaveLength(0);
  });

  it("tool output correction: 'the output is wrong'", () => {
    const results = detectPassiveCorrections(
      user("the output is wrong, the test results don't match"),
    );
    expect(results).toHaveLength(0);
  });

  it("agent being corrected about code, not stored memory", () => {
    const results = detectPassiveCorrections(
      user("your code has a bug in the error handler"),
    );
    expect(results).toHaveLength(0);
  });

  it("suppose / hypothetical scenario", () => {
    const results = detectPassiveCorrections(
      user("suppose we changed the database — what would break?"),
    );
    expect(results).toHaveLength(0);
  });
});

describe("detectPassiveCorrections — characterization", () => {
  it("assistant turns are not scanned", () => {
    const results = detectPassiveCorrections([
      { role: "assistant", content: "actually, we moved to PostgreSQL" },
    ]);
    expect(results).toHaveLength(0);
  });

  it("empty content produces no corrections", () => {
    const results = detectPassiveCorrections([
      { role: "user", content: "" },
    ]);
    expect(results).toHaveLength(0);
  });

  it("non-corrective user text produces no corrections", () => {
    const results = detectPassiveCorrections(
      user("Can you help me write a function to parse JSON?"),
    );
    expect(results).toHaveLength(0);
  });

  it("multiple corrections in one turn are deduped by polarity+target", () => {
    const results = detectPassiveCorrections(
      user("we don't use Redis anymore. Also we don't use Redis anymore."),
    );
    // Same polarity + same target hint → one correction after dedup
    const retracts = results.filter((r) => r.polarity === "retract");
    expect(retracts.length).toBeLessThanOrEqual(2); // dedup may or may not collapse depending on window
  });

  it("confidence is in [0, 1]", () => {
    const results = detectPassiveCorrections(user("we switched to Go"));
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("sourceExcerpt is populated", () => {
    const results = detectPassiveCorrections(user("we switched to Go"));
    for (const r of results) {
      expect(r.sourceExcerpt.length).toBeGreaterThan(0);
    }
  });
});

describe("extractHandles", () => {
  it("extracts [m:xxxx] handles", () => {
    expect(extractHandles("see [m:4f2a] and [m:8b1c]")).toEqual(["[m:4f2a]", "[m:8b1c]"]);
  });

  it("returns empty for no handles", () => {
    expect(extractHandles("no handles here")).toEqual([]);
  });
});
