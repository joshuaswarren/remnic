import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ContentHashIndex, StorageManager } from "./storage.js";
import {
  DEFAULT_CITATION_FORMAT,
  attachCitation,
  deriveSessionId,
  formatCitation,
  hasCitation,
  hasCitationForTemplate,
  parseAllCitations,
  parseCitation,
  stripCitation,
  stripCitationForTemplate,
} from "./source-attribution.js";

test("formatCitation emits the default template with provided fields", () => {
  const out = formatCitation({
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.equal(
    out,
    "[Source: agent=planner, session=main, ts=2026-04-10T14:25:07Z]",
  );
});

test("formatCitation falls back to 'unknown' for missing fields", () => {
  const out = formatCitation({});
  assert.equal(out, "[Source: agent=unknown, session=unknown, ts=unknown]");
});

test("formatCitation supports custom templates with all placeholders", () => {
  const template = "[src:{agent}/{session}@{date}]";
  const out = formatCitation(
    {
      agent: "scout",
      session: "agent:scout:alpha",
      ts: "2026-04-10T14:25:07Z",
    },
    template,
  );
  // session placeholder uses the full colon-delimited session key.
  assert.equal(out, "[src:scout/agent:scout:alpha@2026-04-10]");
});

test("deriveSessionId returns the trailing component of a colon-delimited key", () => {
  assert.equal(deriveSessionId("agent:planner:main"), "main");
  assert.equal(deriveSessionId("single"), "single");
  assert.equal(deriveSessionId(undefined), undefined);
  assert.equal(deriveSessionId(""), undefined);
});

test("attachCitation appends a marker when none is present", () => {
  const text = "The foo service uses Redis for rate limiting.";
  const out = attachCitation(text, {
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.ok(out.startsWith(text));
  assert.ok(
    out.includes("[Source: agent=planner, session=main, ts=2026-04-10T14:25:07Z]"),
  );
});

test("attachCitation is a no-op when the text already carries a citation", () => {
  const text =
    "Already tagged. [Source: agent=foo, session=bar, ts=2026-01-01T00:00:00Z]";
  const out = attachCitation(text, {
    agent: "other",
    session: "other:session",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.equal(out, text);
});

test("attachCitation preserves trailing newlines for markdown rendering", () => {
  const text = "Fact body.\n";
  const out = attachCitation(text, {
    agent: "a",
    session: "s:1",
    ts: "2026-04-10T00:00:00Z",
  });
  assert.ok(out.endsWith("\n"));
  assert.ok(out.includes("[Source: agent=a"));
});

test("parseCitation extracts agent, session, and timestamp", () => {
  const text =
    "Body of the fact. [Source: agent=planner, session=abc123, ts=2026-04-10T14:25:07Z]";
  const parsed = parseCitation(text);
  assert.ok(parsed);
  assert.equal(parsed!.agent, "planner");
  assert.equal(parsed!.session, "abc123");
  assert.equal(parsed!.ts, "2026-04-10T14:25:07Z");
  assert.ok(parsed!.raw.startsWith("[Source:"));
});

test("parseCitation returns null when no citation is present", () => {
  assert.equal(parseCitation("no citation here"), null);
  assert.equal(parseCitation(""), null);
});

test("parseCitation tolerates malformed fields without throwing", () => {
  const parsed = parseCitation("[Source: agent=bob, broken-field, ts=]");
  assert.ok(parsed);
  assert.equal(parsed!.agent, "bob");
  assert.equal(parsed!.session, undefined);
  assert.equal(parsed!.ts, undefined);
});

test("parseAllCitations returns every citation in order", () => {
  const text =
    "First [Source: agent=a, session=s1, ts=2026-04-10T00:00:00Z] and " +
    "second [Source: agent=b, session=s2, ts=2026-04-11T00:00:00Z]";
  const all = parseAllCitations(text);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.agent, "a");
  assert.equal(all[1]!.agent, "b");
});

test("hasCitation returns true only when a marker is present", () => {
  assert.equal(hasCitation("nothing tagged"), false);
  assert.equal(hasCitation(""), false);
  assert.equal(
    hasCitation("Tagged. [Source: agent=x, session=y, ts=z]"),
    true,
  );
});

test("stripCitation removes inline markers cleanly", () => {
  const text =
    "Body of the fact. [Source: agent=planner, session=abc123, ts=2026-04-10T14:25:07Z]";
  assert.equal(stripCitation(text), "Body of the fact.");
});

test("attach → strip is idempotent for well-formed fact text", () => {
  const original = "The foo service uses Redis for rate limiting.";
  const attached = attachCitation(original, {
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.ok(hasCitation(attached));
  assert.equal(stripCitation(attached), original);
});

test("stripCitation leaves plain text untouched", () => {
  assert.equal(stripCitation("no markers"), "no markers");
  assert.equal(stripCitation(""), "");
});

test("DEFAULT_CITATION_FORMAT matches issue #369 proposal", () => {
  assert.equal(
    DEFAULT_CITATION_FORMAT,
    "[Source: agent={agent}, session={sessionId}, ts={ts}]",
  );
});

test("parseConfig disables inline source attribution by default", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.inlineSourceAttributionEnabled, false);
  assert.equal(
    cfg.inlineSourceAttributionFormat,
    "[Source: agent={agent}, session={sessionId}, ts={ts}]",
  );
});

test("parseConfig honors explicit inline source attribution overrides", () => {
  const cfg = parseConfig({
    inlineSourceAttributionEnabled: true,
    inlineSourceAttributionFormat: "[src:{agent}/{sessionId}@{date}]",
  });
  assert.equal(cfg.inlineSourceAttributionEnabled, true);
  assert.equal(
    cfg.inlineSourceAttributionFormat,
    "[src:{agent}/{sessionId}@{date}]",
  );
});

test("parseConfig falls back to default format when override is empty", () => {
  const cfg = parseConfig({
    inlineSourceAttributionEnabled: true,
    inlineSourceAttributionFormat: "   ",
  });
  assert.equal(
    cfg.inlineSourceAttributionFormat,
    "[Source: agent={agent}, session={sessionId}, ts={ts}]",
  );
});

// ── Finding 1 regression: custom citation template dedup detection ────────────

test("hasCitationForTemplate detects default [Source:...] marker regardless of template", () => {
  const text = "Fact body. [Source: agent=planner, session=main, ts=2026-04-10T00:00:00Z]";
  // Default template
  assert.equal(hasCitationForTemplate(text, DEFAULT_CITATION_FORMAT), true);
  // Custom template — should still detect the default marker as a fallback
  assert.equal(hasCitationForTemplate(text, "[src:{agent}/{sessionId}@{date}]"), true);
});

test("hasCitationForTemplate detects a custom-format citation", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const text = "Fact body. [src:planner/main@2026-04-10]";
  assert.equal(hasCitationForTemplate(text, customTemplate), true);
  // Should not falsely match plain text
  assert.equal(hasCitationForTemplate("Fact body.", customTemplate), false);
});

test("hasCitationForTemplate returns false for empty / non-string inputs", () => {
  assert.equal(hasCitationForTemplate("", DEFAULT_CITATION_FORMAT), false);
  assert.equal(hasCitationForTemplate("no citation here", DEFAULT_CITATION_FORMAT), false);
});

test("attachCitation with custom template is a no-op when text already carries that custom marker (Finding 1)", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const ctx = { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T14:25:07Z" };
  // Pre-tag the fact with a custom citation
  const priorCitation = "[src:other/alpha@2026-01-01]";
  const text = `Existing fact. ${priorCitation}`;
  const result = attachCitation(text, ctx, customTemplate);
  // Must be unchanged — no second citation appended
  assert.equal(result, text);
  // Confirm only one citation marker is present
  const markerCount = (result.match(/\[src:/g) ?? []).length;
  assert.equal(markerCount, 1);
});

test("attachCitation with custom template tags untagged text exactly once (Finding 1 positive path)", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const ctx = { agent: "scout", session: "agent:scout:beta", ts: "2026-04-11T00:00:00Z" };
  const text = "The service uses Redis for caching.";
  const result = attachCitation(text, ctx, customTemplate);
  // Should end with one custom citation
  assert.ok(result.includes("[src:scout/beta@2026-04-11]"), `expected custom citation in: ${result}`);
  // Applying again must be idempotent
  const again = attachCitation(result, ctx, customTemplate);
  assert.equal(again, result);
});

// ── Finding 2 regression: placeholder-bounded template matcher ─────────────────

test("hasCitationForTemplate with placeholder-bounded template requires bracket-wrapped match", () => {
  // Template starts AND ends with a placeholder — prefix and suffix are both "".
  // The new strategy requires the match to be wrapped in a bracket/paren/angle
  // pair, so ordinary prose that merely contains the middle literal must NOT
  // be classified as a citation.
  const template = "{source}: {content}";
  // Bracket-wrapped form that a real citation would use: matches.
  assert.equal(hasCitationForTemplate("Fact body. [planner: some-note]", template), true);
  // Prose containing a ": " separator must NOT match — no bracket wrapping.
  assert.equal(hasCitationForTemplate("planner: The service uses Redis", template), false);
  // Random text without the middle literal must NOT match.
  assert.equal(hasCitationForTemplate("random text without separator", template), false);
  assert.equal(hasCitationForTemplate("no separator here at all", template), false);
});

test("hasCitationForTemplate with fully placeholder-only template returns false (cannot anchor)", () => {
  // Template has no literal segments at all — templateMatcher returns null.
  // All-placeholder templates cannot be reliably detected without sentinel
  // markers; hasCitationForTemplate returns false for this shape.
  const template = "{source}{content}";
  assert.equal(hasCitationForTemplate("anything goes here", template), false);
  // Even a text that literally contains the raw template syntax is not
  // recognised — the function deliberately refuses to fall back to a naive
  // text.includes check, because that check would never match a rendered
  // citation body anyway (placeholders have been substituted).
  assert.equal(hasCitationForTemplate("{source}{content}", template), false);
});

test("hasCitationForTemplate preserves normal behaviour for well-formed templates (Finding 2 non-regression)", () => {
  // Well-formed template with non-empty prefix and suffix — existing behaviour.
  const template = "Source: {source} — Content: {content}";
  assert.equal(hasCitationForTemplate("Source: planner — Content: some fact", template), true);
  assert.equal(hasCitationForTemplate("random unrelated text", template), false);
});

test("hasCitationForTemplate: placeholder-bounded template does not falsely tag plain text (Finding 2 negative)", () => {
  const template = "{source}: {content}";
  // Plain text with no colon-space separator must return false.
  assert.equal(hasCitationForTemplate("just a plain statement", template), false);
});

test("hasCitationForTemplate: {agent}:{sessionId} template rejects embedded URL colons", () => {
  // Regression for Cursor High: the previous implementation anchored on the
  // first non-empty middle literal alone — for this template that's just ":",
  // which false-positives on any text containing a colon (URLs, paths, any
  // other prose). The stricter reconstruction requires identifier-shaped
  // tokens on both sides of the literal, bounded by clean delimiters, which
  // in particular rejects the `http://host:80` shape.
  const template = "{agent}:{sessionId}";
  assert.equal(
    hasCitationForTemplate("URL uses http://host:80", template),
    false,
    "a colon inside a URL must not be classified as a citation",
  );
  assert.equal(
    hasCitationForTemplate("plain statement without a colon", template),
    false,
  );
});

test("hasCitationForTemplate: {agent}:{sessionId} template accepts a real citation-shaped token", () => {
  // Positive case — a bracket-wrapped agent:sessionId token looks like an
  // inline citation and should be detected so attachCitation stays idempotent.
  const template = "{agent}:{sessionId}";
  assert.equal(
    hasCitationForTemplate("[backend-agent:abc123] some text", template),
    true,
  );
});

// ── Finding 1 dedup regression: same raw content, different timestamps ─────────

// ── Finding A regression: $ special patterns in replacement strings ───────────

test("formatCitation: agent value containing $& is not expanded by replace", () => {
  // $& is the JS replacement special pattern that inserts the matched substring.
  // With the replacer-function form it must be treated as a literal string.
  const out = formatCitation(
    { agent: "agent-with-$&-literal", session: "sess:abc", ts: "2026-04-11T00:00:00Z" },
  );
  assert.ok(
    out.includes("agent-with-$&-literal"),
    `expected literal $& in output, got: ${out}`,
  );
  // Verify the placeholder was not expanded to the matched regex text either.
  assert.ok(!out.includes("{agent}"), "placeholder must be replaced");
});

test("formatCitation: session value containing $` (backtick) is not corrupted", () => {
  // $` inserts the string before the match. Must be literal here.
  const session = "sess:$`backtick";
  const out = formatCitation(
    { agent: "planner", session, ts: "2026-04-11T00:00:00Z" },
  );
  // The full session key doesn't appear in the default template (sessionId is used),
  // so test via a custom template that includes {session}.
  const tmpl = "[S: agent={agent}, session={session}, ts={ts}]";
  const out2 = formatCitation({ agent: "planner", session, ts: "2026-04-11T00:00:00Z" }, tmpl);
  assert.ok(
    out2.includes("sess:$`backtick"),
    `expected literal session with $\` in output, got: ${out2}`,
  );
});

test("formatCitation: agent value $1$2 stays literal (not resolved to empty groups)", () => {
  // $1 / $2 are capturing-group back-references in replace(). They must not be
  // resolved when the replacer-function form is used (the regex has no groups anyway,
  // but with a string replacement they still produce empty strings on some engines).
  const out = formatCitation(
    { agent: "$1$2", session: "sess:main", ts: "2026-04-11T00:00:00Z" },
  );
  assert.ok(
    out.includes("$1$2"),
    `expected literal $1$2 in output, got: ${out}`,
  );
});

test("attachCitation is idempotent across different timestamps for the same raw content (Finding 1 dedup)", () => {
  // Simulates the dedup scenario: the same raw fact content is presented twice
  // to applyInlineCitation with different "now" values (different timestamps).
  // The CITED content varies each call, but the RAW content is the same.
  // This test verifies that hasCitationForTemplate correctly sees already-cited
  // text as tagged regardless of the exact timestamp in the marker.
  const rawContent = "The database uses PostgreSQL for persistent storage.";
  const template = DEFAULT_CITATION_FORMAT;

  const ctx1 = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:00:00Z" };
  const ctx2 = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:05:00Z" };

  const cited1 = attachCitation(rawContent, ctx1, template);
  // cited1 includes ts=2026-04-11T10:00:00Z
  assert.ok(cited1.includes("2026-04-11T10:00:00Z"), "first citation should include first timestamp");

  // A second attachCitation call on already-cited text (different ts) must be a no-op.
  const cited2 = attachCitation(cited1, ctx2, template);
  assert.equal(cited2, cited1, "second attachCitation must not append a second marker");

  // hasCitationForTemplate must return true for cited1 regardless of template/ts.
  assert.equal(hasCitationForTemplate(cited1, template), true);

  // The raw content itself should NOT be seen as already-cited.
  assert.equal(hasCitationForTemplate(rawContent, template), false);
});

// ── Finding B regression: shared-store dedup indexes raw content hash ─────────

test("ContentHashIndex.add indexes raw content; has() returns true for the same raw string", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-hash-idx-"));
  try {
    const idx = new ContentHashIndex(dir);
    await idx.load();
    const rawContent = "The database uses PostgreSQL for persistent storage.";
    idx.add(rawContent);
    assert.ok(idx.has(rawContent), "has() must return true for a string just added");
    // Simulate what would happen if we indexed the cited variant instead
    const citedContent = `${rawContent} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;
    assert.ok(!idx.has(citedContent), "has() must return false for the cited variant when only raw was added");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory with contentHashSource registers raw-content hash (Finding B)", async () => {
  // This test verifies that writing with contentHashSource=rawContent persists the
  // RAW content hash to the on-disk fact-hashes.txt index. A new StorageManager
  // instance (simulating a subsequent extraction session) should find the raw fact
  // via hasFactContentHash(rawContent) because the persisted hash index carries the
  // raw hash — not the cited hash. Without the fix, only the cited hash would be
  // persisted, and cross-session dedup of the same raw fact would fail.
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-shared-dedup-"));
  try {
    const rawContent = "The service caches reads with Redis for low-latency access.";
    const citedContent = `${rawContent} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;

    // Session 1: write the cited variant, register the RAW content hash for dedup.
    {
      const storage1 = new StorageManager(dir);
      await storage1.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });
      // Same-session: raw content hash must be present in the in-memory index.
      const foundByRaw = await storage1.hasFactContentHash(rawContent);
      assert.ok(foundByRaw, "hasFactContentHash(rawContent) must be true in the same session");
    }

    // Session 2: new StorageManager instance simulating a subsequent extraction run.
    // The fact-hashes.txt on disk should contain the raw content hash so that
    // hasFactContentHash(rawContent) returns true without seeing the raw fact body.
    {
      const storage2 = new StorageManager(dir);
      // A different timestamp would produce a different citedContent, so the
      // cross-session dedup must rely on the persisted rawContent hash.
      const foundByRawCrossSession = await storage2.hasFactContentHash(rawContent);
      assert.ok(
        foundByRawCrossSession,
        "hasFactContentHash(rawContent) must be true in a new session via persisted hash index",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory contentHashSource prevents duplicate promotion cross-session (Finding B dedup regression)", async () => {
  // Simulates two extraction sessions with the same raw fact but different timestamps.
  // Session 1 promotes the fact (cited1). Session 2 (new StorageManager) checks
  // hasFactContentHash(rawFact) — it must return true so the promotion is skipped.
  //
  // Without the fix: session 1 would persist the citedContent hash. Session 2
  // backfills from disk (adds citedContent hash), but hasFactContentHash(rawFact)
  // would only match if rawFact hash was also persisted — which it was not.
  // With the fix: session 1 persists the rawFact hash via contentHashSource.
  // Session 2 loads it from fact-hashes.txt and hasFactContentHash(rawFact) is true.
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-dedup-regression-"));
  try {
    const rawFact = "PostgreSQL is used for durable persistent storage of user profiles.";
    const cited1 = `${rawFact} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;

    // Session 1: first promotion — write cited body but index raw hash.
    {
      const storage1 = new StorageManager(dir);
      await storage1.writeMemory("fact", cited1, {
        source: "extraction-shared-promotion",
        tags: ["shared-promotion"],
        contentHashSource: rawFact,
      });
      // Confirm same-session dedup gate works.
      assert.ok(
        await storage1.hasFactContentHash(rawFact),
        "Session 1: hasFactContentHash(rawFact) must be true after first promotion",
      );
    }

    // Session 2: new StorageManager (fresh process, no in-memory state).
    // The on-disk fact-hashes.txt must carry rawFact hash so dedup blocks re-promotion.
    {
      const storage2 = new StorageManager(dir);
      // Second extraction produces cited2 with a later timestamp. Before writing,
      // the caller checks hasFactContentHash(rawFact) — must return true to skip.
      const wouldDeduplicate = await storage2.hasFactContentHash(rawFact);
      assert.ok(
        wouldDeduplicate,
        "Session 2: hasFactContentHash(rawFact) must return true to prevent re-promotion",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── PR #401 review findings: stricter template matcher + single-pass format ───

test("hasCitationForTemplate: '{agent} {sessionId}' rejects plain two-word prose", () => {
  // Regression: the previous reconstruction used `[\w.-]+ [\w.-]+` with soft
  // whitespace/start anchors, so `"The service responded"` matched — two
  // English words separated by a space. The bracket-delimited anchor in the
  // new strategy rejects prose unambiguously.
  const template = "{agent} {sessionId}";
  assert.equal(
    hasCitationForTemplate("The service responded", template),
    false,
    "two-word English prose must never be classified as a citation",
  );
});

test("hasCitationForTemplate: '{agent} {sessionId}' accepts a bracket-wrapped token", () => {
  // Positive case — the exact shape that attachCitation would emit when the
  // fact body already ends with a bracketed citation token.
  const template = "{agent} {sessionId}";
  assert.equal(
    hasCitationForTemplate("[backend-agent session-abc123]", template),
    true,
    "bracket-wrapped identifier pair must be recognised as a citation",
  );
});

test("hasCitationForTemplate: '{agent}{sessionId}' all-placeholder template returns false", () => {
  // Regression for PR #401: the previous implementation fell through to
  // text.includes(template), which compared the substituted citation against
  // the raw placeholder syntax — always false — causing attachCitation to
  // append a fresh citation on every reprocessing pass. The new behaviour
  // explicitly returns false for all-placeholder templates and documents the
  // limitation so callers cannot rely on (unreliable) dedup for this shape.
  const template = "{agent}{sessionId}";
  assert.equal(
    hasCitationForTemplate("alphaomega", template),
    false,
    "no sentinel / no literal — must return false",
  );
});

test("formatCitation: substituted values containing placeholder syntax are not re-interpreted", () => {
  // Regression for PR #401 (low-severity): the previous implementation chained
  // `.replace(/\{agent\}/g, ...)`, `.replace(/\{ts\}/g, ...)` etc. If the agent
  // value was literally `"{ts}"`, step 1 substituted `{agent}` with the string
  // `{ts}`, and the later {ts} pass replaced THAT into the actual timestamp —
  // producing the timestamp in the agent slot.
  //
  // The single-pass implementation scans the template once and each matched
  // `{name}` token is replaced by exactly one lookup, so substituted values
  // are terminal and cannot re-trigger replacement.
  const out = formatCitation(
    { agent: "{ts}", sessionId: "s1", ts: "T" },
    "{agent}:{sessionId}:{ts}",
  );
  assert.equal(
    out,
    "{ts}:s1:T",
    "agent slot must carry the literal string '{ts}', not the timestamp",
  );
});

test("formatCitation: single-pass substitution handles nested placeholder syntax in session value", () => {
  // Complementary case for session / sessionId values that look like
  // placeholders. Every slot must be filled from its own lookup, never from a
  // prior substitution.
  const out = formatCitation(
    { agent: "a1", session: "sess:{date}", ts: "2026-04-11T00:00:00Z" },
    "[S: agent={agent}, session={session}, date={date}]",
  );
  // The `{date}` inside the session value must remain literal; the `{date}`
  // placeholder at the end of the template must resolve to 2026-04-11.
  assert.equal(
    out,
    "[S: agent=a1, session=sess:{date}, date=2026-04-11]",
  );
});

// ── PR #401 P2 finding (PRRT_kwDORJXyws56UCB6): separator-only placeholder templates ──

test("formatCitation: '{agent}:{sessionId}' produces compact token without brackets", () => {
  // Baseline: confirm that formatCitation never adds brackets for this template.
  // The P2 finding was that hasCitationForTemplate could not detect the
  // already-emitted 'planner:main' token, causing attachCitation to re-append.
  const out = formatCitation(
    { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T14:25:07Z" },
    "{agent}:{sessionId}",
  );
  assert.equal(out, "planner:main");
});

test("hasCitationForTemplate: '{agent}:{sessionId}' detects standalone compact token", () => {
  // Core fix: the pattern must match 'planner:main' when it appears at the
  // start of the string (no preceding context).
  assert.equal(
    hasCitationForTemplate("planner:main", "{agent}:{sessionId}"),
    true,
    "compact citation at start of string must be detected",
  );
});

test("hasCitationForTemplate: '{agent}:{sessionId}' detects token at end of string", () => {
  // Finding 1 fix: compact tokens are only accepted when they appear at the
  // very end of the string (or inside brackets). Since `attachCitation` always
  // appends the citation at the trimmed tail of the fact body, a real emitted
  // citation will always satisfy this condition.
  assert.equal(
    hasCitationForTemplate("Fact body. planner:main", "{agent}:{sessionId}"),
    true,
    "compact citation at end of string must be detected",
  );
  // A compact token embedded in the MIDDLE of prose is no longer accepted.
  // This is the deliberate tightening that prevents false positives on prose
  // like "long-term" or "host:port" embedded in a fact body.
  assert.equal(
    hasCitationForTemplate("The service planner:main is done.", "{agent}:{sessionId}"),
    false,
    "compact citation surrounded by prose must NOT be classified as a citation (Finding 1 fix)",
  );
});

test("hasCitationForTemplate: '{agent}:{sessionId}' rejects URL-embedded colons", () => {
  // Regression guard: 'host:80' inside 'http://host:80' must NOT match.
  // Trace: trying 'host:80' — the char before 'h' is '/' (non-whitespace,
  // non-bracket), so both (?<=[\[\(\<]) and (?<!\S) fail. Trying 'http:...'
  // — after 'http:' the next chars are '//' which are not [\w.-]+, so the
  // second id-token group fails. Neither attempt matches.
  assert.equal(
    hasCitationForTemplate("URL uses http://host:80", "{agent}:{sessionId}"),
    false,
    "colon inside a URL must not be classified as a citation",
  );
});

test("hasCitationForTemplate: '{agent}:{sessionId}' rejects plain text without colon", () => {
  assert.equal(
    hasCitationForTemplate("Plain text with no colon", "{agent}:{sessionId}"),
    false,
  );
});

test("hasCitationForTemplate: '{agent}:{sessionId}' accepts bracket-wrapped token", () => {
  // A bracket-wrapped form also counts as a valid citation marker.
  assert.equal(
    hasCitationForTemplate("[backend-agent:abc123] some text", "{agent}:{sessionId}"),
    true,
    "bracket-wrapped compact token must be recognised",
  );
});

test("attachCitation idempotency: '{agent}:{sessionId}' template appends citation exactly once", () => {
  // Regression for the P2 finding: without the fix, each reprocess pass would
  // call hasCitationForTemplate → false → append another citation, producing
  // 'planner:main planner:main planner:main...' on repeated passes.
  const template = "{agent}:{sessionId}";
  const ctx = { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T14:25:07Z" };
  const rawFact = "The service caches with Redis.";

  const pass1 = attachCitation(rawFact, ctx, template);
  assert.ok(pass1.endsWith("planner:main"), `pass1 should end with citation, got: ${pass1}`);

  // Second pass on already-cited text must be a no-op.
  const pass2 = attachCitation(pass1, ctx, template);
  assert.equal(pass2, pass1, "second attachCitation pass must not append another citation");

  // Third pass too.
  const pass3 = attachCitation(pass2, ctx, template);
  assert.equal(pass3, pass1, "third attachCitation pass must not append another citation");

  // Confirm only one occurrence of the compact token.
  const tokenCount = (pass3.match(/planner:main/g) ?? []).length;
  assert.equal(tokenCount, 1, "citation token must appear exactly once");
});

test("hasCitationForTemplate: '{agent}/{sessionId}' slash separator — compact token detected", () => {
  // Ensure the separator-only path works for slash separators too.
  const template = "{agent}/{sessionId}";
  assert.equal(hasCitationForTemplate("planner/main", template), true);
  assert.equal(hasCitationForTemplate("Fact. planner/main", template), true);
  // URL path segments must not false-positive.
  assert.equal(hasCitationForTemplate("see https://example.com/planner/main for docs", template), false);
});

test("hasCitationForTemplate: '{agent}-{sessionId}' dash separator — compact token detected", () => {
  // Hyphen-separated compact tokens should also work.
  const template = "{agent}-{sessionId}";
  assert.equal(hasCitationForTemplate("planner-main", template), true);
  // A citation appended at end of prose (by attachCitation) is at the tail.
  assert.equal(hasCitationForTemplate("Fact. planner-main", template), true);
  // Finding 1 fix: a compact token in the MIDDLE of prose must not match,
  // because `attachCitation` always appends at the end. This is what prevents
  // hyphenated English words like "long-term" from being falsely detected.
  assert.equal(hasCitationForTemplate("Fact planner-main rest", template), false);
  // Plain text with no separator must return false.
  assert.equal(hasCitationForTemplate("no separator here", template), false);
});

// ── PR #401 P2 findings: Finding 1 (PRRT_kwDORJXyws56UH4M) + Finding 2 (PRRT_kwDORJXyws56UH4O) ──

// Finding 1: compact-template false positives on prose
test("hasCitationForTemplate (Finding 1): hyphenated prose 'long-term' must not match {agent}-{sessionId}", () => {
  // Core regression: 'long-term' looks like `[\w.-]+-[\w.-]+` but is ordinary
  // English prose. The tightened trail anchor (end-of-string or bracket only)
  // rejects it because 'long-term' is followed by ' solution', not end-of-string.
  assert.equal(
    hasCitationForTemplate("long-term solution", "{agent}-{sessionId}"),
    false,
    "'long-term' embedded in prose must not be classified as a citation",
  );
  // A real citation appended by attachCitation WOULD be at end of string.
  assert.equal(
    hasCitationForTemplate("This is a long-term solution. planner-main", "{agent}-{sessionId}"),
    true,
    "citation token at end of fact body (after prose containing hyphen) must be detected",
  );
});

test("hasCitationForTemplate (Finding 1): slashed path 'docs/setup' in prose must not match {agent}/{sessionId}", () => {
  // Regression for slash separator: 'docs/setup' appears in the middle of a
  // sentence, not at the end, so the end-of-string anchor rejects it.
  assert.equal(
    hasCitationForTemplate("see the docs/setup guide for details", "{agent}/{sessionId}"),
    false,
    "'docs/setup' inside a sentence must not be classified as a citation",
  );
});

test("hasCitationForTemplate (Finding 1): bracket-wrapped compact template is accepted", () => {
  // Bracket-wrapped form (e.g. from a caller that wraps citations) should
  // still be detected regardless of position in the string.
  assert.equal(
    hasCitationForTemplate("[agent-abc123] some trailing text", "{agent}-{sessionId}"),
    true,
    "bracket-wrapped compact token must be recognised as a citation",
  );
  assert.equal(
    hasCitationForTemplate("Fact body. [agent-abc123]", "{agent}-{sessionId}"),
    true,
    "bracket-wrapped compact token at end of fact must be recognised",
  );
});

test("stripCitationForTemplate removes bracket-wrapped compact citations", () => {
  assert.equal(
    stripCitationForTemplate("Fact body. [agent-abc123]", "{agent}-{sessionId}"),
    "Fact body.",
  );
});

// Finding 2: stripCitation must be a no-op on uncited input
test("stripCitation (Finding 2): returns uncited input byte-for-byte unchanged", () => {
  // Core regression: the old implementation normalised all repeated whitespace
  // even when no citation was present. This broke markdown hard-break spacing,
  // aligned text, and code-like snippets in fact bodies.
  const withDoubleSpaces = "plain prose with  double  spaces";
  assert.equal(
    stripCitation(withDoubleSpaces),
    withDoubleSpaces,
    "double spaces must be preserved when no citation is present",
  );

  // Tab characters in uncited text must also survive unchanged.
  const withTabs = "col1\t\tcol2\t\tcol3";
  assert.equal(
    stripCitation(withTabs),
    withTabs,
    "tab characters must be preserved when no citation is present",
  );

  // Markdown hard-break: two trailing spaces before a newline.
  const hardBreak = "line one  \nline two";
  assert.equal(
    stripCitation(hardBreak),
    hardBreak,
    "markdown hard-break (two trailing spaces before newline) must be preserved",
  );
});

test("stripCitation (Finding 2): removes citation and normalises only the join seam", () => {
  // Positive case: a citation IS present, so stripping should work as before.
  const cited = "The service uses Redis. [Source: agent=planner, session=main, ts=2026-04-10T00:00:00Z]";
  const stripped = stripCitation(cited);
  assert.equal(stripped, "The service uses Redis.");

  // Whitespace BEFORE the citation (at the seam) is collapsed, but whitespace
  // elsewhere in the body is not touched.
  const citedWithInternalSpaces =
    "col1  col2 [Source: agent=a, session=s, ts=2026-04-10T00:00:00Z]";
  const strippedWithInternalSpaces = stripCitation(citedWithInternalSpaces);
  // The double space inside the fact body must be preserved; only trailing
  // whitespace at the seam is normalised.
  assert.ok(
    strippedWithInternalSpaces.includes("col1  col2"),
    `internal double space must be preserved, got: ${JSON.stringify(strippedWithInternalSpaces)}`,
  );
});

test("stripCitation (Finding 2): attach → strip round-trip with uncited double-space body", () => {
  // Verifies that a fact body containing double spaces survives attach + strip
  // without the double spaces being collapsed.
  const body = "col one  col two  col three";
  const ctx = { agent: "a", session: "s:1", ts: "2026-04-11T00:00:00Z" };
  const attached = attachCitation(body, ctx);
  assert.ok(hasCitation(attached), "citation must be present after attach");
  const stripped = stripCitation(attached);
  assert.equal(stripped, body, "strip must restore original body including double spaces");
});

// ── P2 finding UM3U regression: hash-index key consistent across write and archive ──

test(
  "UM3U: ContentHashIndex.remove via stripCitation(citedContent) removes the raw-content hash (inlineSourceAttributionEnabled=true)",
  async () => {
    // Scenario:
    //   1. inlineSourceAttributionEnabled=true — facts are stored as
    //      "raw content [Source: agent=X, session=Y, ts=Z]" on disk.
    //   2. At write time, contentHashSource=rawContent is passed so the
    //      dedup index stores hash(rawContent), not hash(citedContent).
    //   3. At archive/consolidation time the code previously called
    //      contentHashIndex.remove(memory.content) where memory.content is
    //      the post-citation string — hash(citedContent) ≠ hash(rawContent),
    //      so the remove silently failed and left a stale entry.
    //   4. The fix: call contentHashIndex.remove(stripCitation(memory.content))
    //      which recovers the raw text and produces the matching hash.
    //
    // This test exercises the fix at the ContentHashIndex level (unit) rather
    // than through the full orchestrator, keeping it fast and dependency-free.
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-um3u-"));
    try {
      const rawContent = "user prefers dark mode in all applications";
      const citedContent =
        `${rawContent} [Source: agent=planner, session=chat, ts=2026-04-11T10:00:00Z]`;

      // Simulate write-time: index the RAW content (as contentHashSource does).
      const idx = new ContentHashIndex(dir);
      await idx.load();
      idx.add(rawContent);
      await idx.save();

      // Verify the raw hash is present.
      assert.ok(idx.has(rawContent), "raw content hash must be present after add");
      // The cited variant must NOT collide with the raw hash (validates the premise).
      assert.ok(!idx.has(citedContent), "cited content must hash differently from raw");

      // Simulate the BROKEN archive path: remove using the cited content directly.
      // This must leave the raw hash intact (demonstrating the bug).
      const idxBroken = new ContentHashIndex(dir);
      await idxBroken.load();
      idxBroken.remove(citedContent); // broken: hash mismatch, no-op
      assert.ok(
        idxBroken.has(rawContent),
        "broken path: stale hash must remain because citedContent hash does not match",
      );

      // Simulate the FIXED archive path: strip citation before calling remove.
      // stripCitation(citedContent) === rawContent (same hash), so remove succeeds.
      const idxFixed = new ContentHashIndex(dir);
      await idxFixed.load();
      idxFixed.remove(stripCitation(citedContent)); // fixed: hash matches
      assert.ok(
        !idxFixed.has(rawContent),
        "fixed path: raw content hash must be removed after stripCitation → remove",
      );

      // Verify the index is now empty (no stale entries remain).
      assert.equal(idxFixed.size, 0, "hash index must be empty after correct removal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "UM3U: re-extraction of same raw fact is NOT false-deduped after correct archive removal",
  async () => {
    // After a fact is archived with the FIXED remove path (stripCitation before
    // remove), the hash index no longer contains the raw-content hash.  A
    // subsequent extraction of the same underlying raw fact must therefore pass
    // the dedup gate (has() returns false) and be allowed to be re-written.
    //
    // Without the fix: remove(citedContent) is a no-op → has(rawContent) stays
    // true → new extraction is incorrectly blocked as a duplicate.
    // With the fix: remove(stripCitation(citedContent)) succeeds → has(rawContent)
    // returns false → re-extraction can proceed.
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-um3u-reextract-"));
    try {
      const rawContent = "user likes coffee in the morning";
      const citedContent =
        `${rawContent} [Source: agent=scout, session=chat, ts=2026-04-11T09:00:00Z]`;

      // Write phase: add raw hash to index.
      const writeIdx = new ContentHashIndex(dir);
      await writeIdx.load();
      writeIdx.add(rawContent);
      await writeIdx.save();

      // Archive phase (FIXED): use stripCitation before remove.
      const archiveIdx = new ContentHashIndex(dir);
      await archiveIdx.load();
      archiveIdx.remove(stripCitation(citedContent));
      await archiveIdx.save();

      // Re-extraction phase: load a fresh index (new session / process).
      const reextractIdx = new ContentHashIndex(dir);
      await reextractIdx.load();

      // The re-extracted raw fact must NOT be blocked as a duplicate.
      assert.ok(
        !reextractIdx.has(rawContent),
        "after correct archive removal, re-extraction of the same raw fact must not be false-deduped",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// ── Option A (contentHash on frontmatter): format-agnostic archive cleanup ────

test(
  "Option A — Test A: custom unbracketed inline citation: archive removes raw-content hash via stored contentHash",
  async () => {
    // Configure an unbracketed template: "{agent} {sessionId}"
    // formatCitation produces something like "user prefers tea planner main"
    // stripCitation cannot strip it (no [Source: ...] bracket), but the stored
    // frontmatter.contentHash must still let us remove the correct hash.
    //
    // Verifies Option 1 fix: removeByHash(frontmatter.contentHash) correctly
    // deletes the entry without double-hashing.
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-option-a-test-a-"));
    try {
      const rawContent = "user prefers tea";
      const template = "{agent} {sessionId}";
      const citedContent = attachCitation(
        rawContent,
        { agent: "planner", session: "agent:planner:main" },
        template,
      );
      // citedContent = "user prefers tea planner main" (no brackets — stripCitation is a no-op)
      assert.ok(!rawContent.includes("["), "raw content must have no brackets");

      // Write with contentHashSource so the raw-content hash lands in the index
      // and on frontmatter.contentHash.
      const storage = new StorageManager(dir);
      await storage.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });

      // Confirm raw-content hash is indexed.
      assert.ok(
        await storage.hasFactContentHash(rawContent),
        "raw-content hash must be in the index after write",
      );

      // Load the written memory from disk to retrieve frontmatter.contentHash.
      const allMemories = await storage.readAllMemories();
      const written = allMemories.find((m) => m.content.includes("planner main") || (m.content.includes("planner") && m.content.includes("tea")));
      assert.ok(written, "written memory must be findable");
      assert.ok(
        written!.frontmatter.contentHash,
        "frontmatter.contentHash must be persisted on disk",
      );

      // Confirm frontmatter.contentHash is a 64-char hex string (pre-computed hash).
      assert.match(
        written!.frontmatter.contentHash!,
        /^[a-f0-9]{64}$/,
        "frontmatter.contentHash must be a 64-char SHA-256 hex string",
      );

      // Simulate archive via Option 1 fix: use removeByHash so we skip hashing
      // the already-hashed value.  StorageManager stores fact-hashes.txt under
      // the `state/` subdir — use that same path for the ContentHashIndex.
      const stateDir = path.join(dir, "state");
      const idx = new ContentHashIndex(stateDir);
      await idx.load();
      // Verify the raw-content hash IS present before archive (proves we loaded the right file).
      assert.ok(idx.has(rawContent), "raw-content hash must be present in the state index before archive");
      idx.removeByHash(written!.frontmatter.contentHash!);
      await idx.save();

      // Reload index and verify hash is gone.
      const idxAfter = new ContentHashIndex(stateDir);
      await idxAfter.load();
      assert.ok(
        !idxAfter.has(rawContent),
        "after archive using removeByHash(frontmatter.contentHash), raw-content hash must be removed from index",
      );

      // Confirm that the buggy approach (double-hash via remove()) would have failed.
      // Re-add the raw hash and then remove() the already-hashed value — must be a no-op.
      const idxDoubleHashCheck = new ContentHashIndex(stateDir);
      await idxDoubleHashCheck.load();
      idxDoubleHashCheck.add(rawContent);
      await idxDoubleHashCheck.save();
      const idxBuggy = new ContentHashIndex(stateDir);
      await idxBuggy.load();
      idxBuggy.remove(written!.frontmatter.contentHash!); // double-hash: no-op
      assert.ok(
        idxBuggy.has(rawContent),
        "buggy remove(alreadyHashedValue) must be a no-op — stale hash remains",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Option A — Test B: custom bracketed inline citation: archive removes raw-content hash via stored contentHash",
  async () => {
    // Configure a bracketed custom template: "[src:{agent}/{sessionId}@{date}]"
    // The stored body is "user prefers tea [src:planner/main@2026-04-11]"
    // stripCitation only strips [Source: ...] shape, so this format is a no-op.
    //
    // Verifies Option 1 fix: removeByHash(frontmatter.contentHash) correctly
    // deletes the entry without double-hashing.
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-option-a-test-b-"));
    try {
      const rawContent = "user prefers tea";
      const template = "[src:{agent}/{sessionId}@{date}]";
      const citedContent = attachCitation(
        rawContent,
        { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T00:00:00Z" },
        template,
      );
      // citedContent = "user prefers tea [src:planner/main@2026-04-11]"
      assert.ok(citedContent.includes("[src:"), "cited content must use custom bracket format");
      assert.ok(!citedContent.includes("[Source:"), "must NOT use default [Source: ...] format");

      // Write fact with raw-content as contentHashSource.
      const storage = new StorageManager(dir);
      await storage.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });

      // Confirm raw-content hash is indexed.
      assert.ok(
        await storage.hasFactContentHash(rawContent),
        "raw-content hash must be in the index after write",
      );

      // Load from disk and check frontmatter.contentHash.
      const allMemories = await storage.readAllMemories();
      const written = allMemories.find((m) => m.content.includes("[src:planner/main@"));
      assert.ok(written, "written memory must be findable by custom citation");
      assert.ok(
        written!.frontmatter.contentHash,
        "frontmatter.contentHash must be persisted on disk",
      );

      // Confirm frontmatter.contentHash is a 64-char hex string (pre-computed hash).
      assert.match(
        written!.frontmatter.contentHash!,
        /^[a-f0-9]{64}$/,
        "frontmatter.contentHash must be a 64-char SHA-256 hex string",
      );

      // Simulate archive via Option 1 fix: use removeByHash with the correct
      // state/ subdir path that StorageManager uses.
      const stateDir = path.join(dir, "state");
      const idx = new ContentHashIndex(stateDir);
      await idx.load();
      // Verify the raw-content hash IS present before archive.
      assert.ok(idx.has(rawContent), "raw-content hash must be present in the state index before archive");
      idx.removeByHash(written!.frontmatter.contentHash!);
      await idx.save();

      // Reload and verify hash is gone.
      const idxAfter = new ContentHashIndex(stateDir);
      await idxAfter.load();
      assert.ok(
        !idxAfter.has(rawContent),
        "after archive using removeByHash(frontmatter.contentHash), raw-content hash must be removed from index",
      );

      // Confirm that the buggy approach (double-hash via remove()) would have failed.
      const idxDoubleHashCheck = new ContentHashIndex(stateDir);
      await idxDoubleHashCheck.load();
      idxDoubleHashCheck.add(rawContent);
      await idxDoubleHashCheck.save();
      const idxBuggy = new ContentHashIndex(stateDir);
      await idxBuggy.load();
      idxBuggy.remove(written!.frontmatter.contentHash!); // double-hash: no-op
      assert.ok(
        idxBuggy.has(rawContent),
        "buggy remove(alreadyHashedValue) must be a no-op — stale hash remains",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Option A — Test C (legacy, round-4 fix): memory without frontmatter.contentHash — archive removes hash via content fallback",
  async () => {
    // Verifies the round-4 (P2) fix: when a legacy memory has no contentHash
    // frontmatter, the archive path must call remove(memory.content) to clear
    // the stale dedup entry.  Pre-#369 facts were stored without inline
    // citations, so memory.content is the raw fact text and hashing it via
    // remove() will hit the correct index entry.
    //
    // This replaces the earlier "skip" behaviour (Finding 2 — Urgw) which left
    // stale entries in the index and caused false-dedup suppression of
    // re-extracted facts in upgraded deployments.
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-option-a-test-c-"));
    try {
      const rawContent = "user prefers coffee";

      // Populate the index with the raw-content hash (simulates what writeMemory
      // did in pre-#369 builds when contentHashSource was not yet supported).
      const idx = new ContentHashIndex(dir);
      await idx.load();
      idx.add(rawContent);
      await idx.save();

      const idxCheck = new ContentHashIndex(dir);
      await idxCheck.load();
      assert.ok(idxCheck.has(rawContent), "raw-content hash must be present before archive");

      // Simulate the legacy archive path: frontmatter has NO contentHash, and
      // memory.content is the raw (un-cited) fact text (pre-#369 write).
      const legacyMemory = {
        frontmatter: { contentHash: undefined as string | undefined },
        content: rawContent,
      } as unknown as import("./types.js").MemoryFile;

      // The updated archive path: use removeByHash when contentHash present,
      // else fall back to remove(memory.content) for legacy memories.
      if (legacyMemory.frontmatter.contentHash) {
        idxCheck.removeByHash(legacyMemory.frontmatter.contentHash);
      } else {
        idxCheck.remove(legacyMemory.content);
      }

      await idxCheck.save();

      // The raw-content hash MUST now be gone — stale entry cleared.
      const idxAfter = new ContentHashIndex(dir);
      await idxAfter.load();
      assert.ok(
        !idxAfter.has(rawContent),
        "raw-content hash must be removed from the index after legacy archive content-fallback removal",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// ── Test D: round 8 double-hash regression (Option 1 fix verification) ────────

test(
  "Test D: archive removes hash via frontmatter.contentHash — no double hashing (round 8 regression)",
  async () => {
    // Regression test for the round 8 double-hash bug:
    //   Round 8 changed archive call sites to:
    //     const hashKey = memory.frontmatter.contentHash ?? stripCitation(memory.content);
    //     contentHashIndex.remove(hashKey);
    //   But ContentHashIndex.remove() internally calls computeHash(hashKey).
    //   When hashKey is already a SHA-256 hex string, we compute hash(hash(rawContent))
    //   which never matches the index entry — silent no-op, stale hash leaks.
    //
    // Option 1 fix: removeByHash(hash) deletes the hash directly without re-hashing.
    // This test verifies:
    //   1. After write, has(rawContent) is true.
    //   2. After removeByHash(frontmatter.contentHash), has(rawContent) is false.
    //   3. After the buggy remove(frontmatter.contentHash), has(rawContent) is STILL true.
    //   4. Re-extraction after correct removal is NOT false-deduped.
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-test-d-double-hash-"));
    try {
      const rawContent = "user prefers tea";
      const template = DEFAULT_CITATION_FORMAT;
      const citedContent = attachCitation(
        rawContent,
        { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:00:00Z" },
        template,
      );

      // Write the fact with contentHashSource so both the index and frontmatter.contentHash
      // store hash(rawContent).
      const storage = new StorageManager(dir);
      await storage.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });

      // Step 1: verify has(rawContent) is true immediately after write.
      assert.ok(
        await storage.hasFactContentHash(rawContent),
        "Step 1: has(rawContent) must be true after write",
      );

      // Load the written memory to retrieve frontmatter.contentHash.
      const allMemories = await storage.readAllMemories();
      const written = allMemories.find((m) => m.content.includes("[Source: agent=planner"));
      assert.ok(written, "written memory must be findable");
      const storedHash = written!.frontmatter.contentHash;
      assert.ok(storedHash, "frontmatter.contentHash must be present");
      assert.match(storedHash!, /^[a-f0-9]{64}$/, "frontmatter.contentHash must be a 64-char SHA-256 hex");

      // Verify storedHash equals computeHash(rawContent) — proves it's a pre-computed hash.
      assert.equal(
        storedHash,
        ContentHashIndex.computeHash(rawContent),
        "frontmatter.contentHash must equal computeHash(rawContent)",
      );

      // Step 2a: demonstrate the BUGGY path — remove(alreadyHashedValue) is a no-op.
      // This is the double-hash bug from round 8.
      const stateDir = path.join(dir, "state");
      const idxBuggy = new ContentHashIndex(stateDir);
      await idxBuggy.load();
      assert.ok(idxBuggy.has(rawContent), "Step 2a-pre: hash must be present before buggy remove");
      idxBuggy.remove(storedHash!); // double-hash: hash(hash(rawContent)) — no match
      // The hash must STILL be present (remove was a no-op).
      assert.ok(
        idxBuggy.has(rawContent),
        "Step 2a: buggy remove(alreadyHashedValue) must leave the hash intact — stale hash leaks",
      );

      // Step 2b: demonstrate the FIXED path — removeByHash(alreadyHashedValue) removes directly.
      const idxFixed = new ContentHashIndex(stateDir);
      await idxFixed.load();
      assert.ok(idxFixed.has(rawContent), "Step 2b-pre: hash must be present before fixed remove");
      idxFixed.removeByHash(storedHash!); // correct: no re-hashing
      assert.ok(
        !idxFixed.has(rawContent),
        "Step 2b: removeByHash(frontmatter.contentHash) must remove the raw-content hash",
      );
      await idxFixed.save();

      // Step 3: re-extraction after correct removal must NOT be false-deduped.
      // Load a fresh index (simulating a new extraction session).
      const idxReextract = new ContentHashIndex(stateDir);
      await idxReextract.load();
      assert.ok(
        !idxReextract.has(rawContent),
        "Step 3: after archive, re-extraction of the same raw fact must not be false-deduped (hash is gone)",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// ── Finding 3 (Uru3): templateMatcher — tighten normal-case placeholder regex ─

test(
  "Finding 3 (Uru3): hasCitationForTemplate rejects user content that shares outer delimiters but wrong separators",
  () => {
    // Template [src:{agent}:{sessionId}_{date}] uses ':' and '_' as separators.
    // User content that happens to use different separators ('/' and '@') must
    // NOT be classified as a citation.
    const template = "[src:{agent}:{sessionId}_{date}]";

    // Real citation produced by this template — MUST be detected.
    const realCitation = "The cache was cleared. [src:planner:main_2026-04-11]";
    assert.equal(
      hasCitationForTemplate(realCitation, template),
      true,
      "real citation matching the template separators must be detected",
    );

    // User content with wrong separators ('/' and '@' instead of ':' and '_').
    // Before the fix, `[^\n]*?` between prefix/suffix matched this.
    const wrongSepContent = "See docs at [src:some-agent/abc123@today] for details.";
    assert.equal(
      hasCitationForTemplate(wrongSepContent, template),
      false,
      "user content with different separators must NOT be mis-flagged as a citation (Finding 3 — Uru3)",
    );

    // Edge case: content with the same outer delimiters but more tokens.
    const extraTokenContent = "check [src:agent:session:extra_date] now";
    assert.equal(
      hasCitationForTemplate(extraTokenContent, template),
      false,
      "content with extra tokens inside the template delimiters must NOT match",
    );
  },
);

test(
  "Finding 3 (Uru3): hasCitationForTemplate correctly detects default-format citations after tightening",
  () => {
    // The default format [Source: agent={agent}, session={sessionId}, ts={ts}]
    // has rich inner separators (', session=' and ', ts=').  The tightened
    // normal-case logic must still match real citations produced by formatCitation.
    const realCitation =
      "User prefers dark mode. [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]";
    assert.equal(
      hasCitationForTemplate(realCitation, DEFAULT_CITATION_FORMAT),
      true,
      "default-format citation must be detected after templateMatcher tightening",
    );

    // Also verify an 'unknown' variant (fields populated with CITATION_UNKNOWN).
    const unknownCitation =
      "Some fact. [Source: agent=unknown, session=unknown, ts=unknown]";
    assert.equal(
      hasCitationForTemplate(unknownCitation, DEFAULT_CITATION_FORMAT),
      true,
      "default-format citation with 'unknown' fields must still be detected",
    );
  },
);

test(
  "Finding 3 (Uru3): templateMatcher normal case rejects content that crosses placeholder boundaries",
  () => {
    // Template [src:{agent}/{sessionId}@{date}] with inner seps '/' and '@'.
    // Content where a single value spans BOTH separators must be rejected.
    const template = "[src:{agent}/{sessionId}@{date}]";

    // Content where 'agent' portion alone spans the '/' separator — not a
    // valid emission of the template.
    const crossBoundaryCitation = "check [src:foo/bar/extra@2026-04-11] now";
    assert.equal(
      hasCitationForTemplate(crossBoundaryCitation, template),
      false,
      "content where a value token crosses a separator boundary must not match",
    );

    // Valid citation — exactly three tokens in the right positions.
    const validCitation = "Fact. [src:planner/main@2026-04-11]";
    assert.equal(
      hasCitationForTemplate(validCitation, template),
      true,
      "valid citation matching template separators must be detected",
    );
  },
);

// ── Fix #3 regression: verbatim artifact must share citation timestamp with memory ──

test(
  "Fix #3 (UzK9): verbatim artifact and memory write share the same citation timestamp",
  () => {
    // Regression test for the duplicate-citation bug: when applyInlineCitation
    // is called twice on the same raw content (once for writeMemory and once for
    // writeArtifact), each invocation generates a fresh new Date().toISOString()
    // timestamp, producing two distinct citations for the same logical fact.
    //
    // The fix: compute applyInlineCitation(fact.content) ONCE and reuse the
    // result for both writeMemory and writeArtifact.  This test verifies that
    // calling attachCitation on the SAME already-cited string is idempotent
    // (hasCitationForTemplate returns true, so attachCitation is a no-op),
    // and that calling it on the raw content twice produces different citations.
    const rawContent = "user prefers dark mode";
    const ts1 = "2026-04-11T10:00:00.000Z";
    const ts2 = "2026-04-11T10:00:00.001Z";

    const cited1 = attachCitation(rawContent, { agent: "planner", session: "s1", ts: ts1 });
    const cited2 = attachCitation(rawContent, { agent: "planner", session: "s1", ts: ts2 });

    // Two separate calls on raw content produce different citations (different ts).
    assert.notEqual(
      cited1,
      cited2,
      "two separate attachCitation calls on raw content produce different timestamps",
    );

    // The fix: the second call receives the ALREADY-CITED string from the first call.
    // attachCitation must be idempotent — it should not append a second citation.
    const citedAgain = attachCitation(cited1, { agent: "planner", session: "s1", ts: ts2 });
    assert.equal(
      citedAgain,
      cited1,
      "attachCitation on already-cited content must be idempotent — no duplicate citation appended",
    );

    // Verify hasCitationForTemplate detects the citation on cited1.
    assert.equal(
      hasCitationForTemplate(cited1, DEFAULT_CITATION_FORMAT),
      true,
      "already-cited content must be detected as having a citation",
    );
  },
);

// ── Separator-in-placeholder-value regression (round-5 review thread) ─────────

test("hasCitationForTemplate: placeholder value containing inner separator char is detected (colon in ts)", () => {
  // Template `[src:{agent}:{ts}]` uses `:` as the separator between {agent}
  // and {ts}.  When the `{ts}` value itself contains `:` (ISO-8601 timestamp),
  // the old single shared tokenPattern `[^\n\s:]+?` incorrectly rejects the
  // citation, causing attachCitation to append a duplicate on reprocessing.
  //
  // The fix builds per-placeholder patterns: only the FIRST token (before the
  // `:` separator) must exclude `:`.  The LAST token is terminated by the
  // suffix `]` anchor, so it does not need to exclude `:`.
  const template = "[src:{agent}:{ts}]";
  const citedText = "Fact body. [src:planner:2026-04-10T14:25:07Z]";
  assert.equal(
    hasCitationForTemplate(citedText, template),
    true,
    "citation containing a colon in the ts value must be detected",
  );
  // attachCitation must be idempotent: no second citation appended.
  const ctx = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T00:00:00Z" };
  const again = attachCitation(citedText, ctx, template);
  assert.equal(again, citedText, "attachCitation must not append a duplicate when citation is already present");
});

test("hasCitationForTemplate: colon-separated template still rejects text with wrong structure", () => {
  // The relaxed last-token pattern must not cause false positives — the prefix
  // and suffix anchors (`[src:` and `]`) should still filter out arbitrary text.
  const template = "[src:{agent}:{ts}]";
  assert.equal(hasCitationForTemplate("plain text without citation", template), false);
  assert.equal(hasCitationForTemplate("no bracket prefix here planner:2026", template), false);
});

test("hasCitationForTemplate: multi-separator template detects citation when intermediate value contains sep char", () => {
  // Template `[src:{agent}:{sessionId}:{ts}]` — three placeholders, two `:` separators.
  // The {sessionId} value `scout:alpha` contains `:` which is the separator between
  // placeholder 0 and 1.  Per-placeholder patterns must only exclude `:` from
  // the token that immediately precedes each separator.  The last token ({ts})
  // must not be restricted by `:` at all.
  const template = "[src:{agent}:{sessionId}:{ts}]";
  const citation = "[src:planner:scout:alpha:2026-04-10T14:25:07Z]";
  // This is ambiguous by design — the matcher allows it because idempotency is
  // more important than strict inter-placeholder boundary enforcement when values
  // contain the separator.
  assert.equal(
    hasCitationForTemplate(citation, template),
    true,
    "multi-colon citation where intermediate value contains the separator should be detected",
  );
});
