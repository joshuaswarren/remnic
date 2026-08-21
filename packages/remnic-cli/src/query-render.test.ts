import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQueryRecallRequest,
  renderQueryTextLines,
  summarizeQueryExplainFallbackResults,
} from "./index.js";

test("query recall requests include a one-shot CLI session key", () => {
  const request = buildQueryRecallRequest("known fact");

  assert.equal(request.query, "known fact");
  assert.equal(request.mode, "auto");
  assert.equal(request.sessionKey, `remnic-cli:query:${process.pid}`);
});

test("plain text query output renders recall results content", () => {
  const lines = renderQueryTextLines({
    results: [{ content: "known fact" }],
  });

  assert.deepEqual(lines, ["- known fact"]);
});

test("plain text query output falls back to preview and per-result context", () => {
  assert.deepEqual(
    renderQueryTextLines({
      results: [{ preview: "short preview" }],
    }),
    ["- short preview"],
  );
  assert.deepEqual(
    renderQueryTextLines({
      results: [{ context: "memory context" }],
    }),
    ["- memory context"],
  );
});

test("plain text query output reports no results when recall results are empty", () => {
  assert.deepEqual(renderQueryTextLines({ results: [] }), ["No results."]);
  assert.deepEqual(renderQueryTextLines({}), ["No results."]);
});

test("plain text query output does not use aggregate recall context as item text", () => {
  assert.deepEqual(
    renderQueryTextLines({
      context: "first memory\n\nsecond memory",
      results: [{}],
    }),
    ["- (no preview available)"],
  );
});

test("query explain fallback summaries include per-result bodies", () => {
  assert.deepEqual(
    summarizeQueryExplainFallbackResults({
      results: [
        {
          id: "memory-a",
          content: "Canonical project root is /example/project.",
          source: "facts/project-root.md",
          score: 0.91,
        },
        {
          memoryId: "memory-b",
          preview: "Daily notes live under notes/daily.",
          path: "facts/daily-notes.md",
        },
      ],
    }),
    [
      {
        index: 1,
        id: "memory-a",
        text: "Canonical project root is /example/project.",
        source: "facts/project-root.md",
        score: 0.91,
      },
      {
        index: 2,
        id: "memory-b",
        text: "Daily notes live under notes/daily.",
        source: "facts/daily-notes.md",
      },
    ],
  );
});

test("query explain fallback summaries ignore blank metadata and non-finite scores", () => {
  assert.deepEqual(
    summarizeQueryExplainFallbackResults({
      results: [
        {
          id: " ",
          context: "memory context",
          source: "",
          file: "facts/context.md",
          score: Number.NaN,
        },
        {},
      ],
    }),
    [
      {
        index: 1,
        text: "memory context",
        source: "facts/context.md",
      },
      {
        index: 2,
        text: "(no preview available)",
      },
    ],
  );
});
