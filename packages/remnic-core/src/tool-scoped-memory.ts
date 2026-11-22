
const BT = "`";

const GENERIC_TOOL_NAMES = [
  "read", "write", "search", "fetch", "browser", "exec", "shell", "memory",
  "edit", "bash", "glob", "webfetch", "task",
  "remnic",
];
const KNOWN_CLI_NAMES = [
  "grep", "curl", "git", "npm", "pnpm", "sed", "awk", "jq", "cat", "ssh",
  "docker", "kubectl", "make", "rg", "ls", "cd",
];
const GENERIC_NAMES_ALT = GENERIC_TOOL_NAMES.join("|");
const KNOWN_NAMES_ALT = [...GENERIC_TOOL_NAMES, ...KNOWN_CLI_NAMES].join("|");
const CLI_NAMES_ALT = KNOWN_CLI_NAMES.join("|");

const FS_ROOTS = "(?:etc|var|usr|tmp|home|opt|srv|proc|dev)";
const FLAG = "(?:--|-)[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\\b";
const FLAG_NAKED = "(?:--|-)[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*";
const OPCODE = "[A-Za-z0-9_./-]{1,20}";

const NO_SLASH_TOKEN = "[A-Za-z0-9_.-]{1,60}";
const SLASH_CMD_TOKEN = "/(?:" + GENERIC_NAMES_ALT + ")\\b";
const QUOTED_CONTENT = "(?:" + NO_SLASH_TOKEN + "|" + SLASH_CMD_TOKEN + ")";
const QUOTED_PERMISSIVE =
  "(?:" + BT + QUOTED_CONTENT + BT + "|\"" + QUOTED_CONTENT + "\"|'" + QUOTED_CONTENT + "')";

const SNAKE = "(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\\b";
const SNAKE_NON_DATA = "(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:_(?!id\\b|name\\b|flag\\b|count\\b|at\\b|url\\b|key\\b|type\\b)[a-z0-9]+))\\b";
const SNAKE_KEBAB = "(?:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)\\b";

const KNOWN_NAMES_CI = "\\b(?:" + KNOWN_NAMES_ALT + ")\\b";
const CLI_NAMES_CI = "\\b(?:" + CLI_NAMES_ALT + ")\\b";
const KEYWORD = "\\b(?:mcp[ _]tool|slash[ _]command|cli[ _]flag|subcommand|tool|command)\\b";

const IDENT = "(?:" + QUOTED_PERMISSIVE + "|" + KNOWN_NAMES_CI + "|" + SNAKE_KEBAB + "|" + FLAG + ")";

const IMM = "[\\s'\"" + BT + "]{1,4}";
const CONN = "\\s+(?:named|called|aka)\\s+";
const VERB = "\\b(?:use|run|call|invoke)\\b";
const SLASH_GENERIC = "/(?:" + GENERIC_NAMES_ALT + ")\\b";
const CLAUSE_BOUNDARY = "(?:$|[.,;(:]|(?:when|before|after|to|with|for|on|in|if|unless|whenever)\\b)";
const ARGS = "(?:\\s+" + FLAG + "(?:\\s+" + OPCODE + "){0,4})?";
const CLI_ARG_TOKEN = "(?:[a-z][a-z0-9-]{0,15}|" + FLAG_NAKED + "|" + OPCODE + ")";
const CLI_ARG_RUN = "(?:\\s+" + CLI_ARG_TOKEN + "){1,4}";

const CMD_WITH_ARGS = "(?:(?:" + CLI_NAMES_CI + "|" + SLASH_GENERIC + ")" + CLI_ARG_RUN + ")";
const QSTRICT_CONTENT =
  "(?:" + KNOWN_NAMES_ALT + "|[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+" + "|" + FLAG_NAKED + "|" + SLASH_CMD_TOKEN +
  "|" + CMD_WITH_ARGS + "|(?:" + KNOWN_NAMES_ALT + ")" + CLI_ARG_RUN + ")";
const QUOTED_STRICT =
  "(?:" + BT + QSTRICT_CONTENT + BT + "|\"" + QSTRICT_CONTENT + "\"|'" + QSTRICT_CONTENT + "')";

const INVOCATION_FLAG_ARGS =
  VERB + "\\s+(?:" + QUOTED_STRICT + "|" + KNOWN_NAMES_CI + "|" + SNAKE_NON_DATA + "|" + SLASH_GENERIC + "|" + FLAG + ")" + ARGS + "(?=\\s*" + CLAUSE_BOUNDARY + ")";
const INVOCATION_CLI_ARGS =
  VERB + "\\s+" + CMD_WITH_ARGS + "(?=\\s*" + CLAUSE_BOUNDARY + ")";
const INVOCATION = "(?:" + INVOCATION_FLAG_ARGS + "|" + INVOCATION_CLI_ARGS + ")";

const TOOL_REFERENCE_CI = new RegExp(
  "(?:" +
    IDENT + IMM + KEYWORD + "|" + KEYWORD + IMM + IDENT + "|" +
    KEYWORD + CONN + IDENT + "|" + IDENT + CONN + KEYWORD + "|" +
    INVOCATION +
  ")",
  "i",
);

function hasCapitalisedToolName(content: string): boolean {
  for (const re of [
    /(?:the|a|an|this|that|these|those|use|run|call|invoke)\s+([A-Za-z][A-Za-z0-9]+)\b[\s'`<>]{0,4}\b(?:tool|command|subcommand)\b/gi,
    /\b(?:tool|command|subcommand)\b\s+(?:named|called|aka)\s+([A-Za-z][A-Za-z0-9]+)\b/gi,
  ]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      const w = match[1];
      if (w && w[0] >= "A" && w[0] <= "Z") return true;
    }
  }
  return false;
}

function hasCamelCaseToolName(content: string): boolean {
  const camelRe = /\b([a-z]{3,}[a-z0-9]*[A-Z][a-z][A-Za-z0-9]*)\b/g;
  let m;
  while ((m = camelRe.exec(content)) !== null) {
    const token = m[1];
    const start = m.index!;
    const end = start + token.length;
    const before = content.slice(Math.max(0, start - 20), start);
    const after = content.slice(end);
    if (/(?:^|\s)(?:use|run|call|invoke)\s*$/i.test(before) &&
        /^(?:\s*(?:$|[.,;(:]|(?:when|before|after|to|with|for|on|in|if|unless|whenever)\b))/i.test(after)) {
      return true;
    }
    if (/^(?:\s*(?:tool|command|subcommand)\b)/i.test(after) ||
        /(?:tool|command|subcommand)\s*$/i.test(before)) {
      return true;
    }
  }
  return false;
}

export function referencesAgentSpecificTool(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) return false;
  return TOOL_REFERENCE_CI.test(content) || hasCapitalisedToolName(content) || hasCamelCaseToolName(content);
}

export interface ToolScopeWithholdInputs {
  content: string;
  sourceConnector?: string;
  procedureSteps?: ReadonlyArray<{ intent?: string; expectedOutcome?: string; toolCall?: { kind?: string } }>;
}

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

export function canRecallToolScopedMemory(
  frontmatter: { sourceConnector?: string; toolScoped?: true },
  requestingConnector?: string,
): boolean {
  if (frontmatter.toolScoped !== true) return true;
  const sourceConnector = frontmatter.sourceConnector?.trim();
  const requester = requestingConnector?.trim();
  return !sourceConnector || !requester || sourceConnector === requester;
}

export interface GlobalFactPromotionInputs {
  scope: string | null | undefined;
  content: string;
  sourceConnector?: string;
  procedureSteps?: ReadonlyArray<{ toolCall?: { kind?: string } }>;
}

export function shouldPromoteGlobalFactToShared(inputs: GlobalFactPromotionInputs): boolean {
  if (inputs.scope !== "global") return false;
  return !withholdToolScopedFromSharedNamespace({
    content: inputs.content,
    sourceConnector: inputs.sourceConnector,
    procedureSteps: inputs.procedureSteps,
  });
}
