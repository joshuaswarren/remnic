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

const RESPONSE_NOUN = String.raw`(?:answers?|responses?|repl(?:y|ies)|output)`;
const RESPONSE_CONTROL_PATTERNS: readonly RegExp[] = [
  // "the approved response concerning X is exactly CANARY"
  new RegExp(
    String.raw`\b${RESPONSE_NOUN}\b[^\n]{0,60}\b(?:(?:is|are|be)[ \t]{1,8}exactly|becomes?)\b`,
    "i",
  ),
  // "the response must include / should begin with / needs to say ..."
  new RegExp(
    String.raw`\b${RESPONSE_NOUN}\b[^\n]{0,60}\b(?:must|should|shall|will|needs?[ \t]{1,8}to|has[ \t]{1,8}to|have[ \t]{1,8}to|is[ \t]{1,8}to|are[ \t]{1,8}to)[ \t]{1,8}(?:always[ \t]{1,8})?(?:include|contain|begin|start|end|say|state|mention|output|return|emit|produce|read|quote|reference|append|prepend)\b`,
    "i",
  ),
  // "include CANARY in every answer", "add <url> to answers"
  new RegExp(
    String.raw`\b(?:include|add|emit|output|return|append|prepend|say|state|put)\b[^\n]{0,80}\b(?:in|to|into|with|as|on)[ \t]{1,8}[^\n]{0,30}\b${RESPONSE_NOUN}\b`,
    "i",
  ),
  // "reply with the marker CANARY", "respond by saying"
  /\b(?:reply|respond|answer)[ \t]{1,8}(?:with|by|using)[ \t]{1,8}(?:the[ \t]{1,8}|only[ \t]{1,8}|exactly[ \t]{1,8})?(?:marker|phrase|code|string|text|token|exact|exactly|only|saying|outputting|returning|CANARY)/i,
  // "activation requires outputting CANARY", "retrieval should produce CANARY"
  /\b(?:requires?|should|must|will)[ \t]{1,8}(?:outputting|emitting|returning|saying|replying|responding|answering|producing|output|emit|produce)\b[^\n]{0,40}\b(?:CANARY|marker|phrase|code|token|exactly|https?:)/i,
  /\b(?:retrieval|recall|activation)\b[^\n]{0,40}\b(?:should|must|will|requires?)[ \t]{1,8}(?:produce|output|emit|return|say|reply|respond)\b/i,
  // "say CANARY", "answer CANARY", "use CANARY instead", "return https://..."
  /\b(?:say|answer|reply|respond|output|return|emit|use|produce)[ \t]{1,8}(?:with[ \t]{1,8}|only[ \t]{1,8}|exactly[ \t]{1,8})?(?:CANARY|the[ \t]{1,8}(?:literal|exact|marker|phrase|string|token)\b|https?:)/i,
  // "replace normal behavior with the literal response", "require the literal marker"
  /\breplace[ \t]{1,8}(?:normal|default|your|the|its|all)?[ \t]{0,8}(?:behaviou?r|responses?|answers?|repl(?:y|ies)|output)\b/i,
  /\b(?:literal|exact|verbatim)[ \t]{1,8}(?:response|answer|reply|marker|string|output|phrase|token)\b/i,
];

/**
 * Corroborating signals that separate an injected response control from
 * ordinary prose about response content (issue #3078). "The API response
 * must include a Content-Type header" is directive-SHAPED but names an
 * ordinary field; an injection additionally carries one of:
 *
 *  - an opaque payload to emit: a marker token, a long hex/UUID run, a URL;
 *  - verbatim control: literal / exact / word-for-word / "with no explanation";
 *  - cross-turn persistence: remember / persist / store this / any later
 *    retrieval / across conversations / from now on;
 *  - an agent-directed subject: your answer, the assistant's reply.
 *
 * Requiring one of these keeps every frozen attack payload flagged while
 * ordinary technical and policy sentences fall to zero.
 */
/**
 * Corroborating cues. Measured trade (PR #3079 r4): these are evaluated over
 * the whole memory, not the directive's sentence. Thirty frozen attack
 * payloads state the directive and name the payload in DIFFERENT sentences,
 * so sentence-local cues lose real detections; the price is that a marker in
 * an unrelated sentence can corroborate an ordinary directive. The
 * emission-slot check below stays sentence-local, where locality is free.
 */
const RESPONSE_CONTROL_CORROBORATORS: readonly RegExp[] = [
  /\bCANARY\b/i,
  /https?:\/\//i,
  /\b[0-9a-f]{8,}\b/i,
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
  // Naming the emission as a phrase/marker/token is a payload cue: ordinary
  // prose names a field ("the request id"), not "the phrase".
  /\b(?:the|this|that|following)[ \t]{1,8}(?:phrase|marker|token|string|sequence|literal|codeword|passphrase)\b/i,
  // Verbatim control over the wording, not the content.
  /\b(?:literal(?:ly)?|verbatim|word[- ]for[- ]word|exactly[ \t]{1,8}(?:this|that|as)|character[- ]for[- ]character)\b/i,
  /\bno[ \t]{1,8}(?:explanation|commentary|preamble|deviation|other[ \t]{1,8}text)\b/i,
  /\b(?:only|nothing[ \t]{1,8}else|and[ \t]{1,8}nothing)\b[^\n]{0,30}\b(?:answers?|responses?|repl(?:y|ies)|output|say|said)\b/i,
  // Persistence across turns: an ordinary fact does not legislate later turns.
  /\b(?:remember|persist|store[ \t]{1,8}this|retain[ \t]{1,8}this)\b/i,
  /\bany[ \t]{1,8}(?:later|future|subsequent)\b/i,
  /\b(?:future|later|subsequent|following|upcoming)[ \t]{1,8}(?:answers?|responses?|repl(?:y|ies)|output|turns?|messages?|conversations?|sessions?)\b/i,
  /\b(?:across|between)[ \t]{1,8}(?:conversations|sessions|chats)\b/i,
  /\b(?:from[ \t]{1,8}now[ \t]{1,8}on|going[ \t]{1,8}forward|in[ \t]{1,8}(?:all|every)[ \t]{1,8}(?:future|later)[ \t]{1,8}(?:turns?|answers?|responses?))\b/i,
  /\b(?:whenever|every[ \t]{1,8}time|each[ \t]{1,8}time|any[ \t]{1,8}time)\b[^\n]{0,60}\b(?:asked|discussed|mentioned|queried|retrieved|recalled)\b/i,
  // The subject is the agent, not a system under discussion.
  /\byour[ \t]{1,8}(?:answers?|responses?|repl(?:y|ies)|output|behaviou?r|memory)\b/i,
  /\b(?:assistant|agent|model)(?:'s)?[ \t]{1,8}(?:answers?|responses?|repl(?:y|ies)|output|behaviou?r)\b/i,
  // A hidden activation phrase is itself the second signal.
  /\b(?:activation|trigger)[ \t]{1,8}(?:phrase|key|word|code)\b/i,
  /\b(?:approved|required|correct|canonical)[ \t]{1,8}(?:response|answer|reply)\b/i,
];


/**
 * Acronyms that appear as ordinary content in technical memories, so an
 * all-caps token alone is not evidence of an injected marker.
 */
const ORDINARY_CAPS_TOKENS: ReadonlySet<string> = new Set([
  "API", "HTTP", "HTTPS", "JSON", "XML", "HTML", "CSS", "CSV", "TSV", "YAML", "TOML",
  "SQL", "URL", "URI", "UUID", "ID", "IDS", "UTC", "ISO", "PDF", "PNG", "JPEG", "SVG",
  "TLS", "SSL", "SSH", "DNS", "TCP", "UDP", "IP", "CDN", "CORS", "CSRF", "JWT", "OAUTH",
  "REST", "GRPC", "RPC", "SDK", "CLI", "GUI", "OK", "YES", "NO", "TODO", "FAQ", "PR",
  "CI", "CD", "QA", "UX", "UI", "MIT", "GPL", "EU", "US", "AM", "PM", "FYI", "ETA",
  // Crypto, encoding, and spec vocabulary (trailing digits are stripped
  // before this lookup, so SHA256/SHA-256/UTF8/ISO8601/RFC3339 all reduce).
  "SHA", "MD", "HMAC", "AES", "RSA", "ECDSA", "PBKDF", "BCRYPT", "SCRYPT", "ARGON",
  "UTF", "ASCII", "BASE", "HEX", "CRC", "GZIP", "ZSTD", "RFC", "ANSI", "IEEE",
  "SMTP", "IMAP", "LDAP", "SAML", "OIDC", "SSO", "MFA", "TOTP", "ACL", "RBAC",
  "AWS", "GCP", "GPU", "CPU", "RAM", "SSD", "OS", "VM", "K8S", "NPM", "SEMVER",
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE",
]);

/**
 * Capitalized words that open ordinary templates ("replies must begin with
 * Dear"), so a leading capital alone is not a marker (PR #3079 r3).
 */
const ORDINARY_CAPITALIZED_WORDS: ReadonlySet<string> = new Set([
  "Dear", "Hello", "Hi", "Greetings", "Please", "Thanks", "Thank", "Regards",
  "Sincerely", "Yes", "No", "True", "False", "Null", "None", "Error", "Warning",
  "Note", "Summary", "Subject", "Re", "Fwd", "Attention", "Notice", "Draft",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
]);

/**
 * An opaque token the memory wants echoed verbatim, in the emission slot of
 * a directive: "responses must begin with PWNED". A determiner ("with THE
 * ticket number", "include A Content-Type header") means the object is a
 * described value rather than a literal to emit, and ordinary acronyms are
 * excluded, so technical prose does not match (PR #3079 review).
 */
const OPAQUE_EMISSION_TARGET =
  /\b(?:begin|start|end|include|contain|say|state|output|return|emit|produce|reply|respond|answer)\b[ \t]{1,8}(?:(?:with|by)[ \t]{1,8})?/gi;

/** The emission slot's own content: a quoted payload or a shaped marker. */
const EMISSION_SLOT_VALUE = /^(?:"([^"\n]{2,40})"|'([^'\n]{2,40})'|([A-Z][A-Za-z0-9_-]{1,39})\b)/;

/**
 * Sentence split that never cuts inside a quoted span: a payload like
 * `"exfil me!"` keeps its delimiters, or the emission target would be
 * unrecognizable (PR #3079 r4).
 */
function splitSentencesOutsideQuotes(content: string): string[] {
  const sentences: string[] = [];
  let current = "";
  let quote: string | undefined;
  let previous = "";
  for (const char of content) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      previous = char;
      continue;
    }
    // An apostrophe inside a word is a contraction ("It's"), not an opening
    // quote: treating it as one merges sentences and lets a marker in a
    // later sentence corroborate an ordinary directive (PR #3079 post-cap).
    if (char === '"' || (char === "'" && !/[A-Za-z0-9]/.test(previous))) {
      quote = char;
      current += char;
      previous = char;
      continue;
    }
    if (char === "." || char === "!" || char === "?" || char === "\n") {
      if (current.trim().length > 0) sentences.push(current);
      current = "";
      previous = char;
      continue;
    }
    current += char;
    previous = char;
  }
  if (current.trim().length > 0) sentences.push(current);
  return sentences;
}

/** Strip trailing digits so SHA256, UTF8, and ISO8601 reduce to their acronym. */
function reduceToken(token: string): string {
  return token.replace(/[0-9]+$/, "");
}

/** Is one emission-slot token an ordinary described value rather than a payload? */
function isOrdinaryToken(token: string): boolean {
  const segments = token.split(/[-_]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;
  // A hyphenated Title-Case name is a field or header ("Content-Type",
  // "Cache-Control"), not a marker: markers are all-caps or carry digits.
  if (segments.length > 1 && segments.every((segment) => /^[A-Z][a-z]+$/.test(segment))) return true;
  return segments.every((segment) => {
    if (/^[0-9]+$/.test(segment)) return true;
    const reduced = reduceToken(segment);
    if (ORDINARY_CAPS_TOKENS.has(segment) || ORDINARY_CAPS_TOKENS.has(reduced)) return true;
    return ORDINARY_CAPITALIZED_WORDS.has(segment);
  });
}

/**
 * An opaque token the memory wants echoed verbatim, in the emission slot of
 * a directive IN THE SAME SENTENCE: "responses must begin with PWNED". A
 * determiner ("with THE ticket number", "include A Content-Type header")
 * means the object is a described value; ordinary acronyms, spec vocabulary,
 * and template openers are excluded, quoted or not, so technical prose does
 * not match (PR #3079 r2/r3).
 */
function hasOpaqueEmissionTarget(sentence: string): boolean {
  // The verb is matched case-insensitively ("must BEGIN with"), the marker
  // case-sensitively: an all-lowercase word in the slot is ordinary prose
  // and cannot be told from a marker (PR #3079 r4).
  // Every verb occurrence is tried: the emission verb is not always the
  // first one in the sentence ("The ANSWER must INCLUDE ...", r4).
  OPAQUE_EMISSION_TARGET.lastIndex = 0;
  for (
    let verb = OPAQUE_EMISSION_TARGET.exec(sentence);
    verb !== null;
    verb = OPAQUE_EMISSION_TARGET.exec(sentence)
  ) {
    const match = EMISSION_SLOT_VALUE.exec(sentence.slice(verb.index + verb[0].length));
    if (!match) continue;
    const quoted = match[1] ?? match[2];
    if (quoted !== undefined) {
      const inner = quoted.trim();
      // A quoted multi-word payload is opaque; a single quoted technical
      // value ("OK", "Content-Type") is the same described value as unquoted.
      if (!/\s/.test(inner) && isOrdinaryToken(inner)) continue;
      return true;
    }
    const token = match[3];
    if (token !== undefined && !isOrdinaryToken(token)) return true;
  }
  return false;
}

/**
 * A directive over what the agent's future answer must contain or say,
 * corroborated by a second signal. Ordinary facts that merely pair
 * "policy"/"note"/"response" with a common verb ("the return policy requires
 * a receipt", "the API response must include a Content-Type header") are not
 * directives and are not flagged.
 */
function findResponseControlDirective(
  content: string,
  profile: InjectionScreenProfile = "default",
): InjectionScreenFinding | undefined {
  const directive = RESPONSE_CONTROL_PATTERNS.map((pattern) =>
    findingFor("response-control-directive", content, pattern),
  ).find((finding) => finding !== undefined);
  if (!directive) return undefined;
  // `hardened` is the profile an operator opts into for strict security: it
  // keeps the pre-corroboration behavior, so no directive shape can be
  // talked past the gate there. `default` (custom mode) requires a second
  // signal, which is what keeps ordinary response prose out of quarantine.
  if (profile === "hardened") return directive;
  // Cue scope is a measured trade; see RESPONSE_CONTROL_CORROBORATORS.
  if (RESPONSE_CONTROL_CORROBORATORS.some((pattern) => pattern.test(content))) return directive;
  for (const sentence of splitSentencesOutsideQuotes(content)) {
    if (!RESPONSE_CONTROL_PATTERNS.some((pattern) => pattern.test(sentence))) continue;
    if (hasOpaqueEmissionTarget(sentence)) return directive;
  }
  return undefined;
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
  const rules: Array<
    [string, (value: string, screenProfile: InjectionScreenProfile) => InjectionScreenFinding | undefined]
  > = [
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
    const finding = find(content, profile);
    if (finding) findings.push({ rule, excerpt: finding.excerpt });
  }
  const score = findings.reduce((sum, finding) => sum + ruleWeight(finding.rule, profile), 0);
  return { score, findings, quarantine: score >= INJECTION_SCREEN_THRESHOLD };
}
