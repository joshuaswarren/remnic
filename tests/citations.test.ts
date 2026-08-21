import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOaiMemCitation,
  formatOaiMemCitation,
  buildCitationGuidance,
  sanitizeNoteForCitation,
  type CitationBlock,
  type CitationMetadata,
} from "../packages/remnic-core/src/citations.js";

// ---------------------------------------------------------------------------
// parseOaiMemCitation
// ---------------------------------------------------------------------------

test("parseOaiMemCitation: valid block with entries and rollout IDs", () => {
  const text = `Some preamble
<oai-mem-citation>
<citation_entries>
facts/fact-abc.md:1-5|note=[user prefers dark mode]
facts/fact-def.md:10-20|note=[project deadline is Friday]
</citation_entries>
<rollout_ids>
rollout-001
rollout-002
</rollout_ids>
</oai-mem-citation>
Some epilogue`;

  const result = parseOaiMemCitation(text);
  assert.ok(result);
  assert.equal(result.entries.length, 2);
  assert.deepStrictEqual(result.entries[0], {
    path: "facts/fact-abc.md",
    lineStart: 1,
    lineEnd: 5,
    note: "user prefers dark mode",
  });
  assert.deepStrictEqual(result.entries[1], {
    path: "facts/fact-def.md",
    lineStart: 10,
    lineEnd: 20,
    note: "project deadline is Friday",
  });
  assert.deepStrictEqual(result.rolloutIds, ["rollout-001", "rollout-002"]);
});

test("parseOaiMemCitation: legacy <thread_ids> tag works like <rollout_ids>", () => {
  const text = `<oai-mem-citation>
<citation_entries>
facts/fact-1.md:1-1|note=[test]
</citation_entries>
<thread_ids>
thread-abc
thread-def
</thread_ids>
</oai-mem-citation>`;

  const result = parseOaiMemCitation(text);
  assert.ok(result);
  assert.equal(result.entries.length, 1);
  assert.deepStrictEqual(result.rolloutIds, ["thread-abc", "thread-def"]);
});

test("parseOaiMemCitation: no citation block returns null", () => {
  const text = "This is just regular text with no citation block.";
  const result = parseOaiMemCitation(text);
  assert.equal(result, null);
});

test("parseOaiMemCitation: malformed entries are skipped, valid ones kept", () => {
  const text = `<oai-mem-citation>
<citation_entries>
facts/good.md:1-5|note=[valid entry]
bad line with no structure
also:bad
facts/good2.md:3-7|note=[another valid]
</citation_entries>
<rollout_ids>
id-1
</rollout_ids>
</oai-mem-citation>`;

  const result = parseOaiMemCitation(text);
  assert.ok(result);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].path, "facts/good.md");
  assert.equal(result.entries[1].path, "facts/good2.md");
});

test("parseOaiMemCitation: deduplicates rollout IDs preserving order", () => {
  const text = `<oai-mem-citation>
<citation_entries>
facts/f.md:1-1|note=[x]
</citation_entries>
<rollout_ids>
rollout-a
rollout-b
rollout-a
rollout-c
rollout-b
</rollout_ids>
</oai-mem-citation>`;

  const result = parseOaiMemCitation(text);
  assert.ok(result);
  assert.deepStrictEqual(result.rolloutIds, ["rollout-a", "rollout-b", "rollout-c"]);
});

test("parseOaiMemCitation: empty block with no entries and no IDs returns null", () => {
  const text = `<oai-mem-citation>
<citation_entries>
</citation_entries>
<rollout_ids>
</rollout_ids>
</oai-mem-citation>`;

  const result = parseOaiMemCitation(text);
  assert.equal(result, null);
});

test("parseOaiMemCitation: entry with empty note is valid", () => {
  const text = `<oai-mem-citation>
<citation_entries>
facts/f.md:1-1|note=[]
</citation_entries>
<rollout_ids>
id-1
</rollout_ids>
</oai-mem-citation>`;

  const result = parseOaiMemCitation(text);
  assert.ok(result);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].note, "");
});

test("parseOaiMemCitation: path with colons splits on the LAST colon before range", () => {
  // File paths can contain colons on some systems (e.g., Windows drive letters,
  // macOS resource forks). The parser must split on the last `:` before the
  // digit range, not the first.
  const text = `<oai-mem-citation>
<citation_entries>
C:\\Users\\data:facts/fact-1.md:10-20|note=[colon in path]
</citation_entries>
<rollout_ids>
id-1
</rollout_ids>
</oai-mem-citation>`;

  const result = parseOaiMemCitation(text);
  assert.ok(result);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, "C:\\Users\\data:facts/fact-1.md");
  assert.equal(result.entries[0].lineStart, 10);
  assert.equal(result.entries[0].lineEnd, 20);
  assert.equal(result.entries[0].note, "colon in path");
});

test("parseOaiMemCitation: simple path still parses correctly after regex change", () => {
  const text = `<oai-mem-citation>
<citation_entries>
facts/simple.md:5-15|note=[simple test]
</citation_entries>
<rollout_ids>
id-1
</rollout_ids>
</oai-mem-citation>`;

  const result = parseOaiMemCitation(text);
  assert.ok(result);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, "facts/simple.md");
  assert.equal(result.entries[0].lineStart, 5);
  assert.equal(result.entries[0].lineEnd, 15);
});

// ---------------------------------------------------------------------------
// formatOaiMemCitation
// ---------------------------------------------------------------------------

test("formatOaiMemCitation: produces well-formed XML block", () => {
  const block: CitationBlock = {
    entries: [
      { path: "facts/fact-1.md", lineStart: 1, lineEnd: 5, note: "test note" },
    ],
    rolloutIds: ["rollout-abc"],
  };

  const formatted = formatOaiMemCitation(block);
  assert.ok(formatted.includes("<oai-mem-citation>"));
  assert.ok(formatted.includes("</oai-mem-citation>"));
  assert.ok(formatted.includes("<citation_entries>"));
  assert.ok(formatted.includes("facts/fact-1.md:1-5|note=[test note]"));
  assert.ok(formatted.includes("<rollout_ids>"));
  assert.ok(formatted.includes("rollout-abc"));
});

test("formatOaiMemCitation: round-trip parse(format(block)) preserves data", () => {
  const original: CitationBlock = {
    entries: [
      { path: "facts/fact-a.md", lineStart: 1, lineEnd: 10, note: "memory about dogs" },
      { path: "facts/fact-b.md", lineStart: 3, lineEnd: 7, note: "project deadline" },
    ],
    rolloutIds: ["rollout-001", "rollout-002"],
  };

  const formatted = formatOaiMemCitation(original);
  const parsed = parseOaiMemCitation(formatted);

  assert.ok(parsed);
  assert.deepStrictEqual(parsed.entries, original.entries);
  assert.deepStrictEqual(parsed.rolloutIds, original.rolloutIds);
});

// ---------------------------------------------------------------------------
// buildCitationGuidance
// ---------------------------------------------------------------------------

test("buildCitationGuidance: contains template with citation entries", () => {
  const citations: CitationMetadata[] = [
    {
      memoryId: "fact-1",
      path: "facts/fact-1.md",
      lineStart: 1,
      lineEnd: 1,
      rolloutId: "rollout-abc",
      noteDefault: "user likes coffee",
    },
    {
      memoryId: "fact-2",
      path: "facts/fact-2.md",
      lineStart: 1,
      lineEnd: 1,
      noteDefault: "project uses TypeScript",
    },
  ];

  const guidance = buildCitationGuidance(citations);
  assert.ok(guidance.includes("[Remnic citation guidance]"));
  assert.ok(guidance.includes("<oai-mem-citation>"));
  assert.ok(guidance.includes("facts/fact-1.md:1-1|note=[user likes coffee]"));
  assert.ok(guidance.includes("facts/fact-2.md:1-1|note=[project uses TypeScript]"));
  assert.ok(guidance.includes("rollout-abc"));
  assert.ok(guidance.includes("<rollout_ids>"));
  assert.ok(guidance.includes("</oai-mem-citation>"));
});

test("buildCitationGuidance: empty citations returns empty string", () => {
  const guidance = buildCitationGuidance([]);
  assert.equal(guidance, "");
});

test("buildCitationGuidance: deduplicates rollout IDs", () => {
  const citations: CitationMetadata[] = [
    {
      memoryId: "fact-1",
      path: "facts/fact-1.md",
      lineStart: 1,
      lineEnd: 1,
      rolloutId: "rollout-shared",
      noteDefault: "first",
    },
    {
      memoryId: "fact-2",
      path: "facts/fact-2.md",
      lineStart: 1,
      lineEnd: 1,
      rolloutId: "rollout-shared",
      noteDefault: "second",
    },
  ];

  const guidance = buildCitationGuidance(citations);
  // Count occurrences of "rollout-shared" within the rollout_ids section.
  const rolloutSection = guidance.split("<rollout_ids>")[1]?.split("</rollout_ids>")[0] ?? "";
  const occurrences = rolloutSection.split("rollout-shared").length - 1;
  assert.equal(occurrences, 1, "rollout ID should appear only once after dedup");
});

test("buildCitationGuidance: citations without rolloutId produce empty rollout section", () => {
  const citations: CitationMetadata[] = [
    {
      memoryId: "fact-1",
      path: "facts/fact-1.md",
      lineStart: 1,
      lineEnd: 1,
      noteDefault: "no rollout",
    },
  ];

  const guidance = buildCitationGuidance(citations);
  assert.ok(guidance.includes("<rollout_ids>"));
  // The rollout_ids section should be empty (just the tags with nothing between).
  const rolloutSection = guidance.split("<rollout_ids>")[1]?.split("</rollout_ids>")[0] ?? "";
  assert.equal(rolloutSection.trim(), "");
});

// ---------------------------------------------------------------------------
// sanitizeNoteForCitation
// ---------------------------------------------------------------------------

test("sanitizeNoteForCitation: replaces LF with space", () => {
  assert.equal(sanitizeNoteForCitation("line1\nline2"), "line1 line2");
});

test("sanitizeNoteForCitation: replaces CR+LF with space", () => {
  assert.equal(sanitizeNoteForCitation("line1\r\nline2"), "line1 line2");
});

test("sanitizeNoteForCitation: replaces multiple consecutive newlines with a single space", () => {
  assert.equal(sanitizeNoteForCitation("line1\n\n\nline2"), "line1 line2");
});

test("sanitizeNoteForCitation: preserves notes without newlines", () => {
  assert.equal(sanitizeNoteForCitation("already clean"), "already clean");
});

test("sanitizeNoteForCitation: empty string stays empty", () => {
  assert.equal(sanitizeNoteForCitation(""), "");
});

// ---------------------------------------------------------------------------
// formatOaiMemCitation: multi-line notes are sanitized
// ---------------------------------------------------------------------------

test("formatOaiMemCitation: multi-line note is flattened to one line", () => {
  const block: CitationBlock = {
    entries: [
      { path: "facts/f.md", lineStart: 1, lineEnd: 5, note: "line1\nline2\nline3" },
    ],
    rolloutIds: ["rollout-1"],
  };

  const formatted = formatOaiMemCitation(block);
  // The note should NOT contain literal newlines.
  assert.ok(formatted.includes("|note=[line1 line2 line3]"));
  // Round-trip must succeed: parsed note matches sanitized version.
  const parsed = parseOaiMemCitation(formatted);
  assert.ok(parsed);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].note, "line1 line2 line3");
});

test("formatOaiMemCitation: CR+LF in note is flattened", () => {
  const block: CitationBlock = {
    entries: [
      { path: "facts/f.md", lineStart: 1, lineEnd: 1, note: "a\r\nb" },
    ],
    rolloutIds: [],
  };

  const formatted = formatOaiMemCitation(block);
  assert.ok(formatted.includes("|note=[a b]"));
});

// ---------------------------------------------------------------------------
// buildCitationGuidance: multi-line noteDefault is sanitized
// ---------------------------------------------------------------------------

test("buildCitationGuidance: multi-line noteDefault is flattened", () => {
  const citations: CitationMetadata[] = [
    {
      memoryId: "fact-1",
      path: "facts/fact-1.md",
      lineStart: 1,
      lineEnd: 1,
      noteDefault: "first line\nsecond line",
    },
  ];

  const guidance = buildCitationGuidance(citations);
  assert.ok(guidance.includes("|note=[first line second line]"));
  // Ensure the guidance block can be parsed back correctly.
  const parsed = parseOaiMemCitation(guidance);
  assert.ok(parsed);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].note, "first line second line");
});
