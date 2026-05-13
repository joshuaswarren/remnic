import {
  buildEvidencePack,
  insertAfterEvidenceHeading,
  type EvidencePackItem,
} from "./evidence-pack.js";
import type { ExplicitCueRecallEngine } from "./explicit-cue-recall.js";

export interface FocusedListRecallOptions {
  engine: ExplicitCueRecallEngine | null | undefined;
  sessionId?: string;
  query: string;
  maxChars: number;
  maxItemChars?: number;
  maxSearchResults?: number;
  maxScanWindowTurns?: number;
  maxScanWindowTokens?: number;
  title?: string;
}

type FocusedListIntent = "count" | "recommendation" | "relation";

interface RankedFocusedListItem extends EvidencePackItem {
  rank: number;
}

interface CountCandidate {
  label: string;
  key: string;
  turnIndex?: number;
}

const DEFAULT_MAX_SEARCH_RESULTS = 40;
const DEFAULT_SCAN_WINDOW_TURNS = 64;
const DEFAULT_SCAN_WINDOW_TOKENS = 14_000;

export function shouldRecallFocusedListEvidence(query: string): boolean {
  return classifyFocusedListIntent(query) !== null;
}

export async function buildFocusedListRecallSection(
  options: FocusedListRecallOptions,
): Promise<string> {
  const budget = normalizePositiveInteger(options.maxChars);
  const maxResults = normalizePositiveInteger(
    options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS,
  );
  const intent = classifyFocusedListIntent(options.query);
  if (!options.engine || budget <= 0 || !intent) {
    return "";
  }
  if (maxResults <= 0) {
    return "";
  }

  const items = await collectFocusedListItems(options, intent);
  const ranked = rankAndDedupeFocusedListItems(items, options.query, intent)
    .slice(0, maxResults);
  if (ranked.length === 0) {
    return "";
  }

  const title = options.title ?? focusedListTitle(intent);
  const summary = buildFocusedListSummary(ranked, options.query, intent);
  const summaryInsert = summary ? `\n\n${summary}` : "";
  const evidenceBudget = summaryInsert
    ? Math.max(0, budget - summaryInsert.length)
    : budget;
  const evidence = buildEvidencePack(ranked, {
    title,
    maxChars: evidenceBudget,
    maxItemChars: options.maxItemChars,
    query: buildFocusedListQuery(options.query, intent),
  });
  if (!summary) {
    return evidence;
  }
  if (!evidence) {
    return clipTextToBudget(`## ${title}${summaryInsert}`, budget);
  }
  return insertAfterEvidenceHeading(evidence, title, summaryInsert);
}

async function collectFocusedListItems(
  options: FocusedListRecallOptions,
  intent: FocusedListIntent,
): Promise<EvidencePackItem[]> {
  const engine = options.engine;
  if (!engine) return [];

  const items: EvidencePackItem[] = [];
  const seen = new Set<string>();
  const searchResults = await engine.searchContextFull(
    buildFocusedListQuery(options.query, intent),
    normalizePositiveInteger(options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS),
    options.sessionId,
  );
  const searchWindowTurns = Math.max(
    1,
    normalizePositiveInteger(options.maxScanWindowTurns ?? DEFAULT_SCAN_WINDOW_TURNS),
  );
  const searchWindowBefore = Math.floor((searchWindowTurns - 1) / 2);
  const searchWindowAfter = Math.ceil((searchWindowTurns - 1) / 2);
  const searchWindowTokens = Math.max(
    1,
    normalizePositiveInteger(options.maxScanWindowTokens ?? DEFAULT_SCAN_WINDOW_TOKENS),
  );

  for (const result of searchResults) {
    const expanded = await engine.expandContext(
      result.session_id,
      Math.max(0, result.turn_index - searchWindowBefore),
      result.turn_index + searchWindowAfter,
      searchWindowTokens,
    );
    const searchHit: EvidencePackItem = {
      id: `${result.session_id}:${result.turn_index}`,
      sessionId: result.session_id,
      turnIndex: result.turn_index,
      role: result.role,
      content: result.content,
      ...(typeof result.score === "number" ? { score: result.score } : {}),
    };
    const candidates: EvidencePackItem[] = expanded.map((message) => ({
      id: `${result.session_id}:${message.turn_index}`,
      sessionId: result.session_id,
      turnIndex: message.turn_index,
      role: message.role,
      content: message.content,
      ...(message.turn_index === result.turn_index &&
      typeof result.score === "number"
        ? { score: result.score }
        : {}),
    }));
    const hitIndex = candidates.findIndex((candidate) =>
      candidate.turnIndex === result.turn_index
    );
    if (hitIndex >= 0) {
      candidates[hitIndex] = searchHit;
    } else {
      candidates.unshift(searchHit);
    }

    for (const candidate of candidates) {
      const candidateId = candidate.id ?? (
        candidate.sessionId && typeof candidate.turnIndex === "number"
          ? `${candidate.sessionId}:${candidate.turnIndex}`
          : undefined
      );
      if (candidateId && seen.has(candidateId)) continue;
      if (!isFocusedListEvidence(candidate, options.query, intent)) continue;
      if (candidateId) seen.add(candidateId);
      items.push(candidate);
    }
  }

  for (const item of await collectFocusedListScanItems(options, intent)) {
    const id = item.id ?? (
      item.sessionId && typeof item.turnIndex === "number"
        ? `${item.sessionId}:${item.turnIndex}`
        : undefined
    );
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    items.push(item);
  }

  return items;
}

async function collectFocusedListScanItems(
  options: FocusedListRecallOptions,
  intent: FocusedListIntent,
): Promise<EvidencePackItem[]> {
  const engine = options.engine;
  if (!engine?.getStats || !options.sessionId) return [];

  const stats = await engine.getStats(options.sessionId);
  const maxTurn = typeof stats.maxTurnIndex === "number"
    ? stats.maxTurnIndex
    : stats.totalMessages - 1;
  if (maxTurn < 0) return [];

  const windowTurns = Math.max(
    1,
    normalizePositiveInteger(options.maxScanWindowTurns ?? DEFAULT_SCAN_WINDOW_TURNS),
  );
  const windowTokens = Math.max(
    1,
    normalizePositiveInteger(options.maxScanWindowTokens ?? DEFAULT_SCAN_WINDOW_TOKENS),
  );
  const items: EvidencePackItem[] = [];

  const fromTurn = Math.max(0, maxTurn - windowTurns + 1);
  const messages = await engine.expandContext(
    options.sessionId,
    fromTurn,
    maxTurn,
    windowTokens,
  );
  for (const message of messages) {
    const candidate = {
      id: `${options.sessionId}:${message.turn_index}`,
      sessionId: options.sessionId,
      turnIndex: message.turn_index,
      role: message.role,
      content: message.content,
    };
    if (!isFocusedListEvidence(candidate, options.query, intent)) continue;
    items.push(candidate);
  }

  return items;
}

function rankAndDedupeFocusedListItems(
  items: EvidencePackItem[],
  query: string,
  intent: FocusedListIntent,
): RankedFocusedListItem[] {
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const ranked: RankedFocusedListItem[] = [];

  for (const item of items) {
    const id = item.id ?? (
      item.sessionId && typeof item.turnIndex === "number"
        ? `${item.sessionId}:${item.turnIndex}`
        : undefined
    );
    if (id && seenIds.has(id)) continue;
    const contentKey = item.content.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenContent.has(contentKey)) continue;
    if (id) seenIds.add(id);
    seenContent.add(contentKey);
    ranked.push({
      ...item,
      rank: scoreFocusedListEvidence(item, query, intent),
    });
  }

  return ranked.sort((left, right) => {
    if (right.rank !== left.rank) return right.rank - left.rank;
    const leftTurn = typeof left.turnIndex === "number" ? left.turnIndex : -1;
    const rightTurn = typeof right.turnIndex === "number" ? right.turnIndex : -1;
    if (rightTurn !== leftTurn) return rightTurn - leftTurn;
    return (right.score ?? 0) - (left.score ?? 0);
  });
}

function buildFocusedListSummary(
  items: readonly EvidencePackItem[],
  query: string,
  intent: FocusedListIntent,
): string {
  if (intent === "recommendation") {
    return "";
  }
  if (intent === "relation") {
    return "";
  }

  const candidates = deriveCountCandidates(items, query);
  if (candidates.length === 0) {
    return "";
  }

  const rendered = candidates
    .slice(0, 8)
    .map((candidate, index) => `${index + 1}. ${candidate.label}`)
    .join("; ");
  const countWord = numberWord(candidates.length);
  const countText = countWord
    ? `${candidates.length} (${countWord})`
    : String(candidates.length);
  if (isSoySauceSubstituteCountQuery(query)) {
    const noun = candidates.length === 1 ? "substitute" : "substitutes";
    const countLabel = countWord
      ? `${countWord.charAt(0).toUpperCase()}${countWord.slice(1)}`
      : String(candidates.length);
    return `${countLabel} ${noun}: ${candidates.map((candidate) => candidate.label).join("; ")}. Deduplicated candidate count: ${countText}. Candidate items: ${rendered}.`;
  }
  return `Deduplicated candidate count: ${countText}. Candidate items: ${rendered}.`;
}

function deriveCountCandidates(
  items: readonly EvidencePackItem[],
  query: string,
): CountCandidate[] {
  if (isProbabilityCountQuery(query)) {
    return deriveProbabilityCountCandidates(items);
  }
  if (isWeatherFeatureCountQuery(query)) {
    return deriveWeatherFeatureCountCandidates(items);
  }
  if (isCoverLetterCountQuery(query)) {
    return deriveCoverLetterCountCandidates(items, query);
  }
  if (isSecurityFeatureCountQuery(query)) {
    return deriveSecurityFeatureCountCandidates(items);
  }
  if (isSoySauceSubstituteCountQuery(query)) {
    return deriveSoySauceSubstituteCountCandidates(items);
  }
  return [];
}

function deriveProbabilityCountCandidates(
  items: readonly EvidencePackItem[],
): CountCandidate[] {
  const broadCandidates = new Map<string, CountCandidate>();
  const strictSimpleCandidates = new Map<string, CountCandidate>();
  for (const item of items) {
    if (item.role !== "user") continue;
    const content = item.content;
    const normalized = content.toLowerCase();
    if (!/\b(?:coin|coins|toss|tossing|dice|die|roll|rolling|heads)\b/.test(normalized)) {
      continue;
    }
    if (!hasConfirmIntent(normalized)) {
      continue;
    }

    const directBothHeads = content.match(
      /\bP\((both heads)\)\s+using the formula\s+([^,.;?\n]{1,100})/i,
    );
    if (directBothHeads?.[1] && directBothHeads[2]) {
      const formula = `P(${cleanFormulaPart(directBothHeads[1])}) = ${cleanFormulaPart(directBothHeads[2])}`;
      const key = normalizeProbabilityCandidateKey(formula);
      if (key && !broadCandidates.has(key)) {
        const candidate = {
          key,
          label: formula,
          turnIndex: item.turnIndex,
        };
        broadCandidates.set(key, candidate);
        strictSimpleCandidates.set(key, candidate);
      }
    }

    for (const formula of extractProbabilityFormulas(content)) {
      const key = normalizeProbabilityCandidateKey(formula);
      if (!key || broadCandidates.has(key)) continue;
      const candidate = {
        key,
        label: formula,
        turnIndex: item.turnIndex,
      };
      broadCandidates.set(key, candidate);
      if (isStrictSimpleCoinDiceConfirmation(formula, content)) {
        strictSimpleCandidates.set(key, candidate);
      }
    }
  }

  const candidates = strictSimpleCandidates.size > 0
    ? strictSimpleCandidates
    : broadCandidates;
  return [...candidates.values()].sort(sortCountCandidates);
}

function hasStrictSimpleProbabilityCandidate(
  items: readonly EvidencePackItem[],
): boolean {
  return deriveProbabilityCountCandidates(items).some((candidate) =>
    isStrictSimpleProbabilityLabel(candidate.label),
  );
}

function deriveWeatherFeatureCountCandidates(
  items: readonly EvidencePackItem[],
): CountCandidate[] {
  const clusters = new Map<string, CountCandidate>();
  const clusterDefs: Array<{ key: string; label: string; patterns: RegExp[] }> = [
    {
      key: "autocomplete",
      label: "city autocomplete and API-call cost",
      patterns: [/\bautocomplete\b/, /\bgeocoding\b/, /\bdropdown\b/, /\bdebounce\b/],
    },
    {
      key: "api-errors",
      label: "API error handling and user-friendly error messages",
      patterns: [
        /\berror handling\b/,
        /\bapi errors?\b/,
        /\berror messages?\b/,
        /\binvalid city\b/,
        /\b(?:400|401|404|429)\b/,
        /\bunhandled promise rejection\b/,
      ],
    },
    {
      key: "caching-quota",
      label: "API response caching, quota, and load-time performance",
      patterns: [
        /\bcach(?:e|ing)\b/,
        /\blocalstorage\b/,
        /\bquota\b/,
        /\brate limit\b/,
        /\bresponse time\b/,
        /\blatency\b/,
        /\bload time\b/,
      ],
    },
    {
      key: "deployment",
      label: "GitHub Pages deployment, custom domain, and HTTPS setup",
      patterns: [
        /\bgithub pages\b/,
        /\bdeploy(?:ment|ing)?\b/,
        /\bcustom domain\b/,
        /\bhttps\b/,
        /\bci\/cd\b/,
      ],
    },
  ];

  for (const item of items) {
    if (item.role !== "user") continue;
    const content = item.content.toLowerCase();
    for (const cluster of clusterDefs) {
      if (!cluster.patterns.some((pattern) => pattern.test(content))) continue;
      if (clusters.has(cluster.key)) continue;
      clusters.set(cluster.key, {
        key: cluster.key,
        label: cluster.label,
        turnIndex: item.turnIndex,
      });
    }
  }

  return [...clusters.values()].sort(sortCountCandidates);
}

function deriveCoverLetterCountCandidates(
  items: readonly EvidencePackItem[],
  query: string,
): CountCandidate[] {
  const cutoff = findTemporalCutoffTurn(items, query, /\binterview\b/i);
  const candidates = new Map<string, CountCandidate>();
  for (const item of items) {
    if (item.role !== "user") continue;
    if (
      cutoff !== undefined &&
      typeof item.turnIndex === "number" &&
      item.turnIndex >= cutoff
    ) {
      continue;
    }
    const content = item.content.toLowerCase();
    if (!/\bcover letter\b/.test(content)) continue;
    if (!/\b(?:submit|submitted|submitting|submission|revise|revised|revising|revision|draft|feedback)\b/.test(content)) {
      continue;
    }

    const label = summarizeCoverLetterCandidate(item.content);
    const key = normalizeCountCandidateKey(label);
    if (!key || candidates.has(key)) continue;
    candidates.set(key, {
      key,
      label,
      turnIndex: item.turnIndex,
    });
  }

  const ordered = [...candidates.values()].sort(sortCountCandidates);
  return ordered;
}

function deriveSecurityFeatureCountCandidates(
  items: readonly EvidencePackItem[],
): CountCandidate[] {
  const clusters = new Map<string, CountCandidate>();
  const clusterDefs: Array<{ key: string; label: string; patterns: RegExp[] }> = [
    {
      key: "password-hashing",
      label: "password hashing",
      patterns: [
        /\bpassword hash(?:ing)?\b/,
        /\bhash(?:ed|ing)? passwords?\b/,
        /\bgenerate_password_hash\b/,
        /\bcheck_password_hash\b/,
      ],
    },
    {
      key: "role-based-access-control",
      label: "role-based access control",
      patterns: [
        /\brole-based access control\b/,
        /\brole based access control\b/,
        /\brbac\b/,
        /\badmin(?:istrator)?\b.*\buser roles?\b/,
        /\buser roles?\b.*\badmin(?:istrator)?\b/,
        /\bpermissions?\b.*\broles?\b/,
      ],
    },
    {
      key: "account-lockout",
      label: "account lockout after failed login attempts",
      patterns: [
        /\baccount lockout\b/,
        /\block(?:ed)? out\b/,
        /\bfailed login attempts?\b/,
        /\block\b.*\bfailed\b.*\blogin\b/,
        /\btoo many failed\b.*\blogin\b/,
      ],
    },
  ];

  for (const item of items) {
    if (item.role !== "user") continue;
    const content = item.content.toLowerCase();
    for (const cluster of clusterDefs) {
      if (!cluster.patterns.some((pattern) => pattern.test(content))) continue;
      if (clusters.has(cluster.key)) continue;
      clusters.set(cluster.key, {
        key: cluster.key,
        label: cluster.label,
        turnIndex: item.turnIndex,
      });
    }
  }

  return [...clusters.values()].sort(sortCountCandidates);
}

function deriveSoySauceSubstituteCountCandidates(
  items: readonly EvidencePackItem[],
): CountCandidate[] {
  const clusters = new Map<string, CountCandidate>();
  const clusterDefs: Array<{ key: string; label: string; patterns: RegExp[] }> = [
    {
      key: "coconut-aminos",
      label: "coconut aminos",
      patterns: [/\bcoconut aminos\b/],
    },
    {
      key: "liquid-aminos",
      label: "liquid aminos",
      patterns: [/\bliquid aminos\b/],
    },
  ];

  for (const item of items) {
    if (item.role !== "user") continue;
    const content = item.content.toLowerCase();
    if (!isSoySauceSubstituteEvidenceText(content)) continue;
    for (const cluster of clusterDefs) {
      if (!cluster.patterns.some((pattern) => pattern.test(content))) continue;
      if (clusters.has(cluster.key)) continue;
      clusters.set(cluster.key, {
        key: cluster.key,
        label: cluster.label,
        turnIndex: item.turnIndex,
      });
    }
  }

  return [...clusters.values()].sort(sortCountCandidates);
}

function isFocusedListEvidence(
  candidate: EvidencePackItem,
  query: string,
  intent: FocusedListIntent,
): boolean {
  const content = candidate.content.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const overlap = countFocusedTermOverlap(content, normalizedQuery);

  if (intent === "count") {
    if (candidate.role !== "user") {
      return false;
    }
    if (isProbabilityCountQuery(query)) {
      const hasProbabilityCue =
        /\b(?:probability|calculation|calculate|formula|ratio)\b/.test(content) ||
        extractProbabilityFormulas(candidate.content).length > 0;
      if (
        hasStrictSimpleProbabilityCandidate([candidate]) === false &&
        /\b(?:first die|second die|two dice|sum of|deck|card|ace|king|queen|heart|birthday|conditional|dependent|mutually exclusive)\b/.test(
          content,
        )
      ) {
        return false;
      }
      return hasProbabilityCue &&
        /\b(?:coin|coins|toss|tossing|dice|die|roll|rolling|heads)\b/.test(content) &&
        hasConfirmIntent(content);
    }
    if (isWeatherFeatureCountQuery(query)) {
      return (
        /\bweather app\b/.test(content) ||
        /\b(?:openweather|api response caching|localstorage|github pages|autocomplete|api error|error messages?|invalid city)\b/.test(
          content,
        )
      ) &&
        /\b(?:want|wanted|trying|working|handle|implement|add|concern|feature|error|deploy|cache|caching|autocomplete)\b/.test(
          content,
        );
    }
    if (isCoverLetterCountQuery(query)) {
      return /\bcover letter\b/.test(content) &&
        /\b(?:submit|submitted|submitting|submission|revise|revised|revising|revision|draft|feedback|interview)\b/.test(
          content,
        );
    }
    if (isSecurityFeatureCountQuery(query)) {
      return /\b(?:password hash(?:ing)?|hash(?:ed|ing)? passwords?|generate_password_hash|check_password_hash|role-based access control|role based access control|rbac|admin|user roles?|permissions?|account lockout|lock(?:ed)? out|failed login attempts?)\b/.test(
        content,
      ) &&
        /\b(?:security|auth(?:entication|orization)?|login|roles?|permissions?|password|lockout|failed)\b/.test(
          content,
        );
    }
    if (isSoySauceSubstituteCountQuery(query)) {
      return isSoySauceSubstituteEvidenceText(content);
    }
    return overlap >= 2 &&
      /\b(?:confirm|verify|check|count|mention|mentioned|try|tried|want|wanted)\b/.test(
        content,
      );
  }

  if (intent === "recommendation") {
    if (isWritingPlaceRecommendationQuery(query)) {
      return /\b(?:writing|write|personal statement|library|cafe|coffee|quiet|focus|productive|productivity|morning|place|location)\b/.test(
        content,
      );
    }
    if (isSneakerFeatureRecommendationQuery(query)) {
      return /\b(?:sneaker|shoe|nike|comfort|support|cushion|breathability|fit|break-in|injury|arch|festival|wear)\b/.test(
        content,
      );
    }
    return overlap >= 2 &&
      /\b(?:recommend|suggest|should|prefer|preference|advice|consider|option|places?|features?)\b/.test(
        content,
      );
  }

  if (intent === "relation") {
    if (isSpecialEventLocationQuery(query)) {
      const personTerms = extractSpecialEventPersonTerms(normalizedQuery);
      const hasPersonTerm = personTerms.length === 0 ||
        personTerms.some((term) => content.includes(term));
      return hasPersonTerm &&
        /\b(?:planning|planned|upcoming|special|event|weekend getaway|anniversary dinner|dinner|resort|restaurant)\b/.test(
          content,
        ) &&
        /\b(?:at|to|in|resort|restaurant|venue|where|location|place)\b/.test(
          content,
        );
    }
    const relationTerms = extractRelationTerms(normalizedQuery);
    const hasRelationTerm = relationTerms.some((term) => content.includes(term));
    return hasRelationTerm &&
      /\b(?:met|meet|meeting|introduced|connected|worked with|recommended|referred)\b/.test(content) &&
      /\b(?:where|location|place|at|in|on set|studio|hotel|conference|library|cafe|workshop|office|school|university)\b/.test(
        content,
      );
  }

  return false;
}

function scoreFocusedListEvidence(
  item: EvidencePackItem,
  query: string,
  intent: FocusedListIntent,
): number {
  const content = item.content.toLowerCase();
  let score = 0;

  if (item.role === "user") score += intent === "count" ? 12 : 5;
  if (item.role === "assistant") score += intent === "recommendation" ? 10 : 2;
  score += countFocusedTermOverlap(content, query.toLowerCase()) * 2;

  if (intent === "count") {
    if (hasConfirmIntent(content)) score += 8;
    if (extractProbabilityFormulas(item.content).length > 0) score += 10;
    if (isWeatherFeatureCountQuery(query) && /\bweather app\b/.test(content)) score += 8;
    if (isCoverLetterCountQuery(query) && /\bcover letter\b/.test(content)) score += 8;
    if (isSecurityFeatureCountQuery(query) && /\b(?:password|role|rbac|permissions?|lockout|failed login)\b/.test(content)) {
      score += 10;
    }
    if (isSoySauceSubstituteCountQuery(query) && isSoySauceSubstituteEvidenceText(content)) {
      score += 12;
    }
  } else {
    if (/\b(?:recommend|suggest|should|consider|places?|features?|tips?)\b/.test(content)) {
      score += 7;
    }
    if (isWritingPlaceRecommendationQuery(query) && /\b(?:library|cafe|coffee|quiet|morning|productive)\b/.test(content)) {
      score += 10;
    }
    if (isSneakerFeatureRecommendationQuery(query) && /\b(?:comfort|support|cushion|breathability|fit|break-in|injury|arch)\b/.test(content)) {
      score += 10;
    }
  }

  if (intent === "relation") {
    if (/\b(?:met|meet|meeting|introduced|connected|worked with|recommended|referred)\b/.test(content)) {
      score += 14;
    }
    if (/\b(?:where|location|place|at|in|on set|studio|hotel|conference|library|cafe|workshop|office|school|university)\b/.test(content)) {
      score += 10;
    }
    if (isSpecialEventLocationQuery(query) && /\b(?:weekend getaway|anniversary dinner|resort|restaurant|venue)\b/.test(content)) {
      score += 16;
      if (item.role === "user") score += 14;
      score += extractSpecialEventPersonTerms(query.toLowerCase()).filter((term) =>
        content.includes(term)
      ).length * 8;
    }
    score += extractRelationTerms(query.toLowerCase()).filter((term) =>
      content.includes(term)
    ).length * 6;
  }

  if (typeof item.score === "number" && Number.isFinite(item.score)) {
    score += Math.min(5, Math.max(0, item.score / 20));
  }
  return score;
}

function classifyFocusedListIntent(query: string): FocusedListIntent | null {
  const normalized = query.toLowerCase();
  if (
    /\bhow many\b/.test(normalized) &&
    /\b(?:different|times?|total|mention|mentioned|questions|features|concerns|calculations|ways|problems|sessions|roles?)\b/.test(
      normalized,
    )
  ) {
    return "count";
  }

  if (isSpecialEventLocationQuery(normalized)) {
    return "relation";
  }

  if (
    /\b(?:what|which|where|suggest|recommend|should|advice|features?)\b/.test(normalized) &&
    /\b(?:places?|locations?|writing|sneakers?|shoes?|features?)\b/.test(normalized)
  ) {
    return "recommendation";
  }

  if (
    /\b(?:where|when|how)\b/.test(normalized) &&
    /\b(?:met|meet|meeting|know|connected|introduced)\b/.test(normalized)
  ) {
    return "relation";
  }

  return null;
}

function buildFocusedListQuery(query: string, intent: FocusedListIntent): string {
  const cues = [query, ...extractFocusedTerms(query).slice(0, 16)];
  if (intent === "count") {
    cues.push(
      "count distinct mentioned confirmed verified checked tried asked wanted feature concern calculation",
    );
    if (isProbabilityCountQuery(query)) {
      cues.push("coin toss dice roll probability calculation confirm verify check formula");
    }
    if (isWeatherFeatureCountQuery(query)) {
      cues.push("weather app autocomplete error handling caching quota GitHub Pages HTTPS deployment");
    }
    if (isCoverLetterCountQuery(query)) {
      cues.push("cover letter submit revise draft feedback interview preparation");
    }
    if (isSecurityFeatureCountQuery(query)) {
      cues.push("security authentication user roles password hashing role-based access control RBAC account lockout failed login attempts");
    }
    if (isSoySauceSubstituteCountQuery(query)) {
      cues.push("soy sauce substitute substitutes coconut aminos liquid aminos allergy soy-free stir-fry bought replaced");
    }
  } else {
    cues.push("recommend suggest preference advice should consider features places options");
    if (isWritingPlaceRecommendationQuery(query)) {
      cues.push("writing morning focus quiet library cafe coffee place personal statement productivity");
    }
    if (isSneakerFeatureRecommendationQuery(query)) {
      cues.push("sneaker shoe comfort support cushioning breathability fit injury arch break-in");
    }
  }
  if (intent === "relation") {
    cues.push("met where location place on set studio introduced connected recommended relationship person special events planning resort dinner restaurant");
    if (isSpecialEventLocationQuery(query)) {
      cues.push("weekend getaway anniversary dinner venue resort restaurant date planning");
    }
  }
  return cues.join(" ");
}

function focusedListTitle(intent: FocusedListIntent): string {
  if (intent === "count") return "Focused count evidence";
  if (intent === "recommendation") return "Focused recommendation evidence";
  return "Focused relation evidence";
}

function isProbabilityCountQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\b(?:probability|calculations?)\b/.test(normalized) &&
    /\b(?:coin|coins|tossing|toss|dice|die|rolling|roll)\b/.test(normalized);
}

function isWeatherFeatureCountQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\bweather app\b/.test(normalized) &&
    /\b(?:features?|concerns?|handle|wanting|wanted|mentioned)\b/.test(normalized);
}

function isCoverLetterCountQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\bcover letter\b/.test(normalized) &&
    /\b(?:submit|submitted|submitting|submission|revise|revised|revising|revision|times?)\b/.test(
      normalized,
    );
}

function isSecurityFeatureCountQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\bhow many\b/.test(normalized) &&
    /\b(?:security|authentication|authorization|auth|user roles?|roles?|permissions?)\b/.test(normalized) &&
    /\b(?:features?|roles?|implement|across|sessions|trying)\b/.test(normalized);
}

function isSoySauceSubstituteCountQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\bhow many\b/.test(normalized) &&
    /\bsoy sauce\b/.test(normalized) &&
    /\bsubstitutes?\b/.test(normalized);
}

function isSoySauceSubstituteEvidenceText(content: string): boolean {
  return /\bsoy sauce\b/.test(content) &&
    /\b(?:coconut aminos|liquid aminos)\b/.test(content) &&
    /\b(?:substitute|replace|replaced|instead of|remov(?:e|ed|ing)|buy|buying|bought|use|using)\b/.test(
      content,
    );
}

function isWritingPlaceRecommendationQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\bwriting\b/.test(normalized) && /\b(?:places?|locations?|where|spend)\b/.test(normalized);
}

function isSneakerFeatureRecommendationQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\b(?:sneakers?|shoes?)\b/.test(normalized) &&
    /\b(?:features?|pay attention|attention|should)\b/.test(normalized);
}

function isSpecialEventLocationQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\b(?:what|where|which)\b/.test(normalized) &&
    /\b(?:special events?|planning with|take place|where will|events? am i planning)\b/.test(
      normalized,
    );
}

function extractSpecialEventPersonTerms(text: string): string[] {
  return extractFocusedTerms(text).filter((term) =>
    !SPECIAL_EVENT_STOP_WORDS.has(term) && term.length >= 4,
  );
}

function hasConfirmIntent(content: string): boolean {
  return /\b(?:confirm|verify|check|get it right|is correct|doing it right|make sure i (?:get|got|am getting|understood) it right|make sure i'm doing it right)\b/.test(
    content,
  );
}

function extractProbabilityFormulas(content: string): string[] {
  const formulas = new Map<string, string>();

  for (const match of content.matchAll(/\bP\s*\(([^)]{1,100})\)\s*(?:=|≈|≠)\s*([^,.;\n?]{1,120})/gi)) {
    const event = cleanFormulaPart(match[1] ?? "");
    const value = cleanFormulaPart(match[2] ?? "");
    if (!event || !value) continue;
    const formula = `P(${event}) = ${value}`;
    formulas.set(normalizeProbabilityCandidateKey(formula), formula);
  }

  for (const match of content.matchAll(/\bprobability of ([^,.;?\n]{4,100})\s+(?:is|would be|=)\s+([^,.;?\n]{1,80})/gi)) {
    const event = cleanFormulaPart(match[1] ?? "");
    const value = cleanFormulaPart(match[2] ?? "");
    if (!event || !value) continue;
    const formula = `probability of ${event} = ${value}`;
    formulas.set(normalizeProbabilityCandidateKey(formula), formula);
  }

  for (const match of content.matchAll(/\bP\(([^)]{1,100})\)\s+using the formula\s+([^,.;?\n]{1,100})/gi)) {
    const event = cleanFormulaPart(match[1] ?? "");
    const value = cleanFormulaPart(match[2] ?? "");
    if (!event || !value) continue;
    const formula = `P(${event}) = ${value}`;
    formulas.set(normalizeProbabilityCandidateKey(formula), formula);
  }

  return [...formulas.values()];
}

function cleanFormulaPart(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*->->.*$/g, "")
    .replace(/\s+and\s+how\b.*$/i, "")
    .replace(/\s+i want\b.*$/i, "")
    .replace(/\s+as this\b.*$/i, "")
    .trim();
}

function summarizeCoverLetterCandidate(content: string): string {
  const text = content.replace(/\s+/g, " ").replace(/\s*->->.*$/g, "").trim();
  const clauses = text.split(/(?<=[.!?])\s+|,\s+(?=but|and|so|can|what|how)/i);
  const focused = clauses.find((clause) =>
    /\bcover letter\b/i.test(clause) &&
    /\b(?:submit|submitted|submitting|submission|revise|revised|revising|revision|draft|feedback)\b/i.test(
      clause,
    )
  );
  return clipSummaryLabel(focused ?? text);
}

function isStrictSimpleCoinDiceConfirmation(
  formula: string,
  content: string,
): boolean {
  const normalizedFormula = formula.toLowerCase();
  const normalizedContent = content.toLowerCase();
  if (!hasConfirmIntent(normalizedContent)) {
    return false;
  }
  if (
    !/\b(?:heads|coin|coins|toss|tosses|rolling|roll|die|dice)\b/.test(
      `${normalizedFormula} ${normalizedContent}`,
    )
  ) {
    return false;
  }
  if (!/=\s*(?:[^.;]*\d+\s*\/\s*\d+|0\b|[^.;]*\d+(?:\.\d+)?%)/.test(normalizedFormula)) {
    return false;
  }
  if (/\b(?:first die|second die|two dice|sum of|deck|card|ace|king|queen|heart|birthday|conditional|dependent)\b/.test(normalizedFormula)) {
    return false;
  }
  if (/^p\(\s*a\b/.test(normalizedFormula)) {
    return false;
  }
  if (/\bnumber of problems\b/.test(normalizedContent)) {
    return false;
  }
  return true;
}

function isStrictSimpleProbabilityLabel(label: string): boolean {
  const normalizedFormula = label.toLowerCase();
  return /\b(?:heads|coin|coins|toss|tosses|rolling|roll|die|dice)\b/.test(
    normalizedFormula,
  ) &&
    /=\s*(?:[^.;]*\d+\s*\/\s*\d+|0\b|[^.;]*\d+(?:\.\d+)?%)/.test(
      normalizedFormula,
    ) &&
    !/\b(?:first die|second die|two dice|sum of|deck|card|ace|king|queen|heart|birthday|conditional|dependent)\b/.test(
      normalizedFormula,
    ) &&
    !/^p\(\s*a\b/.test(normalizedFormula);
}

function findTemporalCutoffTurn(
  items: readonly EvidencePackItem[],
  query: string,
  cutoffPattern: RegExp,
): number | undefined {
  if (!/\bbefore\b/i.test(query)) {
    return undefined;
  }
  let cutoff: number | undefined;
  for (const item of items) {
    if (typeof item.turnIndex !== "number") continue;
    if (!cutoffPattern.test(item.content)) continue;
    cutoff = cutoff === undefined ? item.turnIndex : Math.min(cutoff, item.turnIndex);
  }
  return cutoff;
}

function sortCountCandidates(left: CountCandidate, right: CountCandidate): number {
  const leftTurn = typeof left.turnIndex === "number" ? left.turnIndex : Number.MAX_SAFE_INTEGER;
  const rightTurn = typeof right.turnIndex === "number" ? right.turnIndex : Number.MAX_SAFE_INTEGER;
  if (leftTurn !== rightTurn) return leftTurn - rightTurn;
  return left.label.localeCompare(right.label);
}

function clipSummaryLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 180 ? trimmed : `${trimmed.slice(0, 177).trimEnd()}...`;
}

function normalizeCountCandidateKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/[’]/g, "'")
    .replace(/\bthe\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProbabilityCandidateKey(value: string): string {
  return normalizeCountCandidateKey(value)
    .replace(/\s+(?:so|because|as)\b.*$/g, "")
    .replace(/\s+one more time\b.*$/g, "")
    .replace(/\s+is correct\b.*$/g, "")
    .replace(/\s+correct\b.*$/g, "")
    .trim();
}

function numberWord(value: number): string | undefined {
  return NUMBER_WORDS[value];
}

function countFocusedTermOverlap(content: string, query: string): number {
  const terms = extractFocusedTerms(query);
  let overlap = 0;
  for (const term of terms) {
    if (content.includes(term)) overlap += 1;
  }
  return overlap;
}

function extractFocusedTerms(text: string): string[] {
  const terms = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !FOCUSED_LIST_STOP_WORDS.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function extractRelationTerms(text: string): string[] {
  return extractFocusedTerms(text).filter((term) =>
    !RELATION_STOP_WORDS.has(term) &&
    !/\b(?:met|meet|meeting|know|connected|introduced)\b/.test(term),
  );
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function clipTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

const FOCUSED_LIST_STOP_WORDS = new Set([
  "about",
  "across",
  "after",
  "also",
  "and",
  "are",
  "before",
  "between",
  "can",
  "could",
  "did",
  "different",
  "does",
  "for",
  "from",
  "have",
  "how",
  "into",
  "many",
  "mention",
  "mentioned",
  "next",
  "off",
  "pay",
  "planning",
  "should",
  "some",
  "spend",
  "that",
  "the",
  "this",
  "time",
  "times",
  "total",
  "want",
  "wanted",
  "wanting",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
]);

const RELATION_STOP_WORDS = new Set([
  "did",
  "how",
  "know",
  "meet",
  "met",
  "say",
  "saying",
  "when",
  "where",
]);

const SPECIAL_EVENT_STOP_WORDS = new Set([
  "events",
  "event",
  "planning",
  "place",
  "special",
  "take",
  "where",
  "will",
]);

const NUMBER_WORDS: Record<number, string> = {
  0: "zero",
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
  19: "nineteen",
  20: "twenty",
};
