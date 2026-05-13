/**
 * Inline Source Attribution Protocol (issue #369)
 *
 * Extracted facts carry provenance inline inside the fact body, so the
 * citation survives hostile memory text, copy/paste, and LLM quoting. This
 * complements — never replaces — the YAML frontmatter provenance stored on
 * disk.
 *
 * Default format (matches issue #369 proposal):
 *
 *   The foo service uses Redis for rate limiting. [Source: agent=planner, session=abc123, ts=2026-04-10T14:25:07Z]
 *
 * Key properties:
 *   - Inline (part of the body, not metadata).
 *   - Compact (typically <80 chars of overhead per fact).
 *   - Machine-parseable by a single regex.
 *   - Opt-in via `inlineSourceAttributionEnabled` config flag (default off
 *     for backwards compatibility with existing downstream consumers).
 *   - Legacy facts without a citation remain fully readable.
 *
 * The format template is configurable via `inlineSourceAttributionFormat`
 * with supported placeholders:
 *
 *   {agent}     — principal / agent identifier
 *   {session}   — full session key (colon-delimited)
 *   {sessionId} — short stable session id (trailing component)
 *   {ts}        — extraction timestamp (ISO 8601)
 *   {date}      — extraction date (YYYY-MM-DD)
 *
 * Any privacy-sensitive identifiers should be normalized before being passed
 * to `formatCitation` — the helper treats them as opaque strings.
 */

/** Default citation format template (matches issue #369). */
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
  /** Session identifier parsed from the citation. */
  session?: string;
  /** Extraction timestamp parsed from the citation. */
  ts?: string;
  /** The full matched citation substring. */
  raw: string;
}

/**
 * Regex that matches the default `[Source: agent=X, session=Y, ts=Z]` shape
 * as well as human-edited variants (extra whitespace, reordered fields,
 * subset of fields). Matches non-greedily so it can be anchored anywhere in
 * the text. Kept as a getter factory so callers do not share regex state.
 */
function defaultCitationMatcher(): RegExp {
  return /\[Source:\s*([^\]\n]+?)\]/gi;
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

  // Map from recognised placeholder names to their resolved value. Unknown
  // placeholder names are left intact (returning the original `{name}`).
  const values: Record<string, string> = {
    agent,
    session: sessionForTemplate,
    sessionId,
    ts,
    date,
  };

  // Single-pass scan: replace every recognised `{name}` in one sweep so that
  // substituted values cannot themselves be treated as template source on a
  // subsequent pass. The replacer-function form also guarantees that `$` /
  // `$&` / `$1` sequences inside values are emitted literally.
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

/**
 * Escape a string for use as a regex literal.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escape a single character for use INSIDE a character class `[...]`.
 * Special chars inside character classes: `]`, `\`, `^`, `-`.
 */
function escapeRegExpCharClass(ch: string): string {
  if (ch === "]") return "\\]";
  if (ch === "\\") return "\\\\";
  if (ch === "^") return "\\^";
  if (ch === "-") return "\\-";
  // Other regex meta chars are NOT special inside [...] but escaping them is safe.
  return escapeRegExp(ch);
}

/**
 * Build a per-placeholder token pattern that excludes newlines, whitespace,
 * and any punctuation characters used as inner separators in the template.
 *
 * This prevents a placeholder span from consuming separator bytes and
 * matching strings that cross separator boundaries in user-supplied content.
 *
 * @param nonWordSepChars - Set of non-word (non-alphanumeric, non-`_`) chars
 *   extracted from the inner separator literals of the template.
 */
function buildTokenPattern(nonWordSepChars: Set<string>): string {
  // Always exclude newlines and whitespace.
  const base = "\\n\\s";
  if (nonWordSepChars.size === 0) {
    // No inner separator punctuation — the placeholder spans the full space
    // between prefix and suffix. Fall back to a generous no-newline match.
    return `[^\\n]+?`;
  }
  const escaped = [...nonWordSepChars].map(escapeRegExpCharClass).join("");
  return `[^${base}${escaped}]+?`;
}

/** Regex that matches a `{placeholder}` token inside a template string. */
const PLACEHOLDER_REGEX = /\{[a-zA-Z_][\w]*\}/g;

/**
 * Build a regex that matches a citation produced by the given template.
 *
 * The approach depends on the shape of the template:
 *
 *  - **Normal case (non-empty literal prefix or suffix).** Anchor the match
 *    on the outer literal frame and reconstruct the interior as
 *    `interToken + sep + interToken + sep + ... + sep + lastToken`.
 *    All **intermediate** per-placeholder tokens exclude the combined set of
 *    non-word separator characters used between any two adjacent placeholders,
 *    preventing a value from consuming a separator and crossing placeholder
 *    boundaries.  The **last** token is only required to avoid newlines because
 *    it is terminated by the literal suffix anchor — this lets placeholder
 *    values that legitimately contain a separator character be recognised (e.g.
 *    an ISO-8601 timestamp `2026-04-10T14:25:07Z` in `[src:{agent}:{ts}]`
 *    where `:` is the inter-placeholder separator).  A template like
 *    `[src:{agent}/{sessionId}@{date}]` emits
 *    `\[src:[^\n\s/@]+?\/[^\n\s/@]+?@[^\n]+?\]` so that `[src:foo/bar]`
 *    is NOT matched (wrong separator count), `[src:foo/bar/extra@2026]`
 *    is NOT matched (intermediate token crosses a `/` boundary), and
 *    `[src:planner/main@2026-04-10]` IS matched correctly.
 *
 *  - **Placeholder-bounded with whitespace separator.** Both prefix and
 *    suffix are empty and the separator literal(s) between placeholders
 *    contain at least one whitespace character (e.g. `{source}: {content}`,
 *    `{agent} {sessionId}`). A whitespace-containing separator produces
 *    output that is visually indistinguishable from ordinary prose, so the
 *    safe strategy is to require a **hard bracket/paren/angle delimiter** on
 *    both sides of the reconstructed match. Prose almost never places
 *    `[...]` / `(...)` / `<...>` around a phrase, so this yields clean
 *    false-positive rejection.
 *
 *  - **Placeholder-bounded with compact (non-whitespace) separator.** Both
 *    prefix and suffix are empty and the separator literal(s) contain NO
 *    whitespace (e.g. `{agent}:{sessionId}`, `{agent}/{sessionId}`).
 *    `formatCitation` emits a compact token like `planner:main` with no
 *    surrounding delimiters, so the bracket strategy cannot detect it.
 *    Instead, the pattern requires that the entire token is bordered by
 *    whitespace or a bracket/paren/angle on each side:
 *
 *      `(?:(?<=[\[\(\<])|(?<!\S))[\w.-]+<sep>[\w.-]+(?:(?=[\]\)\>])|(?!\S))`
 *
 *    This accepts `planner:main` when it appears standalone or inside a
 *    bracket-wrapped token, and rejects `host:80` embedded inside a URL like
 *    `http://host:80` because `host` is immediately preceded by `/`
 *    (non-whitespace, non-bracket).
 *
 *  - **All-placeholder case (no literals between placeholders either).** No
 *    reliable regex can be built — a template like `{agent}{sessionId}`
 *    contains no anchor characters. Returns `null`; {@link
 *    hasCitationForTemplate} treats this as "cannot detect" and returns
 *    false, falling back on explicit sentinel/format detection only for the
 *    default `[Source: ...]` shape.
 *
 * Returns `null` when the template has no placeholders (fully-literal
 * citation, handled by the string-equality fast path in {@link
 * hasCitationForTemplate}) **or** when the template is entirely placeholder-
 * only with no literal content whatsoever.
 */
function templateMatcher(template: string): RegExp | null {
  // Split around all {placeholder} tokens.
  const parts = template.split(PLACEHOLDER_REGEX);
  if (parts.length <= 1) return null;

  const prefix = parts[0] ?? "";
  const suffix = parts[parts.length - 1] ?? "";

  // Normal case: at least one literal frame on the outside.
  // Tighten the per-placeholder token so it cannot consume separator
  // characters and match strings that cross separator boundaries
  // (Finding 3 — Uru3).
  if (prefix.length > 0 || suffix.length > 0) {
    const escapedPrefix = escapeRegExp(prefix);
    const escapedSuffix = escapeRegExp(suffix);

    // Inner parts: literal separators that sit between adjacent placeholders.
    // For `[src:{agent}/{sessionId}@{date}]`, parts = ["[src:", "/", "@", "]"]
    // so innerParts = ["/", "@"].
    const innerParts = parts.slice(1, -1);

    // Collect only the non-word (punctuation/symbol) characters from each
    // inner separator so alphabetic separator text (unlikely but valid) does
    // not exclude letters from the per-placeholder token pattern.
    const nonWordSepChars = new Set<string>();
    for (const sep of innerParts) {
      for (const ch of sep) {
        if (!/\w/.test(ch)) {
          nonWordSepChars.add(ch);
        }
      }
    }

    // All intermediate tokens (every placeholder except the last) use the
    // combined exclusion so they cannot cross placeholder boundaries.
    //
    // The LAST token is different: it is terminated by the literal suffix anchor
    // (e.g. `\]`), so it does not need to exclude inner-separator characters.
    // Dropping that restriction lets placeholder values that legitimately contain
    // a separator character (e.g. an ISO-8601 timestamp `2026-04-10T14:25:07Z`
    // in template `[src:{agent}:{ts}]`) be recognised correctly instead of
    // producing false-negative misses that trigger duplicate citation injection.
    //
    // Only the LAST token is relaxed.  Intermediate tokens keep the combined
    // exclusion so that cross-boundary false positives are still rejected
    // (e.g. `[src:foo/bar/extra@2026-04-11]` for `[src:{a}/{b}@{c}]`).
    const interToken = buildTokenPattern(nonWordSepChars);
    // Last token: terminated by suffix anchor — exclude only newlines.
    const lastToken = buildTokenPattern(new Set<string>());

    // Reconstruct the interior: interToken sep interToken sep ... sep lastToken
    // (or just lastToken when there are no inner separators at all).
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

  // Placeholder-bounded case: prefix and suffix are both empty.
  const middleLiterals = parts.slice(1, -1);
  const hasNonEmptyMiddle = middleLiterals.some((p) => p.length > 0);
  if (!hasNonEmptyMiddle) {
    // All-placeholder template with no literal content. Impossible to anchor
    // reliably without sentinel markers; signal the caller.
    return null;
  }

  // Identifier token: one or more word chars, dots, dashes, or colons.
  // Colons are included to allow timestamp values like "10:30" or session
  // keys like "agent:planner:main" inside compact placeholder-bounded
  // templates.  URL-like fragments (`http://host:80`) are still rejected
  // because the lead anchor requires whitespace or a bracket immediately
  // before the first id-token group (`http` is preceded by `/`).
  const idToken = "[\\w.:-]+";
  const body =
    idToken +
    middleLiterals.map((lit) => escapeRegExp(lit) + idToken).join("");

  const separatorText = middleLiterals.join("");
  if (/\s/.test(separatorText)) {
    // Separator contains whitespace: the emitted citation looks like ordinary
    // prose (e.g. `planner main`). Require a hard bracket/paren/angle
    // delimiter on both sides to prevent false matches on English text.
    const opener = "[\\[\\(\\<]";
    const closer = "[\\]\\)\\>]";
    return new RegExp(opener + body + closer, "i");
  }

  // Separator is compact (no whitespace): `formatCitation` emits a token like
  // `planner:main` without surrounding delimiters. The challenge is that the
  // same token shape also matches ordinary hyphenated or slashed prose words
  // (e.g. `long-term`, `docs/setup`), causing `hasCitationForTemplate` to
  // return true on uncited fact bodies and silently suppress citation injection
  // from `attachCitation`.
  //
  // Fix (Finding 1): tighten the trail anchor so a bare compact token is only
  // accepted when it sits at the very end of the string (possibly followed by
  // optional trailing whitespace or a newline). Since `attachCitation` always
  // appends the citation at the trimmed end of the fact body, a real citation
  // token will always appear at the tail. Prose like `"long-term solution"`
  // has `long-term` in the middle of the string (followed by ` solution`), so
  // the end-of-string anchor rejects it — no false positive, no silent drop.
  //
  // The lead anchor still accepts either a bracket opener or a whitespace
  // boundary (or start of string), so `"Fact. planner:main"` and standalone
  // `"planner:main"` are both detected after the first attachment pass.
  //
  // Bracket-wrapped form (e.g. `[planner:main]`) is also accepted via the
  // opener/closer pair — bracket still takes precedence over end-of-string.
  //
  // Example — why `http://host:80` does NOT match:
  //   Trying to match `host:80`: the char before `h` is `/` (non-whitespace,
  //   non-bracket), so `(?<=[\[\(\<])` and `(?<!\S)` both fail ⟹ no match.
  //   Trying to match `http:...`: after `http:` the next chars are `//` which
  //   are not `[\w.-]+`, so the second id-token group fails ⟹ no match.
  const leadAnchor = "(?:(?<=[\\[\\(\\<])|(?<!\\S))";
  // Trail: either a bracket closer (for `[token]` shape) or end-of-string
  // optionally preceded by whitespace. The `(?!\S)` is deliberately removed
  // so that a compact token in the MIDDLE of a sentence does not match.
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
export function hasCitationForTemplate(text: string, template: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  // Always accept the default format as a fallback so facts tagged before a
  // configuration change are not double-tagged on reprocessing.
  if (hasCitation(text)) return true;
  // If the configured template matches the default, we're done.
  //
  // Known limitation (Thread 2 — Codex P2): this fast path exits without
  // checking whether the content carries a citation from a DIFFERENT custom
  // template that was active before the config was changed back to the default.
  // Such a fact would be detected by `hasCitation` above only if the prior
  // custom template happened to match the default `[Source: ...]` pattern.
  // In practice, template changes mid-stream are rare, and the false-negative
  // (missing an old custom citation) produces a benign duplicate citation rather
  // than data loss. A full fix would require storing the citation template used
  // at write time in the frontmatter and checking that here.
  if (template === DEFAULT_CITATION_FORMAT) return false;

  // Fully-literal template (no placeholders): exact inclusion check.
  if (!PLACEHOLDER_REGEX.test(template)) {
    // Reset lastIndex because PLACEHOLDER_REGEX is declared with /g.
    PLACEHOLDER_REGEX.lastIndex = 0;
    return text.includes(template);
  }
  // Reset lastIndex after the .test() probe above.
  PLACEHOLDER_REGEX.lastIndex = 0;

  const matcher = templateMatcher(template);
  if (!matcher) {
    // All-placeholder template: cannot build a reliable matcher. See the
    // docstring — callers should not rely on dedup for this shape.
    return false;
  }
  return matcher.test(text);
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
): string {
  if (typeof text !== "string") return text as unknown as string;
  if (hasCitationForTemplate(text, template)) return text;
  const trimmedEnd = text.replace(/\s+$/u, "");
  if (trimmedEnd.length === 0) return text;
  const citation = formatCitation(ctx, template);
  // Preserve any trailing newline that callers rely on for markdown rendering.
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
        // Unknown fields are ignored defensively so human edits never crash.
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
  // Early exit: no citation marker present — return the input unchanged so
  // that callers never lose formatting fidelity on uncited strings.
  if (!hasCitation(text)) return text;

  // Walk through all citations and slice them out one by one so that we can
  // normalise ONLY the whitespace at each seam rather than the entire string.
  const matcher = defaultCitationMatcher();
  let result = "";
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    // Text before this citation. Trim trailing spaces/tabs at the seam only.
    const before = text.slice(lastIndex, match.index).replace(/[ \t]+$/, "");
    result += before;
    lastIndex = match.index + match[0].length;
  }

  // Append any trailing text after the last citation. Trim leading
  // spaces/tabs and trailing whitespace at the join seam.
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
 *  - If the text has a **default-format** citation, delegates to
 *    {@link stripCitation} (always safe).
 *  - If the text has a **custom-template** citation detected by
 *    `hasCitationForTemplate`, builds the template regex and removes every
 *    occurrence (citations are appended at the end of the fact body by
 *    {@link attachCitation}).
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
): string {
  if (typeof text !== "string" || text.length === 0) return text;

  // Fast path: default-format citation — delegate to the existing stripper.
  if (hasCitation(text)) return stripCitation(text);

  // No default citation; check whether the custom template produced one.
  // hasCitationForTemplate returns false for all-placeholder templates (no
  // reliable matcher), so those pass through unchanged below.
  if (!hasCitationForTemplate(text, template)) return text;

  // Build the template matcher. hasCitationForTemplate already returned true,
  // which means templateMatcher produced a non-null result. The null branch
  // here is a defensive fallback only — delegate to stripCitation.
  const matcher = templateMatcher(template);
  if (!matcher) return stripCitation(text);

  // The matcher regex was built without the global flag; add it for exec loop.
  const globalMatcher = new RegExp(
    matcher.source,
    matcher.flags.includes("g") ? matcher.flags : matcher.flags + "g",
  );
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = globalMatcher.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).replace(/[ \t]+$/, "");
    result += before;
    lastIndex = match.index + match[0].length;
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
