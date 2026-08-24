import assert from "node:assert/strict";
import test from "node:test";

import { stripRemnicOwnedRegions } from "./journal-strip.js";

const START = (name = "timeline") => `<!-- remnic:${name}:start -->`;
const END = (name = "timeline") => `<!-- remnic:${name}:end -->`;

test("removes a marker pair and keeps user text", () => {
  const text = ["Morning standup.", START(), "9:00 deep work", END(), "Wrote the parser."].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, "Morning standup.\nWrote the parser.");
  assert.deepEqual(result.warnings, []);
});

test("keeps one blank line where a removal doubled it", () => {
  const text = ["Before.", "", START(), "generated", END(), "", "After."].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, []).text, "Before.\n\nAfter.");
});

test("removes two distinct marker pairs", () => {
  const text = [
    "head",
    START("timeline"),
    "timeline body",
    END("timeline"),
    "middle",
    START("digest"),
    "digest body",
    END("digest"),
    "tail",
  ].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, "head\nmiddle\ntail");
  assert.deepEqual(result.warnings, []);
});

test("strips an unterminated start marker to the end and warns", () => {
  const text = ["kept", START(), "generated", "later user text"].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, "kept");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /unclosed remnic region "timeline"/);
});

test("an unmatched end marker fails closed: everything before it is stripped, with a warning", () => {
  // A pair split across the section boundary leaves a bare END inside the
  // journal section; text before it is presumed published output.
  const text = ["Before.", END(), "After."].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, "After.");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /unmatched remnic region end "timeline"/);
});

test("matched pairs after an unmatched end are still removed", () => {
  const text = ["leaked", END(), "kept", START(), "owned", END(), "also kept"].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, "kept\nalso kept");
});

test("removes an owned heading section up to the next same-level heading", () => {
  const text = ["## Journal", "intro", "## Timeline", "card one", "## Notes", "kept"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]).text, "## Journal\nintro\n## Notes\nkept");
});

test("does not end an owned section at a deeper heading", () => {
  const text = [
    "## Journal",
    "## Timeline",
    "card one",
    "### Deep",
    "deep card",
    "## Notes",
    "kept",
  ].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]).text, "## Journal\n## Notes\nkept");
});

test("preserves a non-owned heading section", () => {
  const text = ["## Journal", "## Timeline", "card one", "## Notes", "kept"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Digest"]).text, text);
});

test("ignores blank and whitespace owned heading entries", () => {
  const text = ["## Timeline", "card one", ""].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["", "   ", "\t"]).text, text);
});

test("trims configured owned heading entries", () => {
  const text = ["## Timeline", "card", "## Notes", "kept"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["  Timeline  "]).text, "## Notes\nkept");
});

test("returns empty string for empty input", () => {
  const result = stripRemnicOwnedRegions("", ["Timeline"]);
  assert.equal(result.text, "");
  assert.deepEqual(result.warnings, []);
});

test("returns unchanged text when nothing is owned", () => {
  const text = ["first", "", "second", "", "third"].join("\n");
  const result = stripRemnicOwnedRegions(text, ["Timeline"]);
  assert.equal(result.text, text);
  assert.deepEqual(result.warnings, []);
});

// Regression: the journal-section reader normalizes tab separators, extra
// spaces, trailing whitespace, and closing # sequences. The stripper must
// recognize exactly the same set, or an owned heading the reader treats as
// the journal section would keep its generated body in the journal text.
test("owned heading matching accepts every ATX form the section reader accepts", () => {
  const body = ["generated line", "", "## User Notes", "kept"].join("\n");
  for (const headingLine of [
    "## Timeline",
    "##  Timeline",
    "##\tTimeline",
    "## Timeline   ",
    "## Timeline ##",
    "## Timeline ### ",
  ]) {
    const result = stripRemnicOwnedRegions([headingLine, body].join("\n"), ["Timeline"]);
    assert.equal(
      result.text,
      ["## User Notes", "kept"].join("\n"),
      `heading line ${JSON.stringify(headingLine)} must strip as owned`,
    );
  }
});

test("an indented heading is not owned, matching the section reader", () => {
  const text = ["  ## Timeline", "not owned body"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]).text, text);
});

// Generative property test (issue #1987): for random user text with random
// Remnic regions injected at random positions, strip returns EXACTLY the
// user text — no user line lost, no owned line kept. Seeded PRNG for
// deterministic CI.
test("property: injected regions vanish and user text survives byte-for-byte", () => {
  let seed = 0x2a1987;
  const rand = (max: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % max;
  };
  const USER_LINES = [
    "Walked the dog.",
    "Tagebuch 📝 Eintrag.",
    "  indented thought",
    "I decided to ship the parser.",
    "We committed to the review pass.",
  ];
  const REGION_NAMES = ["timeline", "weekly", "digest", "standup"];

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const userLineCount = 1 + rand(USER_LINES.length);
    const userLines: string[] = [];
    for (let i = 0; i < userLineCount; i += 1) userLines.push(USER_LINES[rand(USER_LINES.length)]!);
    const regionCount = rand(4);
    const injections: Array<{ at: number; lines: string[] }> = [];
    for (let i = 0; i < regionCount; i += 1) {
      const name = REGION_NAMES[rand(REGION_NAMES.length)]!;
      injections.push({
        at: rand(userLines.length + 1),
        lines: [START(name), `OWNED ${name} ${i}`, END(name)],
      });
    }
    let mixed: string[] = [];
    let userCursor = 0;
    for (const injection of injections.sort((a, b) => a.at - b.at)) {
      mixed = mixed.concat(userLines.slice(userCursor, injection.at), injection.lines);
      userCursor = injection.at;
    }
    mixed = mixed.concat(userLines.slice(userCursor));

    const result = stripRemnicOwnedRegions(mixed.join("\n"), ["Timeline"]);
    assert.equal(result.text, userLines.join("\n"), `iteration ${iteration}: ${JSON.stringify(mixed)}`);
    assert.deepEqual(result.warnings, [], `iteration ${iteration} must be warning-free`);
  }
});

// Issue #2882: markers and owned headings inside code samples are sample
// text. Classification comes from the same shared fileLines() scanner the
// vault publisher uses — fenced (backtick/tilde), indented, and unclosed
// fences all resolve toward stripping MORE live text, never toward eating
// the user's code examples.
test("markers inside a fenced example are sample text and pass through", () => {
  const text = ["```", START(), "sample", END(), "```", "kept"].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, text);
  assert.deepEqual(result.warnings, []);
});

test("an owned heading inside a fenced example is not stripped", () => {
  const text = ["## Journal", "```markdown", "## Timeline", "sample card", "```", "kept"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]).text, text);
});

test("a fenced end marker does not close a live region — the region runs to the real end marker", () => {
  const text = ["kept", START(), "```", END(), "```", "owned tail", END(), "also kept"].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, "kept\nalso kept");
  assert.deepEqual(result.warnings, []);
});

test("an indented marker is code, not a region boundary", () => {
  // Before #2882 the trim-first marker parser recognized indented markers;
  // the publisher's scanner never does.
  const text = ["kept", `    ${START()}`, "    indented sample", `    ${END()}`, "kept too"].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, text);
  assert.deepEqual(result.warnings, []);
});

test("an unclosed fence makes following markers sample text — nothing is stripped, no warning", () => {
  const text = ["kept line", "```", START(), "never closed"].join("\n");
  const result = stripRemnicOwnedRegions(text, []);
  assert.equal(result.text, text);
  assert.deepEqual(result.warnings, []);
});

test("strip preserves the trailing newline of untouched text", () => {
  const text = "first\n\n";
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]).text, text);
});
