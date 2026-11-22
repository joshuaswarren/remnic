
export const DEFAULT_CITATION_FORMAT =
  "[Source: agent={agent}, session={sessionId}, ts={ts}]";

/** Sentinel value used when a provenance field is missing. */
export const CITATION_UNKNOWN = "unknown";

export interface CitationContext {
  /** Principal / agent identifier (e.g. resolved via resolvePrincipal). */
  agent?: string;
  /** Full session key (e.g. "agent:planner:main"). */
  session?: string;
  /**
   * Opaque short session id. Derived from the trailing component of the
   * session key when not provided explicitly. Use this for compact formats
   * that do not need the full colon-delimited session key.
   */
  sessionId?: string;
  /** Extraction timestamp as an ISO 8601 string. */
  ts?: string;
}

export interface ParsedCitation {
  /** Agent identifier parsed from the citation (never crashes on malformed input). */
  agent?: string;
  session?: string;
  ts?: string;
  raw: string;
}

function defaultCitationMatcher(): RegExp {
  return /\[Source:([^\]\n]{1,1024})\]/gi;
}

function trimTrailingWhitespace(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/u.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/**
 * Derive a short session id from a full session key.
 * Falls back to the raw session string if no colon is present.
 */
export function deriveSessionId(session: string | undefined): string | undefined {
  if (!session) return undefined;
  const trimmed = session.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(":").filter((p) => p.length > 0);
  if (parts.length === 0) return trimmed;
  return parts[parts.length - 1];
}

/**
 * Format an inline citation tag using the provided template.
 *
 * Missing context fields fall back to {@link CITATION_UNKNOWN} — the caller
 * should always get a non-empty, parseable tag.
 *
 * Uses a single-pass substitution so that values which themselves contain
 * placeholder syntax (e.g. an agent literally named `"{ts}"`) cannot be
 * re-interpreted by subsequent replacement steps. Each placeholder slot
 * receives exactly one lookup and the substituted value is treated as
 * terminal text, not template source.
 */
export function formatCitation(
  ctx: CitationContext,
  template: string = DEFAULT_CITATION_FORMAT,
): string {
  const session = ctx.session ?? "";
  const sessionId = ctx.sessionId ?? deriveSessionId(session) ?? CITATION_UNKNOWN;
  const ts = ctx.ts ?? CITATION_UNKNOWN;
  const agent = ctx.agent && ctx.agent.trim().length > 0 ? ctx.agent : CITATION_UNKNOWN;
  const date = ts && ts !== CITATION_UNKNOWN ? ts.slice(0, 10) : CITATION_UNKNOWN;
  const sessionForTemplate = session.trim().length > 0 ? session : CITATION_UNKNOWN;

  const values: Record<string, string> = {
    agent,
    session: sessionForTemplate,
    sessionId,
    ts,
    date,
  };

  return template.replace(/\{([a-zA-Z_][\w]*)\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(values, name)
      ? values[name]!
      : match;
  });
}

/**
 * Returns true if the text already carries at least one citation marker.
 * Safe to call on any string — never throws.
 */
export function hasCitation(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return defaultCitationMatcher().test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeRegExpCharClass(ch: string): string {
  if (ch === "]") return "\\]";
  if (ch === "\\") return "\\\\";
  if (ch === "^") return "\\^";
  if (ch === "-") return "\\-";
  return escapeRegExp(ch);
}

function buildTokenPattern(nonWordSepChars: Set<string>): string {
  const base = "\\n\\s";
  if (nonWordSepChars.size === 0) {
    return `[^\\n]+?`;
  }
  const escaped = [...nonWordSepChars].map(escapeRegExpCharClass).join("");
  return `[^${base}${escaped}]+?`;
}

const PLACEHOLDER_REGEX = /\{[a-zA-Z_][\w]*\}/g;

function templateMatcher(template: string): RegExp | null {
  const parts = template.split(PLACEHOLDER_REGEX);
  if (parts.length <= 1) return null;

  const prefix = parts[0] ?? "";
  const suffix = parts[parts.length - 1] ?? "";

  if (prefix.length > 0 || suffix.length > 0) {
    const escapedPrefix = escapeRegExp(prefix);
    const escapedSuffix = escapeRegExp(suffix);

    const innerParts = parts.slice(1, -1);

    const nonWordSepChars = new Set<string>();
    for (const sep of innerParts) {
      for (const ch of sep) {
        if (!/\w/.test(ch)) {
          nonWordSepChars.add(ch);
        }
      }
    }

    const interToken = buildTokenPattern(nonWordSepChars);
    const lastToken = buildTokenPattern(new Set<string>());

    const middle =
      innerParts.length === 0
        ? lastToken
        : interToken +
          innerParts
            .slice(0, -1)
            .map((sep) => escapeRegExp(sep) + interToken)
            .join("") +
          escapeRegExp(innerParts[innerParts.length - 1]!) +
          lastToken;

    const pattern = escapedPrefix + middle + escapedSuffix;
    return new RegExp(pattern, "i");
  }

  const middleLiterals = parts.slice(1, -1);
  const hasNonEmptyMiddle = middleLiterals.some((p) => p.length > 0);
  if (!hasNonEmptyMiddle) {
    return null;
  }

  const idToken = "[\\w.:-]+";
  const body =
    idToken +
    middleLiterals.map((lit) => escapeRegExp(lit) + idToken).join("");

  const separatorText = middleLiterals.join("");
  if (/\s/.test(separatorText)) {
    const opener = "[\\[\\(\\<]";
    const closer = "[\\]\\)\\>]";
    return new RegExp(opener + body + closer, "i");
  }

  //
  //
  //
  //
  const leadAnchor = "(?:(?<=[\\[\\(\\<])|(?<!\\S))";
  const trailAnchor = "(?:(?=[\\]\\)\\>])|(?=\\s*$))";
  return new RegExp(leadAnchor + body + trailAnchor, "i");
}

/**
 * Returns true if `text` already carries a citation produced by `template`
 * **or** by the default `[Source: ...]` format (for facts that were tagged
 * before a config change).
 *
 * Use this instead of {@link hasCitation} whenever the caller has access to
 * the configured `inlineSourceAttributionFormat`.
 *
 * All-placeholder templates such as `{agent}{sessionId}` have no literal
 * content to anchor on and therefore cannot be reliably detected without
 * dedicated sentinel markers. In that case the function returns `false` —
 * callers that need idempotent dedup for such templates should either adopt
 * a template with literal delimiters (recommended) or rely on the default
 * `[Source: ...]` marker detection which is always available via
 * {@link hasCitation}.
 */
export function hasCitationForTemplate(
  text: string,
  template: string,
  priorTemplates: readonly string[] = [],
): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (hasCitation(text)) return true;
  // Probe the current template plus every declared prior format
  // (`inlineSourceAttributionFormatHistory`, issue #3567). A fact written
  // while a different template was configured is detected here instead of
  // being double-cited or hashed with its marker intact on reprocess.
  // citationTemplatesToRecognize drops undetectable shapes, so an
  // all-placeholder prior cannot false-positive.
  for (const candidate of citationTemplatesToRecognize(template, priorTemplates)) {
    if (candidate === DEFAULT_CITATION_FORMAT) continue;
    PLACEHOLDER_REGEX.lastIndex = 0;
    if (!PLACEHOLDER_REGEX.test(candidate)) {
      PLACEHOLDER_REGEX.lastIndex = 0;
      if (text.includes(candidate)) return true;
      continue;
    }
    PLACEHOLDER_REGEX.lastIndex = 0;
    const matcher = templateMatcher(candidate);
    if (matcher?.test(text)) return true;
  }
  return false;
}

/**
 * Return the LAST citation marker in `text` for the given template (or the
 * default `[Source: ...]` shape). `attachCitation` always appends at the
 * trimmed end, so the last occurrence is the most recently attached marker —
 * callers use this to lift a just-attached citation off a cited body and
 * re-attach it to a derived body (the merged-target commit path). Returns
 * null when the text carries no marker of this template (including
 * all-placeholder templates that cannot be matched reliably).
 */
export function lastCitationMarkerForTemplate(
  text: string,
  template: string = DEFAULT_CITATION_FORMAT,
): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  let matcher: RegExp | null;
  if (template === DEFAULT_CITATION_FORMAT) {
    matcher = defaultCitationMatcher();
  } else if (!PLACEHOLDER_REGEX.test(template)) {
    PLACEHOLDER_REGEX.lastIndex = 0;
    return text.includes(template) ? template : null;
  } else {
    PLACEHOLDER_REGEX.lastIndex = 0;
    matcher = templateMatcher(template);
  }
  if (!matcher) return null;
  const global = new RegExp(
    matcher.source,
    matcher.flags.includes("g") ? matcher.flags : matcher.flags + "g",
  );
  let last: string | null = null;
  for (let match = global.exec(text); match !== null; match = global.exec(text)) {
    last = match[0];
    if (match[0].length === 0) global.lastIndex++;
  }
  return last;
}

/**
 * True when a template can be matched and stripped later. All-placeholder
 * templates such as `{agent}{sessionId}` have no literal anchors.
 */
export function citationTemplateIsDetectable(template: string): boolean {
  if (typeof template !== "string" || template.length === 0) return false;
  if (template === DEFAULT_CITATION_FORMAT) return true;
  PLACEHOLDER_REGEX.lastIndex = 0;
  if (!PLACEHOLDER_REGEX.test(template)) {
    PLACEHOLDER_REGEX.lastIndex = 0;
    return true;
  }
  PLACEHOLDER_REGEX.lastIndex = 0;
  return templateMatcher(template) !== null;
}

/**
 * Templates the merge path may lift, preserve, or strip. Longest
 * templates first so an overlapping custom marker beats an inner default
 * match; the current template wins equal-length ties. Undetectable
 * shapes are dropped so we never hash or attach a marker we cannot re-match.
 */
export function citationTemplatesToRecognize(
  primary: string | undefined,
  extra: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const add = (template: string | undefined): void => {
    if (typeof template !== "string" || template.length === 0) return;
    if (!citationTemplateIsDetectable(template)) return;
    if (!out.includes(template)) out.push(template);
  };
  add(primary);
  for (const template of extra) add(template);
  add(DEFAULT_CITATION_FORMAT);
  out.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    if (a === primary && b !== primary) return -1;
    if (b === primary && a !== primary) return 1;
    return 0;
  });
  return out;
}

/**
 * Prior formats the caller still holds, if any. Absent or malformed
 * history is ignored — fail safe, do not invent templates.
 */
export function citationTemplatesForMerge(config: {
  inlineSourceAttributionFormat?: string;
  inlineSourceAttributionFormatHistory?: unknown;
}): string[] {
  const raw = config.inlineSourceAttributionFormatHistory;
  const extra = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  return citationTemplatesToRecognize(config.inlineSourceAttributionFormat, extra);
}

export function lastRecognizedCitationMarker(
  text: string,
  templates: readonly string[],
): string | null {
  for (const template of templates) {
    const marker = lastCitationMarkerForTemplate(text, template);
    if (marker) return marker;
  }
  return null;
}

export function stripRecognizedCitations(text: string, templates: readonly string[]): string {
  let out = text;
  for (const template of templates) {
    out = stripCitationForTemplate(out, template);
  }
  return out;
}

/**
 * Attach an inline citation to fact text.
 *
 * If the text already has a citation — either the default `[Source: ...]`
 * marker or one produced by the configured template — it is returned unchanged.
 * Existing provenance is respected and never overwritten. Otherwise the
 * citation is appended to the trimmed text with a single space separator,
 * which keeps the marker visually adjacent to the fact body.
 */
export function attachCitation(
  text: string,
  ctx: CitationContext,
  template: string = DEFAULT_CITATION_FORMAT,
  priorTemplates: readonly string[] = [],
): string {
  if (typeof text !== "string") return text as unknown as string;
  if (hasCitationForTemplate(text, template, priorTemplates)) return text;
  const trimmedEnd = trimTrailingWhitespace(text);
  if (trimmedEnd.length === 0) return text;
  const citation = formatCitation(ctx, template);
  const trailing = text.slice(trimmedEnd.length);
  return `${trimmedEnd} ${citation}${trailing}`;
}

/**
 * Parse a single inline citation from a piece of text. Returns the first
 * citation encountered or `null` when none is present. Malformed citations
 * do not throw — fields that cannot be parsed simply remain `undefined`.
 */
export function parseCitation(text: string): ParsedCitation | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const matcher = defaultCitationMatcher();
  const match = matcher.exec(text);
  if (!match) return null;

  const body = match[1] ?? "";
  const raw = match[0] ?? "";
  const parsed: ParsedCitation = { raw };

  const fields = body
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const field of fields) {
    const eqIdx = field.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = field.slice(0, eqIdx).trim().toLowerCase();
    const value = field.slice(eqIdx + 1).trim();
    if (value.length === 0) continue;
    switch (key) {
      case "agent":
        parsed.agent = value;
        break;
      case "session":
      case "sessionid":
        parsed.session = value;
        break;
      case "ts":
      case "timestamp":
        parsed.ts = value;
        break;
      default:
        break;
    }
  }

  return parsed;
}

/**
 * Parse every citation embedded in the text. Always returns an array; empty
 * when none are present.
 */
export function parseAllCitations(text: string): ParsedCitation[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const matcher = defaultCitationMatcher();
  const results: ParsedCitation[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const parsed = parseCitation(match[0]);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * Remove all inline citations from a piece of text.
 *
 * Callers that want the raw fact body (for dedup hashing, display, or
 * comparison) should use this helper instead of hand-rolled regexes so the
 * whole codebase agrees on the citation syntax.
 *
 * Finding 2 fix: when the input contains no citation marker, the input is
 * returned byte-for-byte unchanged. When a citation IS removed, whitespace
 * normalization is applied only at each join seam (the single space between
 * the preceding text and where the citation was), rather than across the
 * entire string. This preserves markdown hard-break spacing, aligned text,
 * and code-like snippets in fact bodies that happen to carry a citation.
 *
 * Implementation: each citation match is replaced by its "seam fix" — the
 * content before the match has its trailing whitespace trimmed and then a
 * single space is appended if any text remains, collapsing only the gap
 * left by the removed marker. Whitespace elsewhere in the body is untouched.
 */
export function stripCitation(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  if (!hasCitation(text)) return text;

  const matcher = defaultCitationMatcher();
  let result = "";
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).replace(/[ \t]+$/, "");
    result += before;
    lastIndex = match.index + match[0].length;
  }

  const after = text.slice(lastIndex).replace(/^[ \t]+/, "");
  if (after.length > 0) {
    if (result.length > 0) result += " ";
    result += after;
  }

  return result.trimEnd();
}

/**
 * Strip an inline citation from text using a specific template regex.
 *
 * This is the template-aware counterpart to {@link stripCitation}. When the
 * caller holds the configured `inlineSourceAttributionFormat`, use this
 * function to strip citations produced by that template — including custom
 * templates that differ from the default `[Source: ...]` pattern.
 *
 * Behaviour:
 *  - If the text has a **default-format** citation, strips it first
 *    (always safe).
 *  - Then, if the result has a **custom-template** citation detected by
 *    `hasCitationForTemplate`, builds the template regex and removes every
 *    occurrence. BOTH passes run when a body carries both forms — a target
 *    written under the default format can carry the default marker plus a
 *    custom marker appended after a config change; returning after the
 *    default pass alone left the custom marker inside hash inputs (#2330).
 *  - Fully-literal templates (no placeholders) are stripped by exact match
 *    of the template text, the same inclusion check `hasCitationForTemplate`
 *    uses.
 *  - All-placeholder templates (no literal prefix/suffix/separator) cannot
 *    produce a reliable matcher. `hasCitationForTemplate` already returns
 *    `false` for such templates, so this function never attempts to strip an
 *    undetectable citation. The text is returned unchanged when no citation
 *    is detected.
 *  - If no citation is detected for the given template, returns the text
 *    unchanged.
 *
 * @returns The stripped text (or the original text when no citation is found).
 */
export function stripCitationForTemplate(
  text: string,
  template: string,
  priorTemplates: readonly string[] = [],
): string {
  if (typeof text !== "string" || text.length === 0) return text;

  // First pass: the default-format marker, if any. Later passes still run —
  // a body can carry the default marker AND markers from the current or a
  // prior configured template, and canonicalization must remove every
  // recognized form.
  let out = hasCitation(text) ? stripCitation(text) : text;

  for (const candidate of citationTemplatesToRecognize(template, priorTemplates)) {
    if (candidate === DEFAULT_CITATION_FORMAT) continue;
    out = stripSingleTemplateCitation(out, candidate);
  }
  return out;
}

// Strips every marker `template` produces — literal templates by exact
// match, placeholder templates via the compiled matcher. Undetectable
// (all-placeholder) shapes leave the text unchanged.
function stripSingleTemplateCitation(text: string, template: string): string {
  PLACEHOLDER_REGEX.lastIndex = 0;
  if (!PLACEHOLDER_REGEX.test(template)) {
    PLACEHOLDER_REGEX.lastIndex = 0;
    return stripExactLiteralCitation(text, template);
  }
  PLACEHOLDER_REGEX.lastIndex = 0;

  const matcher = templateMatcher(template);
  if (!matcher) return text;

  const globalMatcher = new RegExp(
    matcher.source,
    matcher.flags.includes("g") ? matcher.flags : matcher.flags + "g",
  );
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = globalMatcher.exec(text)) !== null) {
    const matchEnd = match.index + match[0].length;
    const enclosure = enclosingDelimiterRange(text, match.index, matchEnd);
    const removalStart = enclosure?.start ?? match.index;
    const removalEnd = enclosure?.end ?? matchEnd;
    const before = text.slice(lastIndex, removalStart).replace(/[ \t]+$/, "");
    result += before;
    lastIndex = removalEnd;
    // Guard against zero-width matches causing an infinite loop.
    if (match[0].length === 0) {
      globalMatcher.lastIndex++;
    }
  }

  const after = text.slice(lastIndex).replace(/^[ \t]+/, "");
  if (after.length > 0) {
    if (result.length > 0) result += " ";
    result += after;
  }

  return result.trimEnd();
}

function stripExactLiteralCitation(text: string, marker: string): string {
  if (marker.length === 0) return text;
  let result = "";
  let lastIndex = 0;
  let idx = text.indexOf(marker);
  if (idx === -1) return text;
  while (idx !== -1) {
    const before = text.slice(lastIndex, idx).replace(/[ \t]+$/, "");
    result += before;
    lastIndex = idx + marker.length;
    idx = text.indexOf(marker, lastIndex);
  }
  const after = text.slice(lastIndex).replace(/^[ \t]+/, "");
  if (after.length > 0) {
    if (result.length > 0) result += " ";
    result += after;
  }
  return result.trimEnd();
}

function enclosingDelimiterRange(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  if (start <= 0 || end >= text.length) return undefined;
  const opener = text[start - 1];
  const closer = text[end];
  if (
    (opener === "[" && closer === "]") ||
    (opener === "(" && closer === ")") ||
    (opener === "<" && closer === ">")
  ) {
    return { start: start - 1, end: end + 1 };
  }
  return undefined;
}
