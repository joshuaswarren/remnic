/**
 * Cross-reviewer review-thread deduplication (issue #1994, umbrella #1988).
 *
 * A pure, deterministic module — no model dependency, no GitHub API calls — so
 * it is unit-tested against fixtures harvested from the real #1923/#1852
 * duplicate threads and mirrored inline in `.github/workflows/review-thread-guard.yml`
 * (same convention as `scripts/effective-diff.mjs`; keep the two copies in sync).
 *
 * Design invariant (from the issue): precision beats recall everywhere. A missed
 * duplicate costs one redundant reply; a false merge can silence a real bug.
 * Two threads are duplicates ONLY when they share a file, their anchored line
 * ranges overlap, AND their finding fingerprints are lexically similar at or
 * above the committed threshold. Nothing is ever deleted or hidden — a duplicate
 * inherits its canonical's resolution for the guard's unresolved count, and a
 * one-reply `not-a-duplicate` escape hatch detaches it back into the round set.
 */

/**
 * Shipped configuration. The threshold is justified by the committed fixtures
 * (see tests/review-dedup.test.mjs): every real duplicate pair scores at or
 * above it and every one of the 20 sampled non-duplicate pairs scores below it,
 * for measured precision 1.0 on the fixture set.
 */
export const REVIEW_DEDUP_CONFIG = Object.freeze({
  // Word k-shingle size over content tokens. k=1 (content-word set) is the most
  // robust for reviewer paraphrase of the same finding on the same lines.
  shingleSize: 1,
  // Jaccard similarity at or above this merges (given anchor overlap).
  similarityThreshold: 0.5,
  // Directional guard: an identical token SET (set-sim >= directionalSetMin) with
  // an essentially reversed ORDER (bigram-sim <= directionalOrderMax) is a
  // contradictory pair ("X instead of Y" vs "Y instead of X"), not a duplicate,
  // so it must NOT fold. Genuine paraphrase dups have a lower set-sim and a
  // nonzero bigram-sim, so the guard never fires on them (codex P2).
  directionalSetMin: 0.9,
  directionalOrderMax: 0.1,
});

// Reviewers whose findings are never deduplicated. CodeQL threads cannot be
// resolved via the API and are already excluded by the guard; keep them whole.
export const NON_DEDUP_AUTHOR_LOGINS = new Set([
  "github-advanced-security",
  "github-advanced-security[bot]",
  "github-code-scanning[bot]",
]);

// Marker on gate-authored dedup replies: makes reply-linking idempotent and
// keeps the gate's own "reply not-a-duplicate to detach" instruction from
// self-triggering the detach escape hatch below.
export const GATE_REPLY_MARKER = "<!-- remnic-review-dedup:duplicate -->";

// Only the Actions bot posts the gate reply (via GITHUB_TOKEN). The marker is
// public, so trusting it regardless of author lets anyone who can comment paste
// it into a duplicate and fold the thread out of the guard without a real
// gate-authored link — a false-merge vector (codex P2). Require the author.
export const GATE_REPLY_AUTHOR_LOGINS = new Set(["github-actions", "github-actions[bot]"]);

// PR-level label applied when at least one finding is merged, so the merge is
// discoverable off the thread as well as on it.
export const DUPLICATE_LABEL = "duplicate-finding";

/** Gate-authored reply body linking a duplicate to its canonical thread. */
export function formatDuplicateReply(canonicalUrl) {
  return (
    `${GATE_REPLY_MARKER}\n` +
    `Duplicate of ${canonicalUrl} — this finding is already tracked there, so it ` +
    `inherits that thread's resolution for the merge gate. Nothing is hidden: if ` +
    `the canonical is unresolved the finding still gates via it.\n\n` +
    "If this is a distinct finding, reply `not-a-duplicate` and it detaches back " +
    "into the round set within one gate cycle."
  );
}

/** True when the gate (Actions bot) already posted its dedup reply (idempotency). */
export function hasGateReply(thread) {
  const replies = thread?.comments?.nodes ?? thread?.replies ?? [];
  return replies.some(
    (c) =>
      GATE_REPLY_AUTHOR_LOGINS.has(c?.author?.login ?? "") &&
      (c?.body ?? "").includes(GATE_REPLY_MARKER),
  );
}

// A single maintainer/agent reply carrying this token detaches a merged thread
// back into the round set — the load-bearing escape hatch against false merges.
const DETACH_PATTERN = /\bnot-a-duplicate\b/i;

// Markup/boilerplate stripped before fingerprinting so badge shields, feedback
// footers, severity tags, and emphasis never dominate the lexical signal.
const CODE_FENCE_PATTERN = /```([\s\S]*?)```/g;
// Preserve fenced code (bounded) instead of dropping it: two findings on the
// same lines can carry their only distinguishing facts inside fenced snippets,
// and deleting them collapses both fingerprints to identical prose -> false
// merge in enforce mode. Keep the inner code minus the language line, capped so
// a large block can't dominate the fingerprint (codex P2).
const FENCE_TOKEN_BUDGET = 200;
// Also flatten angle brackets so JSX/generics inside the fence (e.g. <Foo/>)
// survive as tokens instead of being deleted by the later HTML-tag pass —
// otherwise <Foo/> vs <Bar/> both collapse to the same tokens (codex P2).
const preserveFencedCode = (_match, inner) =>
  ` ${String(inner).replace(/^[^\n]*\n/, "").replace(/[<>]/g, " ").slice(0, FENCE_TOKEN_BUDGET)} `;
const INLINE_CODE_PATTERN = /`([^`]*)`/g;
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const SEVERITY_TAG_PATTERN =
  /\b(?:p[0-4]|sev[0-4]|nit|blocker|critical|major|minor|bug|issue|warning|suggestion)\b\s*[:.)\]-]*/gi;
// Footer-anchored: strips only a line that STARTS (after optional markup, emoji,
// or HTML) with a bot-footer phrase — not any line that merely mentions one. An
// unanchored `^.*phrase.*$` deletes a real finding line like "validate the
// generated by header", collapsing two distinct findings and false-merging them
// (precision > recall). The leading class excludes newlines so the prefix can't
// span into a preceding line, and excludes '<' so the tag branch is the only way
// to match it — a disjoint alternation, avoiding regex backtracking (CodeQL).
const FEEDBACK_BOILERPLATE_PATTERN =
  /^(?:<[^>]*>|[^A-Za-z\n<])*(?:was this (?:report|comment) helpful|give feedback|react with|generated by|powered by)\b.*$/gim;
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu;
const NON_WORD_PATTERN = /[^a-z0-9]+/g;

// Common English + markdown-noise stopwords. Removing them keeps the fingerprint
// on the finding's nouns/verbs, not connective tissue. Negations (no/not/cannot)
// are deliberately NOT stopwords: dropping them makes a prohibition and its
// opposite recommendation look identical and false-merge (codex P2).
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
  "could", "de", "do", "does", "for", "from", "has", "have", "if",
  "in", "into", "is", "it", "its", "may", "of", "on", "or", "so",
  "than", "that", "the", "their", "then", "there", "these", "this", "to",
  "up", "was", "we", "when", "which", "will", "with", "would", "you", "your",
  "should", "shall", "here", "how", "why", "what", "where", "who", "this",
]);

/** Strip markdown/HTML/badges/boilerplate from a comment body. */
export function stripMarkup(body) {
  if (typeof body !== "string") return "";
  return body
    .replace(FEEDBACK_BOILERPLATE_PATTERN, " ")
    .replace(CODE_FENCE_PATTERN, preserveFencedCode)
    .replace(IMAGE_PATTERN, " ")
    .replace(LINK_PATTERN, "$1")
    // Flatten angle brackets in inline code (same as fenced code) so JSX/generic
    // identifiers survive as tokens instead of being deleted by the HTML pass
    // below — else `<Foo/>` vs `<Bar/>` collapse to identical tokens (codex P2).
    .replace(INLINE_CODE_PATTERN, (_m, code) => ` ${code.replace(/[<>]/g, " ")} `)
    .replace(HTML_TAG_PATTERN, " ")
    .replace(EMOJI_PATTERN, " ")
    .toLowerCase()
    // Expand contracted negations so the negation survives tokenizing: otherwise
    // `n't` splits into `n`/`t`, both dropped, and a prohibition collapses into
    // its opposite (codex P2). Irregular forms first, then the general rule.
    .replace(/\bcan['’]t\b/g, "can not")
    .replace(/\bwon['’]t\b/g, "will not")
    .replace(/\bshan['’]t\b/g, "shall not")
    .replace(/(\w+?)n['’]t\b/g, "$1 not")
    .replace(SEVERITY_TAG_PATTERN, " ")
    .replace(/[#*_>`~[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized content tokens: markup stripped, stopwords and 1-char tokens dropped. */
export function contentTokens(body) {
  return stripMarkup(body)
    .split(NON_WORD_PATTERN)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

// Directional markers whose two flanking operands carry the meaning: "X instead
// of Y" / "X rather than Y". ("of"/"than" are stopwords, so in the content-token
// stream the marker is the bare "instead"/"rather".)
const DIRECTIONAL_MARKERS = new Set(["instead", "rather"]);

/** The {before, after} operand token PHRASES flanking the first directional
 * marker, or null. Phrases (not single tokens) so multi-word operands like
 * "memory cache" vs "disk store" are compared whole. */
function directionalPhrases(tokens) {
  for (let i = 1; i < tokens.length - 1; i++) {
    if (DIRECTIONAL_MARKERS.has(tokens[i])) {
      return { before: tokens.slice(0, i), after: tokens.slice(i + 1) };
    }
  }
  return null;
}

const seqEqual = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
// Drop the shared leading framing (verb) common to both `before` phrases and the
// shared trailing context common to both `after` phrases, leaving just the
// operands to compare.
const dropCommonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return [a.slice(i), b.slice(i)];
};
const dropCommonSuffix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return [a.slice(0, a.length - i), b.slice(0, b.length - i)];
};

/**
 * True when two bodies state the SAME directive with its operand PHRASES SWAPPED
 * ("use memory cache instead of disk store" vs "use disk store instead of memory
 * cache"). A contradiction, not a duplicate — even with multi-word operands and
 * shared leading/trailing context that keeps the ordered-bigram score above the
 * reversed-order cutoff.
 */
function directionalOperandsSwapped(bodyA, bodyB) {
  const a = directionalPhrases(contentTokens(bodyA));
  const b = directionalPhrases(contentTokens(bodyB));
  if (!a || !b) return false;
  const [aBefore, bBefore] = dropCommonPrefix(a.before, b.before);
  const [aAfter, bAfter] = dropCommonSuffix(a.after, b.after);
  if (aBefore.length === 0 || aAfter.length === 0) return false;
  return seqEqual(aBefore, bAfter) && seqEqual(aAfter, bBefore);
}

// Negation tokens that flip a finding's polarity (contractions are already
// expanded to "not"/"will not"/... before tokenizing).
const NEGATION_TOKENS = new Set(["not", "no", "cannot", "never", "none"]);

/**
 * True when two bodies are the SAME finding at OPPOSITE polarity — one is a
 * prohibition, the other an affirmative ("Do not call deleteAll" vs "Call
 * deleteAll"). Preserving the negation token is not enough: the k=1 Jaccard
 * still scores such pairs above threshold. Reject only when exactly one side
 * carries a negation AND the non-negation content is otherwise IDENTICAL, so a
 * genuine duplicate with an incidental negation (different wording) is unaffected.
 */
function polarityMismatch(bodyA, bodyB) {
  const a = new Set(contentTokens(bodyA));
  const b = new Set(contentTokens(bodyB));
  const aNeg = [...a].some((t) => NEGATION_TOKENS.has(t));
  const bNeg = [...b].some((t) => NEGATION_TOKENS.has(t));
  if (aNeg === bNeg) return false;
  const strip = (s) => [...s].filter((t) => !NEGATION_TOKENS.has(t));
  const na = strip(a);
  const nb = new Set(strip(b));
  // Exact non-negation content match: only a true polarity flip, never an
  // incidental negation inside an otherwise differently-worded duplicate.
  return na.length > 0 && na.length === nb.size && na.every((t) => nb.has(t));
}

/** Deterministic set of word k-shingles over content tokens. */
export function fingerprint(body, shingleSize = REVIEW_DEDUP_CONFIG.shingleSize) {
  const tokens = contentTokens(body);
  const k = Math.max(1, shingleSize | 0);
  if (k === 1) return new Set(tokens);
  const shingles = new Set();
  for (let i = 0; i + k <= tokens.length; i++) {
    shingles.add(tokens.slice(i, i + k).join(" "));
  }
  // A body with fewer than k tokens still contributes its whole token run so it
  // is never silently un-fingerprintable.
  if (shingles.size === 0 && tokens.length > 0) shingles.add(tokens.join(" "));
  return shingles;
}

/** Jaccard similarity of two finding bodies' fingerprints in [0, 1]. */
export function fingerprintSimilarity(
  bodyA,
  bodyB,
  shingleSize = REVIEW_DEDUP_CONFIG.shingleSize,
) {
  const a = fingerprint(bodyA, shingleSize);
  const b = fingerprint(bodyB, shingleSize);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const shingle of a) {
    if (b.has(shingle)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Blame-relative anchor for a thread. Reuses the guard's thread identity model
 * (GraphQL thread id + first comment) rather than inventing a second one; the
 * line range comes from the review thread's line fields, tolerating the null
 * lines GitHub reports for outdated threads.
 */
export function threadAnchor(thread) {
  const comment = thread?.comments?.nodes?.[0] ?? thread?.firstComment ?? thread;
  const path = comment?.path ?? thread?.path ?? null;
  const rawEnd = thread?.line ?? comment?.line ?? thread?.originalLine ?? comment?.originalLine;
  const rawStart =
    thread?.startLine ?? comment?.startLine ?? thread?.originalStartLine ?? comment?.originalStartLine ?? rawEnd;
  const start = Number.isInteger(rawStart) ? rawStart : null;
  const end = Number.isInteger(rawEnd) ? rawEnd : null;
  // Diff side (LEFT = pre-image, RIGHT = post-image). For a multi-line thread the
  // START and END lines can be on different sides, so the anchor carries both:
  // GitHub exposes startDiffSide (first line) separately from diffSide (last
  // line). Two threads that share a line span but differ on either side are
  // different locations and must not dedupe. Missing side normalizes to RIGHT.
  const endSide = thread?.diffSide ?? comment?.diffSide ?? thread?.side ?? "RIGHT";
  const startSide = thread?.startDiffSide ?? comment?.startDiffSide ?? thread?.startSide ?? endSide;
  return { path, start, end, side: `${startSide}:${endSide}` };
}

/**
 * Same file with intersecting line ranges. Missing ranges never overlap: an
 * unknown range is treated as no-overlap (miss = cheap, false merge = feared).
 */
export function anchorsOverlap(a, b) {
  if (!a?.path || !b?.path || a.path !== b.path) return false;
  if (a.side !== b.side) return false;
  if (a.start === null || a.end === null || b.start === null || b.end === null) {
    return false;
  }
  const [aLo, aHi] = a.start <= a.end ? [a.start, a.end] : [a.end, a.start];
  const [bLo, bHi] = b.start <= b.end ? [b.start, b.end] : [b.end, b.start];
  return aLo <= bHi && bLo <= aHi;
}

function firstAuthorLogin(thread) {
  return thread?.comments?.nodes?.[0]?.author?.login ?? thread?.author?.login ?? null;
}

function firstBody(thread) {
  return thread?.comments?.nodes?.[0]?.body ?? thread?.body ?? "";
}

/** True when a maintainer/agent has replied `not-a-duplicate` on the thread. */
export function isDetached(thread) {
  const replies = thread?.comments?.nodes ?? thread?.replies ?? [];
  // The first comment is the finding itself; a detach must be a reply to it.
  // The gate's own reply mentions "not-a-duplicate" as instructions — never let
  // that self-trigger the escape hatch, so skip replies carrying the marker.
  return replies.slice(1).some((c) => {
    const body = c?.body ?? "";
    if (body.includes(GATE_REPLY_MARKER)) return false;
    return DETACH_PATTERN.test(body);
  });
}

function isNonDedupThread(thread) {
  return NON_DEDUP_AUTHOR_LOGINS.has(firstAuthorLogin(thread) ?? "");
}

function stableSort(threads) {
  return threads
    .map((thread, index) => ({ thread, index }))
    .sort((x, y) => {
      const xt = Date.parse(x.thread?.comments?.nodes?.[0]?.createdAt ?? x.thread?.createdAt ?? "");
      const yt = Date.parse(y.thread?.comments?.nodes?.[0]?.createdAt ?? y.thread?.createdAt ?? "");
      const xn = Number.isFinite(xt) ? xt : 0;
      const yn = Number.isFinite(yt) ? yt : 0;
      if (xn !== yn) return xn - yn;
      return x.index - y.index; // Stable tie-break: original filing order.
    })
    .map((entry) => entry.thread);
}

/**
 * Classify each thread as canonical or a duplicate of an earlier canonical.
 * First-seen (earliest by createdAt, then filing order) is canonical.
 *
 * Returns { records, canonicalIds, duplicateCount } where each record is
 * { id, thread, canonicalId, similarity }. canonicalId === id for canonicals,
 * detached threads, and non-dedup (CodeQL) threads.
 */
export function dedupeThreads(threads, config = REVIEW_DEDUP_CONFIG) {
  const threshold = config?.similarityThreshold ?? REVIEW_DEDUP_CONFIG.similarityThreshold;
  const shingleSize = config?.shingleSize ?? REVIEW_DEDUP_CONFIG.shingleSize;
  const directionalSetMin = config?.directionalSetMin ?? REVIEW_DEDUP_CONFIG.directionalSetMin;
  const directionalOrderMax = config?.directionalOrderMax ?? REVIEW_DEDUP_CONFIG.directionalOrderMax;
  const ordered = stableSort(Array.isArray(threads) ? threads : []);
  const canonicals = [];
  const records = [];

  for (const thread of ordered) {
    const id = thread?.id ?? null;
    const anchor = threadAnchor(thread);
    const body = firstBody(thread);

    if (isNonDedupThread(thread) || isDetached(thread)) {
      records.push({ id, thread, canonicalId: id, similarity: null });
      // A detached thread stays a canonical candidate: a genuinely distinct
      // finding can anchor later duplicates. A CodeQL/non-dedup thread must NOT
      // — the guard excludes it entirely, so folding a real finding into it
      // would silently hide that finding (the failure mode this design fears).
      // A resolved+outdated thread must NOT anchor either: its anchor's code
      // changed, so a NEW active finding on the same range must not inherit its
      // stale resolution (codex P2 — false merge via a stale canonical).
      if (!isNonDedupThread(thread) && !isStaleResolvedCanonical(thread)) {
        canonicals.push({ id, anchor, body });
      }
      continue;
    }

    let match = null;
    let matchSimilarity = 0;
    for (const canonical of canonicals) {
      if (!anchorsOverlap(anchor, canonical.anchor)) continue;
      const similarity = fingerprintSimilarity(body, canonical.body, shingleSize);
      if (similarity < threshold || similarity <= matchSimilarity) continue;
      // Directional guard: a contradictory pair, not a duplicate. Two signals —
      // (1) an identical token set in reversed order (k=1 set-sim can't see
      // order, so cross-check the ordered bigram-sim); (2) a swapped "instead
      // of"/"rather than" operand pair, which survives shared surrounding context
      // that would otherwise lift the bigram-sim past the cutoff.
      const orderSimilarity = fingerprintSimilarity(body, canonical.body, 2);
      const reversedOrder = similarity >= directionalSetMin && orderSimilarity <= directionalOrderMax;
      if (
        reversedOrder ||
        directionalOperandsSwapped(body, canonical.body) ||
        polarityMismatch(body, canonical.body)
      ) {
        continue;
      }
      match = canonical;
      matchSimilarity = similarity;
    }

    if (match) {
      records.push({ id, thread, canonicalId: match.id, similarity: matchSimilarity });
    } else {
      records.push({ id, thread, canonicalId: id, similarity: null });
      // Skip anchoring later duplicates to a resolved+outdated thread (see the
      // detached-branch note above): stale resolution must not fold in a new
      // active finding on the same range.
      if (!isStaleResolvedCanonical(thread)) canonicals.push({ id, anchor, body });
    }
  }

  const canonicalIds = new Set(canonicals.map((c) => c.id));
  const duplicateCount = records.filter((r) => r.canonicalId !== r.id).length;
  return { records, canonicalIds, duplicateCount };
}

function isThreadResolved(thread) {
  return thread?.isResolved === true;
}

// A resolved thread whose anchor's code has since changed (isOutdated) must not
// serve as a canonical: a NEW active finding on the same file/range would
// otherwise inherit its stale resolution and pass the merge gate unresolved.
function isStaleResolvedCanonical(thread) {
  return isThreadResolved(thread) && thread?.isOutdated === true;
}

/**
 * Effective guard obligations after dedup. Each canonical (or standalone /
 * detached / CodeQL) thread is counted at most once; a duplicate folds into its
 * canonical and inherits its resolution.
 *
 * - applyInheritance=false (shadow mode): the unresolved COUNT is byte-identical
 *   to today's raw unresolved count, but ledger/measurement data is still
 *   produced so a false-merge would be visible before enforcement flips.
 * - applyInheritance=true (enforce): a duplicate whose canonical is resolved no
 *   longer contributes an obligation; resolving the canonical auto-satisfies it.
 *
 * `wouldBeLostUniqueFindings` reports duplicates whose canonical is UNRESOLVED —
 * i.e. findings enforcement would still surface, proving no distinct finding is
 * hidden by the merge.
 */
export function computeGuardObligations(threads, config = REVIEW_DEDUP_CONFIG, options = {}) {
  const applyInheritance = options.applyInheritance === true;
  const { records, duplicateCount } = dedupeThreads(threads, config);
  const byId = new Map(records.map((r) => [r.id, r]));

  const canonicalResolved = new Map();
  for (const record of records) {
    if (record.canonicalId === record.id) {
      canonicalResolved.set(record.id, isThreadResolved(record.thread));
    }
  }

  const rawUnresolved = [];
  const effectiveUnresolved = [];
  const wouldBeLostUniqueFindings = [];

  for (const record of records) {
    const { thread } = record;
    if (isNonDedupThread(thread)) continue; // Guard already excludes CodeQL.
    const selfResolved = isThreadResolved(thread);
    if (!selfResolved) rawUnresolved.push(thread);

    const isDuplicate = record.canonicalId !== record.id;
    if (!isDuplicate) {
      if (!selfResolved) effectiveUnresolved.push(thread);
      continue;
    }

    const canonicalIsResolved = canonicalResolved.get(record.canonicalId) === true;
    if (!selfResolved && !canonicalIsResolved) {
      // Canonical still open: the finding is NOT hidden — it surfaces via the
      // canonical, so nothing is lost, and we do not double-count the duplicate.
      wouldBeLostUniqueFindings.push({
        id: record.id,
        canonicalId: record.canonicalId,
        surfacedByCanonical: true,
      });
    }
    if (!applyInheritance) {
      if (!selfResolved) effectiveUnresolved.push(thread); // Shadow: preserve raw count.
    } else if (!selfResolved && canonicalIsResolved && !hasGateReply(thread)) {
      // Enforce: a resolved canonical folds a duplicate ONLY with audit evidence
      // (the gate-authored reply). Without it, folding would let a transient or
      // read-only reply-post failure pass enforce with no gate-authored
      // instruction on the thread, so keep gating — the unsticker reruns the
      // guard to post the reply. (A duplicate under an UNRESOLVED canonical is
      // not pushed here: the canonical already gates the finding.)
      effectiveUnresolved.push(thread);
    }
  }

  return {
    records,
    duplicateCount,
    rawUnresolvedCount: rawUnresolved.length,
    effectiveUnresolvedCount: effectiveUnresolved.length,
    effectiveUnresolved,
    wouldBeLostUniqueFindings,
  };
}

/**
 * Per-round ledger lines for the gate summary comment (measurement hook,
 * umbrella decision D). Reports threads filed, deduplicated, unique-by-reviewer,
 * and the canonical link each duplicate was merged into so a false merge is
 * visible and one `not-a-duplicate` reply reverses it.
 */
export function formatRoundLedger(threads, config = REVIEW_DEDUP_CONFIG) {
  const { records, duplicateCount } = dedupeThreads(threads, config);
  const filed = records.length;
  const uniqueByReviewer = new Map();
  for (const record of records) {
    if (record.canonicalId !== record.id) continue;
    const login = firstAuthorLogin(record.thread) ?? "unknown";
    uniqueByReviewer.set(login, (uniqueByReviewer.get(login) ?? 0) + 1);
  }

  const canonicalUrl = (id) => {
    const record = records.find((r) => r.id === id);
    const comment = record?.thread?.comments?.nodes?.[0];
    return comment?.url ?? `thread ${id}`;
  };

  const dedupLines = records
    .filter((r) => r.canonicalId !== r.id)
    .map(
      (r) =>
        `- ${firstAuthorLogin(r.thread) ?? "unknown"} duplicate of ${canonicalUrl(
          r.canonicalId,
        )} (similarity ${r.similarity.toFixed(2)})`,
    );

  const uniqueSummary = [...uniqueByReviewer.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([login, count]) => `${login}: ${count}`)
    .join(", ");

  const header =
    `Review-thread dedup: ${filed} filed, ${duplicateCount} deduplicated` +
    (duplicateCount > 0 ? ` → ${duplicateCount} canonical link(s) below` : "") +
    `; unique-by-reviewer — ${uniqueSummary || "none"}.`;

  return duplicateCount > 0 ? [header, ...dedupLines].join("\n") : header;
}
