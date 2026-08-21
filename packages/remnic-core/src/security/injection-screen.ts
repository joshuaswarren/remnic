/**
 * Deterministic write-path screening for prompt-injection-shaped facts (#1955).
 *
 * This module has no model or storage calls. It only returns explainable
 * findings so callers can quarantine a candidate for human review.
 */

export interface InjectionScreenFinding {
  rule: string;
  excerpt: string;
}

export interface InjectionScreenResult {
  score: number;
  findings: InjectionScreenFinding[];
  quarantine: boolean;
}

// Each score reflects the confidence that the candidate carries executable
// instructions rather than an ordinary fact.
const RULE_WEIGHTS = {
  // Direct commands to an agent are high-confidence instructions.
  "imperative-to-agent": 4,
  // Tool syntax names an executable operation and its arguments.
  "tool-invocation-syntax": 4,
  // Encoded blobs are opaque and cannot receive normal factual review.
  "encoded-blob": 5,
  // Instruction resets directly try to replace the active authority.
  "ignore-previous-family": 4,
  // Conditional triggers encode a hidden action for a future turn.
  "conditional-trigger": 3,
  // Remnic command references can redirect the memory system itself.
  "authority-escalation": 4,
} as const;

// Weight 4 blocks one high-confidence instruction pattern, while ordinary
// prose remains at zero. Encoded blobs use weight 5 because they are opaque.
export const INJECTION_SCREEN_THRESHOLD = 4;

const MAX_EXCERPT_LENGTH = 180;
const AUTHORITY_EXECUTABLE_TOOL_REFERENCE =
  String.raw`(?:remnic|engram)(?:\s+security\s+audit-memory\b|\s+(?:memory_store|suggestion_submit|observe|recall|delete_memory|memory_correct_apply|memory_search)(?:\s+(?:tool|command))?\b|\s+(?:tool|command)\b|[_:-](?:memory_store|suggestion_submit|observe|recall|delete_memory|memory_correct_apply|memory_search)\b)`;
const AUTHORITY_OPTIONAL_QUOTE = String.raw`[\`"']?`;
const AUTHORITY_DIRECTIVE_PATTERN = new RegExp(
  String.raw`\b(?:call|invoke|execute|run|use)\s+(?:the\s+)?${AUTHORITY_OPTIONAL_QUOTE}${AUTHORITY_EXECUTABLE_TOOL_REFERENCE}`,
  "i",
);
const AUTHORITY_MANDATORY_DIRECTIVE_PATTERN = new RegExp(
  String.raw`\byou\s+(?:must|should)\s+(?:call|invoke|execute|run|use)\s+(?:the\s+)?${AUTHORITY_OPTIONAL_QUOTE}${AUTHORITY_EXECUTABLE_TOOL_REFERENCE}`,
  "i",
);

function excerptFor(content: string, match?: RegExpMatchArray): string {
  const start = match?.index ?? 0;
  const excerpt = content.slice(Math.max(0, start - 32), start + MAX_EXCERPT_LENGTH);
  return excerpt.length < content.length ? `${excerpt}…` : excerpt;
}

function findingFor(rule: string, content: string, pattern: RegExp): InjectionScreenFinding | undefined {
  const match = content.match(pattern);
  if (!match) return undefined;
  return { rule, excerpt: excerptFor(content, match) };
}

function findImperativeToAgent(content: string): InjectionScreenFinding | undefined {
  return findingFor(
    "imperative-to-agent",
    content,
    /\b(?:agent|assistant|ai|model)\s*[,!:.-]\s*(?:please\s+)?(?:ignore|disregard|call|run|execute|send|delete|reveal|email|store|remember|follow|use|do)\b/i,
  ) ?? findingFor(
    "imperative-to-agent",
    content,
    /\b(?:agent|assistant|ai|model)\s+(?:must|should|need to|please)\s+(?:ignore|disregard|call|run|execute|send|delete|reveal|email|store|remember|follow|use|do)\b/i,
  );
}

function findToolInvocationSyntax(content: string): InjectionScreenFinding | undefined {
  return findingFor(
    "tool-invocation-syntax",
    content,
    /\{\s*["']?(?:tool|function|name)["']?\s*:\s*["'][^"']+["'][\s\S]*["']?(?:args|arguments|parameters)["']?\s*:/i,
  ) ?? findingFor(
    "tool-invocation-syntax",
    content,
    // Bare verbs only count when the target looks like a tool identifier
    // (namespaced / snake_case / dotted) or is explicitly called a tool —
    // plain English like "on-call SRE" or "call Sam" must not trip the
    // screen (#1955 false-positive criterion).
    /<(?:tool(?:_call)?|function(?:_call)?|invoke)\b[^>]*>|\b(?:call|invoke|execute|run)\s+(?:the\s+)?[a-z][a-z0-9-]*(?:[_:.][a-z0-9-]+)+\b|\b(?:call|invoke|execute|run)\s+the\s+[a-z0-9-]+\s+tool\b/i,
  ) ?? findingFor(
    "tool-invocation-syntax",
    content,
    /\b(?:call|invoke|execute)\s*\(\s*["'][\w:-]+["']/i,
  );
}

function findEncodedBlob(content: string): InjectionScreenFinding | undefined {
  return findingFor("encoded-blob", content, /\b[0-9a-f]{121,}\b/i) ?? findingFor(
    "encoded-blob",
    content,
    /\b[A-Za-z0-9+/]{121,}={0,2}\b/,
  );
}

function findIgnorePreviousFamily(content: string): InjectionScreenFinding | undefined {
  return findingFor(
    "ignore-previous-family",
    content,
    /\b(?:ignore|disregard|skip|forget|dismiss)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|directions?|rules?|messages?|context)\b/i,
  ) ?? findingFor(
    "ignore-previous-family",
    content,
    /\b(?:do\s+not|don't)\s+(?:follow|obey)\s+(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|directions?)\b/i,
  );
}

function findConditionalTrigger(content: string): InjectionScreenFinding | undefined {
  return findingFor(
    "conditional-trigger",
    content,
    /\b(?:when|if)\b[\s\S]{1,120}\b(?:say|says|see|sees|hear|hears|receive|receives|mention|mentions|contain|contains|encounter|encounters)\b[\s\S]{1,120}\b(?:then\s+)?(?:call|invoke|run|execute|send|delete|reveal|store|use|follow|do|respond)\b/i,
  ) ?? findingFor(
    "conditional-trigger",
    content,
    /\b(?:when|if)\b[\s\S]{1,100},\s*(?:then\s+)?(?:call|invoke|run|execute|send|delete|reveal|store|use|follow|do|respond)\b/i,
  );
}

function findAuthorityEscalation(content: string): InjectionScreenFinding | undefined {
  return findingFor(
    "authority-escalation",
    content,
    AUTHORITY_DIRECTIVE_PATTERN,
  ) ?? findingFor(
    "authority-escalation",
    content,
    AUTHORITY_MANDATORY_DIRECTIVE_PATTERN,
  );
}

/** Screen a candidate fact without model calls, I/O, or mutable state. */
export function screenCandidateFact(content: string): InjectionScreenResult {
  const findings: InjectionScreenFinding[] = [];
  const rules: Array<[string, (value: string) => InjectionScreenFinding | undefined]> = [
    ["imperative-to-agent", findImperativeToAgent],
    ["tool-invocation-syntax", findToolInvocationSyntax],
    ["encoded-blob", findEncodedBlob],
    ["ignore-previous-family", findIgnorePreviousFamily],
    ["conditional-trigger", findConditionalTrigger],
    ["authority-escalation", findAuthorityEscalation],
  ];
  for (const [rule, find] of rules) {
    const finding = find(content);
    if (finding) findings.push({ rule, excerpt: finding.excerpt });
  }
  const score = findings.reduce((sum, finding) => sum + RULE_WEIGHTS[finding.rule as keyof typeof RULE_WEIGHTS], 0);
  return { score, findings, quarantine: score >= INJECTION_SCREEN_THRESHOLD };
}
