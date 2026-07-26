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
// the template-literal delimiters used to build the pattern below.
const BT = "`";

// Known tool/command names, matched case-insensitively as an explicit allow-list
// (the bare-token SHAPE rule is NOT relaxed to admit arbitrary words).
const GENERIC_TOOL_NAMES = ["read", "write", "search", "fetch", "browser", "exec", "shell", "memory"];
const KNOWN_CLI_NAMES = [
  "grep", "curl", "git", "npm", "pnpm", "sed", "awk", "jq", "cat", "ssh",
  "docker", "kubectl", "make", "rg", "ls", "cd",
];
const GENERIC_NAMES_ALT = GENERIC_TOOL_NAMES.join("|");
const KNOWN_NAMES_ALT = [...GENERIC_TOOL_NAMES, ...KNOWN_CLI_NAMES].join("|");

// Filesystem roots — a slash token rooted here is a path, not a command,
// regardless of quoting (so `/etc/remnic/config.json` never reads as a tool).
const FS_ROOTS = "(?:etc|var|usr|tmp|home|opt|srv|proc|dev)";

// Quoted/backticked identifier — contents must be TOKEN-LIKE (no whitespace,
// identifier-shaped) so a quoted multi-word phrase ("least privilege") reads as
// prose. A slash form is allowed only as a single non-filesystem-root segment,
// so a quoted path (`/etc/remnic/config.json`, `/var/log/remnic`) never
// qualifies. Bounded {1,60} keeps the match linear (CodeQL js/polynomial-redos).
// CLI flag (--force, -f, --no-color): a LEADING -- or - then a letter +
// alphanum/kebab segments. A leading dash distinguishes a flag from an inline
// hyphenated prose word ("2024-2025", "well-tested") or an em-dash; admitted
// only beside a tool/command keyword, after an invocation verb, or as an
// argument trailing a tool identifier.
const FLAG = "(?:--|-)[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\\b";
// A short argument operand (filename, value, search term) trailing a flag in
// a command-with-args run.
const OPCODE = "[A-Za-z0-9_./-]{1,20}";

const NO_SLASH_TOKEN = "[A-Za-z0-9_.-]{1,60}";
const SLASH_CMD_TOKEN = "/(?!" + FS_ROOTS + "\\b)[A-Za-z0-9_.-]{1,60}";
// A quoted command-with-args: MUST start with a known name + a flag, so a
// quoted prose phrase ("least privilege", "database migrations") never qualifies.
const QUOTED_CMD_ARGS = "\\b(?:" + KNOWN_NAMES_ALT + ")\\b\\s+" + FLAG + "(?:\\s+" + OPCODE + "){0,4}";
const QUOTED_CONTENT = "(?:" + QUOTED_CMD_ARGS + "|" + NO_SLASH_TOKEN + "|" + SLASH_CMD_TOKEN + ")";
const QUOTED_TOKEN =
  "(?:" + BT + QUOTED_CONTENT + BT + "|\"" + QUOTED_CONTENT + "\"|'" + QUOTED_CONTENT + "')";

// Known tool/CLI names and tool/command keywords, word-anchored.
const KNOWN_NAMES_CI = "\\b(?:" + KNOWN_NAMES_ALT + ")\\b";
const KEYWORD = "\\b(?:mcp[ _]tool|slash[ _]command|cli[ _]flag|subcommand|tool|command)\\b";

// Bare snake_case/kebab-case identifier (lowercase). The short all-lowercase
// (<=3 chars) shape is deliberately NOT admitted anywhere: it matches function
// words ("command of", "Call me before…", "use it to…"), and every short real
// tool is already in KNOWN_CLI_NAMES (rg, ls, cd, jq, cat…). With only known
// names and separator-bearing identifiers admitted, the bare arm is a CLOSED
// set, not a heuristic.
const BARE_SNAKE_KEBAB = "(?:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)\\b";

// Identifier admitted NEXT TO an explicit tool/command keyword: a token-like
// quoted identifier, a known tool/CLI name, or a snake/kebab bare identifier.
// The keyword itself is the corroborating context, so a quoted/pre-known token
// is not required here.
const IDENT = "(?:" + QUOTED_TOKEN + "|" + KNOWN_NAMES_CI + "|" + BARE_SNAKE_KEBAB + "|" + FLAG + ")";

// Immediate adjacency: identifier and keyword separated only by a short run of
// whitespace/quotes/backticks. Bounded {1,4} — no unbounded quantifier.
const IMM = "[\\s'\"" + BT + "]{1,4}";
// Explicit named/called/aka connective (longer reach, identifier on the far side).
const CONN = "\\s+(?:named|called|aka)\\s+";

// Imperative invocation verb; slash command naming a generic tool.
const VERB = "\\b(?:use|run|call|invoke)\\b";
const SLASH_GENERIC = "/(?:" + GENERIC_NAMES_ALT + ")\\b";
// A clause boundary after a bare/known identifier — end, punctuation, a call
// expression `(` (stronger evidence than a boundary — prose does not put "("
// directly after a bare word), or a preposition/subordinator.
const CLAUSE_BOUNDARY = "(?:$|[.,;(:]|(?:when|before|after|to|with|for|on|in|if|unless|whenever)\\b)";

// Imperative invocation: verb + (token-like quoted identifier | known tool/CLI
// name | snake/kebab bare identifier | slash command) + clause boundary.
// Optional flag-first argument run after the identifier (Run rg --files …);
// the run must start with a flag so plain prose operands cannot extend a match.
const ARGS = "(?:\\s+" + FLAG + "(?:\\s+" + OPCODE + "){0,4})?";
const INVOCATION =
  VERB + "\\s+(?:" + QUOTED_TOKEN + "|" + KNOWN_NAMES_CI + "|" + BARE_SNAKE_KEBAB + "|" + SLASH_GENERIC + "|" + FLAG + ")" + ARGS + "(?=\\s*" + CLAUSE_BOUNDARY + ")";

const TOOL_REFERENCE = new RegExp(
  "(?:" +
    IDENT + IMM + KEYWORD + "|" + KEYWORD + IMM + IDENT + "|" +
    KEYWORD + CONN + IDENT + "|" + IDENT + CONN + KEYWORD + "|" +
    INVOCATION +
  ")",
  "i",
);

/**
 * Returns true when `content` references a specific tool or command invocation
 * (e.g. "use the search tool", "the `read` tool", "Use search when…",
 * "Run `rg` before editing", "Run grep before editing", "Use curl to fetch",
 * "Call memory_store() to persist", "The memory_store tool persists results",
 * "Use the grep command", "Use /search with a path") rather than portable,
 * agent-agnostic knowledge.
 *
 * Pure and dependency-free. Biased toward detection: a false positive only
 * narrows the namespace (safe default), while a false negative is the
 * cross-integration tool-collision bug from issue #2183.
 */
export function referencesAgentSpecificTool(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) return false;
  return TOOL_REFERENCE.test(content);
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
  procedureSteps?: ReadonlyArray<{ intent?: string; expectedOutcome?: string; toolCall?: { kind?: string } }>;
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
      if (typeof kind === "string" && kind.trim().length > 0) return true;
      // Intent-only step (no toolCall): its text may name a tool/command, e.g.
      // "Run grep before editing". Reuse the text predicate so any improvement
      // to it covers procedure steps too.
      const stepText = [s.intent, s.expectedOutcome]
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .join(" ");
      return stepText.length > 0 && referencesAgentSpecificTool(stepText);
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
  procedureSteps?: ReadonlyArray<{ intent?: string; expectedOutcome?: string; toolCall?: { kind?: string } }>;
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
