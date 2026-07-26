/**
 * Tool-scoped memory guard (issue #2183).
 *
 * A tool-related fact extracted from a specific agent integration carries an
 * UNQUALIFIED tool name — "use the search tool" — with no agent identity
 * attached (the conversation handed to the extraction LLM is rendered as
 * `[role] content` only). Promoting such a fact to the shared namespace lets a
 * DIFFERENT integration that exposes a same-named but incompatible tool (Pi
 * `search` = repo code search vs OpenClaw `search` = web search) consume it.
 *
 * `referencesAgentSpecificTool` flags fact text that references a specific
 * tool/command invocation rather than portable knowledge. The promotion guard
 * in `orchestration/extraction-persist.ts` uses it — when the producing
 * integration is known (`sourceConnector`) — to keep such a fact in that
 * integration's own namespace.
 *
 * Tuning bias: a FALSE POSITIVE is cheap — the fact stays in the narrower
 * namespace, the documented safe default. A FALSE NEGATIVE is the actual
 * cross-integration collision bug, so detection leans permissive — but it must
 * not fire on ordinary prose.
 */

// Backtick as a plain char in a double-quoted string so it never collides with
// the template-literal delimiters used to build the patterns below.
const BT = "`";

// Generic tool names the issue calls out, plus common CLI tokens that actually
// appear in extracted memories. Both are matched case-insensitively as known
// tool/command names (an explicit allow-list — the bare-token SHAPE rule is NOT
// relaxed to admit arbitrary 4+ char words).
const GENERIC_TOOL_NAMES = ["read", "write", "search", "fetch", "browser", "exec", "shell", "memory"];
const KNOWN_CLI_NAMES = [
  "grep", "curl", "git", "npm", "pnpm", "sed", "awk", "jq", "cat", "ssh",
  "docker", "kubectl", "make", "rg", "ls", "cd",
];
const GENERIC_NAMES_ALT = GENERIC_TOOL_NAMES.join("|");
const KNOWN_NAMES_ALT = [...GENERIC_TOOL_NAMES, ...KNOWN_CLI_NAMES].join("|");

// Filesystem roots — a quoted/unquoted slash token rooted here is a path, not a
// command, regardless of quoting (so `/etc/remnic/config.json` never reads as a
// tool). Grouped so a following \b binds to the whole set.
const FS_ROOTS = "(?:etc|var|usr|tmp|home|opt|srv|proc|dev)";

// Build a case-insensitive alternation WITHOUT the /i flag, so it can live in a
// case-sensitive regex (the short-bare-token branch below must stay lowercase-
// only — a blanket /i would let it match capitalised tech names like SQL/API/Go).
function caseInsensitiveAlt(words: string[]): string {
  return "(?:" + words
    .map((w) => w.split("").map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join(""))
    .join("|") + ")";
}

// Quoted/backticked identifier — contents must be TOKEN-LIKE (no whitespace,
// identifier-shaped) so a quoted multi-word phrase ("least privilege",
// "database migrations") reads as prose. A slash form is allowed only as a
// single segment that is NOT a filesystem root, so a quoted path
// (`/etc/remnic/config.json`, `/var/log/remnic`) never qualifies (issue #2183
// round 8). Bounded {1,60} keeps the match linear (CodeQL js/polynomial-redos).
const NO_SLASH_TOKEN = "[A-Za-z0-9_.-]{1,60}";
const SLASH_CMD_TOKEN = "/(?!" + FS_ROOTS + "\\b)[A-Za-z0-9_.-]{1,60}";
const QUOTED_CONTENT = "(?:" + NO_SLASH_TOKEN + "|" + SLASH_CMD_TOKEN + ")";
const QUOTED_TOKEN =
  "(?:" + BT + QUOTED_CONTENT + BT + "|\"" + QUOTED_CONTENT + "\"|'" + QUOTED_CONTENT + "')";

// Tool/command keywords, word-anchored so "tooling"/"commander"/"commanded" do
// not match on the `tool`/`command` prefix.
const KEYWORD = "\\b(?:mcp[ _]tool|slash[ _]command|cli[ _]flag|subcommand|tool|command)\\b";

// Bare snake_case/kebab-case identifier (lowercase). The short all-lowercase
// (<=3 chars) shape is deliberately NOT admitted next to a keyword: it would
// match function words ("command of", "tool of", "command is") — every short
// real tool is already in KNOWN_CLI_NAMES, so the short shape adds only false
// positives there.
const BARE_SNAKE_KEBAB = "(?:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)\\b";

// Identifier admitted NEXT TO an explicit tool/command keyword: a token-like
// quoted identifier, a known tool/CLI name, or a snake/kebab bare identifier.
// The keyword itself is the corroborating context, so a pre-known or quoted
// token is not required here (unlike the bare invocation arm).
const IDENT = "(?:" + QUOTED_TOKEN + "|\\b(?:" + KNOWN_NAMES_ALT + ")\\b|" + BARE_SNAKE_KEBAB + ")";

// Immediate adjacency: identifier and keyword separated only by a short run of
// whitespace/quotes/backticks. Bounded {1,4} — no unbounded quantifier.
const IMM = "[\\s'\"" + BT + "]{1,4}";
// Explicit named/called/aka connective (longer reach, identifier on the far side).
const CONN = "\\s+(?:named|called|aka)\\s+";

// Imperative invocation verb and the clause boundary that must follow a bare
// identifier (end, punctuation, or a preposition/subordinator).
const VERB = "\\b(?:use|run|call|invoke)\\b";
const CLAUSE_BOUNDARY = "(?:$|[.,;:]|(?:when|before|after|to|with|for|on|in|if|unless|whenever)\\b)";
const SLASH_GENERIC = "/(?:" + GENERIC_NAMES_ALT + ")\\b";

// Case-INSENSITIVE invocation: verb + (token-like quoted identifier | known
// tool/CLI name | slash command naming a generic tool) + clause boundary.
const KNOWN_NAMES_CI = "\\b(?:" + KNOWN_NAMES_ALT + ")\\b";
const INVOCATION_CI =
  VERB + "\\s+(?:" + QUOTED_TOKEN + "|" + KNOWN_NAMES_CI + "|" + SLASH_GENERIC + ")(?=\\s*" + CLAUSE_BOUNDARY + ")";

const TOOL_REFERENCE_CI = new RegExp(
  "(?:" +
    IDENT + IMM + KEYWORD + "|" + KEYWORD + IMM + IDENT + "|" +
    KEYWORD + CONN + IDENT + "|" + IDENT + CONN + KEYWORD + "|" +
    INVOCATION_CI +
  ")",
  "i",
);

// Case-SENSITIVE bare invocation: a bare identifier that is tool-LIKE —
// snake_case/kebab-case, or a short all-lowercase token (<=3 chars). The verb
// and clause boundary are matched case-insensitively via character classes; the
// IDENTIFIER itself is lowercase-only, so capitalised product/tech names do not
// qualify. Split from TOOL_REFERENCE_CI because a single /i flag would defeat
// the lowercase discriminator.
const VERB_CS = "\\b" + caseInsensitiveAlt(["use", "run", "call", "invoke"]) + "\\b";
const CLAUSE_BOUNDARY_CS =
  "(?:$|[.,;:]|" + caseInsensitiveAlt([
    "when", "before", "after", "to", "with", "for", "on", "in", "if", "unless", "whenever",
  ]) + "\\b)";
const BARE_LIKE = "(?:" + BARE_SNAKE_KEBAB + "|(?:[a-z]{1,3}))\\b";
const SHORT_BARE_INVOCATION_CS = new RegExp(
  VERB_CS + "\\s+" + BARE_LIKE + "(?=\\s*" + CLAUSE_BOUNDARY_CS + ")",
);

/**
 * Returns true when `content` references a specific tool or command invocation
 * (e.g. "use the search tool", "the `read` tool", "Use search when…",
 * "Run `rg` before editing", "Run grep before editing", "Use curl to fetch",
 * "The memory_store tool persists results", "Use the grep command",
 * "Use /search with a path") rather than portable, agent-agnostic knowledge.
 *
 * Pure and dependency-free. Biased toward detection: a false positive only
 * narrows the namespace (safe default), while a false negative is the
 * cross-integration tool-collision bug from issue #2183.
 */
export function referencesAgentSpecificTool(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) return false;
  return TOOL_REFERENCE_CI.test(content) || SHORT_BARE_INVOCATION_CS.test(content);
}

export interface ToolScopeWithholdInputs {
  content: string;
  sourceConnector?: string;
  /**
   * Structured procedure steps (issue #2183 P2). A procedure whose steps
   * invoke a specific tool is tool-scoped even when the title is portable
   * prose ("When locating implementation" + `toolCall.kind: "search"`). Only
   * the tool-call kinds are consulted.
   */
  procedureSteps?: ReadonlyArray<{ toolCall?: { kind?: string } }>;
}

/**
 * Primitive — the SINGLE definition of "tool-scoped and attributed". True when
 * a fact was produced by a known integration (`sourceConnector`, non-empty
 * after trim — matching dedup/semantic.ts house style) AND either its text
 * references a specific tool/command or one of its structured procedure steps
 * invokes a tool. Every shared-namespace promotion path (scope-routing AND
 * auto-promotion) consults this, so the tool-scope decision cannot diverge
 * across paths (issue #2183).
 */
export function withholdToolScopedFromSharedNamespace({
  content,
  sourceConnector,
  procedureSteps,
}: ToolScopeWithholdInputs): boolean {
  if (typeof sourceConnector !== "string" || sourceConnector.trim().length === 0) return false;
  if (referencesAgentSpecificTool(content)) return true;
  if (
    procedureSteps?.some((s) => {
      const kind = s.toolCall?.kind;
      return typeof kind === "string" && kind.trim().length > 0;
    })
  ) {
    return true;
  }
  return false;
}

export interface GlobalFactPromotionInputs {
  scope: string | null | undefined;
  content: string;
  sourceConnector?: string;
  procedureSteps?: ReadonlyArray<{ toolCall?: { kind?: string } }>;
}

/**
 * Scope-routing composition: a `global`-scoped fact promotes to the shared
 * namespace unless the tool-scope primitive withholds it. This is the SINGLE
 * decision point called by BOTH the pre-judge namespace prediction AND the
 * write-loop scope-routing block in extraction-persist.ts (AGENTS.md namespace
 * invariant: read path and write path resolve through the same resolver), and
 * it is gated by the enclosing extractionScopeClassificationEnabled
 * capability — call this only inside a scope-classification-gated branch.
 */
export function shouldPromoteGlobalFactToShared(inputs: GlobalFactPromotionInputs): boolean {
  if (inputs.scope !== "global") return false;
  return !withholdToolScopedFromSharedNamespace({
    content: inputs.content,
    sourceConnector: inputs.sourceConnector,
    procedureSteps: inputs.procedureSteps,
  });
}
