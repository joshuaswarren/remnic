/**
 * Tool-scoped memory guard (issue #2183).
 *
 * A tool-related fact extracted from a specific agent integration carries an
 * UNQUALIFIED tool name — "use the search tool" — with no agent identity
 * attached (the conversation handed to the extraction LLM is rendered as
 * `[role] content` only). The scope classifier can tag such a fact `global`,
 * which promotes it to the shared namespace, where a DIFFERENT integration
 * that exposes a same-named but incompatible tool (Pi `search` = repo code
 * search vs OpenClaw `search` = web search) picks it up and applies the wrong
 * rule.
 *
 * `referencesAgentSpecificTool` flags fact text that references a specific
 * tool/command invocation rather than portable knowledge. The promotion guard
 * in `orchestration/extraction-persist.ts` uses it — when the producing
 * integration is known (`sourceConnector`) — to keep such a fact in that
 * integration's own namespace instead of promoting it to the shared one.
 *
 * Tuning bias: a FALSE POSITIVE is cheap — the fact simply stays in the
 * narrower namespace, which the codebase documents as the safe default
 * ("When in doubt, prefer project"). A FALSE NEGATIVE is the actual bug, so
 * detection leans permissive — but it must not light up on ordinary prose.
 */

// Backtick as a plain char in a double-quoted string so it never collides with
// the template-literal delimiters used to build the patterns below.
const BT = "`";

// Generic tool/command names the issue calls out. Matched as standalone,
// word-boundary tokens ONLY when a tool/command keyword is adjacent — the bare
// verb "reads documentation" must not fire, because `\bread\b` does not match
// inside "reads".
const GENERIC_TOOL_NAMES = ["read", "write", "search", "fetch", "browser", "exec", "shell", "memory"];

// Backticked or quoted short token (signal 2 carrier). Bounded {1,60} keeps the
// match linear (CodeQL js/polynomial-redos — see source-attribution.ts for the
// house pattern): no unbounded `+` over hostile text, no overlapping quantifier.
const QUOTED_TOKEN =
  "(?:" + BT + "[^" + BT + "\\n]{1,60}" + BT + "|\"[^\"\\n]{1,60}\"|'[^'\\n]{1,60}')";

// Function words + common prose adjectives that sit next to "tool"/"command" in
// ordinary writing ("a useful tool", "the main tool of", "command of") but are
// not tool identifiers. Blocks the bare-ident branch via lookahead so prose
// does not fire while "use the grep tool" does.
const PROSE_FILLER_WORDS = [
  // articles / determiners
  "the", "a", "an", "this", "that", "these", "those", "every", "any", "some", "no",
  "another", "other", "same", "such", "each", "all", "many", "few", "several", "one",
  "two", "three", "both", "either", "neither", "own",
  // adjectives
  "useful", "helpful", "great", "good", "new", "old", "powerful", "simple", "complex",
  "basic", "advanced", "single", "multiple", "different", "similar", "main", "only",
  "first", "last", "next", "previous", "primary", "secondary", "default", "common",
  "general", "specific", "particular", "certain", "whole", "full", "partial", "real",
  "virtual", "key", "core",
  // prepositions / conjunctions (the "tool of/for/with" prose pattern)
  "of", "for", "to", "in", "with", "and", "or", "on", "at", "by", "from", "into",
  "over", "under", "via", "per", "than", "as", "if", "because", "while", "when",
  "where", "upon", "within", "without", "across", "about", "between", "among",
  "through", "during", "before", "after", "since", "until", "against", "toward",
  "towards",
  // pronouns / possessives
  "its", "his", "her", "their", "our", "your", "my", "we", "you", "they", "he",
  "she", "it", "i", "us", "them", "who", "whom", "whose", "which", "what",
];
const NOT_PROSE_FILLER = "(?!(?:" + PROSE_FILLER_WORDS.join("|") + ")\\b)";

// A bare code-ish identifier (signal 1 carrier) — a short token starting with a
// letter, word-anchored on BOTH sides so the match cannot slide into a word
// mid-spelling (which would let "useful" be entered as "seful" and dodge the
// filler lookahead), and gated by the filler lookahead.
const BARE_IDENT = "\\b" + NOT_PROSE_FILLER + "[A-Za-z][A-Za-z0-9_-]{1,40}\\b";

// Tool-flavored context keywords. The bare word "command" is handled by
// COMMAND_KW below, where ordinary prose ("command line", "chain of command",
// "command of the subject") makes a bare-word identifier next to it too noisy —
// only quoted/generic identifiers are admitted there.
const TOOL_KW = "(?:mcp[ _]tool|slash[ _]command|cli[ _]flag|subcommand|tool)";
const COMMAND_KW = "(?:mcp[ _]tool|slash[ _]command|cli[ _]flag|subcommand|command)";

// Immediate adjacency: identifier and keyword separated only by a short run of
// whitespace/quotes/backticks. Bounded {1,4} — no unbounded quantifier.
const IMM = "[\\s'\"" + BT + "]{1,4}";
// Explicit named/called/aka connective (longer reach, identifier on the far side).
const CONN = "\\s+(?:named|called|aka)\\s+";

// Identifier admitted next to a tool-flavored keyword: a quoted token, a known
// generic tool name, or a bare code identifier (prose filler blocked).
const IDENT_FOR_TOOL = "(?:" + QUOTED_TOKEN + "|" + GENERIC_TOOL_NAMES.join("|") + "|" + BARE_IDENT + ")";
// Identifier admitted next to the bare "command" keyword: quoted token or known
// generic name only. Bare words are NOT admitted here — "command line",
// "command pattern", "chain of command" are ordinary prose, not tool refs.
const IDENT_FOR_COMMAND = "(?:" + QUOTED_TOKEN + "|" + GENERIC_TOOL_NAMES.join("|") + ")";

const TOOL_REFERENCE = new RegExp(
  "(?:" +
    IDENT_FOR_TOOL + IMM + TOOL_KW + "|" + TOOL_KW + IMM + IDENT_FOR_TOOL + "|" +
    IDENT_FOR_COMMAND + IMM + COMMAND_KW + "|" + COMMAND_KW + IMM + IDENT_FOR_COMMAND + "|" +
    "(?:tool|command)" + CONN + IDENT_FOR_TOOL + "|" + IDENT_FOR_TOOL + CONN + "(?:tool|command)" +
  ")",
  "i",
);

/**
 * Returns true when `content` references a specific tool or command invocation
 * (e.g. "use the search tool", "the `read` tool", "the exec tool requires an
 * absolute cwd") rather than portable, agent-agnostic knowledge.
 *
 * Pure and dependency-free. Biased toward detection: a false positive only
 * narrows the namespace (safe default), while a false negative is the
 * cross-integration tool-collision bug from issue #2183.
 */
export function referencesAgentSpecificTool(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) return false;
  return TOOL_REFERENCE.test(content);
}

export interface GlobalFactPromotionInputs {
  scope: string | null | undefined;
  content: string;
  sourceConnector?: string;
}

/**
 * True when a `global`-scoped fact should be promoted to the shared namespace,
 * accounting for the #2183 tool-scope guard. This is the SINGLE decision point
 * called by BOTH the pre-judge namespace prediction AND the write-loop
 * scope-routing block in extraction-persist.ts, so the read path and the write
 * path can never diverge on the tool-scope decision (AGENTS.md namespace
 * invariant: both paths resolve through the same namespace resolver).
 *
 * The guard has no separate config knob: it is gated by the SAME
 * `extractionScopeClassificationEnabled` capability as the scope-routing block
 * it lives in — the guard only ever applies to facts the scope classifier
 * tagged `global`, so scope classification is both its input domain and its
 * escape hatch. Call this only inside a scope-classification-gated branch.
 *
 * Returns false (do not promote) for a tool-scoped fact produced by a known
 * integration; true otherwise.
 */
export function shouldPromoteGlobalFactToShared(inputs: GlobalFactPromotionInputs): boolean {
  if (inputs.scope !== "global") return false;
  if (
    typeof inputs.sourceConnector === "string" &&
    inputs.sourceConnector.length > 0 &&
    referencesAgentSpecificTool(inputs.content)
  ) {
    return false;
  }
  return true;
}
