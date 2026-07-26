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

// Generic tool/command names the issue calls out. Word-anchored so the "search"
// inside "research" and the "read" inside "reads" do not match.
const GENERIC_TOOL_NAMES = ["read", "write", "search", "fetch", "browser", "exec", "shell", "memory"];
const GENERIC = "\\b(?:" + GENERIC_TOOL_NAMES.join("|") + ")\\b";

// Backticked or quoted short token. Bounded {1,60} keeps the match linear
// (CodeQL js/polynomial-redos — see source-attribution.ts for the house
// pattern): no unbounded `+` over hostile text, no overlapping quantifier.
const QUOTED_TOKEN =
  "(?:" + BT + "[^" + BT + "\\n]{1,60}" + BT + "|\"[^\"\\n]{1,60}\"|'[^'\\n]{1,60}')";

// Tool/command keywords, word-anchored so "tooling"/"commander"/"commanded" do
// not match on the `tool`/`command` prefix.
const KEYWORD = "\\b(?:mcp[ _]tool|slash[ _]command|cli[ _]flag|subcommand|tool|command)\\b";

// Identifier admitted next to a keyword: a quoted/backticked token or a generic
// tool name (both anchored). Bare words are NOT admitted — "research tool",
// "marketing command" are ordinary prose, not tool refs.
const IDENT = "(?:" + QUOTED_TOKEN + "|" + GENERIC + ")";

// Immediate adjacency: identifier and keyword separated only by a short run of
// whitespace/quotes/backticks. Bounded {1,4} — no unbounded quantifier.
const IMM = "[\\s'\"" + BT + "]{1,4}";
// Explicit named/called/aka connective (longer reach, identifier on the far side).
const CONN = "\\s+(?:named|called|aka)\\s+";

// Imperative invocation: use/run/call/invoke immediately followed by a
// backticked/quoted identifier OR a slash command — "Use `search`",
// "Run `rg`", "Use /search". The identifier is restricted to the quoted/slash
// form (not the generic name) so prose like "writers use memory" does not fire,
// and a bare absolute path ("from /etc/remnic/config.json") never qualifies.
const INVOCATION = "\\b(?:use|run|call|invoke)\\b\\s+(?:" + QUOTED_TOKEN + "|/[a-z][a-z0-9_-]{0,40}\\b)";

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
 * (e.g. "use the search tool", "the `read` tool", "Run `rg`", "Use /search")
 * rather than portable, agent-agnostic knowledge.
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
  procedureSteps?: ReadonlyArray<{ toolCall?: { kind?: string } }>;
}

/**
 * Primitive — the SINGLE definition of "tool-scoped and attributed". True when
 * a fact was produced by a known integration (`sourceConnector`) AND either its
 * text references a specific tool/command or one of its structured procedure
 * steps invokes a tool. Every shared-namespace promotion path (scope-routing
 * AND auto-promotion) consults this, so the tool-scope decision cannot diverge
 * across paths (issue #2183).
 */
export function withholdToolScopedFromSharedNamespace({
  content,
  sourceConnector,
  procedureSteps,
}: ToolScopeWithholdInputs): boolean {
  if (typeof sourceConnector !== "string" || sourceConnector.length === 0) return false;
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
