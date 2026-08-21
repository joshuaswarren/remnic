/**
 * Tests for `remnic patterns list` and `remnic patterns explain <id>`
 * CLI helpers (issue #687 PR 4/4).
 *
 * Everything here exercises pure functions from `patterns-cli.ts` — no
 * orchestrator needed.  The tests are organised into four suites:
 *
 *   1. Flag validation helpers (parsePatternsFormat, parsePatternsLimit,
 *      parsePatternsCategory, parsePatternsSince,
 *      parsePatternsListOptions, parsePatternsExplainOptions)
 *   2. collectPatternMemories — filtering, sorting, and slicing
 *   3. explainPatternMemory   — canonical lookup + cluster assembly
 *   4. Renderers              — renderPatternsList + renderPatternExplain
 *      in text / markdown / json output forms
 *
 * Test data is fully synthetic (CLAUDE.md public-repo rule: no real
 * conversation content or user identifiers).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  collectPatternMemories,
  explainPatternMemory,
  parsePatternsCategory,
  parsePatternsExplainOptions,
  parsePatternsFormat,
  parsePatternsLimit,
  parsePatternsListOptions,
  parsePatternsSince,
  renderPatternExplain,
  renderPatternsList,
  type PatternExplainDetail,
  type PatternListRow,
} from "../../packages/remnic-core/src/patterns-cli.js";
import type { MemoryFile } from "../../packages/remnic-core/src/types.js";

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function makeMemory(
  id: string,
  opts: {
    reinforcementCount?: number;
    lastReinforcedAt?: string;
    category?: string;
    status?: string;
    supersededBy?: string;
    supersededAt?: string;
    derivedFrom?: string[];
    derivedVia?: string;
    content?: string;
  } = {},
): MemoryFile {
  return {
    path: `facts/2026-01-01/${id}.md`,
    frontmatter: {
      id,
      category: (opts.category ?? "fact") as MemoryFile["frontmatter"]["category"],
      status: (opts.status ?? "active") as MemoryFile["frontmatter"]["status"],
      ...(opts.reinforcementCount !== undefined
        ? { reinforcement_count: opts.reinforcementCount }
        : {}),
      ...(opts.lastReinforcedAt !== undefined
        ? { last_reinforced_at: opts.lastReinforcedAt }
        : {}),
      ...(opts.supersededBy !== undefined
        ? { supersededBy: opts.supersededBy }
        : {}),
      ...(opts.supersededAt !== undefined
        ? { supersededAt: opts.supersededAt }
        : {}),
      ...(opts.derivedFrom !== undefined
        ? { derived_from: opts.derivedFrom }
        : {}),
      ...(opts.derivedVia !== undefined
        ? { derived_via: opts.derivedVia as MemoryFile["frontmatter"]["derived_via"] }
        : {}),
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    } as MemoryFile["frontmatter"],
    content: opts.content ?? `Content for ${id}`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Suite 1 — Flag validation
// ───────────────────────────────────────────────────────────────────────────

test("parsePatternsFormat returns text for undefined/null", () => {
  assert.equal(parsePatternsFormat(undefined), "text");
  assert.equal(parsePatternsFormat(null), "text");
});

test("parsePatternsFormat accepts valid format strings", () => {
  assert.equal(parsePatternsFormat("text"), "text");
  assert.equal(parsePatternsFormat("markdown"), "markdown");
  assert.equal(parsePatternsFormat("json"), "json");
});

test("parsePatternsFormat rejects invalid format with listed-options error (rule 51)", () => {
  assert.throws(
    () => parsePatternsFormat("xml"),
    /--format expects one of text, markdown, json; got "xml"/,
  );
  assert.throws(
    () => parsePatternsFormat(""),
    /--format expects one of/,
  );
});

test("parsePatternsLimit returns undefined for missing", () => {
  assert.equal(parsePatternsLimit(undefined), undefined);
  assert.equal(parsePatternsLimit(null), undefined);
});

test("parsePatternsLimit coerces numeric strings", () => {
  assert.equal(parsePatternsLimit("10"), 10);
  assert.equal(parsePatternsLimit(5), 5);
});

test("parsePatternsLimit rejects non-positive and non-integer values", () => {
  assert.throws(() => parsePatternsLimit(0), /--limit expects a positive integer/);
  assert.throws(() => parsePatternsLimit(-1), /--limit expects a positive integer/);
  assert.throws(() => parsePatternsLimit(2.5), /--limit expects a positive integer/);
  assert.throws(() => parsePatternsLimit("abc"), /--limit expects a positive integer/);
});

test("parsePatternsCategory returns undefined for missing", () => {
  assert.equal(parsePatternsCategory(undefined), undefined);
  assert.equal(parsePatternsCategory(null), undefined);
});

test("parsePatternsCategory splits comma-separated list and deduplicates", () => {
  const result = parsePatternsCategory("fact,preference,fact");
  assert.deepEqual(result, ["fact", "preference"]);
});

test("parsePatternsCategory trims whitespace around tokens", () => {
  const result = parsePatternsCategory("  fact ,  preference  ");
  assert.deepEqual(result, ["fact", "preference"]);
});

test("parsePatternsCategory rejects empty string and all-whitespace", () => {
  assert.throws(
    () => parsePatternsCategory(""),
    /--category expects at least one non-empty category name/,
  );
  assert.throws(
    () => parsePatternsCategory("   ,  "),
    /--category expects at least one non-empty category name/,
  );
});

test("parsePatternsCategory rejects non-string value", () => {
  assert.throws(
    () => parsePatternsCategory(42 as unknown),
    /--category expects a comma-separated list/,
  );
});

test("parsePatternsSince returns undefined for missing", () => {
  assert.equal(parsePatternsSince(undefined), undefined);
  assert.equal(parsePatternsSince(null), undefined);
});

test("parsePatternsSince round-trips a valid ISO timestamp", () => {
  const result = parsePatternsSince("2026-04-01T00:00:00Z");
  assert.ok(typeof result === "string");
  // Must be a valid parseable date
  assert.ok(Number.isFinite(Date.parse(result!)));
});

test("parsePatternsSince rejects non-date strings", () => {
  assert.throws(
    () => parsePatternsSince("not-a-date"),
    /ISO 8601/,
  );
  assert.throws(
    () => parsePatternsSince(""),
    /--since expects an ISO 8601 timestamp/,
  );
});

test("parsePatternsSince rejects non-ISO date formats (strict validation)", () => {
  // Non-ISO locale-style dates must be rejected even though Date.parse accepts them.
  assert.throws(() => parsePatternsSince("04/01/2026"), /ISO 8601/);
  assert.throws(() => parsePatternsSince("December 25 2026"), /ISO 8601/);
  // Calendar overflow must be rejected.
  assert.throws(() => parsePatternsSince("2026-02-30T00:00:00Z"), /overflow|out of range|calendar/i);
});

test("parsePatternsSince rejects non-string values", () => {
  assert.throws(
    () => parsePatternsSince(12345 as unknown),
    /--since expects an ISO 8601 timestamp/,
  );
});

test("parsePatternsListOptions assembles option bag", () => {
  const result = parsePatternsListOptions({
    format: "json",
    limit: "5",
    category: "fact",
    since: "2026-01-01T00:00:00Z",
  });
  assert.equal(result.format, "json");
  assert.equal(result.limit, 5);
  assert.deepEqual(result.categories, ["fact"]);
  assert.ok(typeof result.sinceIso === "string");
});

test("parsePatternsListOptions uses text format and no limit/category/since when all absent", () => {
  const result = parsePatternsListOptions({});
  assert.equal(result.format, "text");
  assert.equal(result.limit, undefined);
  assert.equal(result.categories, undefined);
  assert.equal(result.sinceIso, undefined);
});

test("parsePatternsExplainOptions rejects missing or empty memoryId", () => {
  assert.throws(
    () => parsePatternsExplainOptions("", {}),
    /patterns explain: <memoryId> is required/,
  );
  assert.throws(
    () => parsePatternsExplainOptions("   ", {}),
    /patterns explain: <memoryId> is required/,
  );
  assert.throws(
    () => parsePatternsExplainOptions(undefined, {}),
    /patterns explain: <memoryId> is required/,
  );
});

test("parsePatternsExplainOptions returns trimmed id and defaults format to text", () => {
  const result = parsePatternsExplainOptions("  mem-abc  ", {});
  assert.equal(result.id, "mem-abc");
  assert.equal(result.format, "text");
});

test("parsePatternsExplainOptions forwards --format", () => {
  const result = parsePatternsExplainOptions("mem-abc", { format: "json" });
  assert.equal(result.format, "json");
});

// ───────────────────────────────────────────────────────────────────────────
// Suite 2 — collectPatternMemories
// ───────────────────────────────────────────────────────────────────────────

test("collectPatternMemories drops memories with no reinforcement_count", () => {
  const memories = [
    makeMemory("a", {}),
    makeMemory("b", { reinforcementCount: 0 }),
    makeMemory("c", { reinforcementCount: 3 }),
  ];
  const rows = collectPatternMemories(memories, { format: "text" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "c");
});

test("collectPatternMemories drops memories with reinforcement_count <= 0", () => {
  const memories = [
    makeMemory("a", { reinforcementCount: -1 }),
    makeMemory("b", { reinforcementCount: 0 }),
    makeMemory("c", { reinforcementCount: 1 }),
  ];
  const rows = collectPatternMemories(memories, { format: "text" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "c");
});

test("collectPatternMemories sorts by reinforcementCount desc, then lastReinforcedAt desc, then id asc (rule 19)", () => {
  const memories = [
    makeMemory("b", { reinforcementCount: 5, lastReinforcedAt: "2026-04-01T00:00:00Z" }),
    makeMemory("a", { reinforcementCount: 5, lastReinforcedAt: "2026-04-02T00:00:00Z" }),
    makeMemory("c", { reinforcementCount: 3, lastReinforcedAt: "2026-04-03T00:00:00Z" }),
    makeMemory("d", { reinforcementCount: 5, lastReinforcedAt: "2026-04-02T00:00:00Z" }),
  ];
  const rows = collectPatternMemories(memories, { format: "text" });
  // Primary: count desc: a,b,d (all 5), c (3)
  // Secondary (same count 5): lastReinforcedAt desc: a/d (2026-04-02) before b (2026-04-01)
  // Tertiary (same count + same ts): id asc: a before d
  assert.equal(rows[0].id, "a");
  assert.equal(rows[1].id, "d");
  assert.equal(rows[2].id, "b");
  assert.equal(rows[3].id, "c");
});

test("collectPatternMemories sort treats malformed lastReinforcedAt as 0 (NaN guard)", () => {
  // A malformed timestamp must not produce NaN from the comparator, which
  // would violate the sort contract and produce non-deterministic ordering
  // (CLAUDE.md rule 19 + Cursor Medium review comment).
  const memories = [
    makeMemory("a", { reinforcementCount: 2, lastReinforcedAt: "pending" }),  // malformed
    makeMemory("b", { reinforcementCount: 2, lastReinforcedAt: "2026-04-10T00:00:00Z" }),  // valid
    makeMemory("c", { reinforcementCount: 2 }),  // absent
  ];
  // Should not throw and must produce a deterministic result.
  const rows = collectPatternMemories(memories, { format: "text" });
  assert.equal(rows.length, 3);
  // b has a valid ts so it sorts first; a and c both resolve to 0 so id asc breaks the tie.
  assert.equal(rows[0].id, "b");
  assert.equal(rows[1].id, "a");
  assert.equal(rows[2].id, "c");
});

test("collectPatternMemories applies category filter", () => {
  const memories = [
    makeMemory("a", { reinforcementCount: 2, category: "fact" }),
    makeMemory("b", { reinforcementCount: 3, category: "preference" }),
    makeMemory("c", { reinforcementCount: 1, category: "fact" }),
  ];
  const rows = collectPatternMemories(memories, {
    format: "text",
    categories: ["fact"],
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.category === "fact"));
});

test("collectPatternMemories applies --since filter: drops memories with no lastReinforcedAt", () => {
  const memories = [
    makeMemory("a", { reinforcementCount: 2 }),                               // no lastReinforcedAt
    makeMemory("b", { reinforcementCount: 2, lastReinforcedAt: "2026-04-15T00:00:00Z" }),
  ];
  const rows = collectPatternMemories(memories, {
    format: "text",
    sinceIso: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "b");
});

test("collectPatternMemories --since boundary: includes ts >= sinceMs, excludes ts < sinceMs", () => {
  const since = "2026-04-10T00:00:00.000Z";
  const memories = [
    makeMemory("early", { reinforcementCount: 2, lastReinforcedAt: "2026-04-09T23:59:59Z" }),
    makeMemory("exact", { reinforcementCount: 2, lastReinforcedAt: "2026-04-10T00:00:00Z" }),
    makeMemory("later", { reinforcementCount: 2, lastReinforcedAt: "2026-04-11T00:00:00Z" }),
  ];
  const rows = collectPatternMemories(memories, { format: "text", sinceIso: since });
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes("early"));
  assert.ok(ids.includes("exact"));
  assert.ok(ids.includes("later"));
});

test("collectPatternMemories respects --limit (default 50)", () => {
  const memories = Array.from({ length: 60 }, (_, i) =>
    makeMemory(`mem-${String(i).padStart(3, "0")}`, { reinforcementCount: i + 1 }),
  );
  const rows = collectPatternMemories(memories, { format: "text" });
  assert.equal(rows.length, 50);
});

test("collectPatternMemories respects explicit --limit", () => {
  const memories = Array.from({ length: 20 }, (_, i) =>
    makeMemory(`m${i}`, { reinforcementCount: 1 }),
  );
  const rows = collectPatternMemories(memories, { format: "text", limit: 5 });
  assert.equal(rows.length, 5);
});

test("collectPatternMemories returns empty array when no memories qualify", () => {
  const rows = collectPatternMemories([], { format: "text" });
  assert.deepEqual(rows, []);
});

// ───────────────────────────────────────────────────────────────────────────
// Suite 3 — explainPatternMemory
// ───────────────────────────────────────────────────────────────────────────

test("explainPatternMemory returns null for unknown id", () => {
  const result = explainPatternMemory([], "does-not-exist");
  assert.equal(result, null);
});

test("explainPatternMemory returns null when reinforcement_count is missing", () => {
  const memories = [makeMemory("x", {})];
  assert.equal(explainPatternMemory(memories, "x"), null);
});

test("explainPatternMemory returns null when reinforcement_count <= 0", () => {
  const memories = [makeMemory("x", { reinforcementCount: 0 })];
  assert.equal(explainPatternMemory(memories, "x"), null);
});

test("explainPatternMemory returns full detail for a valid canonical", () => {
  const memories = [
    makeMemory("canon", {
      reinforcementCount: 4,
      lastReinforcedAt: "2026-04-20T00:00:00Z",
      derivedFrom: ["mem-old", "mem-older"],
      derivedVia: "pattern-reinforcement",
      content: "The canonical body.",
    }),
  ];
  const detail = explainPatternMemory(memories, "canon");
  assert.ok(detail !== null);
  assert.equal(detail!.id, "canon");
  assert.equal(detail!.reinforcementCount, 4);
  assert.equal(detail!.lastReinforcedAt, "2026-04-20T00:00:00Z");
  assert.equal(detail!.derivedVia, "pattern-reinforcement");
  assert.equal(detail!.canonicalContent, "The canonical body.");
  assert.equal(detail!.derivedFrom.length, 2);
  assert.equal(detail!.clusterMembers.length, 0);
});

test("explainPatternMemory parses derived_from source ids and legacy path versions correctly", () => {
  const memories = [
    makeMemory("canon", {
      reinforcementCount: 2,
      derivedFrom: [
        "mem-source-id",
        "entity:person:Jane",
        "global:42",
        "facts/2026-01-01/mem.md:5",
        "facts/2026-01-01/also-bad:notanumber",
        "facts/2026-01-01/missing-version.md",
      ],
    }),
  ];
  const detail = explainPatternMemory(memories, "canon")!;
  assert.equal(detail.derivedFrom[0].path, "mem-source-id");
  assert.equal(detail.derivedFrom[0].version, null);
  assert.equal(detail.derivedFrom[0].malformed, undefined);
  assert.equal(detail.derivedFrom[1].path, "entity:person:Jane");
  assert.equal(detail.derivedFrom[1].version, null);
  assert.equal(detail.derivedFrom[1].malformed, undefined);
  assert.equal(detail.derivedFrom[2].path, "global:42");
  assert.equal(detail.derivedFrom[2].version, null);
  assert.equal(detail.derivedFrom[2].malformed, undefined);
  assert.equal(detail.derivedFrom[3].path, "facts/2026-01-01/mem.md");
  assert.equal(detail.derivedFrom[3].version, 5);
  assert.equal(detail.derivedFrom[3].malformed, undefined);
  assert.equal(detail.derivedFrom[4].path, "facts/2026-01-01/also-bad:notanumber");
  assert.equal(detail.derivedFrom[4].version, null);
  assert.equal(detail.derivedFrom[4].malformed, true);
  assert.equal(detail.derivedFrom[5].path, "facts/2026-01-01/missing-version.md");
  assert.equal(detail.derivedFrom[5].version, null);
  assert.equal(detail.derivedFrom[5].malformed, true);
});

test("explainPatternMemory collects cluster members sorted supersededAt desc then id asc", () => {
  const memories = [
    makeMemory("canon", { reinforcementCount: 3 }),
    makeMemory("member-b", {
      supersededBy: "canon",
      supersededAt: "2026-04-10T00:00:00Z",
      status: "superseded",
    }),
    makeMemory("member-a", {
      supersededBy: "canon",
      supersededAt: "2026-04-12T00:00:00Z",
      status: "superseded",
    }),
    makeMemory("member-c", {
      supersededBy: "canon",
      supersededAt: "2026-04-10T00:00:00Z",
      status: "superseded",
    }),
  ];
  const detail = explainPatternMemory(memories, "canon")!;
  assert.equal(detail.clusterMembers.length, 3);
  // Sort: a (apr-12) > b,c (apr-10 alphabetical)
  assert.equal(detail.clusterMembers[0].id, "member-a");
  assert.equal(detail.clusterMembers[1].id, "member-b");
  assert.equal(detail.clusterMembers[2].id, "member-c");
});

test("explainPatternMemory cluster sort treats malformed supersededAt as 0 (NaN guard)", () => {
  // Malformed supersededAt must not produce NaN from comparator (same fix as
  // collectPatternMemories — Cursor Medium review comment, both locations).
  const memories = [
    makeMemory("canon", { reinforcementCount: 2 }),
    makeMemory("mx", { supersededBy: "canon", supersededAt: "not-a-date", status: "superseded" }),
    makeMemory("my", { supersededBy: "canon", supersededAt: "2026-04-05T00:00:00Z", status: "superseded" }),
    makeMemory("mz", { supersededBy: "canon", status: "superseded" }),  // absent
  ];
  // Should not throw, must produce deterministic result.
  const detail = explainPatternMemory(memories, "canon")!;
  assert.equal(detail.clusterMembers.length, 3);
  // my has a valid ts so it sorts first; mx (malformed→0) and mz (absent→0) follow by id asc.
  assert.equal(detail.clusterMembers[0].id, "my");
  assert.equal(detail.clusterMembers[1].id, "mx");
  assert.equal(detail.clusterMembers[2].id, "mz");
});

test("explainPatternMemory does not include memories that supersede a different id", () => {
  const memories = [
    makeMemory("canon", { reinforcementCount: 2 }),
    makeMemory("other-canon", { reinforcementCount: 1 }),
    makeMemory("member", { supersededBy: "other-canon", status: "superseded" }),
  ];
  const detail = explainPatternMemory(memories, "canon")!;
  assert.equal(detail.clusterMembers.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// Suite 4 — Renderers
// ───────────────────────────────────────────────────────────────────────────

const sampleRows: PatternListRow[] = [
  {
    id: "mem-001",
    category: "fact",
    reinforcementCount: 7,
    lastReinforcedAt: "2026-04-20T00:00:00Z",
    status: "active",
    preview: "First line of content",
    path: "facts/2026-01-01/mem-001.md",
  },
  {
    id: "mem-002",
    category: "preference",
    reinforcementCount: 3,
    status: "active",
    preview: "Another memory preview",
    path: "facts/2026-01-01/mem-002.md",
  },
];

test("renderPatternsList text format shows count, id, and preview", () => {
  const output = renderPatternsList(sampleRows, "text");
  assert.ok(output.includes("[7x] mem-001"));
  assert.ok(output.includes("First line of content"));
  assert.ok(output.includes("[3x] mem-002"));
});

test("renderPatternsList text format shows no-results message on empty input", () => {
  const output = renderPatternsList([], "text");
  assert.ok(output.includes("No reinforced patterns found."));
});

test("renderPatternsList markdown format renders a table header", () => {
  const output = renderPatternsList(sampleRows, "markdown");
  assert.ok(output.includes("# Pattern memories"));
  assert.ok(output.includes("| Count | ID |"));
  assert.ok(output.includes("`mem-001`"));
});

test("renderPatternsList markdown empty shows italicised no-result message", () => {
  const output = renderPatternsList([], "markdown");
  assert.ok(output.includes("_No reinforced patterns found._"));
});

test("renderPatternsList json format produces valid JSON with rows array", () => {
  const output = renderPatternsList(sampleRows, "json");
  const parsed = JSON.parse(output);
  assert.ok(Array.isArray(parsed.rows));
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].id, "mem-001");
});

test("renderPatternsList json format on empty input has empty rows array", () => {
  const parsed = JSON.parse(renderPatternsList([], "json"));
  assert.deepEqual(parsed.rows, []);
});

test("renderPatternsList markdown escapes backslashes before pipes in preview (CodeQL fix)", () => {
  // Backslash must be escaped before pipe so a literal `\` in content is not
  // misinterpreted as part of a `\|` escape sequence by Markdown renderers.
  const rows: PatternListRow[] = [
    {
      id: "mem-bs",
      category: "fact",
      reinforcementCount: 1,
      status: "active",
      preview: "path\\to\\file|extra",
      path: "facts/mem-bs.md",
    },
  ];
  const output = renderPatternsList(rows, "markdown");
  // Backslash should be doubled; pipe should be escaped.
  assert.ok(output.includes("path\\\\to\\\\file\\|extra"), `Got: ${output}`);
});

const sampleDetail: PatternExplainDetail = {
  id: "mem-001",
  category: "fact",
  reinforcementCount: 7,
  lastReinforcedAt: "2026-04-20T00:00:00Z",
  status: "active",
  derivedVia: "pattern-reinforcement",
  canonicalContent: "The canonical fact body.",
  canonicalPath: "facts/2026-01-01/mem-001.md",
  derivedFrom: [
    { ref: "mem-old", path: "mem-old", version: null },
    { ref: "mem-older", path: "mem-older", version: null },
  ],
  clusterMembers: [
    {
      id: "mem-superseded-1",
      status: "superseded",
      supersededAt: "2026-04-10T00:00:00Z",
      path: "facts/2026-01-01/mem-superseded-1.md",
      preview: "Old version content",
    },
  ],
};

test("renderPatternExplain text format shows all key fields", () => {
  const output = renderPatternExplain(sampleDetail, "text");
  assert.ok(output.includes("Pattern: mem-001"));
  assert.ok(output.includes("reinforcement_count: 7"));
  assert.ok(output.includes("The canonical fact body."));
  assert.ok(output.includes("mem-old"));
  assert.ok(output.includes("mem-superseded-1"));
});

test("renderPatternExplain markdown format shows heading and sections", () => {
  const output = renderPatternExplain(sampleDetail, "markdown");
  assert.ok(output.includes("# Pattern: `mem-001`"));
  assert.ok(output.includes("## Canonical content"));
  assert.ok(output.includes("## Derived from (2)"));
  assert.ok(output.includes("## Cluster members (1)"));
  assert.ok(output.includes("`mem-old`"));
});

test("renderPatternExplain json format produces valid JSON", () => {
  const parsed = JSON.parse(renderPatternExplain(sampleDetail, "json"));
  assert.equal(parsed.id, "mem-001");
  assert.equal(parsed.reinforcementCount, 7);
  assert.equal(parsed.derivedFrom.length, 2);
  assert.equal(parsed.clusterMembers.length, 1);
});

test("renderPatternExplain shows (none) for empty derived_from and cluster members in text", () => {
  const empty: PatternExplainDetail = {
    ...sampleDetail,
    derivedFrom: [],
    clusterMembers: [],
  };
  const output = renderPatternExplain(empty, "text");
  assert.ok(output.includes("Derived from (0):\n  (none)"));
  assert.ok(output.includes("Cluster members (0):\n  (none)"));
});

test("renderPatternExplain shows italicised messages for empty sections in markdown", () => {
  const empty: PatternExplainDetail = {
    ...sampleDetail,
    derivedFrom: [],
    clusterMembers: [],
  };
  const output = renderPatternExplain(empty, "markdown");
  assert.ok(output.includes("_No derived_from entries recorded._"));
  assert.ok(output.includes("_No superseded members reference this canonical._"));
});

test("renderPatternExplain handles missing lastReinforcedAt gracefully", () => {
  const noTs: PatternExplainDetail = {
    ...sampleDetail,
    lastReinforcedAt: undefined,
  };
  const output = renderPatternExplain(noTs, "text");
  assert.ok(output.includes("last_reinforced_at: —"));
});

test("renderPatternExplain handles malformed derived_from version as (malformed) in markdown", () => {
  const withMalformed: PatternExplainDetail = {
    ...sampleDetail,
    derivedFrom: [
      {
        ref: "facts/old.md:notanumber",
        path: "facts/old.md",
        version: null,
        malformed: true,
      },
    ],
  };
  const output = renderPatternExplain(withMalformed, "markdown");
  assert.ok(output.includes("(malformed)"));
});
