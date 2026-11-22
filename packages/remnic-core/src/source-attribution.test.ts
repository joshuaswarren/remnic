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
  citationTemplateIsDetectable,
  citationTemplatesForMerge,
  citationTemplatesToRecognize,
  deriveSessionId,
  formatCitation,
  hasCitation,
  hasCitationForTemplate,
  lastRecognizedCitationMarker,
  parseAllCitations,
  parseCitation,
  stripCitation,
  stripCitationForTemplate,
  stripRecognizedCitations,
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
  assert.deepEqual(cfg.inlineSourceAttributionFormatHistory, []);
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

test("parseConfig keeps inlineSourceAttributionFormatHistory when format is normalized", () => {
  const prior = "[src:{agent}/{sessionId}@{date}]";
  const current = "[via:{agent}]";
  const cfg = parseConfig({
    inlineSourceAttributionFormat: "   ",
    inlineSourceAttributionFormatHistory: [prior, "", 12, "  ", current],
  });
  assert.equal(cfg.inlineSourceAttributionFormat, DEFAULT_CITATION_FORMAT);
  assert.deepEqual(cfg.inlineSourceAttributionFormatHistory, [prior, current]);
  assert.deepEqual(citationTemplatesForMerge(cfg), [
    DEFAULT_CITATION_FORMAT,
    prior,
    current,
  ]);
});


test("hasCitationForTemplate detects default [Source:...] marker regardless of template", () => {
  const text = "Fact body. [Source: agent=planner, session=main, ts=2026-04-10T00:00:00Z]";
  assert.equal(hasCitationForTemplate(text, DEFAULT_CITATION_FORMAT), true);
  assert.equal(hasCitationForTemplate(text, "[src:{agent}/{sessionId}@{date}]"), true);
});

test("hasCitationForTemplate detects a custom-format citation", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const text = "Fact body. [src:planner/main@2026-04-10]";
  assert.equal(hasCitationForTemplate(text, customTemplate), true);
  assert.equal(hasCitationForTemplate("Fact body.", customTemplate), false);
});

test("hasCitationForTemplate returns false for empty / non-string inputs", () => {
  assert.equal(hasCitationForTemplate("", DEFAULT_CITATION_FORMAT), false);
  assert.equal(hasCitationForTemplate("no citation here", DEFAULT_CITATION_FORMAT), false);
});

test("attachCitation with custom template is a no-op when text already carries that custom marker (Finding 1)", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const ctx = { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T14:25:07Z" };
  const priorCitation = "[src:other/alpha@2026-01-01]";
  const text = `Existing fact. ${priorCitation}`;
  const result = attachCitation(text, ctx, customTemplate);
  assert.equal(result, text);
  const markerCount = (result.match(/\[src:/g) ?? []).length;
  assert.equal(markerCount, 1);
});

test("attachCitation with custom template tags untagged text exactly once (Finding 1 positive path)", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const ctx = { agent: "scout", session: "agent:scout:beta", ts: "2026-04-11T00:00:00Z" };
  const text = "The service uses Redis for caching.";
  const result = attachCitation(text, ctx, customTemplate);
  assert.ok(result.includes("[src:scout/beta@2026-04-11]"), `expected custom citation in: ${result}`);
  const again = attachCitation(result, ctx, customTemplate);
  assert.equal(again, result);
});


test("hasCitationForTemplate with placeholder-bounded template requires bracket-wrapped match", () => {
  const template = "{source}: {content}";
  assert.equal(hasCitationForTemplate("Fact body. [planner: some-note]", template), true);
  assert.equal(hasCitationForTemplate("planner: The service uses Redis", template), false);
  assert.equal(hasCitationForTemplate("random text without separator", template), false);
  assert.equal(hasCitationForTemplate("no separator here at all", template), false);
});

test("hasCitationForTemplate with fully placeholder-only template returns false (cannot anchor)", () => {
  const template = "{source}{content}";
  assert.equal(hasCitationForTemplate("anything goes here", template), false);
  assert.equal(hasCitationForTemplate("{source}{content}", template), false);
});

test("hasCitationForTemplate preserves normal behaviour for well-formed templates (Finding 2 non-regression)", () => {
  const template = "Source: {source} — Content: {content}";
  assert.equal(hasCitationForTemplate("Source: planner — Content: some fact", template), true);
  assert.equal(hasCitationForTemplate("random unrelated text", template), false);
});

test("hasCitationForTemplate: placeholder-bounded template does not falsely tag plain text (Finding 2 negative)", () => {
  const template = "{source}: {content}";
  assert.equal(hasCitationForTemplate("just a plain statement", template), false);
});

test("hasCitationForTemplate: {agent}:{sessionId} template rejects embedded URL colons", () => {
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
  const template = "{agent}:{sessionId}";
  assert.equal(
    hasCitationForTemplate("[backend-agent:abc123] some text", template),
    true,
  );
});



test("formatCitation: agent value containing $& is not expanded by replace", () => {
  const out = formatCitation(
    { agent: "agent-with-$&-literal", session: "sess:abc", ts: "2026-04-11T00:00:00Z" },
  );
  assert.ok(
    out.includes("agent-with-$&-literal"),
    `expected literal $& in output, got: ${out}`,
  );
  assert.ok(!out.includes("{agent}"), "placeholder must be replaced");
});

test("formatCitation: session value containing $` (backtick) is not corrupted", () => {
  const session = "sess:$`backtick";
  const out = formatCitation(
    { agent: "planner", session, ts: "2026-04-11T00:00:00Z" },
  );
  const tmpl = "[S: agent={agent}, session={session}, ts={ts}]";
  const out2 = formatCitation({ agent: "planner", session, ts: "2026-04-11T00:00:00Z" }, tmpl);
  assert.ok(
    out2.includes("sess:$`backtick"),
    `expected literal session with $\` in output, got: ${out2}`,
  );
});

test("formatCitation: agent value $1$2 stays literal (not resolved to empty groups)", () => {
  const out = formatCitation(
    { agent: "$1$2", session: "sess:main", ts: "2026-04-11T00:00:00Z" },
  );
  assert.ok(
    out.includes("$1$2"),
    `expected literal $1$2 in output, got: ${out}`,
  );
});

test("attachCitation is idempotent across different timestamps for the same raw content (Finding 1 dedup)", () => {
  const rawContent = "The database uses PostgreSQL for persistent storage.";
  const template = DEFAULT_CITATION_FORMAT;

  const ctx1 = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:00:00Z" };
  const ctx2 = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:05:00Z" };

  const cited1 = attachCitation(rawContent, ctx1, template);
  assert.ok(cited1.includes("2026-04-11T10:00:00Z"), "first citation should include first timestamp");

  const cited2 = attachCitation(cited1, ctx2, template);
  assert.equal(cited2, cited1, "second attachCitation must not append a second marker");

  assert.equal(hasCitationForTemplate(cited1, template), true);

  assert.equal(hasCitationForTemplate(rawContent, template), false);
});


test("ContentHashIndex.add indexes raw content; has() returns true for the same raw string", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-hash-idx-"));
  try {
    const idx = new ContentHashIndex(dir);
    await idx.load();
    const rawContent = "The database uses PostgreSQL for persistent storage.";
    idx.add(rawContent);
    assert.ok(idx.has(rawContent), "has() must return true for a string just added");
    const citedContent = `${rawContent} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;
    assert.ok(!idx.has(citedContent), "has() must return false for the cited variant when only raw was added");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory with contentHashSource registers raw-content hash (Finding B)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-shared-dedup-"));
  try {
    const rawContent = "The service caches reads with Redis for low-latency access.";
    const citedContent = `${rawContent} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;

    {
      const storage1 = new StorageManager(dir);
      await storage1.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });
      const foundByRaw = await storage1.hasFactContentHash(rawContent);
      assert.ok(foundByRaw, "hasFactContentHash(rawContent) must be true in the same session");
    }

    {
      const storage2 = new StorageManager(dir);
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-dedup-regression-"));
  try {
    const rawFact = "PostgreSQL is used for durable persistent storage of user profiles.";
    const cited1 = `${rawFact} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;

    {
      const storage1 = new StorageManager(dir);
      await storage1.writeMemory("fact", cited1, {
        source: "extraction-shared-promotion",
        tags: ["shared-promotion"],
        contentHashSource: rawFact,
      });
      assert.ok(
        await storage1.hasFactContentHash(rawFact),
        "Session 1: hasFactContentHash(rawFact) must be true after first promotion",
      );
    }

    {
      const storage2 = new StorageManager(dir);
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


test("hasCitationForTemplate: '{agent} {sessionId}' rejects plain two-word prose", () => {
  const template = "{agent} {sessionId}";
  assert.equal(
    hasCitationForTemplate("The service responded", template),
    false,
    "two-word English prose must never be classified as a citation",
  );
});

test("hasCitationForTemplate: '{agent} {sessionId}' accepts a bracket-wrapped token", () => {
  const template = "{agent} {sessionId}";
  assert.equal(
    hasCitationForTemplate("[backend-agent session-abc123]", template),
    true,
    "bracket-wrapped identifier pair must be recognised as a citation",
  );
});

test("hasCitationForTemplate: '{agent}{sessionId}' all-placeholder template returns false", () => {
  const template = "{agent}{sessionId}";
  assert.equal(
    hasCitationForTemplate("alphaomega", template),
    false,
    "no sentinel / no literal — must return false",
  );
});

test("citationTemplateIsDetectable rejects all-placeholder templates", () => {
  assert.equal(citationTemplateIsDetectable("{agent}{sessionId}"), false);
  assert.equal(citationTemplateIsDetectable(DEFAULT_CITATION_FORMAT), true);
  assert.equal(citationTemplateIsDetectable("[src:{agent}/{sessionId}@{date}]"), true);
});

test("citationTemplatesToRecognize drops undetectable shapes and keeps prior history", () => {
  const prior = "[src:{agent}/{sessionId}@{date}]";
  const recognized = citationTemplatesToRecognize("{agent}{sessionId}", [prior]);
  assert.deepEqual(recognized, [DEFAULT_CITATION_FORMAT, prior]);
  const body = "The cadence is weekly. [src:agent-a/s-old@2026-08-19]";
  assert.equal(stripRecognizedCitations(body, recognized), "The cadence is weekly.");
  assert.deepEqual(citationTemplatesForMerge({ inlineSourceAttributionFormat: prior }), [
    DEFAULT_CITATION_FORMAT,
    prior,
  ]);
});

test("stripCitationForTemplate: literal template strips the exact marker (#2951)", () => {
  const template = "[cited-fixed]";
  const body = "Fact body. [cited-fixed]";
  assert.equal(citationTemplateIsDetectable(template), true);
  assert.equal(hasCitationForTemplate(body, template), true);
  assert.equal(stripCitationForTemplate(body, template), "Fact body.");
});

test("citationTemplatesToRecognize: overlapping custom marker wins over inner default (#2951)", () => {
  const custom = "[Source: agent={agent}, session={sessionId}, ts={ts}; via={agent}]";
  const ctx = {
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-04-10T14:25:07Z",
  };
  const marker = formatCitation(ctx, custom);
  const body = `The cadence is weekly. ${marker}`;
  const recognized = citationTemplatesToRecognize(custom);
  assert.ok(
    recognized.indexOf(custom) < recognized.indexOf(DEFAULT_CITATION_FORMAT),
    "current overlapping template must be recognized before the inner default",
  );
  assert.equal(lastRecognizedCitationMarker(body, recognized), marker);
  assert.equal(stripRecognizedCitations(body, recognized), "The cadence is weekly.");
});

test("formatCitation: substituted values containing placeholder syntax are not re-interpreted", () => {
  //
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
  const out = formatCitation(
    { agent: "a1", session: "sess:{date}", ts: "2026-04-11T00:00:00Z" },
    "[S: agent={agent}, session={session}, date={date}]",
  );
  assert.equal(
    out,
    "[S: agent=a1, session=sess:{date}, date=2026-04-11]",
  );
});


test("formatCitation: '{agent}:{sessionId}' produces compact token without brackets", () => {
  const out = formatCitation(
    { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T14:25:07Z" },
    "{agent}:{sessionId}",
  );
  assert.equal(out, "planner:main");
});

test("hasCitationForTemplate: '{agent}:{sessionId}' detects standalone compact token", () => {
  assert.equal(
    hasCitationForTemplate("planner:main", "{agent}:{sessionId}"),
    true,
    "compact citation at start of string must be detected",
  );
});

test("hasCitationForTemplate: '{agent}:{sessionId}' detects token at end of string", () => {
  assert.equal(
    hasCitationForTemplate("Fact body. planner:main", "{agent}:{sessionId}"),
    true,
    "compact citation at end of string must be detected",
  );
  assert.equal(
    hasCitationForTemplate("The service planner:main is done.", "{agent}:{sessionId}"),
    false,
    "compact citation surrounded by prose must NOT be classified as a citation (Finding 1 fix)",
  );
});

test("hasCitationForTemplate: '{agent}:{sessionId}' rejects URL-embedded colons", () => {
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
  assert.equal(
    hasCitationForTemplate("[backend-agent:abc123] some text", "{agent}:{sessionId}"),
    true,
    "bracket-wrapped compact token must be recognised",
  );
});

test("attachCitation idempotency: '{agent}:{sessionId}' template appends citation exactly once", () => {
  const template = "{agent}:{sessionId}";
  const ctx = { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T14:25:07Z" };
  const rawFact = "The service caches with Redis.";

  const pass1 = attachCitation(rawFact, ctx, template);
  assert.ok(pass1.endsWith("planner:main"), `pass1 should end with citation, got: ${pass1}`);

  const pass2 = attachCitation(pass1, ctx, template);
  assert.equal(pass2, pass1, "second attachCitation pass must not append another citation");

  const pass3 = attachCitation(pass2, ctx, template);
  assert.equal(pass3, pass1, "third attachCitation pass must not append another citation");

  const tokenCount = (pass3.match(/planner:main/g) ?? []).length;
  assert.equal(tokenCount, 1, "citation token must appear exactly once");
});

test("hasCitationForTemplate: '{agent}/{sessionId}' slash separator — compact token detected", () => {
  const template = "{agent}/{sessionId}";
  assert.equal(hasCitationForTemplate("planner/main", template), true);
  assert.equal(hasCitationForTemplate("Fact. planner/main", template), true);
  assert.equal(hasCitationForTemplate("see https://example.com/planner/main for docs", template), false);
});

test("hasCitationForTemplate: '{agent}-{sessionId}' dash separator — compact token detected", () => {
  const template = "{agent}-{sessionId}";
  assert.equal(hasCitationForTemplate("planner-main", template), true);
  assert.equal(hasCitationForTemplate("Fact. planner-main", template), true);
  assert.equal(hasCitationForTemplate("Fact planner-main rest", template), false);
  assert.equal(hasCitationForTemplate("no separator here", template), false);
});


test("hasCitationForTemplate (Finding 1): hyphenated prose 'long-term' must not match {agent}-{sessionId}", () => {
  assert.equal(
    hasCitationForTemplate("long-term solution", "{agent}-{sessionId}"),
    false,
    "'long-term' embedded in prose must not be classified as a citation",
  );
  assert.equal(
    hasCitationForTemplate("This is a long-term solution. planner-main", "{agent}-{sessionId}"),
    true,
    "citation token at end of fact body (after prose containing hyphen) must be detected",
  );
});

test("hasCitationForTemplate (Finding 1): slashed path 'docs/setup' in prose must not match {agent}/{sessionId}", () => {
  assert.equal(
    hasCitationForTemplate("see the docs/setup guide for details", "{agent}/{sessionId}"),
    false,
    "'docs/setup' inside a sentence must not be classified as a citation",
  );
});

test("hasCitationForTemplate (Finding 1): bracket-wrapped compact template is accepted", () => {
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

test("stripCitation (Finding 2): returns uncited input byte-for-byte unchanged", () => {
  const withDoubleSpaces = "plain prose with  double  spaces";
  assert.equal(
    stripCitation(withDoubleSpaces),
    withDoubleSpaces,
    "double spaces must be preserved when no citation is present",
  );

  const withTabs = "col1\t\tcol2\t\tcol3";
  assert.equal(
    stripCitation(withTabs),
    withTabs,
    "tab characters must be preserved when no citation is present",
  );

  const hardBreak = "line one  \nline two";
  assert.equal(
    stripCitation(hardBreak),
    hardBreak,
    "markdown hard-break (two trailing spaces before newline) must be preserved",
  );
});

test("stripCitation (Finding 2): removes citation and normalises only the join seam", () => {
  const cited = "The service uses Redis. [Source: agent=planner, session=main, ts=2026-04-10T00:00:00Z]";
  const stripped = stripCitation(cited);
  assert.equal(stripped, "The service uses Redis.");

  const citedWithInternalSpaces =
    "col1  col2 [Source: agent=a, session=s, ts=2026-04-10T00:00:00Z]";
  const strippedWithInternalSpaces = stripCitation(citedWithInternalSpaces);
  assert.ok(
    strippedWithInternalSpaces.includes("col1  col2"),
    `internal double space must be preserved, got: ${JSON.stringify(strippedWithInternalSpaces)}`,
  );
});

test("stripCitation (Finding 2): attach → strip round-trip with uncited double-space body", () => {
  const body = "col one  col two  col three";
  const ctx = { agent: "a", session: "s:1", ts: "2026-04-11T00:00:00Z" };
  const attached = attachCitation(body, ctx);
  assert.ok(hasCitation(attached), "citation must be present after attach");
  const stripped = stripCitation(attached);
  assert.equal(stripped, body, "strip must restore original body including double spaces");
});


test(
  "UM3U: ContentHashIndex.remove via stripCitation(citedContent) removes the raw-content hash (inlineSourceAttributionEnabled=true)",
  async () => {
    //
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-um3u-"));
    try {
      const rawContent = "user prefers dark mode in all applications";
      const citedContent =
        `${rawContent} [Source: agent=planner, session=chat, ts=2026-04-11T10:00:00Z]`;

      const idx = new ContentHashIndex(dir);
      await idx.load();
      idx.add(rawContent);
      await idx.save();

      assert.ok(idx.has(rawContent), "raw content hash must be present after add");
      assert.ok(!idx.has(citedContent), "cited content must hash differently from raw");

      const idxBroken = new ContentHashIndex(dir);
      await idxBroken.load();
      idxBroken.remove(citedContent); // broken: hash mismatch, no-op
      assert.ok(
        idxBroken.has(rawContent),
        "broken path: stale hash must remain because citedContent hash does not match",
      );

      const idxFixed = new ContentHashIndex(dir);
      await idxFixed.load();
      idxFixed.remove(stripCitation(citedContent)); // fixed: hash matches
      assert.ok(
        !idxFixed.has(rawContent),
        "fixed path: raw content hash must be removed after stripCitation → remove",
      );

      assert.equal(idxFixed.size, 0, "hash index must be empty after correct removal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "UM3U: re-extraction of same raw fact is NOT false-deduped after correct archive removal",
  async () => {
    //
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-um3u-reextract-"));
    try {
      const rawContent = "user likes coffee in the morning";
      const citedContent =
        `${rawContent} [Source: agent=scout, session=chat, ts=2026-04-11T09:00:00Z]`;

      const writeIdx = new ContentHashIndex(dir);
      await writeIdx.load();
      writeIdx.add(rawContent);
      await writeIdx.save();

      const archiveIdx = new ContentHashIndex(dir);
      await archiveIdx.load();
      archiveIdx.remove(stripCitation(citedContent));
      await archiveIdx.save();

      const reextractIdx = new ContentHashIndex(dir);
      await reextractIdx.load();

      assert.ok(
        !reextractIdx.has(rawContent),
        "after correct archive removal, re-extraction of the same raw fact must not be false-deduped",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);


test(
  "Option A — Test A: custom unbracketed inline citation: archive removes raw-content hash via stored contentHash",
  async () => {
    //
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-option-a-test-a-"));
    try {
      const rawContent = "user prefers tea";
      const template = "{agent} {sessionId}";
      const citedContent = attachCitation(
        rawContent,
        { agent: "planner", session: "agent:planner:main" },
        template,
      );
      assert.ok(!rawContent.includes("["), "raw content must have no brackets");

      const storage = new StorageManager(dir);
      await storage.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });

      assert.ok(
        await storage.hasFactContentHash(rawContent),
        "raw-content hash must be in the index after write",
      );

      const allMemories = await storage.readAllMemories();
      const written = allMemories.find((m) => m.content.includes("planner main") || (m.content.includes("planner") && m.content.includes("tea")));
      assert.ok(written, "written memory must be findable");
      assert.ok(
        written!.frontmatter.contentHash,
        "frontmatter.contentHash must be persisted on disk",
      );

      assert.match(
        written!.frontmatter.contentHash!,
        /^[a-f0-9]{64}$/,
        "frontmatter.contentHash must be a 64-char SHA-256 hex string",
      );

      const stateDir = path.join(dir, "state");
      const idx = new ContentHashIndex(stateDir);
      await idx.load();
      assert.ok(idx.has(rawContent), "raw-content hash must be present in the state index before archive");
      idx.removeByHash(written!.frontmatter.contentHash!);
      await idx.save();

      const idxAfter = new ContentHashIndex(stateDir);
      await idxAfter.load();
      assert.ok(
        !idxAfter.has(rawContent),
        "after archive using removeByHash(frontmatter.contentHash), raw-content hash must be removed from index",
      );

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
      assert.ok(citedContent.includes("[src:"), "cited content must use custom bracket format");
      assert.ok(!citedContent.includes("[Source:"), "must NOT use default [Source: ...] format");

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

      const stateDir = path.join(dir, "state");
      const idx = new ContentHashIndex(stateDir);
      await idx.load();
      assert.ok(idx.has(rawContent), "raw-content hash must be present in the state index before archive");
      idx.removeByHash(written!.frontmatter.contentHash!);
      await idx.save();

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
    //
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-option-a-test-c-"));
    try {
      const rawContent = "user prefers coffee";

      const idx = new ContentHashIndex(dir);
      await idx.load();
      idx.add(rawContent);
      await idx.save();

      const idxCheck = new ContentHashIndex(dir);
      await idxCheck.load();
      assert.ok(idxCheck.has(rawContent), "raw-content hash must be present before archive");

      const legacyMemory = {
        frontmatter: { contentHash: undefined as string | undefined },
        content: rawContent,
      } as unknown as import("./types.js").MemoryFile;

      if (legacyMemory.frontmatter.contentHash) {
        idxCheck.removeByHash(legacyMemory.frontmatter.contentHash);
      } else {
        idxCheck.remove(legacyMemory.content);
      }

      await idxCheck.save();

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


test(
  "Test D: archive removes hash via frontmatter.contentHash — no double hashing (round 8 regression)",
  async () => {
    //
    const dir = await mkdtemp(path.join(os.tmpdir(), "engram-test-d-double-hash-"));
    try {
      const rawContent = "user prefers tea";
      const template = DEFAULT_CITATION_FORMAT;
      const citedContent = attachCitation(
        rawContent,
        { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:00:00Z" },
        template,
      );

      const storage = new StorageManager(dir);
      await storage.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });

      assert.ok(
        await storage.hasFactContentHash(rawContent),
        "Step 1: has(rawContent) must be true after write",
      );

      const allMemories = await storage.readAllMemories();
      const written = allMemories.find((m) => m.content.includes("[Source: agent=planner"));
      assert.ok(written, "written memory must be findable");
      const storedHash = written!.frontmatter.contentHash;
      assert.ok(storedHash, "frontmatter.contentHash must be present");
      assert.match(storedHash!, /^[a-f0-9]{64}$/, "frontmatter.contentHash must be a 64-char SHA-256 hex");

      assert.equal(
        storedHash,
        ContentHashIndex.computeHash(rawContent),
        "frontmatter.contentHash must equal computeHash(rawContent)",
      );

      const stateDir = path.join(dir, "state");
      const idxBuggy = new ContentHashIndex(stateDir);
      await idxBuggy.load();
      assert.ok(idxBuggy.has(rawContent), "Step 2a-pre: hash must be present before buggy remove");
      idxBuggy.remove(storedHash!); // double-hash: hash(hash(rawContent)) — no match
      assert.ok(
        idxBuggy.has(rawContent),
        "Step 2a: buggy remove(alreadyHashedValue) must leave the hash intact — stale hash leaks",
      );

      const idxFixed = new ContentHashIndex(stateDir);
      await idxFixed.load();
      assert.ok(idxFixed.has(rawContent), "Step 2b-pre: hash must be present before fixed remove");
      idxFixed.removeByHash(storedHash!); // correct: no re-hashing
      assert.ok(
        !idxFixed.has(rawContent),
        "Step 2b: removeByHash(frontmatter.contentHash) must remove the raw-content hash",
      );
      await idxFixed.save();

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


test(
  "Finding 3 (Uru3): hasCitationForTemplate rejects user content that shares outer delimiters but wrong separators",
  () => {
    const template = "[src:{agent}:{sessionId}_{date}]";

    const realCitation = "The cache was cleared. [src:planner:main_2026-04-11]";
    assert.equal(
      hasCitationForTemplate(realCitation, template),
      true,
      "real citation matching the template separators must be detected",
    );

    const wrongSepContent = "See docs at [src:some-agent/abc123@today] for details.";
    assert.equal(
      hasCitationForTemplate(wrongSepContent, template),
      false,
      "user content with different separators must NOT be mis-flagged as a citation (Finding 3 — Uru3)",
    );

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
    const realCitation =
      "User prefers dark mode. [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]";
    assert.equal(
      hasCitationForTemplate(realCitation, DEFAULT_CITATION_FORMAT),
      true,
      "default-format citation must be detected after templateMatcher tightening",
    );

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
    const template = "[src:{agent}/{sessionId}@{date}]";

    const crossBoundaryCitation = "check [src:foo/bar/extra@2026-04-11] now";
    assert.equal(
      hasCitationForTemplate(crossBoundaryCitation, template),
      false,
      "content where a value token crosses a separator boundary must not match",
    );

    const validCitation = "Fact. [src:planner/main@2026-04-11]";
    assert.equal(
      hasCitationForTemplate(validCitation, template),
      true,
      "valid citation matching template separators must be detected",
    );
  },
);


test(
  "Fix #3 (UzK9): verbatim artifact and memory write share the same citation timestamp",
  () => {
    //
    const rawContent = "user prefers dark mode";
    const ts1 = "2026-04-11T10:00:00.000Z";
    const ts2 = "2026-04-11T10:00:00.001Z";

    const cited1 = attachCitation(rawContent, { agent: "planner", session: "s1", ts: ts1 });
    const cited2 = attachCitation(rawContent, { agent: "planner", session: "s1", ts: ts2 });

    assert.notEqual(
      cited1,
      cited2,
      "two separate attachCitation calls on raw content produce different timestamps",
    );

    const citedAgain = attachCitation(cited1, { agent: "planner", session: "s1", ts: ts2 });
    assert.equal(
      citedAgain,
      cited1,
      "attachCitation on already-cited content must be idempotent — no duplicate citation appended",
    );

    assert.equal(
      hasCitationForTemplate(cited1, DEFAULT_CITATION_FORMAT),
      true,
      "already-cited content must be detected as having a citation",
    );
  },
);


test("hasCitationForTemplate: placeholder value containing inner separator char is detected (colon in ts)", () => {
  //
  const template = "[src:{agent}:{ts}]";
  const citedText = "Fact body. [src:planner:2026-04-10T14:25:07Z]";
  assert.equal(
    hasCitationForTemplate(citedText, template),
    true,
    "citation containing a colon in the ts value must be detected",
  );
  const ctx = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T00:00:00Z" };
  const again = attachCitation(citedText, ctx, template);
  assert.equal(again, citedText, "attachCitation must not append a duplicate when citation is already present");
});

test("hasCitationForTemplate: colon-separated template still rejects text with wrong structure", () => {
  const template = "[src:{agent}:{ts}]";
  assert.equal(hasCitationForTemplate("plain text without citation", template), false);
  assert.equal(hasCitationForTemplate("no bracket prefix here planner:2026", template), false);
});

test("hasCitationForTemplate: multi-separator template detects citation when intermediate value contains sep char", () => {
  const template = "[src:{agent}:{sessionId}:{ts}]";
  const citation = "[src:planner:scout:alpha:2026-04-10T14:25:07Z]";
  assert.equal(
    hasCitationForTemplate(citation, template),
    true,
    "multi-colon citation where intermediate value contains the separator should be detected",
  );
});

test("citation matcher resists polynomial ReDoS on hostile unterminated input (CodeQL js/polynomial-redos)", () => {
  const hostile = `prefix [Source:${" ".repeat(100000)}no closing bracket`;
  const start = process.hrtime.bigint();
  const detected = hasCitation(hostile);
  const parsed = parseAllCitations(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(detected, false);
  assert.deepEqual(parsed, []);
  assert.ok(elapsedMs < 1000, `citation scan took ${elapsedMs.toFixed(1)}ms (expected < 1000ms)`);

  const valid = parseAllCitations("body [Source:  doc-1 , 2026-06-08 ]");
  assert.equal(valid.length, 1);
});

test("#3567 hasCitationForTemplate: default fast path consults configured prior templates", () => {
  // Fact written while a custom template was configured; config later reverted
  // to the default. The marker does not match the default shape, so the old
  // `template === DEFAULT_CITATION_FORMAT` fast path returned false and the
  // body was double-cited / hash-mismatched on reprocess.
  const priorTemplate = "[src:{agent}/{session}@{date}]";
  const body = "Latency improved after the index rebuild.";
  const cited = attachCitation(
    body,
    { agent: "scout", session: "agent:scout:alpha", ts: "2026-04-10T14:25:07Z" },
    priorTemplate,
  );

  // The prior template is out of history: the miss stands (documents the
  // operator contract — list prior formats in inlineSourceAttributionFormatHistory).
  assert.equal(hasCitationForTemplate(cited, DEFAULT_CITATION_FORMAT), false);

  // With the prior template declared, the same check detects it.
  assert.equal(
    hasCitationForTemplate(cited, DEFAULT_CITATION_FORMAT, [priorTemplate]),
    true,
  );
});

test("#3567 stripCitationForTemplate strips a prior-template marker under a reverted config", () => {
  const priorTemplate = "[src:{agent}/{session}@{date}]";
  const body = "Latency improved after the index rebuild.";
  const cited = attachCitation(
    body,
    { agent: "scout", session: "agent:scout:alpha", ts: "2026-04-10T14:25:07Z" },
    priorTemplate,
  );

  assert.equal(
    stripCitationForTemplate(cited, DEFAULT_CITATION_FORMAT, [priorTemplate]),
    body,
  );
});

test("#3567 attachCitation does not double-cite a body carrying a prior-template marker", () => {
  const priorTemplate = "[src:{agent}/{session}@{date}]";
  const body = "Latency improved after the index rebuild.";
  const cited = attachCitation(
    body,
    { agent: "scout", session: "agent:scout:alpha", ts: "2026-04-10T14:25:07Z" },
    priorTemplate,
  );

  const reattached = attachCitation(
    cited,
    { agent: "planner", session: "agent:planner:main", ts: "2026-06-01T00:00:00Z" },
    DEFAULT_CITATION_FORMAT,
    [priorTemplate],
  );
  assert.equal(reattached, cited);
});
