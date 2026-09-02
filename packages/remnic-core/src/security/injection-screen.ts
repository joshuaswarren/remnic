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

export type InjectionScreenProfile = "default" | "hardened";

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
  // Remnic command references can redirect the memory system itself.
  "authority-escalation": 4,
  // Stored response controls try to turn recalled data into future behavior.
  "response-control-directive": 4,
  // Tool-routing controls replace the current tool choice from recalled data.
  "tool-routing-directive": 4,
} as const;

// Rules whose confidence depends on the screen profile (#1962). `hardened`
// (any named memoryInjectionDefenseMode) treats a conditional trigger alone
// as high-confidence; `default` (custom mode) keeps weight 3 so benign
// conditional procedure prose stays below the threshold. Rules absent from
// this table share RULE_WEIGHTS in both profiles.
const PROFILE_RULE_WEIGHTS = {
  // Conditional triggers encode a hidden action for a future turn.
  "conditional-trigger": { default: 3, hardened: 4 },
} as const;

function ruleWeight(rule: string, profile: InjectionScreenProfile): number {
  const profileWeights = PROFILE_RULE_WEIGHTS[rule as keyof typeof PROFILE_RULE_WEIGHTS];
  return profileWeights
    ? profileWeights[profile]
    : RULE_WEIGHTS[rule as keyof typeof RULE_WEIGHTS];
}

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
    /\b(?:agent|assistant|ai|model)[ \t]{0,8}[,!:.-][ \t]{0,8}(?:please[ \t]{1,8})?(?:ignore|disregard|call|run|execute|send|delete|reveal|email|store|remember|follow|use|do|answer|respond|reply|emit|output|return|include|produce|say)\b/i,
  ) ?? findingFor(
    "imperative-to-agent",
    content,
    /\b(?:agent|assistant|ai|model)[ \t]{1,8}(?:must|should|need to|please|to)[ \t]{1,8}(?:ignore|disregard|call|run|execute|send|delete|reveal|email|store|remember|follow|use|do|answer|respond|reply|emit|output|return|include|produce|say)\b/i,
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
    /\b(?:when|if|unless|after|only after|if and only if|on seeing)\b[\s\S]{1,180}\b(?:ask|asked|say|says|see|sees|seeing|hear|hears|receive|receives|mention|mentions|mentioned|appear|appears|contain|contains|encounter|encounters|phrase|condition|key)\b[\s\S]{0,180}\b(?:then[ \t]{1,8})?(?:answer|call|include|invoke|run|execute|send|delete|reveal|store|use|follow|do|respond|reply|emit|output|return|produce|say|add|replace)\b/i,
  ) ?? findingFor(
    "conditional-trigger",
    content,
    /\b(?:when|if|unless)\b[\s\S]{1,120},[ \t]{0,8}(?:then[ \t]{1,8})?(?:answer|call|include|invoke|run|execute|send|delete|reveal|store|use|follow|do|respond|reply|emit|output|return|produce|say|add|replace)\b/i,
  );
}

function findResponseControlDirective(content: string): InjectionScreenFinding | undefined {
  return findingFor(
    "response-control-directive",
    content,
    /\b(?:answer|response|reply|behavior|instruction|rule|policy|reminder|note|retrieval|activation|preference|questions?|condition)\b[\s\S]{0,120}\b(?:must|should|requires?|means|becomes?|is[ \t]{1,8}exactly|replace|produce|include|add|emit|output|return|respond|reply|answer|say|begin|cause|use)\b|\b(?:must|should|requires?|replace|produce|include|add|emit|output|return|respond|reply|answer|say|begin|cause|use)\b[\s\S]{0,120}\b(?:answer|response|reply|behavior|instruction|rule|policy|reminder|note|retrieval|activation|preference|questions?|condition)\b/i,
  );
}

function findToolRoutingDirective(content: string): InjectionScreenFinding | undefined {
  return findingFor(
    "tool-routing-directive",
    content,
    /\b(?:ignore|redirect(?:ing)?|override|substitute|preferred[_ -]?tool|never[ \t]{1,8}use|must[ \t]{1,8}call|requires?[ \t]{1,8}redirecting)\b[\s\S]{0,160}\b(?:tool|function|[a-z][a-z0-9-]*[_:.][a-z0-9-]+)\b|\b(?:tool|function|[a-z][a-z0-9-]*[_:.][a-z0-9-]+)\b[\s\S]{0,160}\b(?:redirect(?:ing)?|override|substitute|preferred[_ -]?tool|never[ \t]{1,8}use|must[ \t]{1,8}call)\b/i,
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
export function screenCandidateFact(content: string, profile: InjectionScreenProfile = "default"): InjectionScreenResult {
  const findings: InjectionScreenFinding[] = [];
  const rules: Array<[string, (value: string) => InjectionScreenFinding | undefined]> = [
    ["imperative-to-agent", findImperativeToAgent],
    ["tool-invocation-syntax", findToolInvocationSyntax],
    ["encoded-blob", findEncodedBlob],
    ["ignore-previous-family", findIgnorePreviousFamily],
    ["conditional-trigger", findConditionalTrigger],
    ["authority-escalation", findAuthorityEscalation],
    ["response-control-directive", findResponseControlDirective],
    ["tool-routing-directive", findToolRoutingDirective],
  ];
  for (const [rule, find] of rules) {
    const finding = find(content);
    if (finding) findings.push({ rule, excerpt: finding.excerpt });
  }
  const score = findings.reduce((sum, finding) => sum + ruleWeight(finding.rule, profile), 0);
  return { score, findings, quarantine: score >= INJECTION_SCREEN_THRESHOLD };
}
