import test from "node:test";
import assert from "node:assert/strict";

import {
  referencesAgentSpecificTool,
  shouldPromoteGlobalFactToShared,
} from "./tool-scoped-memory.js";

// ---------------------------------------------------------------------------
// referencesAgentSpecificTool — table-driven, both polarities.
//
// Tuning bias (issue #2183): a FALSE POSITIVE is cheap (the fact stays in the
// narrower namespace — the documented safe default); a FALSE NEGATIVE is the
// cross-integration tool-collision bug. So detection leans permissive, but
// must not fire on ordinary prose.
// ---------------------------------------------------------------------------

const CASES: Array<{ content: string; expected: boolean; note: string }> = [
  // ---- MUST match (true) -------------------------------------------------
  {
    content: "Prefer the search tool and provide a path when locating code.",
    expected: true,
    note: "generic tool name adjacent to the word 'tool'",
  },
  {
    content: "Use the `read` tool before editing a file.",
    expected: true,
    note: "backticked token adjacent to 'tool' (signal 2)",
  },
  {
    content: "The exec tool requires an absolute cwd.",
    expected: true,
    note: "generic tool name 'exec' adjacent to 'tool'",
  },
  // ---- MUST NOT match (false) -------------------------------------------
  {
    content: "User prefers dark mode in all editors",
    expected: false,
    note: "portable preference; no tool/command context",
  },
  {
    content: "PostgreSQL 15 requires the uuid-ossp extension for gen_random_uuid()",
    expected: false,
    note: "portable framework knowledge; no tool/command keyword",
  },
  {
    content: "Magento 2.4.8 has a race condition in checkout",
    expected: false,
    note: "'condition' is not a tool/command keyword; 'checkout' is not a generic name",
  },
  {
    content: "The user reads documentation before starting a task",
    expected: false,
    note: "the bare verb 'reads' is not a tool reference (word boundary excludes it)",
  },
];

for (const { content, expected, note } of CASES) {
  test(`referencesAgentSpecificTool: ${expected ? "detects" : "ignores"} "${content.slice(0, 48)}…" (${note})`, () => {
    assert.equal(
      referencesAgentSpecificTool(content),
      expected,
      `${expected ? "expected detection but missed" : "expected no match but fired"} — ${note}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Extra coverage beyond the issue's required set: bias-toward-detection cases
// (must stay true) and ordinary-prose traps (must stay false).
// ---------------------------------------------------------------------------

const EXTRA_POSITIVE: string[] = [
  "Use the grep tool to find symbols.",
  "The rg subcommand is fastest for large repos.",
  "The `checkout` command switches branches.",
  "The browser tool navigates to the URL first.",
  "Always run the memory tool after a context switch.",
  "the tool named search returns repo hits",
  "tool called grep is preferred",
  "Pi exposes a search tool; OpenClaw exposes a same-named web tool.",
];

for (const content of EXTRA_POSITIVE) {
  test(`referencesAgentSpecificTool detects: "${content.slice(0, 48)}…"`, () => {
    assert.equal(referencesAgentSpecificTool(content), true);
  });
}

const EXTRA_NEGATIVE: string[] = [
  "Git is a useful tool for version control.",
  "The command line is faster than the GUI for this workflow.",
  "She has a good command of the deployment process.",
  "Communication is the main tool of a leader.",
  "PostgreSQL read replicas lag under heavy load.",
  "The user reads the docs every morning.",
  "Memory usage spikes during compaction.",
  "The browser caches static assets aggressively.",
  "Reading long files is slow.",
  "He writes detailed notes after every meeting.",
  "Leadership requires command of the subject matter.",
];

for (const content of EXTRA_NEGATIVE) {
  test(`referencesAgentSpecificTool ignores prose: "${content.slice(0, 48)}…"`, () => {
    assert.equal(referencesAgentSpecificTool(content), false);
  });
}

test("referencesAgentSpecificTool: empty/non-string input is false (no throw)", () => {
  assert.equal(referencesAgentSpecificTool(""), false);
  assert.equal(referencesAgentSpecificTool("   "), false);
});

// ---------------------------------------------------------------------------
// shouldPromoteGlobalFactToShared — the single decision point shared by the
// pre-judge namespace prediction and the write-loop scope-routing block. The
// guard has no separate config knob: it is gated by the enclosing
// extractionScopeClassificationEnabled capability, so only {scope, content,
// sourceConnector} participate in the decision.
// ---------------------------------------------------------------------------

const PROMOTION_CASES: Array<{ name: string; args: { scope: string | null | undefined; content: string; sourceConnector?: string }; expected: boolean }> = [
  {
    name: "global portable fact, no connector -> promote",
    args: { scope: "global", content: "User prefers dark mode in all editors" },
    expected: true,
  },
  {
    name: "global tool-scoped fact WITH connector -> withhold (#2183)",
    args: { scope: "global", content: "Prefer the search tool when locating code.", sourceConnector: "pi" },
    expected: false,
  },
  {
    name: "global tool-scoped fact, guard has no knob -> always withheld when connector known",
    args: { scope: "global", content: "The exec tool requires an absolute cwd.", sourceConnector: "openclaw" },
    expected: false,
  },
  {
    name: "global tool-scoped fact WITHOUT connector -> promote (unattributed)",
    args: { scope: "global", content: "Prefer the search tool when locating code." },
    expected: true,
  },
  {
    name: "project-scoped fact -> never promote via this path",
    args: { scope: "project", content: "Prefer the search tool when locating code.", sourceConnector: "pi" },
    expected: false,
  },
  {
    name: "empty connector string is treated as unknown -> promote",
    args: { scope: "global", content: "Prefer the search tool when locating code.", sourceConnector: "" },
    expected: true,
  },
];

for (const { name, args, expected } of PROMOTION_CASES) {
  test(`shouldPromoteGlobalFactToShared: ${name}`, () => {
    assert.equal(shouldPromoteGlobalFactToShared(args), expected);
  });
}
