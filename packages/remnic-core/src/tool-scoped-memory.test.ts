import test from "node:test";
import assert from "node:assert/strict";

import {
  referencesAgentSpecificTool,
  shouldPromoteGlobalFactToShared,
  withholdToolScopedFromSharedNamespace,
} from "./tool-scoped-memory.js";

// ---------------------------------------------------------------------------
// referencesAgentSpecificTool — table-driven, both polarities.
//
// Tuning bias (issue #2183): a FALSE POSITIVE is cheap (the fact stays in the
// narrower namespace — the documented safe default); a FALSE NEGATIVE is the
// cross-integration tool-collision bug. Detection leans permissive but must not
// fire on ordinary prose. Keywords and generic names are word-anchored so
// "tooling"/"commander" and the "search" inside "research" do not match.
// ---------------------------------------------------------------------------

const REF_CASES: Array<{ content: string; expected: boolean; note: string }> = [
  // ---- MUST match --------------------------------------------------------
  { content: "Prefer the search tool and provide a path when locating code.", expected: true, note: "generic name adjacent to 'tool'" },
  { content: "Use the `read` tool before editing a file.", expected: true, note: "backticked token adjacent to 'tool'" },
  { content: "The exec tool requires an absolute cwd.", expected: true, note: "generic name 'exec' adjacent to 'tool'" },
  { content: "Use `search` when locating code.", expected: true, note: "imperative invocation + backticked identifier" },
  { content: "Run `rg` before editing.", expected: true, note: "imperative invocation + backticked identifier" },
  { content: "Use /search with a path.", expected: true, note: "slash-command syntax" },
  // ---- MUST NOT match ----------------------------------------------------
  { content: "User prefers dark mode in all editors", expected: false, note: "portable preference; no tool/command context" },
  { content: "PostgreSQL 15 requires the uuid-ossp extension for gen_random_uuid()", expected: false, note: "portable framework knowledge" },
  { content: "Magento 2.4.8 has a race condition in checkout", expected: false, note: "'condition' is not a keyword; 'checkout' is not generic" },
  { content: "The user reads documentation before starting a task", expected: false, note: "the bare verb 'reads' is not a tool reference" },
  { content: "Search tooling improves developer productivity", expected: false, note: "'tool' must not match the prefix of 'tooling'" },
  { content: "Research tool improves accuracy", expected: false, note: "'search' must not match inside 'research'" },
];

for (const { content, expected, note } of REF_CASES) {
  test(`referencesAgentSpecificTool: ${expected ? "detects" : "ignores"} "${content.slice(0, 44)}…" (${note})`, () => {
    assert.equal(referencesAgentSpecificTool(content), expected, note);
  });
}

const EXTRA_POSITIVE: string[] = [
  "The `checkout` command switches branches.",
  "The browser tool navigates to the URL first.",
  "Always run the memory tool after a context switch.",
  "the tool named search returns repo hits",
  "Pi exposes a search tool; OpenClaw exposes a same-named web tool.",
  "Invoke `memory_store` to persist the reflection.",
  "Use search when locating implementation",
  "Run rg before editing",
  "Call memory_store to persist the result",
];
for (const content of EXTRA_POSITIVE) {
  test(`referencesAgentSpecificTool detects: "${content.slice(0, 44)}…"`, () => {
    assert.equal(referencesAgentSpecificTool(content), true);
  });
}

const EXTRA_NEGATIVE: string[] = [
  "Git is a useful tool for version control.",
  "The command line is faster than the GUI for this workflow.",
  "She has a good command of the deployment process.",
  "Communication is the main tool of a leader.",
  "PostgreSQL read replicas lag under heavy load.",
  "Memory usage spikes during compaction.",
  "The browser caches static assets aggressively.",
  "Reading long files is slow.",
  "He writes detailed notes after every meeting.",
  "Leadership requires command of the subject matter.",
  "Writers use memory and emotion to craft stories.",
  "I use search engines daily for research.",
  "Use memory wisely and rest often.",
  "Visit https://example.com/search for docs.",
  "The service reads configuration from /etc/remnic/config.json",
  "Logs live under /var/log/remnic",
  "Restore the backup from /tmp/dump.sql",
  "Use /etc/remnic/config.json for configuration",
  "The service should use /health for readiness checks",
];
for (const content of EXTRA_NEGATIVE) {
  test(`referencesAgentSpecificTool ignores prose: "${content.slice(0, 44)}…"`, () => {
    assert.equal(referencesAgentSpecificTool(content), false);
  });
}

test("referencesAgentSpecificTool: empty/non-string input is false (no throw)", () => {
  assert.equal(referencesAgentSpecificTool(""), false);
  assert.equal(referencesAgentSpecificTool("   "), false);
});

// ---------------------------------------------------------------------------
// shouldPromoteGlobalFactToShared — composed scope-routing predicate.
// ---------------------------------------------------------------------------

const PROMOTION_CASES: Array<{ name: string; args: { scope: string | null | undefined; content: string; sourceConnector?: string; procedureSteps?: ReadonlyArray<{ intent?: string; toolCall?: { kind?: string; signature?: string } }> }; expected: boolean }> = [
  { name: "global portable fact, no connector -> promote", args: { scope: "global", content: "User prefers dark mode in all editors" }, expected: true },
  { name: "global tool-scoped fact WITH connector -> withhold (#2183)", args: { scope: "global", content: "Prefer the search tool when locating code.", sourceConnector: "pi" }, expected: false },
  { name: "global tool-scoped fact, no knob -> withheld when connector known", args: { scope: "global", content: "The exec tool requires an absolute cwd.", sourceConnector: "openclaw" }, expected: false },
  { name: "global tool-scoped fact WITHOUT connector -> promote (unattributed)", args: { scope: "global", content: "Prefer the search tool when locating code." }, expected: true },
  { name: "project-scoped fact -> never promote via this path", args: { scope: "project", content: "Prefer the search tool when locating code.", sourceConnector: "pi" }, expected: false },
  { name: "empty connector string is treated as unknown -> promote", args: { scope: "global", content: "Prefer the search tool when locating code.", sourceConnector: "" }, expected: true },
  { name: "global portable-title procedure with tool-bearing steps + connector -> withhold (#2183 P2, scope-routing)", args: { scope: "global", content: "Workflow for locating implementation", sourceConnector: "pi", procedureSteps: [{ intent: "find the symbol", toolCall: { kind: "search", signature: "search('foo')" } }, { intent: "open the file", toolCall: { kind: "read", signature: "read('bar')" } }] }, expected: false },
];
for (const { name, args, expected } of PROMOTION_CASES) {
  test(`shouldPromoteGlobalFactToShared: ${name}`, () => {
    assert.equal(shouldPromoteGlobalFactToShared(args), expected);
  });
}

// ---------------------------------------------------------------------------
// withholdToolScopedFromSharedNamespace — the SINGLE primitive every shared-
// namespace promotion path consults. Includes structured procedure tool
// identity (issue #2183 P2): a portable title + tool-bearing steps withholds.
// ---------------------------------------------------------------------------

const WITHHOLD_CASES: Array<{
  name: string;
  args: { content: string; sourceConnector?: string; procedureSteps?: ReadonlyArray<{ intent?: string; toolCall?: { kind?: string; signature?: string } }> };
  expected: boolean;
}> = [
  { name: "tool-scoped + connector -> withhold", args: { content: "Prefer the search tool when locating code.", sourceConnector: "pi" }, expected: true },
  { name: "tool-scoped + empty connector -> do not withhold", args: { content: "Prefer the search tool when locating code.", sourceConnector: "" }, expected: false },
  { name: "tool-scoped + whitespace-only connector -> do not withhold", args: { content: "Prefer the search tool when locating code.", sourceConnector: "   " }, expected: false },
  { name: "tool-scoped + no connector -> do not withhold", args: { content: "Prefer the search tool when locating code." }, expected: false },
  { name: "portable + connector -> do not withhold", args: { content: "User prefers dark mode in all editors", sourceConnector: "pi" }, expected: false },
  { name: "portable title + connector + tool-bearing steps -> withhold (#2183 P2)", args: { content: "When locating implementation", sourceConnector: "pi", procedureSteps: [{ intent: "find", toolCall: { kind: "search", signature: "search('foo')" } }] }, expected: true },
  { name: "portable title + connector + steps without toolCall -> do not withhold", args: { content: "When locating implementation", sourceConnector: "pi", procedureSteps: [{ intent: "read the docs" }] }, expected: false },
  { name: "portable title + connector + steps with empty kind -> do not withhold", args: { content: "When locating implementation", sourceConnector: "pi", procedureSteps: [{ intent: "x", toolCall: { kind: "  ", signature: "y" } }] }, expected: false },
  { name: "tool-bearing steps but NO connector -> do not withhold (unattributed)", args: { content: "When locating implementation", procedureSteps: [{ intent: "find", toolCall: { kind: "search", signature: "search('foo')" } }] }, expected: false },
];
for (const { name, args, expected } of WITHHOLD_CASES) {
  test(`withholdToolScopedFromSharedNamespace: ${name}`, () => {
    assert.equal(withholdToolScopedFromSharedNamespace(args), expected);
  });
}
