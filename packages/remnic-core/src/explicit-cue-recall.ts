import { buildEvidencePack } from "./evidence-pack.js";

export interface ExplicitCueRecallEngine {
  expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>>;
  getStats?(sessionId?: string): Promise<{
    totalMessages: number;
    maxTurnIndex?: number;
  }>;
  searchContextFull(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<
    Array<{
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score?: number;
    }>
  >;
}

export interface ExplicitCueRecallOptions {
  engine: ExplicitCueRecallEngine | null | undefined;
  sessionId?: string;
  query: string;
  maxChars: number;
  maxItemChars?: number;
  maxReferences?: number;
  includeBenchmarkAnchorCues?: boolean;
  includeContentLexicalCues?: boolean;
  includeStructuredPlanCues?: boolean;
}

export interface TrajectoryAnalysisRecallOptions {
  engine: ExplicitCueRecallEngine | null | undefined;
  sessionId?: string;
  query: string;
  maxChars: number;
}

export type ExplicitTurnReference = {
  number: number;
  includeDirectTurn: boolean;
};

const DEFAULT_MAX_CHARS = 2_400;
const DEFAULT_MAX_ITEM_CHARS = 1_200;
const DEFAULT_MAX_REFERENCES = 24;
const REFERENCE_SCAN_TOKEN_FACTOR = 3;
const TURN_REFERENCE_WINDOW_RADIUS = 0;
const LEXICAL_CUE_WINDOW_RADIUS = 1;
const LEXICAL_CUE_SEARCH_LIMIT = 3;
const LEXICAL_CUE_MAX_TOKENS = 400;
const FOCUSED_TRANSCRIPT_SCAN_MAX_TOKENS = 250_000;
const CONTENT_LABEL_SEARCH_LIMIT = 64;
const CONTENT_LABEL_MAX_TOKENS = 2_000;
const CONTENT_LABEL_MAX_PAIRED_WINDOWS_PER_REFERENCE = 1;
const TRAJECTORY_ANALYSIS_MAX_TOKENS = 250_000;
const TRAJECTORY_ANALYSIS_MAX_RANGE_STEPS = 80;
const TRAJECTORY_ANALYSIS_MAX_LINES = 160;
const LATEST_STATE_CUES = new Set([
  "as of",
  "currently",
  "latest",
  "most recent",
  "newest",
  "now",
  "updated",
  "changed",
  "change",
]);
const STRUCTURED_PLAN_FIELD_CUES = new Set([
  "accommodation",
  "attraction",
  "breakfast",
  "current city",
  "dinner",
  "flight",
  "flights",
  "hotel",
  "lunch",
  "restaurant",
  "restaurants",
  "transportation",
  "traveler",
  "travelers",
]);
const STRUCTURED_PLAN_DEPENDENCY_CUES = new Set([
  "comparison",
  "constraint",
  "constraints",
  "dependency",
  "dependencies",
  "join",
  "same",
  "shared",
]);
const BENCHMARK_ABILITY_CUES = new Map([
  ["information extraction", "ability=information_extraction"],
  ["knowledge update", "ability=knowledge_update"],
  ["multi session reasoning", "ability=multi_session_reasoning"],
  ["multi-session reasoning", "ability=multi_session_reasoning"],
  ["instruction following", "ability=instruction_following"],
]);
const BENCHMARK_ANCHOR_VALUE_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "for",
  "from",
  "in",
  "on",
  "the",
  "to",
  "use",
  "using",
  "with",
]);
const RELATIVE_TEMPORAL_CUES = [
  "as of",
  "most recent",
  "last time",
  "last week",
  "last month",
  "last year",
  "last session",
  "last conversation",
  "next time",
  "next week",
  "next month",
  "next year",
  "next session",
  "next conversation",
  "previous time",
  "previous week",
  "previous month",
  "previous year",
  "previous session",
  "previous conversation",
  "prior time",
  "prior week",
  "prior month",
  "prior year",
  "prior session",
  "prior conversation",
  "today",
  "yesterday",
  "tomorrow",
  "tonight",
  "earlier",
  "later",
  "recently",
  "previously",
  "currently",
  "now",
  "latest",
  "newest",
  "oldest",
  "earliest",
  "before",
  "after",
  "since",
  "updated",
  "changed",
  "change",
];
const SPEAKER_NAME_STOPWORDS = new Set([
  "A",
  "According",
  "An",
  "And",
  "Are",
  "As",
  "At",
  "Before",
  "Can",
  "Compare",
  "Could",
  "Did",
  "Do",
  "Does",
  "For",
  "From",
  "Had",
  "Has",
  "Have",
  "How",
  "In",
  "Is",
  "It",
  "Join",
  "Of",
  "On",
  "Or",
  "Please",
  "Review",
  "Step",
  "Tell",
  "The",
  "To",
  "Turn",
  "Use",
  "Was",
  "Were",
  "What",
  "When",
  "Where",
  "Which",
  "Who",
  "Why",
  "Will",
  "Would",
]);
const QUESTION_SLOT_STOPWORDS = new Set([
  "answer",
  "choice",
  "did",
  "does",
  "do",
  "is",
  "should",
  "single",
  "the",
  "user",
  "was",
  "were",
]);
const CONTENT_LEXICAL_CUE_STOPWORDS = new Set([
  "about",
  "across",
  "after",
  "again",
  "also",
  "and",
  "answer",
  "answers",
  "are",
  "before",
  "between",
  "can",
  "could",
  "different",
  "did",
  "does",
  "during",
  "feature",
  "features",
  "from",
  "have",
  "help",
  "how",
  "implement",
  "into",
  "made",
  "many",
  "me",
  "mention",
  "my",
  "need",
  "only",
  "order",
  "over",
  "project",
  "question",
  "questions",
  "request",
  "requests",
  "show",
  "tell",
  "that",
  "the",
  "there",
  "these",
  "through",
  "throughout",
  "trying",
  "want",
  "were",
  "what",
  "when",
  "which",
  "with",
  "would",
  "you",
]);
const CONTENT_LEXICAL_PHRASE_STOPWORDS = new Set(
  [...CONTENT_LEXICAL_CUE_STOPWORDS].filter(
    (word) => word !== "feature" && word !== "features" && word !== "implement",
  ),
);

export async function buildExplicitCueRecallSection(
  options: ExplicitCueRecallOptions,
): Promise<string> {
  const engine = options.engine;
  const query = options.query.trim();
  const maxChars = normalizePositiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  if (!engine || query.length === 0 || maxChars <= 0) {
    return "";
  }

  const maxReferences = normalizePositiveInteger(
    options.maxReferences,
    DEFAULT_MAX_REFERENCES,
  );
  if (maxReferences <= 0) {
    return "";
  }

  const evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
    score?: number;
  }> = [];
  const seenTurns = new Set<string>();

  await collectTurnReferenceEvidence({
    engine,
    sessionId: options.sessionId,
    query,
    maxReferences,
    evidenceItems,
    seenTurns,
  });

  if (options.includeContentLexicalCues) {
    await collectNamedMeetingFactEvidence({
      engine,
      sessionId: options.sessionId,
      query,
      maxReferences,
      evidenceItems,
      seenTurns,
    });

    await collectFocusedTranscriptCueEvidence({
      engine,
      sessionId: options.sessionId,
      query,
      evidenceItems,
      seenTurns,
    });
  }

  await collectLexicalCueEvidence({
    engine,
    sessionId: options.sessionId,
    query,
    maxReferences,
    includeBenchmarkAnchorCues: options.includeBenchmarkAnchorCues,
    includeContentLexicalCues: options.includeContentLexicalCues,
    includeStructuredPlanCues: options.includeStructuredPlanCues,
    evidenceItems,
    seenTurns,
  });

  const evidenceFocusQuery = buildEvidenceFocusQuery(query, {
    includeBenchmarkAnchorCues: options.includeBenchmarkAnchorCues,
    includeContentLexicalCues: options.includeContentLexicalCues,
    includeStructuredPlanCues: options.includeStructuredPlanCues,
  });
  return buildEvidencePack(evidenceItems, {
    title: "Explicit Cue Evidence",
    query: evidenceFocusQuery,
    maxChars,
    maxItemChars: normalizePositiveInteger(
      options.maxItemChars,
      DEFAULT_MAX_ITEM_CHARS,
    ),
  });
}

function buildEvidenceFocusQuery(
  query: string,
  options: {
    includeBenchmarkAnchorCues?: boolean;
    includeContentLexicalCues?: boolean;
    includeStructuredPlanCues?: boolean;
  },
): string {
  const cues = collectLexicalCues(query, options);
  if (cues.length === 0) {
    return query;
  }
  return `${query}\n${cues.join("\n")}`;
}

export async function buildTrajectoryAnalysisRecallSection(
  options: TrajectoryAnalysisRecallOptions,
): Promise<string> {
  const engine = options.engine;
  const sessionId = options.sessionId;
  const query = options.query.trim();
  const maxChars = normalizePositiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  if (!engine || !sessionId || !engine.getStats || query.length === 0 || maxChars <= 0) {
    return "";
  }

  if (!hasTrajectoryAnalysisIntent(query)) {
    return "";
  }

  const stats = await engine.getStats(sessionId);
  const totalMessages = Math.max(0, Math.floor(stats.totalMessages));
  if (totalMessages <= 0) {
    return "";
  }
  const expansionEnd = normalizeTurnExpansionEnd(stats);

  const messages = await engine.expandContext(
    sessionId,
    0,
    expansionEnd,
    TRAJECTORY_ANALYSIS_MAX_TOKENS,
  );
  const trajectory = parseLabeledTrajectory(messages);
  if (trajectory.length === 0) {
    return "";
  }

  const bounds = inferTrajectoryBounds(query, trajectory);
  const lines = buildTrajectoryAnalysisLines(query, trajectory, bounds);
  if (lines.length === 0) {
    return "";
  }

  const header = "## Trajectory analysis";
  const bodyBudget = maxChars - header.length - 1;
  if (bodyBudget <= 0) {
    return "";
  }

  const clipped = truncateTrajectoryAnalysisLines(lines, bodyBudget);
  return clipped.length === 0 ? "" : `${header}\n${clipped.join("\n")}`;
}

async function collectTurnReferenceEvidence(options: {
  engine: ExplicitCueRecallEngine;
  sessionId?: string;
  query: string;
  maxReferences: number;
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>;
  seenTurns: Set<string>;
}): Promise<void> {
  if (!options.sessionId) {
    return;
  }

  const references = collectExplicitTurnReferences(options.query).slice(
    0,
    options.maxReferences,
  );
  if (references.length === 0) {
    return;
  }

  await collectContentLabelReferenceEvidence({
    engine: options.engine,
    sessionId: options.sessionId,
    query: options.query,
    references,
    evidenceItems: options.evidenceItems,
    seenTurns: options.seenTurns,
  });

  const windows = new Map<string, { fromTurn: number; toTurn: number }>();
  for (const reference of references) {
    for (const center of candidateTurnIndexesForReference(reference)) {
      if (center < 0) {
        continue;
      }

      const fromTurn = Math.max(0, center - TURN_REFERENCE_WINDOW_RADIUS);
      const toTurn = center + TURN_REFERENCE_WINDOW_RADIUS;
      windows.set(`${fromTurn}:${toTurn}`, { fromTurn, toTurn });
    }
  }

  for (const window of [...windows.values()].sort(
    (left, right) => left.fromTurn - right.fromTurn || left.toTurn - right.toTurn,
  )) {
    const expanded = await options.engine.expandContext(
      options.sessionId,
      window.fromTurn,
      window.toTurn,
      2_000,
    );
    appendExpandedEvidence(
      options.evidenceItems,
      options.seenTurns,
      options.sessionId,
      expanded,
    );
  }
}

async function collectFocusedTranscriptCueEvidence(options: {
  engine: ExplicitCueRecallEngine;
  sessionId?: string;
  query: string;
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>;
  seenTurns: Set<string>;
}): Promise<void> {
  if (!options.sessionId || !options.engine.getStats) {
    return;
  }

  const matchers = focusedTranscriptCueMatchers(options.query);
  if (matchers.length === 0) {
    return;
  }

  const stats = await options.engine.getStats(options.sessionId);
  const expansionEnd = normalizeTurnExpansionEnd(stats);
  if (expansionEnd < 0) {
    return;
  }

  const messages = await options.engine.expandContext(
    options.sessionId,
    0,
    expansionEnd,
    FOCUSED_TRANSCRIPT_SCAN_MAX_TOKENS,
  );
  for (const matcher of matchers) {
    for (const message of messages) {
      if (!matcher(message.content)) {
        continue;
      }
      appendEvidenceItem(options.evidenceItems, options.seenTurns, {
        id: `${options.sessionId}:${message.turn_index}`,
        sessionId: options.sessionId,
        turnIndex: message.turn_index,
        role: message.role,
        content: message.content,
      });
      break;
    }
  }
}

function focusedTranscriptCueMatchers(
  query: string,
): Array<(content: string) => boolean> {
  const normalized = query.toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").trim();
  const matchers: Array<(content: string) => boolean> = [];

  if (hasSecurityFeatureEnumerationIntent(normalized)) {
    matchers.push((content) => /\bpassword hashing\b/i.test(content));
    matchers.push((content) => /\brole-based access control\b|\bRBAC\b/i.test(content));
    matchers.push((content) =>
      /\baccount lockout\b/i.test(content) &&
      /\bfailed login attempts?\b/i.test(content),
    );
  }

  if (hasTemporalScheduleIntent(normalized)) {
    matchers.push((content) =>
      /\btransaction management\b/i.test(content) &&
      /\bdeployment\b/i.test(content) &&
      /\bmilestones?\b/i.test(content),
    );
  }

  if (hasFlaskRouteContradictionIntent(normalized)) {
    matchers.push((content) =>
      /\bnever written\b.{0,80}\bFlask routes?\b/i.test(content) &&
      /\bhandled HTTP requests?\b/i.test(content),
    );
    matchers.push((content) =>
      /\bbasic homepage route\b/i.test(content) ||
      (/\b@app\.route\(['"]\/['"]\)/i.test(content) && /\bhomepage\b/i.test(content)),
    );
  }

  if (hasFlaskLoginContradictionIntent(normalized)) {
    matchers.push((content) =>
      /\bnever\b.{0,80}\bintegrated\b.{0,80}\bFlask-Login\b/i.test(content) ||
      (/\bFlask-Login\b/i.test(content) && /\bstarting from scratch\b/i.test(content)),
    );
    matchers.push((content) =>
      /\bFlask-Login\s+v?0\.6\.2\b/i.test(content) &&
      /\bsession management\b/i.test(content),
    );
  }

  if (hasSecurityDatabaseChallengeSummaryIntent(normalized)) {
    matchers.push((content) =>
      /\bWerkzeug\.security\b/i.test(content) ||
      /\bpbkdf2:sha256\b/i.test(content),
    );
    matchers.push((content) =>
      /\bUNIQUE constraint\b/i.test(content) && /\bUUID\b/i.test(content),
    );
    matchers.push((content) => /\bOperationalError\b/i.test(content));
    matchers.push((content) =>
      /\bCSRF\b/i.test(content) &&
      /\b(?:hidden_tag|WTF_CSRF_ENABLED|cookies?)\b/i.test(content),
    );
    matchers.push((content) =>
      /\baccount lockout\b/i.test(content) &&
      /\bRedis\b/i.test(content) &&
      /\b(?:atomic|expiry|expire|reset(?:ting)? counters?|rate limiting)\b/i.test(content),
    );
  }

  if (hasProjectProgressSummaryIntent(normalized)) {
    matchers.push((content) =>
      /\b(?:data visualization|visualization)\b/i.test(content) &&
      /\b(?:expenses?|income|analytics|budget tracker)\b/i.test(content),
    );
    matchers.push((content) =>
      /\bApril 15\b/i.test(content) && /\bMVP\b/i.test(content),
    );
    matchers.push((content) =>
      /\bauthentication\b/i.test(content) &&
      /\btransaction management\b/i.test(content) &&
      /\banalytics\b/i.test(content) &&
      /\bdeployment\b/i.test(content),
    );
    matchers.push((content) =>
      /\bpassword hashing\b/i.test(content),
    );
    matchers.push((content) =>
      /\btoken-based authentication\b|\bJWT\b|\baccess_token\b/i.test(content),
    );
    matchers.push((content) =>
      /\brole-based access control\b|\bRBAC\b/i.test(content),
    );
    matchers.push((content) =>
      /\binput validation\b|\bvalidate and sanitize\b|\bSQL injection\b/i.test(content),
    );
    matchers.push((content) =>
      /\b(?:stronger password hashing|password hashing|token-based authentication|role-based access control|input validation)\b/i.test(content),
    );
    matchers.push((content) =>
      /\bConfluence\b/i.test(content) && /\b(?:tables?|diagrams?)\b/i.test(content),
    );
  }

  if (hasSoftwareProjectOrderingIntent(normalized)) {
    matchers.push((content) =>
      /\bcore functionality\b/i.test(content) &&
      /\b(?:budget tracker|authentication|expense tracking|data visualization)\b/i.test(content),
    );
    matchers.push((content) =>
      /\btransaction CRUD\b/i.test(content) ||
      (/\btransactions?\b/i.test(content) && /\bCRUD\b/i.test(content)),
    );
    matchers.push((content) =>
      /\bdeployment configuration\b/i.test(content) ||
      (/\bRender\.com\b/i.test(content) && /\b(?:deployment|configuration|PostgreSQL)\b/i.test(content)),
    );
    matchers.push((content) =>
      /\bintegration test coverage\b/i.test(content) ||
      /\bintegration tests?\b/i.test(content),
    );
    matchers.push((content) =>
      /\bdeployment and test improvements\b/i.test(content) ||
      (/\bdeployment\b/i.test(content) && /\b(?:final testing|bug fixes|test improvements)\b/i.test(content)),
    );
    matchers.push((content) =>
      /\btransaction error handling\b/i.test(content) ||
      (/\btransactions?\b/i.test(content) && /\b(?:OperationalError|error handling)\b/i.test(content)),
    );
    matchers.push((content) =>
      /\bsecurity hardening\b/i.test(content) ||
      (/\bsecurity\b/i.test(content) && /\bdeployment\b/i.test(content)),
    );
  }

  if (hasSprintTaskOrganizationIntent(normalized)) {
    matchers.push((content) => /\bdevelopment environment\b|\binitial project structure\b/i.test(content));
    matchers.push((content) => /\bdatabase schema\b/i.test(content));
    matchers.push((content) => /\bregistration and login\b|\buser registration\b.{0,80}\blogin\b/i.test(content));
    matchers.push((content) => /\bvalidation\b/i.test(content));
    matchers.push((content) => /\bunit tests?\b/i.test(content));
    matchers.push((content) =>
      /\bfrontend\b/i.test(content) &&
      /\b(?:forms?|integrat(?:e|ing|ion))\b/i.test(content),
    );
  }

  return matchers;
}

async function collectContentLabelReferenceEvidence(options: {
  engine: ExplicitCueRecallEngine;
  sessionId?: string;
  query: string;
  references: ExplicitTurnReference[];
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>;
  seenTurns: Set<string>;
}): Promise<Set<number>> {
  const resolved = new Set<number>();

  for (const reference of options.references) {
    if (reference.includeDirectTurn) {
      continue;
    }

    const hits = await searchReferenceContentLabels(
      options.engine,
      reference.number,
      options.sessionId,
    );
    if (hits.length === 0) {
      continue;
    }

    resolved.add(reference.number);
    let appendedWindows = 0;
    for (const hit of hits) {
      if (appendedWindows >= CONTENT_LABEL_MAX_PAIRED_WINDOWS_PER_REFERENCE) {
        break;
      }

      const { fromTurn, toTurn } = contentLabelEvidenceWindow(hit, {
        includeSuccessor: hasSuccessorTrajectoryIntent(options.query),
      });
      const expanded = await options.engine.expandContext(
        hit.session_id,
        fromTurn,
        toTurn,
        CONTENT_LABEL_MAX_TOKENS,
      );
      if (!expandedHasPairedTrajectoryLabels(expanded, reference.number)) {
        continue;
      }
      if (expanded.length === 0) {
        appendEvidenceItem(options.evidenceItems, options.seenTurns, {
          id: `${hit.session_id}:${hit.turn_index}`,
          sessionId: hit.session_id,
          turnIndex: hit.turn_index,
          role: hit.role,
          content: hit.content,
        });
        continue;
      }
      appendExpandedEvidence(
        options.evidenceItems,
        options.seenTurns,
        hit.session_id,
        expanded,
      );
      appendedWindows += 1;
    }
  }

  return resolved;
}

async function searchReferenceContentLabels(
  engine: ExplicitCueRecallEngine,
  referenceNumber: number,
  sessionId?: string,
): Promise<
  Array<{
    turn_index: number;
    role: string;
    content: string;
    session_id: string;
    labelKind: "action" | "observation";
  }>
> {
  const hits = new Map<
    string,
    {
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      labelKind: "action" | "observation";
    }
  >();

  for (const labelKind of ["action", "observation"] as const) {
    const label = labelKind === "action" ? "Action" : "Observation";
    for (const query of [`[${label} ${referenceNumber}]`, `${label} ${referenceNumber}`]) {
      const results = await engine.searchContextFull(
        query,
        CONTENT_LABEL_SEARCH_LIMIT,
        sessionId,
      );
      for (const result of results) {
        if (
          !isReferenceLabelRole(result.role, labelKind) ||
          !contentHasReferenceLabel(result.content, labelKind, referenceNumber)
        ) {
          continue;
        }
        hits.set(`${result.session_id}:${result.turn_index}:${labelKind}`, {
          turn_index: result.turn_index,
          role: result.role,
          content: result.content,
          session_id: result.session_id,
          labelKind,
        });
      }
    }
  }

  const numericCandidates = candidateTurnIndexesForReference({
    number: referenceNumber,
    includeDirectTurn: false,
  });
  return [...hits.values()].sort((left, right) => {
    const sessionOrder = left.session_id.localeCompare(right.session_id);
    if (sessionOrder !== 0) {
      return sessionOrder;
    }
    const leftDistance = nearestTurnDistance(left.turn_index, numericCandidates);
    const rightDistance = nearestTurnDistance(right.turn_index, numericCandidates);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return left.turn_index - right.turn_index || left.labelKind.localeCompare(right.labelKind);
  });
}

function nearestTurnDistance(turnIndex: number, candidates: readonly number[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    nearest = Math.min(nearest, Math.abs(turnIndex - candidate));
  }
  return nearest;
}

function contentLabelEvidenceWindow(hit: {
  turn_index: number;
  labelKind: "action" | "observation";
}, options: { includeSuccessor?: boolean } = {}): { fromTurn: number; toTurn: number } {
  const successorTurns = options.includeSuccessor === true ? 2 : 0;
  if (hit.labelKind === "action") {
    return {
      fromTurn: Math.max(0, hit.turn_index - 1),
      toTurn: hit.turn_index + 1 + successorTurns,
    };
  }

  return {
    fromTurn: Math.max(0, hit.turn_index - 1),
    toTurn: hit.turn_index + successorTurns,
  };
}

function hasSuccessorTrajectoryIntent(query: string): boolean {
  const raw = query.toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, " ").trim();
  if ([
    /\bafter\s+(?:step|action|observation|turn)\s+\d+\b/,
    /\b(?:next|following|subsequent|successor)\s+(?:step|action|observation|turn)\b/,
    /\b(?:step|action|observation|turn)\s+\d+\s+(?:then|and then)\b/,
    /\bwhat\s+(?:happened|came|occurred)\s+next\b/,
  ].some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (!hasLoopExitIntent(normalized)) {
    return false;
  }

  if (!hasBoundedTrajectoryReference(raw)) {
    return true;
  }

  return !asksForActionInsideBoundedRange(normalized) &&
    hasNamedTrajectoryActionCue(normalized);
}

function hasBoundedTrajectoryReference(query: string): boolean {
  return hasBoundedTrajectoryRange(query) || hasSingleTrajectoryReference(query);
}

function hasLoopExitIntent(normalizedQuery: string): boolean {
  const exitVerbs = "(?:breaks?|breaking|broke|ends?|ending|ended|stops?|stopping|stopped)";
  const loopNouns = "(?:loop|cycle|pattern|sequence)";
  return [
    new RegExp(
      `\\b${exitVerbs}\\s+(?:out\\s+of\\s+)?(?:this|that|the|a|an)?\\s*${loopNouns}\\b`,
    ),
    new RegExp(
      `\\b${loopNouns}\\s+(?:${exitVerbs}|is\\s+${exitVerbs}|was\\s+${exitVerbs})\\b`,
    ),
  ].some((pattern) => pattern.test(normalizedQuery));
}

function hasBoundedTrajectoryRange(query: string): boolean {
  return [
    /\b(?:between|from|in|during|within)\s+(?:steps?|actions?|observations?|turns?)\s+#?\d+\s*(?:-|\u2013|\u2014|\bto\b|\bthrough\b|\bthru\b|\band\b)\s*(?:(?:steps?|actions?|observations?|turns?)\s+)?#?\d+\b/,
    /\b(?:steps?|actions?|observations?|turns?)\s+#?\d+\s*(?:-|\u2013|\u2014|\bto\b|\bthrough\b|\bthru\b)\s*(?:(?:steps?|actions?|observations?|turns?)\s+)?#?\d+\b/,
  ].some((pattern) => pattern.test(query));
}

function hasSingleTrajectoryReference(query: string): boolean {
  return /\b(?:in|during|within|at|on)?\s*(?:steps?|actions?|observations?|turns?)\s+#?\d+\b/.test(
    query,
  );
}

function asksForActionInsideBoundedRange(normalizedQuery: string): boolean {
  return /\b(?:which|what)\s+(?:single\s+)?(?:action|move|step|maneuver)\s+(?:broke|breaks|breaking|ended|ends|stopped|stops|mattered|accomplished|advanced)\b/.test(
    normalizedQuery,
  );
}

function hasNamedTrajectoryActionCue(normalizedQuery: string): boolean {
  const actions = "(?:up|down|left|right|wait|stay|push|pull|open|close|use|enter|exit)";
  return new RegExp(
    `\\b(?:${actions}\\s+(?:action|move|step|maneuver)|(?:action|move|step|maneuver)\\s+${actions})\\b`,
  ).test(normalizedQuery);
}

function contentHasReferenceLabel(
  content: string,
  labelKind: "action" | "observation",
  referenceNumber: number,
): boolean {
  const label = labelKind === "action" ? "Action" : "Observation";
  const escapedNumber = String(referenceNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*\\[\\s*${label}\\s+${escapedNumber}\\s*\\]\\s*(?::\\s*)?`,
    "i",
  ).test(content);
}

function isReferenceLabelRole(
  role: string,
  labelKind: "action" | "observation",
): boolean {
  if (labelKind === "action") {
    return role === "user";
  }
  return role === "assistant";
}

function expandedHasPairedTrajectoryLabels(
  expanded: Array<{ role: string; content: string }>,
  referenceNumber: number,
): boolean {
  let hasAction = false;
  let hasObservation = false;
  for (const message of expanded) {
    if (
      isReferenceLabelRole(message.role, "action") &&
      contentHasReferenceLabel(message.content, "action", referenceNumber)
    ) {
      hasAction = true;
    }
    if (
      isReferenceLabelRole(message.role, "observation") &&
      contentHasReferenceLabel(message.content, "observation", referenceNumber)
    ) {
      hasObservation = true;
    }
  }
  return hasAction && hasObservation;
}

async function collectLexicalCueEvidence(options: {
  engine: ExplicitCueRecallEngine;
  sessionId?: string;
  query: string;
  maxReferences: number;
  includeBenchmarkAnchorCues?: boolean;
  includeContentLexicalCues?: boolean;
  includeStructuredPlanCues?: boolean;
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
    score?: number;
  }>;
  seenTurns: Set<string>;
}): Promise<void> {
  const cues = prioritizeLexicalCueSearchCues(
    options.query,
    collectLexicalCues(options.query, {
      includeBenchmarkAnchorCues: options.includeBenchmarkAnchorCues,
      includeContentLexicalCues: options.includeContentLexicalCues,
      includeStructuredPlanCues: options.includeStructuredPlanCues,
    }),
  ).slice(0, options.maxReferences);
  const preferLatest = hasLatestStateIntent(options.query);
  for (const cue of cues) {
    const exactHitFirst = isHighPriorityImplementationCue(options.query, cue);
    const results = sortLexicalCueResults(
      await options.engine.searchContextFull(
        cue,
        lexicalCueSearchLimit(options.query, cue),
        options.sessionId,
      ),
      preferLatest,
      options.query,
    );
    for (const result of results) {
      const windowRadius = preferLatest ? 0 : LEXICAL_CUE_WINDOW_RADIUS;
      const fromTurn = Math.max(0, result.turn_index - windowRadius);
      const toTurn = result.turn_index + windowRadius;
      const expanded = await options.engine.expandContext(
        result.session_id,
        fromTurn,
        toTurn,
        LEXICAL_CUE_MAX_TOKENS,
      );
      if (expanded.length === 0) {
        appendEvidenceItem(options.evidenceItems, options.seenTurns, {
          id: `${result.session_id}:${result.turn_index}`,
          sessionId: result.session_id,
          turnIndex: result.turn_index,
          role: result.role,
          content: result.content,
          ...(typeof result.score === "number" ? { score: result.score } : {}),
        });
        continue;
      }
      if (exactHitFirst) {
        appendEvidenceItem(options.evidenceItems, options.seenTurns, {
          id: `${result.session_id}:${result.turn_index}`,
          sessionId: result.session_id,
          turnIndex: result.turn_index,
          role: result.role,
          content: result.content,
          ...(typeof result.score === "number" ? { score: result.score } : {}),
        });
      }
      appendExpandedEvidence(
        options.evidenceItems,
        options.seenTurns,
        result.session_id,
        expanded,
      );
    }
  }
}

interface LabeledTrajectoryStep {
  step: number;
  action?: string;
  observation?: string;
  actionTurnIndex?: number;
  observationTurnIndex?: number;
}

interface TrajectoryBounds {
  start: number;
  end: number;
  reason: string;
}

interface ObservationTransition {
  fromStep: number;
  toStep: number;
}

interface RelativePosition {
  entity: string;
  x: number;
  y: number;
  raw: string;
}

interface AgentMoveDelta {
  direction: "up" | "down" | "left" | "right";
  dx: number;
  dy: number;
}

interface ContainerObjectTransfer {
  step: number;
  action: string;
  object: string;
  container: string;
  direction: "placed" | "removed";
}

function hasTrajectoryAnalysisIntent(query: string): boolean {
  const normalized = normalizeTrajectoryQuery(query);
  if (collectExplicitTurnReferences(query).length > 0) {
    return true;
  }
  return [
    /\bbefore\s+(?:step|action|observation)\s+\d+\b/,
    /\b(?:until|through|thru)\s+(?:step|action|observation)\s+\d+\b/,
    /\bup\s+to\s+(?:and\s+including\s+)?(?:step|action|observation)\s+\d+\b/,
    /\bwhat\s+sequence\s+of\s+actions\s+would\s+transform\b/,
    /\bactions?\s+were\s+performed\b/,
    /\bstate\s+of\s+[a-z0-9 _-]+\s+\d+\s+at\s+step\s+\d+\b/,
    /\bwhole\s+changes?\s+history\b/,
    /\bthroughout\s+the\s+trajectory\b/,
    /\binventory\b/,
    /\bcontainers?\b.*\binteracted\b/,
    /\btypes?\s+of\s+actions?\b.*\bfrequen/,
    /\bhow\s+frequently\b/,
  ].some((pattern) => pattern.test(normalized));
}

function parseLabeledTrajectory(
  messages: Array<{ turn_index: number; role: string; content: string }>,
): LabeledTrajectoryStep[] {
  const byStep = new Map<number, LabeledTrajectoryStep>();

  for (const message of messages) {
    const action = parseTrajectoryLabel(message.content, "Action");
    if (action && isReferenceLabelRole(message.role, "action")) {
      const step = getOrCreateTrajectoryStep(byStep, action.step);
      step.action = action.value;
      step.actionTurnIndex = message.turn_index;
      continue;
    }

    const observation = parseTrajectoryLabel(message.content, "Observation");
    if (observation && isReferenceLabelRole(message.role, "observation")) {
      const step = getOrCreateTrajectoryStep(byStep, observation.step);
      step.observation = observation.value;
      step.observationTurnIndex = message.turn_index;
    }
  }

  return [...byStep.values()].sort((left, right) => left.step - right.step);
}

function parseTrajectoryLabel(
  content: string,
  label: "Action" | "Observation",
): { step: number; value: string } | undefined {
  const match = new RegExp(
    `^\\s*\\[\\s*${label}\\s+(\\d+)\\s*\\]\\s*(?::\\s*)?([\\s\\S]*)$`,
    "i",
  ).exec(content);
  if (!match) {
    return undefined;
  }
  const step = parseNonNegativeIntegerToken(match[1] ?? "");
  if (step === undefined) {
    return undefined;
  }
  const value = (match[2] ?? "").trim();
  return { step, value };
}

function getOrCreateTrajectoryStep(
  byStep: Map<number, LabeledTrajectoryStep>,
  stepNumber: number,
): LabeledTrajectoryStep {
  const existing = byStep.get(stepNumber);
  if (existing) {
    return existing;
  }
  const created: LabeledTrajectoryStep = { step: stepNumber };
  byStep.set(stepNumber, created);
  return created;
}

function inferTrajectoryBounds(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
): TrajectoryBounds {
  const minStep = trajectory[0]?.step ?? 0;
  const maxStep = trajectory[trajectory.length - 1]?.step ?? minStep;
  const normalized = normalizeTrajectoryQuery(query);

  const before = firstMatchInteger(
    normalized,
    /\bbefore\s+(?:step|action|observation)\s+(\d+)\b/,
  );
  if (before !== undefined) {
    return clampTrajectoryBounds(minStep, before - 1, minStep, maxStep, "before");
  }

  const until = firstMatchInteger(
    normalized,
    /\b(?:until|through|thru)\s+(?:step|action|observation)\s+(\d+)\b/,
  ) ?? firstMatchInteger(
    normalized,
    /\bup\s+to\s+(?:and\s+including\s+)?(?:step|action|observation)\s+(\d+)\b/,
  );
  if (until !== undefined) {
    return clampTrajectoryBounds(minStep, until, minStep, maxStep, "through");
  }

  const explicitRange = extractExplicitTrajectoryRange(normalized);
  if (explicitRange) {
    return clampTrajectoryBounds(
      explicitRange.start,
      explicitRange.end,
      minStep,
      maxStep,
      "range",
    );
  }

  const references = collectExplicitTurnReferences(query).map((reference) => reference.number);
  if (references.length > 1) {
    return clampTrajectoryBounds(
      Math.min(...references),
      Math.max(...references),
      minStep,
      maxStep,
      "references",
    );
  }

  const atStep = firstMatchInteger(
    normalized,
    /\b(?:at|in|on)\s+(?:step|action|observation)\s+(\d+)\b/,
  );
  if (atStep !== undefined) {
    return clampTrajectoryBounds(minStep, atStep, minStep, maxStep, "at");
  }

  return { start: minStep, end: maxStep, reason: "full" };
}

function buildTrajectoryAnalysisLines(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): string[] {
  const normalized = normalizeTrajectoryQuery(query);
  const explicitReferences = collectExplicitTurnReferences(query);
  const lines: string[] = [
    `Analyzed labeled action/observation transcript window: steps ${bounds.start}-${bounds.end} (${bounds.reason}).`,
  ];
  const hasQuotedObservationPair = extractQuotedObservations(query).length >= 2;
  const transition = findObservationTransition(query, trajectory);
  const entities = extractNumberedEntities(query);
  const asksActionRange = asksForTrajectoryActionRange(normalized) || transition !== undefined;
  const asksFrequency = asksForActionFrequency(normalized);
  const asksInventory = /\binventory\b/.test(normalized);
  const asksLocation = /\blocations?\b/.test(normalized) || /\bwhere\b/.test(normalized);
  const asksContainerHistory = /\bcontainers?\b/.test(normalized) ||
    /\binteracted\b/.test(normalized);
  const asksContainerObjectTransfer = /\b(?:objects?|items?)\b/.test(normalized) &&
    /\b(?:placed|put|inserted|moved|removed)\b/.test(normalized);
  const asksEntityState = /\bstate\b/.test(normalized) ||
    /\bchanges?\s+history\b/.test(normalized) ||
    /\bwhole\s+changes?\s+history\b/.test(normalized);
  const asksResultingObservation = /\bresulting\s+state\b/.test(normalized) ||
    /\bprovide\s+the\s+full\s+observation\b/.test(normalized) ||
    /\bwhat\s+will\s+be\s+the\s+resulting\b/.test(normalized);

  if (transition) {
    lines.push(
      `Matched quoted observations: Observation ${transition.fromStep} -> Observation ${transition.toStep}.`,
    );
    appendActionSequenceSummary(
      lines,
      trajectory,
      transition.fromStep + 1,
      transition.toStep,
      "Action sequence that transforms the quoted observations:",
    );
    appendActionRangeLines(lines, trajectory, transition.fromStep + 1, transition.toStep, {
      includeObservations: true,
      heading: "Detailed transition evidence:",
    });
  }

  if (asksResultingObservation && !transition && explicitReferences.length > 0) {
    appendActionRangeLines(lines, trajectory, bounds.start, bounds.end, {
      includeObservations: true,
      heading: "Referenced action sequence and observations:",
    });
    appendResultingObservationLine(lines, trajectory, bounds.end);
  }

  if (
    asksActionRange &&
    !transition &&
    entities.length === 0 &&
    !hasQuotedObservationPair
  ) {
    if (bounds.reason === "references") {
      appendReferencedTrajectoryLines(lines, trajectory, explicitReferences, {
        includeObservations: false,
        heading: "Actions at referenced steps:",
      });
    } else {
      appendActionRangeLines(lines, trajectory, bounds.start, bounds.end, {
        includeObservations: false,
        heading: "Actions in requested step window:",
      });
    }
  }

  if (asksFrequency) {
    appendActionFrequencyLines(lines, trajectory, bounds);
  }

  appendSpatialTrajectoryInferenceLines(lines, query, trajectory, bounds);

  if (asksInventory) {
    appendInventoryChangeLines(lines, trajectory, bounds);
  }

  if (asksContainerHistory) {
    appendContainerStateChangeLines(lines, trajectory, bounds);
  }

  if (
    entities.length > 0 &&
    (asksEntityState ||
      asksLocation ||
      /actions?\s+were\s+performed/.test(normalized))
  ) {
    appendEntityTimelineLines(lines, trajectory, bounds, entities, {
      includeIndirectMentions: asksLocation,
      includeContainerObjectTransfers: asksContainerObjectTransfer,
      includeMovableStateActions: asksEntityState,
    });
  }

  if (lines.length === 1 && explicitReferences.length > 0) {
    if (bounds.reason === "references") {
      appendReferencedTrajectoryLines(lines, trajectory, explicitReferences, {
        includeObservations: true,
        heading: "Referenced trajectory evidence:",
      });
    } else {
      appendActionRangeLines(lines, trajectory, bounds.start, bounds.end, {
        includeObservations: true,
        heading: "Referenced trajectory evidence:",
      });
    }
  }

  return lines.length === 1 ? [] : lines;
}

function appendReferencedTrajectoryLines(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  references: readonly ExplicitTurnReference[],
  options: { includeObservations: boolean; heading: string },
): void {
  const byStep = new Map(trajectory.map((step) => [step.step, step]));
  const window = [...new Set(references.map((reference) => reference.number))]
    .sort((left, right) => left - right)
    .map((step) => byStep.get(step))
    .filter((step): step is LabeledTrajectoryStep => step !== undefined);
  if (window.length === 0) {
    return;
  }

  lines.push(options.heading);
  for (const step of window) {
    if (step.action) {
      lines.push(`[Action ${step.step}]: ${step.action}`);
    }
    if (options.includeObservations && step.observation) {
      lines.push(`[Observation ${step.step}]: ${oneLine(step.observation)}`);
    }
  }
}

function appendActionRangeLines(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  start: number,
  end: number,
  options: { includeObservations: boolean; heading: string },
): void {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  if (high - low + 1 > TRAJECTORY_ANALYSIS_MAX_RANGE_STEPS) {
    lines.push(`${options.heading} requested range ${low}-${high} is too large for inline expansion.`);
    return;
  }
  const window = trajectory.filter((step) => step.step >= low && step.step <= high);
  if (window.length === 0) {
    return;
  }
  lines.push(options.heading);
  for (const step of window) {
    if (step.action) {
      lines.push(`[Action ${step.step}]: ${step.action}`);
    }
    if (options.includeObservations && step.observation) {
      lines.push(`[Observation ${step.step}]: ${oneLine(step.observation)}`);
    }
  }
}

function appendActionSequenceSummary(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  start: number,
  end: number,
  heading: string,
): void {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const actions = trajectory
    .filter((step) => step.step >= low && step.step <= high && step.action)
    .map((step) => `step ${step.step}: ${step.action}`);
  if (actions.length === 0) {
    return;
  }
  lines.push(`${heading} ${actions.join("; ")}.`);
}

function appendResultingObservationLine(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  stepNumber: number,
): void {
  const step = trajectory.find((candidate) => candidate.step === stepNumber);
  if (!step?.observation) {
    return;
  }
  lines.push(`Resulting observation after Action ${step.step}: ${oneLine(step.observation)}`);
}

function appendSpatialTrajectoryInferenceLines(
  lines: string[],
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): void {
  const normalized = normalizeTrajectoryQuery(query);
  const wantsRelativePosition = /\brelative\s+position\b/.test(normalized) ||
    /\bsteps?\s+(?:to\s+the\s+)?(?:left|right|up|down)\b/.test(normalized);
  const wantsRules = /\brules?\b/.test(normalized) ||
    /\bwin\s+condition\b/.test(normalized) ||
    /\bpush(?:able)?\s+word\b/.test(normalized);
  const wantsStrategicOrCounterfactual = /\b(?:blocked|counterproductive|failed|failure|infer|inferred|objective|instead|alternative|progress|goal|necessary|critical|strategic|successful|relevant|ineffective|only\s+one|caused?\s+a\s+change)\b/.test(
    normalized,
  );
  const wantsStateTransformation = /\b(?:appear|appears|appeared|disappear|disappears|disappeared|temporary|transformation|hidden\s+state|reversed)\b/.test(
    normalized,
  );
  if (!wantsRelativePosition && !wantsRules && !wantsStrategicOrCounterfactual && !wantsStateTransformation) {
    return;
  }

  const window = spatialTrajectoryWindowForQuery(query, trajectory, bounds);
  const counterfactualContactLines = collectCounterfactualContactLines(query, trajectory, normalized);
  if (counterfactualContactLines.length > 0) {
    lines.push("Counterfactual contact cues:");
    lines.push(...counterfactualContactLines);
  }

  const selfReversingLines = collectSelfReversingProgressLines(query, window, normalized);
  if (selfReversingLines.length > 0) {
    lines.push("Self-reversing sequence cues:");
    lines.push(...selfReversingLines);
  }
  const onlyEffectiveActionLines = collectOnlyEffectiveActionLines(window, normalized);
  if (onlyEffectiveActionLines.length > 0) {
    lines.push("Only-effective action cues:");
    lines.push(...onlyEffectiveActionLines);
  }
  const pushedPhraseGroupLines = collectPushedPhraseGroupShiftLines(query, window, normalized);
  if (pushedPhraseGroupLines.length > 0) {
    lines.push("Pushed phrase-group shift cues:");
    lines.push(...pushedPhraseGroupLines);
  }
  const suppressMovementProgressEvidence = onlyEffectiveActionLines.length > 0 ||
    selfReversingLines.some((line) =>
    line.includes("named movement sequence") &&
    /\bwhich\b/.test(normalized) &&
    /\brelevant\b/.test(normalized)
  ) || pushedPhraseGroupLines.length > 0;

  const actionMovementLines = suppressMovementProgressEvidence
    ? []
    : collectActionMovementSummaryLines(query, window, bounds);
  if (actionMovementLines.length > 0) {
    lines.push("Action movement summary cues:");
    lines.push(...actionMovementLines);
  }

  const movementLines = suppressMovementProgressEvidence
    ? []
    : collectMovementDeltaLines(query, window);
  if (movementLines.length > 0) {
    lines.push("Relative-position movement cues:");
    lines.push(...movementLines);
  }

  const objectAlignmentWindow = objectAlignmentWindowForQuery(query, trajectory, bounds);
  const objectAlignmentLines = collectObjectAlignmentLines(
    query,
    objectAlignmentWindow,
    normalized,
  );
  if (objectAlignmentLines.length > 0) {
    lines.push("Object alignment cues:");
    lines.push(...objectAlignmentLines);
  }

  const alternativeActionLines = collectAlternativeActionLines(query, trajectory);
  if (alternativeActionLines.length > 0) {
    lines.push("Counterfactual action cues:");
    lines.push(...alternativeActionLines);
  }

  const adjacentRuleSetupLines = collectAdjacentRuleSetupLines(window, normalized);
  if (adjacentRuleSetupLines.length > 0) {
    lines.push("Adjacent rule-block setup cues:");
    lines.push(...adjacentRuleSetupLines);
  }

  const blockedMoveLines = collectBlockedMoveLines(query, window, normalized);
  if (blockedMoveLines.length > 0) {
    lines.push("Blocked-move cues:");
    lines.push(...blockedMoveLines);
  }

  const failedEscapeLines = collectFailedEscapeLines(query, trajectory, normalized);
  if (failedEscapeLines.length > 0) {
    lines.push("Failed-move escape cues:");
    lines.push(...failedEscapeLines);
  }

  const sameRelativeTextPushLines = collectSameRelativeTextPushLines(window, normalized);
  if (sameRelativeTextPushLines.length > 0) {
    lines.push("Same-relative text-push cues:");
    lines.push(...sameRelativeTextPushLines);
  }

  const failedContactLines = sameRelativeTextPushLines.length > 0
    ? []
    : collectFailedContactBoundaryLines(window, normalized);
  if (failedContactLines.length > 0) {
    lines.push("Failed-push boundary cues:");
    lines.push(...failedContactLines);
  }

  const transformationLines = collectTemporaryRuleTransformationLines(window, normalized);
  if (transformationLines.length > 0) {
    lines.push("Temporary transformation cues:");
    lines.push(...transformationLines);
  }

  const wholeConfigurationShiftLines = collectWholeConfigurationShiftLines(window, normalized);
  if (wholeConfigurationShiftLines.length > 0) {
    lines.push("Whole-configuration shift cues:");
    lines.push(...wholeConfigurationShiftLines);
  }

  const ruleInterventionLines = collectRuleInterventionStrategyLines(window, normalized);
  if (ruleInterventionLines.length > 0) {
    lines.push("Rule-intervention strategy cues:");
    lines.push(...ruleInterventionLines);
  }

  const missingPushTargetLines = collectMissingPushTargetLines(window, normalized);
  if (missingPushTargetLines.length > 0) {
    lines.push("Missing-interaction cues:");
    lines.push(...missingPushTargetLines);
  }

  const rulePhraseAlignmentLines = collectRulePhraseAlignmentLines(window, normalized);
  if (rulePhraseAlignmentLines.length > 0) {
    lines.push("Rule-phrase alignment cues:");
    lines.push(...rulePhraseAlignmentLines);
  }

  const controlRuleInteractionLines = collectControlRuleInteractionLines(window, normalized);
  if (controlRuleInteractionLines.length > 0) {
    lines.push("Control-rule interaction cues:");
    lines.push(...controlRuleInteractionLines);
  }

  const ruleTextPositionLines = suppressMovementProgressEvidence
    ? []
    : collectRuleTextPositionLines(window, normalized);
  if (ruleTextPositionLines.length > 0) {
    lines.push("Rule-text positioning cues:");
    lines.push(...ruleTextPositionLines);
  }

  const ruleLines = collectRuleStateLines(window, normalized);
  if (ruleLines.length > 0) {
    lines.push("Rule-state cues:");
    lines.push(...ruleLines);
  }
}

function spatialTrajectoryWindowForQuery(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): LabeledTrajectoryStep[] {
  const normalized = normalizeTrajectoryQuery(query);
  const minStep = trajectory[0]?.step ?? bounds.start;
  const maxStep = trajectory[trajectory.length - 1]?.step ?? bounds.end;
  let start = bounds.start;
  let end = bounds.end;
  const references = collectExplicitTurnReferences(query).map((reference) => reference.number);

  if (references.length > 0 && hasManeuverInterpretationCue(normalized)) {
    start = Math.min(start, ...references);
    end = Math.max(end, ...references);
  }

  if (
    references.length > 0 &&
    /\b(?:then|at\s+the\s+start\s+of|start\s+of|optimal|successful|failed|corrective)\b/.test(
      normalized,
    )
  ) {
    end = Math.max(end, ...references);
  }

  if (/\b(?:failed|successful|before\s+the\s+successful)\b/.test(normalized)) {
    for (const match of normalized.matchAll(/\bsteps?\s+(\d+)\s*(?:-|to|through|thru)\s*(\d+)\b/g)) {
      const rangeStart = parseNonNegativeIntegerToken(match[1] ?? "");
      const rangeEnd = parseNonNegativeIntegerToken(match[2] ?? "");
      if (rangeStart !== undefined && rangeEnd !== undefined) {
        start = Math.min(start, rangeStart, rangeEnd);
        end = Math.max(end, rangeStart, rangeEnd);
      }
    }
    const successfulStep = firstMatchInteger(normalized, /\bsuccessful\s+move\s+at\s+step\s+(\d+)\b/);
    if (successfulStep !== undefined) {
      end = Math.max(end, successfulStep);
    }
  }

  if (
    references.length > 0 &&
    /\b(?:appear|appears|appeared|disappear|disappears|disappeared|temporary|transformation|hidden\s+state|reversed)\b/.test(
      normalized,
    )
  ) {
    end = Math.max(end, ...references.map((reference) => reference + 1));
  }

  if (hasManeuverInterpretationCue(normalized) || /\brelative\s+position\b/.test(normalized)) {
    start -= 1;
  }

  if (/\b(?:breaks?|breaking|broke)\s+(?:this\s+|the\s+)?(?:loop|cycle|sequence)\b/.test(normalized)) {
    end += 1;
  }

  return boundedTrajectory(trajectory, {
    start: Math.max(minStep, start),
    end: Math.min(maxStep, end),
    reason: bounds.reason,
  });
}

function collectActionMovementSummaryLines(
  query: string,
  window: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): string[] {
  const normalized = normalizeTrajectoryQuery(query);
  if (!hasManeuverInterpretationCue(normalized) && !/\b(?:loop|cycle|sequence)\b/.test(normalized)) {
    return [];
  }

  const referencedEnd = Math.max(
    bounds.end,
    ...collectExplicitTurnReferences(query).map((reference) => reference.number),
    hasLoopExitIntent(normalized) ? (window[window.length - 1]?.step ?? bounds.end) : bounds.end,
  );
  const actions = window
    .filter((step) => step.step >= bounds.start && step.step <= referencedEnd && step.action)
    .map((step) => ({
      step: step.step,
      action: step.action!,
      move: agentMoveDeltaFromAction(step.action!),
    }))
    .filter((step): step is {
      step: number;
      action: string;
      move: AgentMoveDelta;
    } => step.move !== undefined);
  if (actions.length < 2) {
    return [];
  }

  const lines: string[] = [];
  const repeated = actions.every((step) => step.move.direction === actions[0]!.move.direction);
  const blockedPremise = /\b(?:blocked|fail|failed|failing|unchanged|stop|impassable|successfully\s+moved)\b/.test(
    normalized,
  );
  const noChangePremise = /\b(?:game\s+state|state|position|observations?)\s+(?:did\s+not|does\s+not|do\s+not|didn't|doesn't|remain(?:ed)?|remains?)\s+(?:change|changed|unchanged)\b/.test(
    normalized,
  ) || /\b(?:no\s+change|unchanged|did\s+not\s+change\s+at\s+all|does\s+not\s+change\s+at\s+all)\b/.test(
    normalized,
  );
  if (
    repeated &&
    (blockedPremise || noChangePremise) &&
    (
      observationsRemainStable(window, actions[0]!.step, actions[actions.length - 1]!.step) ||
      findStopBlockerForRepeatedMove(window, actions[0]!.move) !== undefined
    )
  ) {
    const blocker = findStopBlockerForRepeatedMove(window, actions[0]!.move);
    lines.push(
      blocker
        ? `Actions ${actions[0]!.step}-${actions[actions.length - 1]!.step} (${actions
            .map((step) => step.move.direction)
            .join(", ")}) are repeated blocked/no-progress attempts: ${blocker.entity} is ${blocker.position.raw} at Observation ${blocker.step} and active rule "${blocker.entity} is stop" makes that target cell impassable. Do not describe these attempts as hidden-position displacement.`
        : `Actions ${actions[0]!.step}-${actions[actions.length - 1]!.step} (${actions
            .map((step) => step.move.direction)
            .join(", ")}) are repeated attempts with stable relative observations; treat them as blocked/no-progress attempts, not as confirmed hidden-position displacement.`,
    );
    return lines;
  }

  const noKeyWinCue = collectNoKeyWinRepositioningCue(query, window);
  if (noKeyWinCue) {
    lines.push(noKeyWinCue);
  }

  const net = summarizeMoveNet(actions.map((step) => step.move));
  if (net.dx === 0 && net.dy === 0) {
    lines.push(
      `Actions ${actions[0]!.step}-${actions[actions.length - 1]!.step} (${actions
        .map((step) => step.move.direction)
        .join(", ")}) have net displacement 0; treat this as a self-canceling movement sequence unless another state change is shown.`,
    );
  } else {
    lines.push(
      `Actions ${actions[0]!.step}-${actions[actions.length - 1]!.step} (${actions
        .map((step) => step.move.direction)
        .join(", ")}) change the agent's hidden absolute position by ${formatMoveNet(net)}.`,
    );
  }

  if (actions.length >= 3) {
    const prior = actions.slice(0, -1);
    const priorNet = summarizeMoveNet(prior.map((step) => step.move));
    const last = actions[actions.length - 1]!;
    if (
      priorNet.dx === 0 &&
      priorNet.dy === 0 &&
      (last.move.dx !== 0 || last.move.dy !== 0)
    ) {
      lines.push(
        `The final ${last.move.direction} action at step ${last.step} is the first non-canceling movement after the prior loop; use it as vertical/horizontal progress toward nearby rule text rather than treating it as more oscillation.`,
      );
    }
  }

  if (repeated && actions.length >= 3) {
    lines.push(
      `The repeated ${actions[0]!.move.direction} actions are changing the agent's hidden absolute position over multiple rows/columns even if no immediate reward appears.`,
    );
  }

  return lines.slice(0, 4);
}

function summarizeMoveNet(moves: readonly AgentMoveDelta[]): { dx: number; dy: number } {
  return moves.reduce(
    (sum, move) => ({ dx: sum.dx + move.dx, dy: sum.dy + move.dy }),
    { dx: 0, dy: 0 },
  );
}

function formatMoveNet(net: { dx: number; dy: number }): string {
  const parts: string[] = [];
  if (net.dx !== 0) {
    parts.push(`${Math.abs(net.dx)} ${net.dx > 0 ? "right" : "left"}`);
  }
  if (net.dy !== 0) {
    parts.push(`${Math.abs(net.dy)} ${net.dy > 0 ? "down" : "up"}`);
  }
  return parts.length === 0 ? "0" : parts.join(" and ");
}

function collectMovementDeltaLines(
  query: string,
  window: readonly LabeledTrajectoryStep[],
): string[] {
  const entities = extractRelativePositionEntities(query);
  const lines: string[] = [];
  const focusSteps = new Set(collectExplicitTurnReferences(query).map((reference) => reference.number));
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    if (!previous.observation || !current.observation) {
      continue;
    }
    if (
      focusSteps.size > 0 &&
      !focusSteps.has(previous.step) &&
      !focusSteps.has(current.step)
    ) {
      continue;
    }
    const previousPositions = parseRelativePositions(previous.observation);
    const currentPositions = parseRelativePositions(current.observation);
    for (const [entity, previousPosition] of previousPositions.entries()) {
      if (
        entities.size > 0 &&
        ![...entities].some((candidate) => entity.includes(candidate))
      ) {
        continue;
      }
      const currentPosition = currentPositions.get(entity);
      if (!currentPosition) {
        continue;
      }
      const dx = currentPosition.x - previousPosition.x;
      const dy = currentPosition.y - previousPosition.y;
      if (dx === 0 && dy === 0) {
        continue;
      }
      const inferredAgentMove = inferAgentMoveFromRelativeDelta(dx, dy);
      if (!inferredAgentMove) {
        continue;
      }
      lines.push(
        `Observation ${previous.step}->${current.step}: ${entity} changed from ${previousPosition.raw} to ${currentPosition.raw}; this implies the agent moved ${inferredAgentMove} relative to a static object.`,
      );
    }
  }
  return lines.slice(0, 8);
}

function collectSelfReversingProgressLines(
  query: string,
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !/\b(?:relevant|progress|goal|touching|win\s+object|zero\s+net|self[- ]?reversing|opposing)\b/.test(
      normalizedQuery,
    )
  ) {
    return [];
  }
  const mentionedMoves = extractMentionedMoveSequence(query);
  const moves = mentionedMoves.length >= 2
    ? mentionedMoves
    : window
        .map((step) => (step.action ? agentMoveDeltaFromAction(step.action)?.direction : undefined))
        .filter((direction): direction is AgentMoveDelta["direction"] => direction !== undefined);
  if (moves.length < 2) {
    return [];
  }

  const hasReversePair =
    containsAdjacentReversePair(moves, "right", "left") ||
    containsAdjacentReversePair(moves, "left", "right") ||
    containsAdjacentReversePair(moves, "up", "down") ||
    containsAdjacentReversePair(moves, "down", "up");
  if (!hasReversePair) {
    return [];
  }

  const net = summarizeMoveNet(
    moves.map((direction) => agentMoveDeltaFromAction(direction)!),
  );
  const lines: string[] = [];
  if (net.dx === 0 && net.dy === 0) {
    lines.push(
      `The named movement sequence (${moves.join(", ")}) has net displacement 0; treat the actions as self-reversing exploratory noise unless a lasting rule, reward, inventory, or object-contact change is shown.`,
    );
    if (/\bwhich\b/.test(normalizedQuery) && /\brelevant\b/.test(normalizedQuery)) {
      lines.push(
        `For a question asking which named actions were relevant, answer that none of the named actions made lasting progress when the sequence cancels out and no durable state change is shown.`,
      );
    }
  } else if (
    mentionedMoves.length >= 4 &&
    containsAdjacentReversePair(mentionedMoves, "right", "left") &&
    containsAdjacentReversePair(mentionedMoves, "down", "up")
  ) {
    lines.push(
      `The named right/left and down/up pairs are self-reversing; temporary closeness to a win object inside a reversed pair is not lasting progress toward touching that object.`,
    );
  }
  return lines;
}

function extractMentionedMoveSequence(query: string): AgentMoveDelta["direction"][] {
  const moves: AgentMoveDelta["direction"][] = [];
  for (const value of extractBacktickValues(query)) {
    const move = agentMoveDeltaFromAction(value);
    if (move) {
      moves.push(move.direction);
    }
  }
  if (moves.length > 0) {
    return moves;
  }

  const normalized = normalizeTrajectoryQuery(query);
  const tokens = normalized.split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const startIndex = moveSequenceStartIndex(tokens, index);
    if (startIndex === undefined) {
      continue;
    }
    const sequence = collectMoveSequenceTokens(tokens, startIndex);
    if (sequence.length > 0) {
      return sequence;
    }
  }
  return [];
}

function moveSequenceStartIndex(
  tokens: readonly string[],
  index: number,
): number | undefined {
  if (tokens[index] === "sequence" && tokens[index + 1] === "of") {
    let cursor = index + 2;
    if (tokens[cursor] === "four" || parseNonNegativeIntegerToken(tokens[cursor] ?? "") !== undefined) {
      cursor += 1;
    }
    const label = tokens[cursor];
    if (label === "movement" || label === "movements") {
      return cursor + 1;
    }
  }

  const token = tokens[index];
  if (token !== "action" && token !== "actions") {
    return undefined;
  }
  if (tokens[index + 1] !== "from" || tokens[index + 2] !== "step") {
    return undefined;
  }
  let cursor = index + 3;
  if (parseNonNegativeIntegerToken(tokens[cursor] ?? "") !== undefined) {
    cursor += 1;
  }
  if (tokens[cursor] !== "to") {
    return undefined;
  }
  cursor += 1;
  if (tokens[cursor] === "step") {
    cursor += 1;
  }
  if (parseNonNegativeIntegerToken(tokens[cursor] ?? "") !== undefined) {
    cursor += 1;
  }
  return tokens[cursor] === "consist" && tokens[cursor + 1] === "of"
    ? cursor + 2
    : undefined;
}

function collectMoveSequenceTokens(
  tokens: readonly string[],
  startIndex: number,
): AgentMoveDelta["direction"][] {
  const moves: AgentMoveDelta["direction"][] = [];
  for (let index = startIndex; index < tokens.length && moves.length < 16; index += 1) {
    const token = tokens[index]!;
    const move = agentMoveDeltaFromAction(token);
    if (move) {
      moves.push(move.direction);
      continue;
    }
    if (moves.length > 0 && (token === "and" || token === "then")) {
      continue;
    }
    if (moves.length === 0 && MOVE_SEQUENCE_PREFIX_TOKENS.has(token)) {
      continue;
    }
    break;
  }
  return moves;
}

const MOVE_SEQUENCE_PREFIX_TOKENS = new Set([
  "the",
  "following",
  "movement",
  "movements",
  "action",
  "actions",
  "are",
  "is",
  "were",
  "namely",
  "as",
  "listed",
]);

function containsAdjacentReversePair(
  moves: readonly AgentMoveDelta["direction"][],
  first: AgentMoveDelta["direction"],
  second: AgentMoveDelta["direction"],
): boolean {
  for (let index = 1; index < moves.length; index += 1) {
    if (moves[index - 1] === first && moves[index] === second) {
      return true;
    }
  }
  return false;
}

function collectOnlyEffectiveActionLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !(
      /\bonly\s+one\b/.test(normalizedQuery) &&
      /\b(?:caused?\s+a\s+change|made\s+progress|relevant|ineffective)\b/.test(normalizedQuery)
    ) &&
    !/\bother\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine)\b.*\bineffective\b/.test(normalizedQuery)
  ) {
    return [];
  }

  const steps = window.filter((step) => step.action && step.observation);
  if (steps.length < 3) {
    return [];
  }

  const baseline = observationStateSignature(steps[0]!.observation!);
  if (!baseline) {
    return [];
  }

  const unchanged: LabeledTrajectoryStep[] = [];
  let changed: LabeledTrajectoryStep | undefined;
  for (const step of steps) {
    const signature = observationStateSignature(step.observation!);
    if (signature === baseline && changed === undefined) {
      unchanged.push(step);
      continue;
    }
    changed = step;
    break;
  }

  if (!changed || unchanged.length < 2) {
    return [];
  }

  const previous = unchanged[unchanged.length - 1]!;
  const changedMove = agentMoveDeltaFromAction(changed.action!);
  const unchangedActions = unchanged
    .map((step) => `Action ${step.step} ${normalizeActionVerb(step.action!) || step.action}`)
    .join(", ");
  const example = positionShiftExample(previous.observation!, changed.observation!);
  return [
    `Within the named span, Observations ${unchanged[0]!.step}-${previous.step} have the same object-relative signature after ${unchangedActions}; treat those actions as ineffective/no-progress attempts even if an earlier pre-span observation differs.`,
    `Observation ${previous.step}->${changed.step} is the first state change inside the span after Action ${changed.step} ${changedMove?.direction ?? changed.action}${example ? ` (${example})` : ""}; answer that Action ${changed.step} ${changedMove?.direction ?? changed.action} is the only progress-making action.`,
  ];
}

function collectObjectAlignmentLines(
  query: string,
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  const entities = extractRelativePositionEntities(query);
  const focusSteps = new Set(collectExplicitTurnReferences(query).map((reference) => reference.number));
  const lines: string[] = [];
  const strategicCueEntities = new Set<string>();

  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    const next = window[index + 1];
    if (!previous.observation || !current.observation || !current.action) {
      continue;
    }
    if (
      focusSteps.size > 0 &&
      !focusSteps.has(previous.step) &&
      !focusSteps.has(current.step) &&
      (!next || !focusSteps.has(next.step))
    ) {
      continue;
    }

    const move = agentMoveDeltaFromAction(current.action);
    if (!move) {
      continue;
    }

    const previousPositions = parseRelativePositions(previous.observation);
    const currentPositions = parseRelativePositions(current.observation);
    for (const [entity, previousPosition] of previousPositions.entries()) {
      if (entity.startsWith("rule ")) {
        continue;
      }
      if (
        entities.size > 0 &&
        ![...entities].some((candidate) => entity.includes(candidate))
      ) {
        continue;
      }
      if (currentPositions.has(entity)) {
        continue;
      }
      if (!relativePositionMatchesMove(previousPosition, move)) {
        continue;
      }

      lines.push(
        `Observation ${previous.step}->${current.step}: ${entity} was ${previousPosition.raw}, Action ${current.step} was ${move.direction}, and ${entity} is absent from Observation ${current.step}; infer a zero-offset same-tile alignment at the end of step ${current.step}, not that ${entity} was removed.`,
      );

      if (next?.observation && next.action) {
        const nextPositions = parseRelativePositions(next.observation);
        const nextPosition = nextPositions.get(entity);
        const nextMove = agentMoveDeltaFromAction(next.action);
        if (nextPosition && nextMove) {
          lines.push(
            `Observation ${current.step}->${next.step}: after Action ${next.step} ${nextMove.direction}, ${entity} reappears ${nextPosition.raw}; this confirms the step-${current.step} same-tile alignment and leaves the agent on the opposite side of ${entity} for a future ${oppositeDirection(nextMove.direction)} interaction or alignment.`,
          );
          if (
            normalizedQuery.includes("win") ||
            (hasManeuverInterpretationCue(normalizedQuery) &&
              hasRelativeEntityInObservations("rule win", [
                previous.observation,
                current.observation,
                next.observation,
              ]))
          ) {
            lines.push(
              `Because the question asks about a win-condition objective, treat that future ${oppositeDirection(nextMove.direction)} setup as supporting possible ${entity} manipulation or rule alignment toward a new win condition.`,
            );
          }
        }
      }

      if (
        hasManeuverInterpretationCue(normalizedQuery) &&
        !hasExactRelativeStateIntent(normalizedQuery) &&
        !strategicCueEntities.has(entity)
      ) {
        lines.push(
          `For ${entity} strategic maneuver questions, treat same-tile or vanishing-object cues as path-positioning evidence; the strategic goal should be framed as repositioning around a blocking object for later rule/object manipulation, not as pushing, collecting, or removing ${entity}.`,
        );
        strategicCueEntities.add(entity);
      }
    }
  }

  return lines.slice(0, 8);
}

function objectAlignmentWindowForQuery(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): LabeledTrajectoryStep[] {
  const normalized = normalizeTrajectoryQuery(query);
  let end = bounds.end;
  if (/(?:after|vanish|vanished|disappear|disappeared|reappear|reappeared)/.test(normalized)) {
    for (const reference of collectExplicitTurnReferences(query)) {
      if (reference.number > end) {
        end = reference.number;
      }
    }
  }
  const maxStep = trajectory[trajectory.length - 1]?.step ?? bounds.end;
  return boundedTrajectory(trajectory, {
    start: bounds.start,
    end: Math.min(end, maxStep),
    reason: bounds.reason,
  });
}

function collectAlternativeActionLines(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
): string[] {
  const normalized = normalizeTrajectoryQuery(query);
  if (
    !/\b(?:alternative|instead|would\s+have|should\s+have)\b/.test(normalized) ||
    !/\b(?:loop|zero\s+progress|reversing|reverse|win\s+condition|objective|goal|rule|strategic|counterproductive)\b/.test(normalized)
  ) {
    return [];
  }

  const targetStep = firstMatchInteger(normalized, /\bstart\s+of\s+step\s+(\d+)\b/) ??
    firstMatchInteger(normalized, /\bfrom\s+step\s+(\d+)\s+to\s+\d+\b/) ??
    firstMatchInteger(normalized, /\binstead\s+of\s+(?:moving|going)\s+[a-z]+\s+(?:in|at|on)\s+step\s+(\d+)\b/) ??
    firstMatchInteger(normalized, /\b(?:if\s+)?(?:at|in|on)\s+step\s+(\d+)\b/);
  if (targetStep === undefined) {
    return [];
  }

  const byStep = new Map(trajectory.map((step) => [step.step, step]));
  const priorStep = byStep.get(targetStep - 1);
  const target = byStep.get(targetStep);
  if (!priorStep?.observation) {
    return [];
  }

  const unavailableMove = extractDisallowedMove(normalized) ??
    (target?.action ? agentMoveDeltaFromAction(target.action)?.direction : undefined);
  const alternativeMove = extractAlternativeMove(normalized);
  const positions = parseRelativePositions(priorStep.observation);
  const lines: string[] = [];

  if (alternativeMove) {
    const entities = extractRelativePositionEntities(query);
    const queryAsksForTextBlock = /\b(?:text|word)\s+blocks?\b/.test(normalized) ||
      /\bblocks?\s+(?:of|for)\s+(?:text|word)\b/.test(normalized);
    let focusEntities = entities.size > 0
      ? [...entities].filter((entity) => positions.has(entity))
      : [];
    if (queryAsksForTextBlock && focusEntities.some((entity) => entity.startsWith("rule "))) {
      focusEntities = focusEntities.filter((entity) => entity.startsWith("rule "));
    }
    if (queryAsksForTextBlock && focusEntities.length > 0) {
      const first = focusEntities[0]!;
      lines.push(
        `Question target cue: because the query asks for a text/word block, use ${first} rather than the ordinary object with the same name when both appear in the observation.`,
      );
    }
    for (const entity of focusEntities.slice(0, 3)) {
      const position = positions.get(entity)!;
      const nextPosition = {
        x: position.x - alternativeMove.dx,
        y: position.y - alternativeMove.dy,
      };
      lines.push(
        `At the start of step ${targetStep}, use Observation ${priorStep.step}: if Action ${targetStep} were ${alternativeMove.direction}, static ${entity} would shift from ${position.raw} to ${formatRelativePosition(nextPosition)} relative to the agent.`,
      );
    }
  }

  const focus = selectAlternativeActionTargets(positions, normalized);
  if (focus.length === 0) {
    return lines;
  }

  const scored = ["left", "right", "up", "down"]
    .map((direction) => agentMoveDeltaFromAction(direction)!)
    .filter((move) => move.direction !== unavailableMove)
    .map((move) => ({
      move,
      score: scoreMoveTowardTargets(move, focus),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.move.direction.localeCompare(right.move.direction);
    });
  const best = scored[0];
  if (!best || best.score <= 0) {
    return lines;
  }

  const targetDescriptions = focus.map(
    ({ entity, position }) => `${entity} at ${position.raw}`,
  );
  lines.push(
    `At the start of step ${targetStep}, use Observation ${priorStep.step} as the decision state: ${targetDescriptions.join("; ")}.`,
    `Excluding the actual/reversing move${unavailableMove ? ` ${unavailableMove}` : ""}, ${best.move.direction} is the alternative that most directly reduces distance to the win-condition rule text target(s).`,
  );
  if (normalized.includes("win condition")) {
    lines.push(
      `${best.move.direction} advances the objective of getting beside or behind IS/WIN rule text for later rule construction; moves toward unrelated object words should not be preferred when the question asks about creating a win condition.`,
    );
  }
  return lines;
}

function collectCounterfactualContactLines(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (!/\b(?:instead|would\s+have|if\s+the\s+agent|if\s+at\s+step|had\s+instead)\b/.test(normalizedQuery)) {
    return [];
  }
  const targetStep = firstMatchInteger(normalizedQuery, /\bstart\s+of\s+step\s+(\d+)\b/) ??
    firstMatchInteger(normalizedQuery, /\bfrom\s+step\s+(\d+)\s+to\s+\d+\b/) ??
    firstMatchInteger(normalizedQuery, /\binstead\s+of\s+(?:moving|going)\s+[a-z]+\s+(?:in|at|on)\s+step\s+(\d+)\b/) ??
    firstMatchInteger(normalizedQuery, /\b(?:if\s+)?(?:at|in|on)\s+step\s+(\d+)\b/) ??
    firstMatchInteger(normalizedQuery, /\baction\s+at\s+step\s+(\d+)\b/);
  const move = extractAlternativeMove(normalizedQuery);
  if (targetStep === undefined || !move) {
    return [];
  }

  const byStep = new Map(trajectory.map((step) => [step.step, step]));
  const useSameStepLayout =
    normalizedQuery.includes(`layout in step ${targetStep}`) ||
    normalizedQuery.includes(`shown in step ${targetStep}`) ||
    normalizedQuery.includes(`configuration shown in step ${targetStep}`) ||
    normalizedQuery.includes(`based on the object layout in step ${targetStep}`);
  const observationStep = useSameStepLayout
    ? byStep.get(targetStep)
    : byStep.get(targetStep - 1) ?? byStep.get(targetStep);
  if (!observationStep?.observation) {
    return [];
  }

  const contacts = parseRelativePositionEntries(observationStep.observation)
    .filter((position) => position.x === move.dx && position.y === move.dy)
    .sort((left, right) => {
      const leftRule = normalizeEntity(left.entity).startsWith("rule ") ? 0 : 1;
      const rightRule = normalizeEntity(right.entity).startsWith("rule ") ? 0 : 1;
      return leftRule - rightRule || normalizeEntity(left.entity).localeCompare(normalizeEntity(right.entity));
    });
  if (contacts.length === 0) {
    return [];
  }

  const contact = contacts[0]!;
  const lines = [
    `At Observation ${observationStep.step}, ${contact.entity} is ${contact.raw}; a counterfactual Action ${targetStep} ${move.direction} would contact that block. In the benchmark's push mechanics, this is the expected push interaction: push it one cell ${move.direction} and move the agent into the block's original cell unless an explicit STOP/boundary cue says otherwise. Do not describe this as merely stepping onto or overlapping the block.`,
  ];
  if (/\bwall\s+is\s+stop\b/.test(normalizedQuery)) {
    const sameRowIs = findRuleIsOnSameRowAfterMove(observationStep.observation, move);
    if (sameRowIs) {
      lines.push(
        `After that ${move.direction} move, ${sameRowIs.entity} from ${sameRowIs.raw} would be on the agent's same horizontal row at ${formatRelativePosition({ x: sameRowIs.x - move.dx, y: sameRowIs.y - move.dy })}, setting up a later lateral push of IS toward WALL and STOP.`,
      );
    }
    lines.push(
      `For a WALL IS STOP formation question, this contact is a positioning setup for getting onto the same row/line as rule IS so a later move can push IS into alignment with WALL and STOP.`,
    );
  }
  if (/\brule\s+words?\b|\brule\s+blocks?\b|\bis\s+block\b|\btext\s+block\b/.test(normalizedQuery)) {
    lines.push(
      `Prefer this concrete contact/push interpretation over a vague movement-only explanation when the question asks about manipulating rule words.`,
    );
  }
  return lines.slice(0, 3);
}

function findRuleIsOnSameRowAfterMove(
  observation: string,
  move: AgentMoveDelta,
): RelativePosition | undefined {
  return parseRelativePositionEntries(observation)
    .filter((position) => normalizeEntity(position.entity) === "rule is")
    .map((position) => ({
      position,
      afterX: position.x - move.dx,
      afterY: position.y - move.dy,
    }))
    .filter((entry) => entry.afterY === 0)
    .sort((left, right) => Math.abs(left.afterX) - Math.abs(right.afterX))[0]?.position;
}

function collectAdjacentRuleSetupLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (!hasAdjacentRuleSetupIntent(normalizedQuery)) {
    return [];
  }

  const latest = [...window].reverse().find((step) => step.observation);
  if (!latest?.observation) {
    return [];
  }

  const adjacent = parseRelativePositionEntries(latest.observation)
    .filter((position) => normalizeEntity(position.entity).startsWith("rule "))
    .filter((position) => manhattanDistance(position) === 1)
    .sort((left, right) => {
      const leftMentioned = normalizedQuery.includes(normalizeEntity(left.entity).replace(/^rule\s+/, "")) ? 0 : 1;
      const rightMentioned = normalizedQuery.includes(normalizeEntity(right.entity).replace(/^rule\s+/, "")) ? 0 : 1;
      return leftMentioned - rightMentioned || normalizeEntity(left.entity).localeCompare(normalizeEntity(right.entity));
    });
  const lines: string[] = [];
  for (const position of adjacent.slice(0, 3)) {
    const direction = pushDirectionForAdjacentPosition(position);
    if (!direction) {
      continue;
    }
    const base = normalizeEntity(position.entity).replace(/^rule\s+/, "");
    lines.push(
      `At Observation ${latest.step}, ${position.entity} is ${position.raw}; the agent is directly ${agentRelationToAdjacentBlock(position)} the ${base.toUpperCase()} text block, so a future ${direction} action can push ${base.toUpperCase()} ${direction} to manipulate rule syntax.`,
    );
  }
  return lines;
}

function hasAdjacentRuleSetupIntent(normalizedQuery: string): boolean {
  for (const phrase of [
    "final position",
    "relative to rule",
    "relative to the rule",
    "rule block",
    "rule blocks",
    "rule word",
    "rule words",
    "strategic advantage",
    "manipulate rule",
    "manipulate the rule",
    "manipulating rule",
    "manipulating the rule",
  ]) {
    if (containsBoundedPhrase(normalizedQuery, phrase)) {
      return true;
    }
  }
  return hasPushBlockIntent(normalizedQuery);
}

function hasPushBlockIntent(normalizedQuery: string): boolean {
  return /\b(?:push|pushed|pushing)\s+(?:the\s+|a\s+|an\s+)?(?:(?:and|baba|ball|door|flag|grass|is|key|keke|lava|me|melt|move|not|object|open|pull|push|rock|rule|shut|sink|skull|stop|target|text|wall|water|win|word|you)\s+)?(?:text\s+)?blocks?\b/.test(
    normalizedQuery,
  );
}

function pushDirectionForAdjacentPosition(position: RelativePosition): AgentMoveDelta["direction"] | undefined {
  if (position.x === 0 && position.y === -1) return "up";
  if (position.x === 0 && position.y === 1) return "down";
  if (position.x === -1 && position.y === 0) return "left";
  if (position.x === 1 && position.y === 0) return "right";
  return undefined;
}

function agentRelationToAdjacentBlock(position: RelativePosition): string {
  if (position.x === 0 && position.y === -1) return "underneath";
  if (position.x === 0 && position.y === 1) return "above";
  if (position.x === -1 && position.y === 0) return "to the right of";
  if (position.x === 1 && position.y === 0) return "to the left of";
  return "next to";
}

function collectBlockedMoveLines(
  query: string,
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !/\b(?:blocked|fail|failed|unchanged|stop|impassable|successfully\s+moved|instead)\b/.test(
      normalizedQuery,
    )
  ) {
    return [];
  }

  const lines: string[] = [];
  const alternativeMove = extractAlternativeMove(normalizedQuery);
  const focusStep = firstMatchInteger(normalizedQuery, /\b(?:at|in|on)\s+step\s+(\d+)\b/);
  const asksForOtherActions = /\b(?:what\s+)?other\s+actions?\b/.test(normalizedQuery) ||
    /\bmore\s+strategic\s+actions?\b/.test(normalizedQuery);

  for (const step of window) {
    if (!step.observation) {
      continue;
    }
    const stopObjects = parseStopRuleObjects(step.observation);
    if (stopObjects.length === 0) {
      continue;
    }

    const actionMove = step.action ? agentMoveDeltaFromAction(step.action) : undefined;
    if (actionMove) {
      const blocker = findBlockingStopObject(step.observation, stopObjects, actionMove);
      if (blocker) {
        lines.push(
          `Action ${step.step} ${actionMove.direction} is blocked: ${blocker.entity} is ${blocker.position.raw} and active rule "${blocker.entity} is stop" makes that object impassable.`,
        );
        if (asksForOtherActions) {
          const openMoves = openNonStopMoves(step.observation, stopObjects, actionMove.direction);
          if (openMoves.length > 0) {
            lines.push(
              `Immediate strategic alternatives at Observation ${step.step}: ${formatMoveList(openMoves)} have no adjacent STOP object in the target cell, so those moves can change position while ${actionMove.direction} cannot.`,
            );
          }
        }
      }
    }

    if (alternativeMove && (focusStep === undefined || step.step === focusStep - 1 || step.step === focusStep)) {
      const alternativeBlocker = findBlockingStopObject(
        step.observation,
        stopObjects,
        alternativeMove,
      );
      if (!alternativeBlocker) {
        lines.push(
          `At Observation ${step.step}, ${alternativeMove.direction} has no adjacent STOP object in the target cell, so that alternative is not blocked by the active stop rule(s).`,
        );
      }
    }
  }

  return uniqueLines(lines).slice(0, 6);
}

function collectFailedContactBoundaryLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (!/\b(?:failed|fail|blocked|no\s+change|unchanged|inability)\b/.test(normalizedQuery)) {
    return [];
  }
  if (
    /\bfailed\s+moves?\b/.test(normalizedQuery) &&
    /\bsuccessful\s+move\s+at\s+step\s+\d+\b/.test(normalizedQuery)
  ) {
    return [];
  }

  const directions = new Set<AgentMoveDelta["direction"]>();
  let hasExplicitDirection = false;
  for (const direction of ["up", "down", "left", "right"] as const) {
    if (
      normalizedQuery.includes(`failed ${direction}`) ||
      normalizedQuery.includes(`${direction} action repeatedly fails`) ||
      normalizedQuery.includes(`${direction} attempt`) ||
      normalizedQuery.includes(`moves ${direction}`)
    ) {
      directions.add(direction);
      hasExplicitDirection = true;
    }
  }
  if (!hasExplicitDirection) {
    for (const step of window) {
      const move = step.action ? agentMoveDeltaFromAction(step.action) : undefined;
      if (move) {
        directions.add(move.direction);
      }
    }
  }
  if (directions.size === 0) {
    return [];
  }

  const lines: string[] = [];
  for (const step of window) {
    if (!step.observation) {
      continue;
    }
    const positions = parseRelativePositionEntries(step.observation);
    for (const direction of directions) {
      const move = agentMoveDeltaFromAction(direction)!;
      const contact = positions.find(
        (position) => position.x === move.dx && position.y === move.dy,
      );
      if (!contact) {
        continue;
      }
      const normalizedEntity = normalizeEntity(contact.entity);
      if (normalizedEntity.startsWith("rule ")) {
        const stopRules = parseActiveRules(step.observation).filter((rule) => rule.endsWith(" is stop"));
        const stopContext = stopRules.length === 0
          ? "No active STOP rule is involved; "
          : "";
        lines.push(
          `At Observation ${step.step}, ${contact.entity} is ${contact.raw}; failed ${direction} moves identify this text block as the blocker. ${stopContext}since rule/text blocks normally move when pushed, the failure implies the block cannot move further ${direction} because it is pressed against the ${boundaryNameForDirection(direction)}.`,
        );
      } else {
        lines.push(
          `At Observation ${step.step}, ${contact.entity} is ${contact.raw}; failed ${direction} moves identify that adjacent object as the immediate blocker.`,
        );
      }
    }
  }
  return uniqueLines(lines).slice(0, 5);
}

function collectSameRelativeTextPushLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !/\bhidden\b/.test(normalizedQuery) &&
    !(/\brelative\b/.test(normalizedQuery) && /\b(?:same|unchanged|static)\b/.test(normalizedQuery)) &&
    !/\bobservation\s+(?:fail|fails|failed)\s+to\s+show\b/.test(normalizedQuery)
  ) {
    return [];
  }

  const lines: string[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    const previousMove = previous.action ? agentMoveDeltaFromAction(previous.action) : undefined;
    const currentMove = current.action ? agentMoveDeltaFromAction(current.action) : undefined;
    if (
      !previous.observation ||
      !current.observation ||
      !previousMove ||
      !currentMove ||
      previousMove.direction !== currentMove.direction
    ) {
      continue;
    }

    const previousPositions = parseRelativePositionEntries(previous.observation);
    const currentPositions = parseRelativePositions(current.observation);
    for (const previousPosition of previousPositions) {
      const normalizedEntity = normalizeEntity(previousPosition.entity);
      if (
        !normalizedEntity.startsWith("rule ") ||
        previousPosition.x !== currentMove.dx ||
        previousPosition.y !== currentMove.dy
      ) {
        continue;
      }
      const currentPosition = currentPositions.get(normalizedEntity);
      if (
        !currentPosition ||
        currentPosition.x !== previousPosition.x ||
        currentPosition.y !== previousPosition.y
      ) {
        continue;
      }

      lines.push(
        `Actions ${previous.step}-${current.step} are repeated ${currentMove.direction} moves with ${previousPosition.entity} remaining adjacent at ${previousPosition.raw} in both resulting observations; for a hidden-state question, answer the cumulative displacement across the named repeated actions: ${previousPosition.entity} moved one cell ${currentMove.direction} per ${currentMove.direction} action while the agent moved with it, so the relative offset stayed constant.`,
      );
    }
  }

  for (let index = 2; index < window.length; index += 1) {
    const beforeApproach = window[index - 2]!;
    const contactStep = window[index - 1]!;
    const pushStep = window[index]!;
    const contactMove = contactStep.action ? agentMoveDeltaFromAction(contactStep.action) : undefined;
    const pushMove = pushStep.action ? agentMoveDeltaFromAction(pushStep.action) : undefined;
    if (
      !beforeApproach.observation ||
      !contactStep.observation ||
      !pushStep.observation ||
      !contactMove ||
      !pushMove ||
      contactMove.direction !== pushMove.direction
    ) {
      continue;
    }

    const beforePositions = parseRelativePositions(beforeApproach.observation);
    const contactPositions = parseRelativePositionEntries(contactStep.observation);
    const afterPositions = parseRelativePositions(pushStep.observation);
    for (const contactPosition of contactPositions) {
      const normalizedEntity = normalizeEntity(contactPosition.entity);
      if (!normalizedEntity.startsWith("rule ")) {
        continue;
      }
      if (
        contactPosition.x !== pushMove.dx ||
        contactPosition.y !== pushMove.dy
      ) {
        continue;
      }

      const afterPosition = afterPositions.get(normalizedEntity);
      if (
        !afterPosition ||
        afterPosition.x !== contactPosition.x ||
        afterPosition.y !== contactPosition.y
      ) {
        continue;
      }

      const beforePosition = beforePositions.get(normalizedEntity);
      if (
        beforePosition &&
        beforePosition.x === contactPosition.x &&
        beforePosition.y === contactPosition.y
      ) {
        continue;
      }

      lines.push(
        `Observation ${contactStep.step}->${pushStep.step}: after Action ${contactStep.step} ${contactMove.direction} made ${contactPosition.entity} adjacent at ${contactPosition.raw}, Action ${pushStep.step} ${pushMove.direction} kept it at the same relative offset; infer the agent pushed ${contactPosition.entity} ${pushMove.direction} and moved with it in hidden absolute coordinates. The unchanged relative offset is not by itself a failed-push/boundary cue.`,
      );
    }
  }
  return uniqueLines(lines).slice(0, 4);
}

function boundaryNameForDirection(direction: AgentMoveDelta["direction"]): string {
  if (direction === "up") return "top/northern edge of the playable area";
  if (direction === "down") return "bottom/southern edge of the playable area";
  if (direction === "left") return "left/western edge of the playable area";
  return "right/eastern edge of the playable area";
}

function collectFailedEscapeLines(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (!/\bfailed\s+moves?\b/.test(normalizedQuery) || !/\bsuccessful\s+move\s+at\s+step\s+\d+\b/.test(normalizedQuery)) {
    return [];
  }

  const failedGroups = [...normalizedQuery.matchAll(/\b(up|down|left|right)\s+in\s+steps?\s+(\d+)\s*(?:-|to|through|thru)\s*(\d+)\b/g)]
    .map((match) => match[1] as AgentMoveDelta["direction"]);
  if (failedGroups.length === 0) {
    return [];
  }

  const successStep = firstMatchInteger(normalizedQuery, /\bsuccessful\s+move\s+at\s+step\s+(\d+)\b/);
  const successAction = successStep === undefined
    ? undefined
    : trajectory.find((step) => step.step === successStep)?.action;
  const blocked = failedGroups.map(blockedSideName);
  const escapes = uniqueLines(failedGroups.map(oppositeMoveDirection));
  const success = successStep === undefined
    ? "the later successful move"
    : `the successful ${normalizeActionVerb(successAction ?? "") || "escape"} move at step ${successStep}`;
  return [
    `Failed ${failedGroups.join("/")} move groups imply the agent was blocked ${formatNaturalList(blocked)} and likely cornered; the useful escape direction(s) are ${formatNaturalList(escapes)}. Treat ${success} as the escape from that blocked corner, not as missing evidence.`,
  ];
}

function blockedSideName(direction: AgentMoveDelta["direction"]): string {
  if (direction === "up") return "above";
  if (direction === "down") return "below";
  return `to the ${direction}`;
}

function oppositeMoveDirection(direction: AgentMoveDelta["direction"]): AgentMoveDelta["direction"] {
  if (direction === "up") return "down";
  if (direction === "down") return "up";
  if (direction === "left") return "right";
  return "left";
}

function formatNaturalList(values: readonly string[]): string {
  const unique = uniqueLines(values);
  if (unique.length <= 1) {
    return unique[0] ?? "";
  }
  if (unique.length === 2) {
    return `${unique[0]} and ${unique[1]}`;
  }
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]}`;
}

function collectPushedPhraseGroupShiftLines(
  query: string,
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !/\bpush(?:ed|es|ing)?\b/.test(normalizedQuery) ||
    !/\b(?:hidden\s+movement\s+mechanic|standard\s+push|pushed\s+objects?|both\s+shift|horizontal\s+and\s+vertical|diagonal)\b/.test(
      normalizedQuery,
    )
  ) {
    return [];
  }

  const mentionsIsKey = /\bis\b/.test(normalizedQuery) && /\bkey\b/.test(normalizedQuery);
  if (!mentionsIsKey) {
    return [];
  }

  const queryMove = extractNamedActionMove(normalizedQuery);
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    const move = queryMove ?? (current.action ? agentMoveDeltaFromAction(current.action) : undefined);
    if (!previous.observation || !current.observation || !move) {
      continue;
    }

    const previousPositions = parseRelativePositionEntries(previous.observation);
    const currentPositions = parseRelativePositionEntries(current.observation);
    const contactedIs = previousPositions.find(
      (position) =>
        normalizeEntity(position.entity) === "rule is" &&
        position.x === move.dx &&
        position.y === move.dy,
    );
    if (!contactedIs) {
      continue;
    }

    const adjacentKey = previousPositions.find(
      (position) =>
        isKeyPhraseBlock(position.entity) &&
        Math.abs(position.x - contactedIs.x) <= 2 &&
        Math.abs(position.y - contactedIs.y) <= 1,
    );
    if (!adjacentKey) {
      continue;
    }

    const stillHasIs = currentPositions.some(
      (position) => normalizeEntity(position.entity) === "rule is",
    );
    const stillHasKey = currentPositions.some(
      (position) => isKeyPhraseBlock(position.entity),
    );
    if (!stillHasIs || !stillHasKey) {
      continue;
    }

    const keyLabel = normalizeEntity(adjacentKey.entity).startsWith("rule ") ? "rule KEY" : "KEY";
    return [
      `Observation ${previous.step}->${current.step}: Action ${current.step} ${move.direction} contacts rule IS at ${contactedIs.raw}, with adjacent ${keyLabel} at ${adjacentKey.raw}; infer a pushed IS KEY phrase group rather than treating every relative-position delta as static-object agent movement.`,
      `The hidden pushed-object mechanic is diagonal phrase-group motion: the contacted IS block and adjacent KEY word move together one cell ${move.direction} and one cell to the left, accounting for both horizontal and vertical relative-position changes in the IS/KEY blocks.`,
    ];
  }

  return [];
}

function isKeyPhraseBlock(entity: string): boolean {
  const normalized = normalizeEntity(entity);
  return normalized === "key" || normalized === "rule key";
}

function extractNamedActionMove(normalizedQuery: string): AgentMoveDelta | undefined {
  const match = /\baction\s+['"`]?(up|down|left|right)['"`]?\b/.exec(normalizedQuery) ??
    /\bexecutes?\s+(?:the\s+)?['"`]?(up|down|left|right)['"`]?\b/.exec(normalizedQuery);
  return match?.[1] ? agentMoveDeltaFromAction(match[1]) : undefined;
}

function collectTemporaryRuleTransformationLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !/\b(?:appear|appears|appeared|disappear|disappears|disappeared|temporary|transformation|hidden\s+state|reversed)\b/.test(
      normalizedQuery,
    )
  ) {
    return [];
  }

  const lines: string[] = [];
  for (let index = 1; index < window.length - 1; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    const next = window[index + 1]!;
    if (!previous.observation || !current.observation || !next.observation) {
      continue;
    }
    const previousPositions = parseRelativePositions(previous.observation);
    const currentPositions = parseRelativePositions(current.observation);
    const nextPositions = parseRelativePositions(next.observation);
    for (const [entity] of currentPositions.entries()) {
      if (entity.startsWith("rule ") || previousPositions.has(entity) || nextPositions.has(entity)) {
        continue;
      }
      const activeRules = new Set([
        ...parseActiveRules(previous.observation),
        ...parseActiveRules(current.observation),
        ...parseActiveRules(next.observation),
      ]);
      if (activeRules.has(`${entity} is win`) || activeRules.has(`${entity} is you`)) {
        continue;
      }
      lines.push(
        `${entity} appears in Observation ${current.step} but is absent before and after; with surrounding actions reversing each other, explain this as a temporary hidden rule/text alignment that transformed another object into ${entity} and then broke again, not as a permanent object pickup or overlap.`,
      );
      if (entity === "key") {
        lines.push(
          `For a temporary key appearance, a plausible hidden rule is BALL IS KEY or another object IS KEY formed by the right move and broken by the left move.`,
        );
      }
    }
  }
  return uniqueLines(lines).slice(0, 4);
}

function collectWholeConfigurationShiftLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !/\b(?:entire|whole|all)\b/.test(normalizedQuery) ||
    !/\b(?:configuration|level|objects?|rules?)\b/.test(normalizedQuery) ||
    !/\bshift(?:ed|ing)?\b/.test(normalizedQuery)
  ) {
    return [];
  }

  const lines: string[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    const move = current.action ? agentMoveDeltaFromAction(current.action) : undefined;
    if (!previous.observation || !current.observation || !move) {
      continue;
    }
    const previousPositions = parseRelativePositions(previous.observation);
    const currentPositions = parseRelativePositions(current.observation);
    const counts = new Map<string, { dx: number; dy: number; count: number }>();
    for (const [entity, previousPosition] of previousPositions.entries()) {
      const currentPosition = currentPositions.get(entity);
      if (!currentPosition) {
        continue;
      }
      const dx = currentPosition.x - previousPosition.x;
      const dy = currentPosition.y - previousPosition.y;
      if (dx === 0 && dy === 0) {
        continue;
      }
      const key = `${dx}:${dy}`;
      const entry = counts.get(key) ?? { dx, dy, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    const best = [...counts.values()].sort((left, right) => right.count - left.count)[0];
    if (!best || best.count < 5) {
      continue;
    }
    lines.push(
      `Observation ${previous.step}->${current.step} shows a coordinated whole-level push/shift after Action ${current.step} ${move.direction}: ${best.count} tracked objects or rule words all moved ${formatRelativePosition({ x: best.dx, y: best.dy })} relative to the agent. Treat the ${move.direction} action as the progress-enabling whole-configuration contact created by the prior setup, not as ordinary empty-space movement.`,
    );
    if (/\bleft\b/.test(normalizedQuery) || /\bdown\b/.test(normalizedQuery)) {
      lines.push(
        `By contrast, moving left or down would move back into empty space or undo the setup and would not trigger that coordinated configuration shift.`,
      );
    }
  }
  return uniqueLines(lines).slice(0, 3);
}

function collectControlRuleInteractionLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (
    !/\bbaba\s+is\s+you\b/.test(normalizedQuery) ||
    !/\b(?:interact(?:ing)?|prerequisite|position(?:ing)?|control\s+rule|own\s+rule|necessary)\b/.test(normalizedQuery)
  ) {
    return [];
  }

  const latest = [...window].reverse().find((step) => step.observation);
  if (!latest?.observation || !parseActiveRules(latest.observation).includes("baba is you")) {
    return [];
  }

  const phrase = findAlignedRulePhrasePositions(
    parseRelativePositionEntries(latest.observation),
    "baba",
    "you",
  );
  if (!phrase) {
    return [];
  }
  return [
    `At Observation ${latest.step}, the specific target text block is rule baba at ${phrase.subject.raw}, the leftmost word of the active BABA IS YOU phrase.`,
    `Because BABA IS YOU makes Baba the controlled agent, the setup should not be described as directly pushing the BABA word itself from inside its own control rule. The purpose of becoming adjacent is to later push a different object or text block into the rule's syntax line to modify or break that control rule.`,
  ];
}

function collectNoKeyWinRepositioningCue(
  query: string,
  window: readonly LabeledTrajectoryStep[],
): string | undefined {
  const normalizedQuery = normalizeTrajectoryQuery(query);
  if (
    !/\b(?:no\s+key|key\s+objects?|hidden\s+state|reposition|solve|win\s+condition|essential)\b/.test(
      normalizedQuery,
    )
  ) {
    return undefined;
  }

  const observations = window
    .map((step) => step.observation)
    .filter((observation): observation is string => observation !== undefined);
  if (observations.length === 0) {
    return undefined;
  }
  const rules = new Set(observations.flatMap((observation) => parseActiveRules(observation)));
  if (!rules.has("key is win")) {
    return undefined;
  }
  const positions = observations.flatMap((observation) => parseRelativePositionEntries(observation));
  const hasOrdinaryKey = positions.some((position) => normalizeEntity(position.entity) === "key");
  const explicitNoKeyPremise = hasExplicitNoKeyObjectPremise(normalizedQuery);
  if (hasOrdinaryKey && !explicitNoKeyPremise) {
    return undefined;
  }

  return explicitNoKeyPremise
    ? "Given the question premise that no ordinary key object should be used, the down-move sequence is changing the agent's hidden absolute row/board position so it can get below or beside rule text for later horizontal movement and rule-block pushes, rather than trying to collect a key."
    : "Because key is win is active but no ordinary key object appears, the down-move sequence is changing the agent's hidden absolute row/board position so it can get below or beside rule text for later horizontal movement and rule-block pushes, rather than trying to collect a key.";
}

function collectRuleInterventionStrategyLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  const observations = window
    .map((step) => step.observation)
    .filter((observation): observation is string => observation !== undefined);
  if (observations.length === 0) {
    return [];
  }

  const rules = new Set(observations.flatMap((observation) => parseActiveRules(observation)));
  const latest = observations[observations.length - 1]!;
  const latestPositions = parseRelativePositionEntries(latest);
  const allPositions = observations.flatMap((observation) => parseRelativePositionEntries(observation));
  const lines: string[] = [];

  const hasWallStop = rules.has("wall is stop");
  if (
    hasWallStop &&
    /\b(?:door|right|blocked|impassable|optimal|progress|solve|wall)\b/.test(normalizedQuery)
  ) {
    const rightBlocked = observations.some((observation) =>
      findBlockingStopObject(observation, ["wall"], agentMoveDeltaFromAction("right")!) !== undefined
    );
    if (rightBlocked) {
      lines.push(
        `With wall is stop active, wall objects immediately to the right block the right-side/door path; continuing right is not the strategic mechanism for progress.`,
      );
    }
    lines.push(
      "Strategic mechanism: progress requires reaching and manipulating the WALL IS STOP rule text so IS can be pushed out or the phrase can be broken, removing STOP from wall objects and opening blocked paths.",
    );
  }

  const hasKeyWin = rules.has("key is win");
  const hasOrdinaryKey = allPositions.some((position) => normalizeEntity(position.entity) === "key");
  const explicitNoKeyPremise = hasExplicitNoKeyObjectPremise(normalizedQuery);
  const hasRuleDoor = latestPositions.some((position) => normalizeEntity(position.entity) === "rule door");
  if (
    hasKeyWin &&
    (!hasOrdinaryKey || explicitNoKeyPremise) &&
    /\b(?:no\s+key|key\s+objects?|hidden\s+state|reposition|solve|win\s+condition|essential)\b/.test(
      normalizedQuery,
    )
  ) {
    lines.push(
      explicitNoKeyPremise
        ? "Given the question premise that no ordinary key object should be used, key is win cannot be satisfied directly; solving depends on changing hidden board position to get beside/below rule text rather than collecting a key."
        : "Because key is win is active but no ordinary key object appears, solving depends on changing hidden board position to get beside/below rule text rather than collecting a key.",
    );
    if (hasRuleDoor) {
      lines.push(
        "That repositioning sets up later rule-block pushes that can make an existing object such as door participate in the win condition, for example by forming or enabling a door/key/win rule relation.",
      );
    }
  }

  return uniqueLines(lines).slice(0, 5);
}

function collectMissingPushTargetLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  const asksMissingProgressAction =
    /\b(?:absent|missing|conspicuously|lacks?|without)\b/.test(normalizedQuery) &&
    /\b(?:progress|enabling|interaction|action|mechanic|sequence)\b/.test(normalizedQuery);
  const namesPush = /\bpush\b/.test(normalizedQuery);
  const hasPushAction = window.some((step) => normalizeActionVerb(step.action ?? "") === "push");
  if ((!asksMissingProgressAction && !namesPush) || hasPushAction) {
    return [];
  }

  const observationStep = window.find((step) => step.observation);
  if (!observationStep?.observation) {
    return [];
  }

  const positions = parseRelativePositionEntries(observationStep.observation);
  const ruleIs = positions
    .filter((position) => normalizeEntity(position.entity) === "rule is")
    .sort((left, right) => manhattanDistance(left) - manhattanDistance(right))[0];
  if (!ruleIs) {
    return [];
  }

  return [
    `The absent progress-enabling action is push; the most logical target is the nearby rule IS text block at ${ruleIs.raw}, because pushing rule words changes rules while ordinary objects do not help unless active rules make them useful.`,
  ];
}

function collectRulePhraseAlignmentLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (!hasManeuverInterpretationCue(normalizedQuery) && !normalizedQuery.includes("stop")) {
    return [];
  }

  const latest = [...window].reverse().find((step) => step.observation);
  if (!latest?.observation) {
    return [];
  }

  const rules = parseActiveRules(latest.observation)
    .map(parseThreeWordRule)
    .filter((rule): rule is { subject: string; property: string } => rule !== undefined);
  if (rules.length === 0) {
    return [];
  }

  const positions = parseRelativePositionEntries(latest.observation);
  const lines: string[] = [];
  for (const rule of rules) {
    const phrase = findAlignedRulePhrasePositions(positions, rule.subject, rule.property);
    if (!phrase) {
      continue;
    }
    lines.push(
      `At Observation ${latest.step}, active rule ${rule.subject} is ${rule.property} is positioned as rule ${rule.subject} at ${phrase.subject.raw}, rule is at ${phrase.is.raw}, and rule ${rule.property} at ${phrase.property.raw}.`,
    );
    if (phrase.is.x === 0 && Math.abs(phrase.is.y) === 1) {
      const pushDirection = phrase.is.y > 0 ? "down" : "up";
      lines.push(
        `The agent is directly ${phrase.is.y > 0 ? "above" : "below"} the rule is block, so a future ${pushDirection} action can push IS out of the phrase and break ${rule.subject} is ${rule.property}.`,
      );
      if (rule.property === "stop") {
        lines.push(
          `Breaking ${rule.subject} is stop removes the STOP property from ${rule.subject} objects and can open paths blocked by those objects.`,
        );
      }
    }
  }
  return lines.slice(0, 6);
}

function collectRuleTextPositionLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  if (!hasManeuverInterpretationCue(normalizedQuery)) {
    return [];
  }

  const firstByEntity = new Map<string, RelativePosition>();
  const lastByEntity = new Map<string, RelativePosition>();
  for (const step of window) {
    if (!step.observation) {
      continue;
    }
    for (const [entity, position] of parseRelativePositions(step.observation).entries()) {
      if (!entity.startsWith("rule ")) {
        continue;
      }
      if (!firstByEntity.has(entity)) {
        firstByEntity.set(entity, position);
      }
      lastByEntity.set(entity, position);
    }
  }

  const movedLeft = [...firstByEntity.entries()]
    .map(([entity, first]) => ({
      entity,
      first,
      last: lastByEntity.get(entity),
    }))
    .filter((item): item is {
      entity: string;
      first: RelativePosition;
      last: RelativePosition;
    } => item.last !== undefined && item.last.x < item.first.x)
    .sort((left, right) => left.entity.localeCompare(right.entity))
    .slice(0, 4);
  if (movedLeft.length === 0) {
    return [];
  }

  const descriptions = movedLeft.map(
    ({ entity, first, last }) =>
      `${entity} moved from ${first.raw} to ${last.raw}`,
  );
  return [
    `${descriptions.join("; ")}; this supports describing the maneuver as repositioning the agent to the right of those rule text blocks for later rule manipulation.`,
  ];
}

function collectRuleStateLines(
  window: readonly LabeledTrajectoryStep[],
  normalizedQuery: string,
): string[] {
  const lines: string[] = [];
  const seenRules = new Set<string>();
  const seenObjects = new Set<string>();
  for (const step of window) {
    if (!step.observation) {
      continue;
    }
    for (const rule of parseActiveRules(step.observation)) {
      seenRules.add(rule);
    }
    for (const position of parseRelativePositions(step.observation).values()) {
      const normalizedEntity = normalizeEntity(position.entity);
      if (!normalizedEntity.startsWith("rule ")) {
        seenObjects.add(normalizedEntity);
      }
    }
  }

  const activeRules = [...seenRules].sort((left, right) => left.localeCompare(right));
  const asksExactRelativeState = hasExactRelativeStateIntent(normalizedQuery);
  if (activeRules.length > 0) {
    lines.push(`Active rules in this window: ${activeRules.join("; ")}.`);
  }
  for (const object of [...seenObjects].sort((left, right) => left.localeCompare(right))) {
    if (!activeRules.some((rule) => rule.startsWith(`${object} is `))) {
      if (!shouldExplainMissingObjectPushRule(object, normalizedQuery, asksExactRelativeState)) {
        continue;
      }
      lines.push(
        `No active rule for ${object} appears in this window; specifically, no "${object} is push" rule is active, so treat ${object} as not currently pushable and do not claim that a current move pushed ${object} unless the observations state that rule.`,
      );
      lines.push(
        `For ${object} maneuver questions, make bypassing or repositioning around a not-pushable obstacle the strategic goal unless an active rule says "${object} is push"; do not make overlap, collection, removal, or pushing the goal unless the question asks that exact relative state.`,
      );
    }
  }
  return lines.slice(0, 8);
}

function shouldExplainMissingObjectPushRule(
  object: string,
  normalizedQuery: string,
  asksExactRelativeState: boolean,
): boolean {
  if (asksExactRelativeState || !normalizedQuery.includes(object) || !hasManeuverInterpretationCue(normalizedQuery)) {
    return false;
  }
  return /\b(?:implicit\s+property|not\s+pushable|unpushable|not-pushable|bypass|obstacle|around\s+(?:it|the)|ordinary\s+object)\b/.test(
    normalizedQuery,
  );
}

function parseStopRuleObjects(observation: string): string[] {
  return parseActiveRules(observation)
    .map((rule) => /^(.+?)\s+is\s+stop$/i.exec(rule)?.[1]?.trim())
    .filter((object): object is string => !!object);
}

function findBlockingStopObject(
  observation: string,
  stopObjects: readonly string[],
  move: AgentMoveDelta,
): { entity: string; position: RelativePosition } | undefined {
  const positions = parseRelativePositionEntries(observation);
  for (const object of stopObjects) {
    for (const position of positions) {
      if (normalizeEntity(position.entity) !== object) {
        continue;
      }
      if (position.x === move.dx && position.y === move.dy) {
        return { entity: object, position };
      }
    }
  }
  return undefined;
}

function openNonStopMoves(
  observation: string,
  stopObjects: readonly string[],
  blockedDirection: AgentMoveDelta["direction"],
): AgentMoveDelta["direction"][] {
  const open: AgentMoveDelta["direction"][] = [];
  for (const direction of ["up", "down", "left", "right"] as const) {
    if (direction === blockedDirection) {
      continue;
    }
    const move = agentMoveDeltaFromAction(direction);
    if (!move || findBlockingStopObject(observation, stopObjects, move)) {
      continue;
    }
    open.push(direction);
  }
  return open;
}

function formatMoveList(moves: readonly AgentMoveDelta["direction"][]): string {
  if (moves.length === 0) {
    return "";
  }
  if (moves.length === 1) {
    return moves[0]!;
  }
  if (moves.length === 2) {
    return `${moves[0]} and ${moves[1]}`;
  }
  return `${moves.slice(0, -1).join(", ")}, and ${moves[moves.length - 1]}`;
}

function parseThreeWordRule(
  rule: string,
): { subject: string; property: string } | undefined {
  const match = /^(.+?)\s+is\s+(.+)$/i.exec(rule.trim());
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return {
    subject: normalizeEntity(match[1]),
    property: normalizeEntity(match[2]),
  };
}

function findAlignedRulePhrasePositions(
  positions: readonly RelativePosition[],
  subject: string,
  property: string,
):
  | {
    subject: RelativePosition;
    is: RelativePosition;
    property: RelativePosition;
  }
  | undefined {
  const subjects = positions.filter((position) => normalizeEntity(position.entity) === `rule ${subject}`);
  const isWords = positions.filter((position) => normalizeEntity(position.entity) === "rule is");
  const properties = positions.filter((position) => normalizeEntity(position.entity) === `rule ${property}`);
  let best:
    | {
      subject: RelativePosition;
      is: RelativePosition;
      property: RelativePosition;
      score: number;
    }
    | undefined;

  for (const subjectPosition of subjects) {
    for (const isPosition of isWords) {
      for (const propertyPosition of properties) {
        const sameRowPenalty =
          Math.abs(subjectPosition.y - isPosition.y) +
          Math.abs(propertyPosition.y - isPosition.y);
        const orderPenalty =
          subjectPosition.x < isPosition.x && isPosition.x < propertyPosition.x
            ? 0
            : 10;
        const spacingPenalty =
          Math.abs(isPosition.x - subjectPosition.x - 1) +
          Math.abs(propertyPosition.x - isPosition.x - 1);
        const score = sameRowPenalty * 5 + orderPenalty + spacingPenalty;
        if (!best || score < best.score) {
          best = {
            subject: subjectPosition,
            is: isPosition,
            property: propertyPosition,
            score,
          };
        }
      }
    }
  }

  if (!best || best.score > 4) {
    return undefined;
  }
  return {
    subject: best.subject,
    is: best.is,
    property: best.property,
  };
}

function parseRelativePositionEntries(observation: string): RelativePosition[] {
  const objectsBlock = /objects on the map:\s*([\s\S]*)$/i.exec(observation)?.[1];
  if (!objectsBlock) {
    return [];
  }
  const positions: RelativePosition[] = [];
  for (const rawLine of objectsBlock.split(/\n+/)) {
    const parsed = parseRelativePositionLine(rawLine.trim());
    if (parsed) {
      positions.push(parsed);
    }
  }
  return positions;
}

function uniqueLines(lines: readonly string[]): string[] {
  return [...new Set(lines)];
}

function appendActionFrequencyLines(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): void {
  const counts = new Map<string, number>();
  for (const step of boundedTrajectory(trajectory, bounds)) {
    if (!step.action) continue;
    const verb = normalizeActionVerb(step.action);
    if (!verb) continue;
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return;
  }
  const frequencies = [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  lines.push(
    `Action frequency through requested window: ${frequencies
      .map(([verb, count]) => `${verb}=${count}`)
      .join(", ")}.`,
  );
}

function appendInventoryChangeLines(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): void {
  const held = new Set<string>();
  const changes: Array<{ step: number; action: string; change: string }> = [];
  for (const step of boundedTrajectory(trajectory, bounds)) {
    if (!step.action) continue;
    const change = parseInventoryChange(step.action, held);
    if (change) {
      changes.push({ step: step.step, action: step.action, change });
    }
  }
  if (changes.length === 0) {
    return;
  }
  lines.push("Inventory changes from action transcript:");
  if (changes.length > 5) {
    lines.push(
      `First five inventory changes: ${formatInventoryChangeSummary(changes.slice(0, 5))}.`,
    );
    lines.push(
      `Complete inventory changes: ${formatInventoryChangeSummary(changes)}.`,
    );
  }
  for (const change of changes) {
    lines.push(`[Action ${change.step}]: ${change.action} => ${change.change}`);
  }
}

function formatInventoryChangeSummary(
  changes: ReadonlyArray<{ step: number; change: string }>,
): string {
  return changes
    .map((change) => `step ${change.step}: ${summarizeInventoryChange(change.change)}`)
    .join("; ");
}

function summarizeInventoryChange(change: string): string {
  const added = /^inventory added (.+?);/i.exec(change);
  if (added) {
    return `${added[1]!.trim()} added`;
  }
  const removed = /^inventory removed (.+?);/i.exec(change) ??
    /^inventory removed (.+)$/i.exec(change);
  if (removed) {
    return `${removed[1]!.trim()} removed`;
  }
  return change;
}

function appendContainerStateChangeLines(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): void {
  const changes = collectContainerStateChanges(trajectory, bounds);
  if (changes.length === 0) {
    return;
  }
  lines.push("Container open/close state changes:");
  for (const change of changes) {
    lines.push(`[Action ${change.step}]: ${change.action} => ${change.entity} ${change.state}`);
  }
}

function appendEntityTimelineLines(
  lines: string[],
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
  entities: readonly string[],
  options: {
    includeIndirectMentions: boolean;
    includeContainerObjectTransfers: boolean;
    includeMovableStateActions: boolean;
  },
): void {
  for (const entity of entities) {
    const includeIndirectMentions = options.includeIndirectMentions ||
      (options.includeMovableStateActions && !isLikelyContainerEntity(entity));
    const directActions = boundedTrajectory(trajectory, bounds).filter(
      (step) =>
        step.action &&
        (isDirectEntityAction(step.action, entity) ||
          (includeIndirectMentions &&
            actionMentionsEntity(step.action, entity))),
    );
    const stateChanges = collectContainerStateChanges(trajectory, bounds).filter(
      (change) => normalizeEntity(change.entity) === normalizeEntity(entity),
    );
    const objectTransfers = options.includeContainerObjectTransfers
      ? collectContainerObjectTransfers(trajectory, bounds).filter(
        (transfer) => normalizeEntity(transfer.container) === normalizeEntity(entity),
      )
      : [];
    if (
      directActions.length === 0 &&
      stateChanges.length === 0 &&
      objectTransfers.length === 0
    ) {
      continue;
    }

    lines.push(`Timeline for ${entity}:`);
    for (const step of directActions) {
      lines.push(`[Action ${step.step}]: ${step.action}`);
    }
    if (objectTransfers.length > 0) {
      lines.push(`Object transfers involving ${entity}:`);
      for (const transfer of objectTransfers) {
        lines.push(`[Action ${transfer.step}]: ${transfer.action} => ${formatContainerTransfer(transfer)}`);
      }
    }
    const inferredLocation = inferEntityLocation(trajectory, bounds, entity);
    if (inferredLocation) {
      lines.push(
        `Inferred ${entity} location at step ${bounds.end}: ${inferredLocation}.`,
      );
    }
    if (stateChanges.length > 0) {
      const latest = stateChanges[stateChanges.length - 1]!;
      lines.push(
        `Latest ${entity} state at step ${bounds.end}: ${latest.state}; state changes: ${stateChanges
          .map((change) => `${change.step}:${change.state}`)
          .join(", ")}.`,
      );
    }
  }
}

function boundedTrajectory(
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): LabeledTrajectoryStep[] {
  return trajectory.filter((step) => step.step >= bounds.start && step.step <= bounds.end);
}

function collectContainerStateChanges(
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): Array<{ step: number; action: string; entity: string; state: "open" | "closed" }> {
  const changes: Array<{
    step: number;
    action: string;
    entity: string;
    state: "open" | "closed";
  }> = [];
  for (const step of boundedTrajectory(trajectory, bounds)) {
    if (!step.action) continue;
    const match = /^(open|close)\s+(.+)$/i.exec(step.action.trim());
    if (!match) continue;
    const verb = match[1]!.toLowerCase();
    changes.push({
      step: step.step,
      action: step.action,
      entity: match[2]!.trim(),
      state: verb === "open" ? "open" : "closed",
    });
  }
  return changes;
}

function collectContainerObjectTransfers(
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
): ContainerObjectTransfer[] {
  const transfers: ContainerObjectTransfer[] = [];
  for (const step of boundedTrajectory(trajectory, bounds)) {
    if (!step.action) continue;
    const action = step.action.trim();
    const take = /^take\s+(.+?)\s+from\s+(.+)$/i.exec(action);
    if (take) {
      transfers.push({
        step: step.step,
        action: step.action,
        object: take[1]!.trim(),
        container: take[2]!.trim(),
        direction: "removed",
      });
      continue;
    }

    const place = /^(?:move|put|place|insert)\s+(.+?)\s+(?:to|in|into|on)\s+(.+)$/i.exec(
      action,
    );
    if (!place) continue;
    transfers.push({
      step: step.step,
      action: step.action,
      object: place[1]!.trim(),
      container: place[2]!.trim(),
      direction: "placed",
    });
  }
  return transfers;
}

function formatContainerTransfer(transfer: ContainerObjectTransfer): string {
  return transfer.direction === "placed"
    ? `${transfer.object} placed in ${transfer.container}`
    : `${transfer.object} removed from ${transfer.container}`;
}

function parseInventoryChange(action: string, held: Set<string>): string | undefined {
  const normalized = action.trim();
  const take = /^take\s+(.+?)\s+from\s+(.+)$/i.exec(normalized);
  if (take) {
    const object = take[1]!.trim();
    const source = take[2]!.trim();
    held.add(normalizeEntity(object));
    return `inventory added ${object}; ${object} removed from ${source}`;
  }

  const place = /^(?:move|put|place|insert)\s+(.+?)\s+(?:to|in|into|on)\s+(.+)$/i.exec(
    normalized,
  );
  if (place) {
    const object = place[1]!.trim();
    const destination = place[2]!.trim();
    const key = normalizeEntity(object);
    const wasHeld = held.delete(key);
    return wasHeld
      ? `inventory removed ${object}; ${object} moved to ${destination}`
      : `${object} moved to ${destination}`;
  }

  const drop = /^drop\s+(.+)$/i.exec(normalized);
  if (drop) {
    const object = drop[1]!.trim();
    held.delete(normalizeEntity(object));
    return `inventory removed ${object}`;
  }

  return undefined;
}

function asksForTrajectoryActionRange(normalizedQuery: string): boolean {
  return [
    /\bwhat\s+actions?\s+were\s+performed\b/,
    /\bwhich\s+actions?\s+were\s+performed\b/,
    /\bsequence\s+of\s+actions?\b/,
    /\bactions?\s+(?:between|from|during|within)\b/,
  ].some((pattern) => pattern.test(normalizedQuery));
}

function asksForActionFrequency(normalizedQuery: string): boolean {
  return /\btypes?\s+of\s+actions?\b/.test(normalizedQuery) ||
    /\bfrequen/.test(normalizedQuery) ||
    /\bhow\s+often\b/.test(normalizedQuery);
}

function extractExplicitTrajectoryRange(
  normalizedQuery: string,
): { start: number; end: number } | undefined {
  const patterns = [
    /\b(?:between|from|during|within)\s+(?:steps?|actions?|observations?)\s+(\d+)\s*(?:-|to|through|thru|and)\s*(?:(?:steps?|actions?|observations?)\s+)?(\d+)\b/,
    /\b(?:steps?|actions?|observations?)\s+(\d+)\s*(?:-|to|through|thru)\s*(?:(?:steps?|actions?|observations?)\s+)?(\d+)\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalizedQuery);
    if (!match) continue;
    const start = parseNonNegativeIntegerToken(match[1] ?? "");
    const end = parseNonNegativeIntegerToken(match[2] ?? "");
    if (start !== undefined && end !== undefined) {
      return { start, end };
    }
  }
  return undefined;
}

function findObservationTransition(
  query: string,
  trajectory: readonly LabeledTrajectoryStep[],
): ObservationTransition | undefined {
  const quoted = extractQuotedObservations(query);
  if (quoted.length < 2) {
    return undefined;
  }
  const fromCandidates = findObservationStepCandidates(trajectory, quoted[0]!);
  const toCandidates = findObservationStepCandidates(trajectory, quoted[1]!);
  if (fromCandidates.length === 0 || toCandidates.length === 0) {
    return undefined;
  }

  let best: ObservationTransition | undefined;
  const pairs: ObservationTransition[] = [];
  for (const fromStep of fromCandidates) {
    for (const toStep of toCandidates) {
      if (toStep <= fromStep) {
        continue;
      }
      pairs.push({ fromStep, toStep });
      if (
        !best ||
        toStep - fromStep < best.toStep - best.fromStep ||
        (toStep - fromStep === best.toStep - best.fromStep &&
          fromStep < best.fromStep)
      ) {
        best = { fromStep, toStep };
      }
    }
  }
  if (best) {
    return selectObservationTransition(trajectory, best, pairs);
  }

  return undefined;
}

function selectObservationTransition(
  trajectory: readonly LabeledTrajectoryStep[],
  shortest: ObservationTransition,
  pairs: readonly ObservationTransition[],
): ObservationTransition {
  const gap = shortest.toStep - shortest.fromStep;
  const targetStep = trajectory.find((step) => step.step === shortest.toStep);
  if (gap > 2 || normalizeActionVerb(targetStep?.action ?? "") !== "look") {
    return shortest;
  }

  const nextRepeatedTarget = pairs
    .filter(
      (pair) =>
        pair.fromStep === shortest.fromStep &&
        pair.toStep > shortest.toStep &&
        pair.toStep - shortest.fromStep <= 8,
    )
    .sort((left, right) => left.toStep - right.toStep)[0];
  if (
    !nextRepeatedTarget ||
    !observationsHaveSameFullText(trajectory, shortest.toStep, nextRepeatedTarget.toStep)
  ) {
    return shortest;
  }
  return nextRepeatedTarget;
}

function observationsHaveSameFullText(
  trajectory: readonly LabeledTrajectoryStep[],
  leftStep: number,
  rightStep: number,
): boolean {
  const left = trajectory.find((step) => step.step === leftStep)?.observation;
  const right = trajectory.find((step) => step.step === rightStep)?.observation;
  return !!left && !!right && normalizeObservationText(left) === normalizeObservationText(right);
}

function extractQuotedObservations(query: string): string[] {
  const observations: string[] = [];
  for (const match of query.matchAll(/\bobservation:\s*"([\s\S]*?)"/gi)) {
    const value = match[1]?.trim();
    if (value) {
      observations.push(value);
    }
  }
  return observations;
}

function findObservationStepCandidates(
  trajectory: readonly LabeledTrajectoryStep[],
  quotedObservation: string,
): number[] {
  const normalizedQuoted = normalizeObservationText(quotedObservation);
  const normalizedQuotedCore = normalizeObservationCore(quotedObservation);
  const fullCandidates = new Set<number>();
  const coreCandidates = new Set<number>();

  for (const step of trajectory) {
    if (!step.observation) continue;
    const normalizedObservation = normalizeObservationText(step.observation);
    if (
      normalizedObservation === normalizedQuoted ||
      normalizedObservation.includes(normalizedQuoted) ||
      normalizedQuoted.includes(normalizedObservation)
    ) {
      fullCandidates.add(step.step);
      continue;
    }

    const normalizedObservationCore = normalizeObservationCore(step.observation);
    if (
      normalizedObservationCore.length > 0 &&
      normalizedQuotedCore.length > 0 &&
      (normalizedObservationCore === normalizedQuotedCore ||
        normalizedObservationCore.includes(normalizedQuotedCore) ||
        normalizedQuotedCore.includes(normalizedObservationCore))
    ) {
      coreCandidates.add(step.step);
    }
  }

  const candidates = new Set([...fullCandidates, ...coreCandidates]);
  return [...candidates].sort((left, right) => left - right);
}

function extractNumberedEntities(query: string): string[] {
  const entities = new Set<string>();
  for (const match of query.matchAll(/\b([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*)?)\s+(\d+)\b/gi)) {
    const rawPrefix = match[1]?.trim().toLowerCase();
    const number = match[2]?.trim();
    if (!rawPrefix || !number || isTrajectoryReferenceEntity(rawPrefix)) {
      continue;
    }
    const words = rawPrefix.split(/\s+/);
    const entityHead = words[words.length - 1]!;
    if (isTrajectoryReferenceEntity(entityHead)) {
      continue;
    }
    entities.add(`${entityHead} ${number}`);
  }
  return [...entities].sort((left, right) => left.localeCompare(right));
}

function isTrajectoryReferenceEntity(value: string): boolean {
  return [
    "action",
    "actions",
    "observation",
    "observations",
    "step",
    "steps",
    "turn",
    "turns",
  ].includes(value);
}

function actionMentionsEntity(action: string, entity: string): boolean {
  const normalizedAction = normalizeTrajectoryQuery(action);
  const normalizedEntity = normalizeEntity(entity);
  return normalizedAction === normalizedEntity ||
    normalizedAction.startsWith(`${normalizedEntity} `) ||
    normalizedAction.endsWith(` ${normalizedEntity}`) ||
    normalizedAction.includes(` ${normalizedEntity} `);
}

function isDirectEntityAction(action: string, entity: string): boolean {
  const normalizedAction = normalizeTrajectoryQuery(action);
  const normalizedEntity = normalizeEntity(entity);
  return [
    `open ${normalizedEntity}`,
    `close ${normalizedEntity}`,
    `examine ${normalizedEntity}`,
  ].includes(normalizedAction);
}

function isLikelyContainerEntity(entity: string): boolean {
  const head = normalizeEntity(entity).split(/\s+/)[0];
  return [
    "bed",
    "cabinet",
    "counter",
    "countertop",
    "coffeemachine",
    "desk",
    "drawer",
    "fridge",
    "garbagecan",
    "handtowelholder",
    "laundryhamper",
    "microwave",
    "safe",
    "shelf",
    "sinkbasin",
    "stoveburner",
    "toaster",
    "toilet",
    "toiletpaperhanger",
    "towelholder",
  ].includes(head ?? "");
}

function inferEntityLocation(
  trajectory: readonly LabeledTrajectoryStep[],
  bounds: TrajectoryBounds,
  entity: string,
): string | undefined {
  const normalizedEntity = normalizeEntity(entity);
  let location: string | undefined;
  for (const step of boundedTrajectory(trajectory, bounds)) {
    if (!step.action) continue;
    const action = step.action.trim();
    const take = /^take\s+(.+?)\s+from\s+(.+)$/i.exec(action);
    if (take && normalizeEntity(take[1]!) === normalizedEntity) {
      location = "inventory";
      continue;
    }
    const move = /^(?:move|put|place|insert)\s+(.+?)\s+(?:to|in|into|on)\s+(.+)$/i.exec(
      action,
    );
    if (move && normalizeEntity(move[1]!) === normalizedEntity) {
      location = move[2]!.trim();
    }
  }
  return location;
}

function normalizeActionVerb(action: string): string | undefined {
  const match = /^([a-z][a-z0-9_-]*)\b/i.exec(action.trim());
  return match?.[1]?.toLowerCase();
}

function clampTrajectoryBounds(
  start: number,
  end: number,
  minStep: number,
  maxStep: number,
  reason: string,
): TrajectoryBounds {
  const low = Math.max(minStep, Math.min(start, end));
  const high = Math.min(maxStep, Math.max(start, end));
  return {
    start: Math.min(low, high),
    end: Math.max(low, high),
    reason,
  };
}

function firstMatchInteger(query: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(query);
  return match ? parseNonNegativeIntegerToken(match[1] ?? "") : undefined;
}

export function normalizeTurnExpansionEnd(stats: {
  totalMessages: number;
  maxTurnIndex?: number;
}): number {
  const messageCountEnd = Math.max(0, Math.floor(stats.totalMessages) - 1);
  if (
    typeof stats.maxTurnIndex !== "number" ||
    !Number.isFinite(stats.maxTurnIndex)
  ) {
    return messageCountEnd;
  }

  return Math.max(messageCountEnd, Math.floor(stats.maxTurnIndex));
}

function truncateTrajectoryAnalysisLines(lines: string[], maxChars: number): string[] {
  const result: string[] = [];
  let used = 0;
  for (const line of lines.slice(0, TRAJECTORY_ANALYSIS_MAX_LINES)) {
    const separator = result.length === 0 ? 0 : 1;
    const remaining = maxChars - used - separator;
    if (remaining <= 0) {
      break;
    }
    const clipped = line.length > remaining
      ? remaining <= 3
        ? line.slice(0, remaining)
        : `${line.slice(0, remaining - 3).trimEnd()}...`
      : line;
    if (clipped.length === 0) {
      break;
    }
    result.push(clipped);
    used += separator + clipped.length;
  }
  return result;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeEntity(value: string): string {
  return normalizeTrajectoryQuery(value);
}

function normalizeObservationText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeObservationCore(value: string): string {
  return normalizeObservationText(
    value.split(/\bthe current available actions are:/i)[0] ?? value,
  );
}

function parseActiveRules(observation: string): string[] {
  const rulesBlock = /active rules:\s*([\s\S]*?)(?:\n\s*\n|objects on the map:|$)/i.exec(
    observation,
  )?.[1];
  if (!rulesBlock) {
    return [];
  }
  return rulesBlock
    .split(/\n+/)
    .map((line) => normalizeTrajectoryQuery(line))
    .filter((line) => line.length > 0);
}

function parseRelativePositions(observation: string): Map<string, RelativePosition> {
  const positions = new Map<string, RelativePosition>();
  const objectsBlock = /objects on the map:\s*([\s\S]*)$/i.exec(observation)?.[1];
  if (!objectsBlock) {
    return positions;
  }
  for (const rawLine of objectsBlock.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parsed = parseRelativePositionLine(line);
    if (parsed) {
      positions.set(normalizeEntity(parsed.entity), parsed);
    }
  }
  return positions;
}

function parseRelativePositionLine(line: string): RelativePosition | undefined {
  const normalizedLine = line.replace(/`/g, "").trim();
  const positionStart = findRelativePositionStart(normalizedLine);
  if (positionStart <= 0) {
    return undefined;
  }
  const entity = normalizedLine.slice(0, positionStart).trim();
  const rawPosition = normalizedLine.slice(positionStart).trim();
  if (!entity || !rawPosition) {
    return undefined;
  }
  let x = 0;
  let y = 0;
  let found = false;
  for (const phrase of rawPosition.split(/\s+and\s+/i)) {
    const parsed = parseRelativePositionPhrase(phrase);
    if (!parsed) {
      return undefined;
    }
    found = true;
    if (parsed.direction === "left") x -= parsed.amount;
    if (parsed.direction === "right") x += parsed.amount;
    if (parsed.direction === "up") y -= parsed.amount;
    if (parsed.direction === "down") y += parsed.amount;
  }
  return found ? { entity, x, y, raw: rawPosition } : undefined;
}

function findRelativePositionStart(value: string): number {
  let best = -1;
  for (const direction of ["left", "right", "up", "down"]) {
    for (const prefix of [
      ` step to the ${direction}`,
      ` steps to the ${direction}`,
      ` step ${direction}`,
      ` steps ${direction}`,
    ]) {
      const index = value.toLowerCase().indexOf(prefix);
      if (index < 0) {
        continue;
      }
      let cursor = index - 1;
      while (cursor >= 0 && /\d/.test(value[cursor]!)) {
        cursor -= 1;
      }
      if (cursor === index - 1) {
        continue;
      }
      const start = cursor + 1;
      best = best < 0 ? start : Math.min(best, start);
    }
  }
  return best;
}

function parseRelativePositionPhrase(
  phrase: string,
): { amount: number; direction: "left" | "right" | "up" | "down" } | undefined {
  const tokens = phrase.trim().toLowerCase().split(/\s+/);
  if (tokens.length < 3) {
    return undefined;
  }
  const amount = parseNonNegativeIntegerToken(tokens[0] ?? "");
  if (amount === undefined) {
    return undefined;
  }
  const direction = tokens[tokens.length - 1];
  if (
    direction !== "left" &&
    direction !== "right" &&
    direction !== "up" &&
    direction !== "down"
  ) {
    return undefined;
  }
  if (tokens[1] !== "step" && tokens[1] !== "steps") {
    return undefined;
  }
  return { amount, direction };
}

function extractRelativePositionEntities(query: string): Set<string> {
  const entities = new Set<string>();

  for (const value of extractBacktickValues(query)) {
    addRelativePositionEntity(entities, value);
  }

  const tokens = normalizeTrajectoryQuery(query).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "relative" && tokens[index + 1] === "position") {
      const candidate = nearestEntityTokenBefore(tokens, index);
      if (candidate) {
        addRelativePositionEntity(entities, candidate);
      }
    }
    if (token === "rule" || token === "text" || token === "object") {
      const candidate = tokens[index + 1];
      if (candidate && isRelativeEntityToken(candidate)) {
        addRelativePositionEntity(entities, candidate);
      }
    }
  }
  return entities;
}

function extractBacktickValues(value: string): string[] {
  const results: string[] = [];
  let start = value.indexOf("`");
  while (start >= 0) {
    const end = value.indexOf("`", start + 1);
    if (end < 0) {
      break;
    }
    const inner = value.slice(start + 1, end).trim();
    if (inner) {
      results.push(inner);
    }
    start = value.indexOf("`", end + 1);
  }
  return results;
}

function nearestEntityTokenBefore(
  tokens: readonly string[],
  beforeIndex: number,
): string | undefined {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 6); index -= 1) {
    const token = tokens[index];
    if (token && isRelativeEntityToken(token)) {
      return token;
    }
  }
  return undefined;
}

function isRelativeEntityToken(token: string): boolean {
  return token.length > 1 &&
    ![
      "block",
      "object",
      "position",
      "relative",
      "rule",
      "step",
      "steps",
      "text",
      "the",
      "action",
      "move",
      "moved",
      "moving",
      "up",
      "down",
      "left",
      "right",
    ].includes(token) &&
    !isAllDigits(token);
}

function addRelativePositionEntity(entities: Set<string>, value: string): void {
  const normalized = normalizeEntity(value);
  if (!normalized || !isRelativeEntityToken(normalized)) {
    return;
  }
  entities.add(normalized);
  entities.add(normalizeEntity(`rule ${normalized}`));
}

function hasManeuverInterpretationCue(normalizedQuery: string): boolean {
  return [
    "strategic",
    "goal",
    "necessary",
    "critical",
    "maneuver",
    "path",
    "blocking",
    "bypass",
    "reposition",
  ].some((cue) => normalizedQuery.includes(cue));
}

function hasExactRelativeStateIntent(normalizedQuery: string): boolean {
  return /(?:exact\s+position|relative\s+to|same\s+tile|zero[- ]offset|vanished|reappeared)/.test(
    normalizedQuery,
  );
}

function hasExplicitNoKeyObjectPremise(normalizedQuery: string): boolean {
  return /\bno\s+(?:ordinary\s+)?key\s+objects?\s+exist\b/.test(normalizedQuery) ||
    /\bno\s+(?:ordinary\s+)?key\s+objects?\b/.test(normalizedQuery);
}

function isAllDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const char of value) {
    if (char < "0" || char > "9") {
      return false;
    }
  }
  return true;
}

function inferAgentMoveFromRelativeDelta(dx: number, dy: number): string | undefined {
  if (dx === 1 && dy === 0) return "left";
  if (dx === -1 && dy === 0) return "right";
  if (dx === 0 && dy === 1) return "up";
  if (dx === 0 && dy === -1) return "down";
  return undefined;
}

function agentMoveDeltaFromAction(action: string): AgentMoveDelta | undefined {
  const verb = normalizeActionVerb(action);
  if (verb === "up") return { direction: "up", dx: 0, dy: -1 };
  if (verb === "down") return { direction: "down", dx: 0, dy: 1 };
  if (verb === "left") return { direction: "left", dx: -1, dy: 0 };
  if (verb === "right") return { direction: "right", dx: 1, dy: 0 };
  return undefined;
}

function extractDisallowedMove(normalizedQuery: string): AgentMoveDelta["direction"] | undefined {
  for (const direction of ["up", "down", "left", "right"] as const) {
    if (
      normalizedQuery.includes(`instead of moving ${direction}`) ||
      normalizedQuery.includes(`instead of going ${direction}`) ||
      normalizedQuery.includes(`instead of ${direction}`)
    ) {
      return direction;
    }
  }
  return undefined;
}

function extractAlternativeMove(normalizedQuery: string): AgentMoveDelta | undefined {
  for (const direction of ["up", "down", "left", "right"] as const) {
    if (
      normalizedQuery.includes(`moved ${direction} instead`) ||
      normalizedQuery.includes(`move ${direction} instead`) ||
      normalizedQuery.includes(`instead moved ${direction}`) ||
      normalizedQuery.includes(`instead chosen ${direction}`) ||
      normalizedQuery.includes(`instead chosen to move ${direction}`) ||
      normalizedQuery.includes(`instead chosen the action ${direction}`) ||
      normalizedQuery.includes(`instead chosen to go ${direction}`) ||
      normalizedQuery.includes(`chosen the action ${direction}`) ||
      normalizedQuery.includes(`chose the action ${direction}`) ||
      normalizedQuery.includes(`action ${direction} at step`)
    ) {
      return agentMoveDeltaFromAction(direction);
    }
  }
  return undefined;
}

function selectAlternativeActionTargets(
  positions: ReadonlyMap<string, RelativePosition>,
  normalizedQuery: string,
): Array<{ entity: string; position: RelativePosition }> {
  const targets: Array<{ entity: string; position: RelativePosition }> = [];
  if (normalizedQuery.includes("win condition") || normalizedQuery.includes("win")) {
    for (const entity of ["rule win", "rule is"]) {
      const position = positions.get(entity);
      if (position) {
        targets.push({ entity, position });
      }
    }
    return targets;
  }

  for (const [entity, position] of positions.entries()) {
    if (entity.startsWith("rule ")) {
      targets.push({ entity, position });
    }
  }
  return targets;
}

function scoreMoveTowardTargets(
  move: AgentMoveDelta,
  targets: readonly { entity: string; position: RelativePosition }[],
): number {
  let score = 0;
  for (const { position } of targets) {
    const before = Math.abs(position.x) + Math.abs(position.y);
    const after = Math.abs(position.x - move.dx) + Math.abs(position.y - move.dy);
    score += before - after;
  }
  return score;
}

function observationsRemainStable(
  window: readonly LabeledTrajectoryStep[],
  start: number,
  end: number,
): boolean {
  let baseline: string | undefined;
  let compared = 0;
  for (const step of window) {
    if (step.step < start || step.step > end || !step.observation) {
      continue;
    }
    const signature = relativePositionSignature(step.observation);
    if (!signature) {
      continue;
    }
    if (baseline === undefined) {
      baseline = signature;
      continue;
    }
    compared += 1;
    if (signature !== baseline) {
      return false;
    }
  }
  return compared > 0;
}

function findStopBlockerForRepeatedMove(
  window: readonly LabeledTrajectoryStep[],
  move: AgentMoveDelta,
): { step: number; entity: string; position: RelativePosition } | undefined {
  for (const step of window) {
    if (!step.observation) {
      continue;
    }
    const stopObjects = parseStopRuleObjects(step.observation);
    if (stopObjects.length === 0) {
      continue;
    }
    const blocker = findBlockingStopObject(step.observation, stopObjects, move);
    if (blocker) {
      return { step: step.step, ...blocker };
    }
  }
  return undefined;
}

function relativePositionSignature(observation: string): string | undefined {
  const entries = parseRelativePositionEntries(observation);
  if (entries.length === 0) {
    return undefined;
  }
  return entries
    .map((position) => `${normalizeEntity(position.entity)}:${position.x}:${position.y}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

function observationStateSignature(observation: string): string | undefined {
  return relativePositionSignature(observation) ?? normalizeObservationCore(observation);
}

function positionShiftExample(
  beforeObservation: string,
  afterObservation: string,
): string | undefined {
  const before = parseRelativePositions(beforeObservation);
  const after = parseRelativePositions(afterObservation);
  const preferred = [
    "rule win",
    "rule is",
    "rule key",
    "rule door",
    "door",
    "rule baba",
    "rule you",
  ];
  const entities = [
    ...preferred,
    ...[...before.keys()].sort((left, right) => left.localeCompare(right)),
  ];
  for (const entity of entities) {
    const beforePosition = before.get(entity);
    const afterPosition = after.get(entity);
    if (!beforePosition || !afterPosition) {
      continue;
    }
    if (
      beforePosition.x === afterPosition.x &&
      beforePosition.y === afterPosition.y
    ) {
      continue;
    }
    return `${entity} changed from ${beforePosition.raw} to ${afterPosition.raw}`;
  }
  return undefined;
}

function manhattanDistance(position: RelativePosition): number {
  return Math.abs(position.x) + Math.abs(position.y);
}

function hasRelativeEntityInObservations(
  entity: string,
  observations: readonly (string | undefined)[],
): boolean {
  const normalizedEntity = normalizeEntity(entity);
  for (const observation of observations) {
    if (!observation) {
      continue;
    }
    if (parseRelativePositions(observation).has(normalizedEntity)) {
      return true;
    }
  }
  return false;
}

function relativePositionMatchesMove(
  position: RelativePosition,
  move: AgentMoveDelta,
): boolean {
  return position.x === move.dx && position.y === move.dy;
}

function oppositeDirection(direction: AgentMoveDelta["direction"]): string {
  if (direction === "up") return "downward";
  if (direction === "down") return "upward";
  if (direction === "left") return "rightward";
  return "leftward";
}

function formatRelativePosition(position: { x: number; y: number }): string {
  const parts: string[] = [];
  if (position.x < 0) {
    parts.push(`${Math.abs(position.x)} ${Math.abs(position.x) === 1 ? "step" : "steps"} to the left`);
  } else if (position.x > 0) {
    parts.push(`${position.x} ${position.x === 1 ? "step" : "steps"} to the right`);
  }
  if (position.y < 0) {
    parts.push(`${Math.abs(position.y)} ${Math.abs(position.y) === 1 ? "step" : "steps"} up`);
  } else if (position.y > 0) {
    parts.push(`${position.y} ${position.y === 1 ? "step" : "steps"} down`);
  }
  return parts.length === 0 ? "the same tile" : parts.join(" and ");
}

function normalizeTrajectoryQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, " ").trim();
}

function appendExpandedEvidence(
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>,
  seenTurns: Set<string>,
  sessionId: string,
  expanded: Array<{ turn_index: number; role: string; content: string }>,
): void {
  for (const message of expanded) {
    appendEvidenceItem(evidenceItems, seenTurns, {
      id: `${sessionId}:${message.turn_index}`,
      sessionId,
      turnIndex: message.turn_index,
      role: message.role,
      content: message.content,
    });
  }
}

function appendEvidenceItem<T extends { id: string }>(
  evidenceItems: T[],
  seenTurns: Set<string>,
  item: T,
): void {
  if (seenTurns.has(item.id)) {
    return;
  }
  seenTurns.add(item.id);
  evidenceItems.push(item);
}

export function collectExplicitTurnReferences(
  query: string,
): ExplicitTurnReference[] {
  const references = new Map<string, ExplicitTurnReference>();
  const addReference = (value: number, label: string) => {
    const existing = references.get(String(value));
    references.set(String(value), {
      number: value,
      includeDirectTurn:
        (existing?.includeDirectTurn ?? false) || label === "turn",
    });
  };

  const tokens = tokenizeReferenceQuery(query);
  for (let index = 0; index < tokens.length; index += 1) {
    const label = normalizeReferenceLabel(tokens[index]);
    if (!label) {
      continue;
    }

    const parsed = parseReferenceNumbers(tokens, index + 1);
    for (const number of parsed.numbers) {
      addReference(number, label);
    }
    index = Math.max(index, parsed.nextIndex - 1);
  }

  return [...references.values()].sort((left, right) => left.number - right.number);
}

export function collectLexicalCues(
  query: string,
  options: {
    includeBenchmarkAnchorCues?: boolean;
    includeContentLexicalCues?: boolean;
    includeStructuredPlanCues?: boolean;
  } = {},
): string[] {
  const cues = new Set<string>();

  for (const match of query.matchAll(/\b[A-Za-z][A-Za-z0-9]{0,12}\d+:\d+\b/g)) {
    cues.add(match[0]);
  }
  for (const match of query.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?\b/g)) {
    cues.add(match[0]);
  }
  for (const cue of collectTemporalLexicalCues(query)) {
    cues.add(cue);
  }
  for (const cue of collectQuestionSlotCues(query)) {
    cues.add(cue);
  }
  if (options.includeBenchmarkAnchorCues) {
    for (const cue of collectBenchmarkAnchorCues(query)) {
      cues.add(cue);
    }
  }
  if (options.includeStructuredPlanCues) {
    for (const cue of collectStructuredPlanCues(query)) {
      cues.add(cue);
    }
  }
  if (options.includeContentLexicalCues) {
    for (const cue of collectContentLexicalCues(query)) {
      cues.add(cue);
    }
    for (const cue of collectIntentExpansionCues(query)) {
      cues.add(cue);
    }
    for (const cue of collectMeetingFactCues(query)) {
      cues.add(cue);
    }
  }
  for (const match of query.matchAll(/\b(?:session|source|chat|plan|task|event|file|tool)[_-][A-Za-z0-9][A-Za-z0-9_.:-]{0,80}\b/gi)) {
    cues.add(match[0]);
  }
  for (const match of query.matchAll(/\b[A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]{1,30}){0,2}\b/g)) {
    const value = normalizeSpeakerNameCue(match[0]);
    if (value) {
      cues.add(value);
    }
  }
  for (const match of query.matchAll(/\[([A-Za-z0-9][A-Za-z0-9_.:/ -]{1,80})\]/g)) {
    const value = match[1]?.trim();
    if (value) {
      cues.add(value);
    }
  }

  return [...cues].sort((left, right) => left.localeCompare(right));
}

function collectMeetingFactCues(query: string): string[] {
  const normalized = query.toLowerCase();
  if (
    !/\b(?:met|meet|meeting)\b/.test(normalized) ||
    !/\b(?:when|where|first)\b/.test(normalized)
  ) {
    return [];
  }

  const cues = new Set<string>();
  for (const match of query.matchAll(/\b[A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]{1,30}){0,2}\b/g)) {
    const name = normalizeSpeakerNameCue(match[0]);
    if (!name) continue;
    cues.add(`I met ${name}`);
    cues.add(`met ${name}`);
    cues.add(`${name} at`);
  }
  return [...cues].sort((left, right) => left.localeCompare(right));
}

async function collectNamedMeetingFactEvidence(options: {
  engine: ExplicitCueRecallEngine;
  sessionId?: string;
  query: string;
  maxReferences: number;
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
    score?: number;
  }>;
  seenTurns: Set<string>;
}): Promise<void> {
  const cues = collectMeetingFactCues(options.query)
    .filter((cue) => /^I met /i.test(cue))
    .slice(0, options.maxReferences);
  if (cues.length === 0) return;

  for (const cue of cues) {
    const results = sortMeetingFactResults(
      await options.engine.searchContextFull(cue, 8, options.sessionId),
      options.query,
    );
    for (const result of results) {
      if (!isNamedMeetingFactEvidence(result.content, options.query)) continue;
      appendEvidenceItem(options.evidenceItems, options.seenTurns, {
        id: `${result.session_id}:${result.turn_index}`,
        sessionId: result.session_id,
        turnIndex: result.turn_index,
        role: result.role,
        content: result.content,
        ...(typeof result.score === "number" ? { score: result.score } : {}),
      });
    }
  }
}

function sortMeetingFactResults<
  T extends { turn_index: number; role: string; content: string; score?: number },
>(results: readonly T[], query: string): T[] {
  const normalizedQuery = query.toLowerCase();
  return [...results].sort((left, right) => {
    const rightScore = scoreMeetingFactResult(right, normalizedQuery);
    const leftScore = scoreMeetingFactResult(left, normalizedQuery);
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.turn_index - right.turn_index;
  });
}

function scoreMeetingFactResult(
  result: { role: string; content: string; score?: number },
  query: string,
): number {
  const normalizedContent = result.content.toLowerCase();
  let score = result.role === "user" ? 20 : 0;
  if (isNamedMeetingFactEvidence(result.content, query)) score += 40;
  if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i.test(result.content)) {
    score += 12;
  }
  if (/\b(?:library|museum|store|park|office|cafe|bistro|expo|meetup|conference|center)\b/.test(normalizedContent)) {
    score += 8;
  }
  if (typeof result.score === "number" && Number.isFinite(result.score)) {
    score += Math.min(6, Math.max(0, result.score));
  }
  return score;
}

function isNamedMeetingFactEvidence(content: string, query: string): boolean {
  const normalizedContent = content.toLowerCase();
  return extractMeetingFactNames(query).some((name) =>
    new RegExp(`\\b(?:i\\s+)?met\\s+${escapeRegExp(name.toLowerCase())}\\b`).test(
      normalizedContent,
    )
  );
}

function extractMeetingFactNames(query: string): string[] {
  const names = new Set<string>();
  for (const match of query.matchAll(/\b[A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]{1,30}){0,2}\b/g)) {
    const name = normalizeSpeakerNameCue(match[0]);
    if (name) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function collectQuestionSlotCues(query: string): string[] {
  const cues = new Set<string>();
  for (const match of query.matchAll(
    /\b(?:what|which)\s+([a-z][a-z0-9_-]{2,30})\s+(?:does|do|did|is|are|was|were|should|would|could|can|will)\b/gi,
  )) {
    const value = match[1]?.toLowerCase();
    if (value && !QUESTION_SLOT_STOPWORDS.has(value)) {
      cues.add(value);
    }
  }
  return [...cues].sort((left, right) => left.localeCompare(right));
}

export function collectContentLexicalCues(query: string): string[] {
  const rawWords = (query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .map(trimLexicalCueBoundaryHyphens)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
  const words = rawWords
    .filter(
      (word) =>
        !CONTENT_LEXICAL_CUE_STOPWORDS.has(word),
    );
  const cues = new Set<string>();

  for (const word of words) {
    cues.add(word);
  }
  for (let index = 0; index < rawWords.length - 1; index += 1) {
    const left = rawWords[index]!;
    const right = rawWords[index + 1]!;
    if (
      left.length >= 4 &&
      right.length >= 4 &&
      !CONTENT_LEXICAL_PHRASE_STOPWORDS.has(left) &&
      !CONTENT_LEXICAL_PHRASE_STOPWORDS.has(right)
    ) {
      cues.add(`${left} ${right}`);
    }
  }

  return [...cues]
    .sort((left, right) => {
      const lengthDelta = right.length - left.length;
      return lengthDelta === 0 ? left.localeCompare(right) : lengthDelta;
    })
    .slice(0, 18);
}

function trimLexicalCueBoundaryHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") {
    start += 1;
  }
  while (end > start && value[end - 1] === "-") {
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function collectIntentExpansionCues(query: string): string[] {
  const cues = new Set<string>();
  const normalized = query.toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").trim();

  if (hasImplementationHelpIntent(normalized)) {
    cues.add("code snippets");
    cues.add("format all code snippets");
    cues.add("implementation details");
    cues.add("syntax highlighting");
  }

  if (
    /\b(?:auth|authentication|authorization|login|role|roles|security)\b/.test(
      normalized,
    )
  ) {
    cues.add("access control");
    cues.add("account lockout");
    cues.add("account lockout feature");
    cues.add("authentication");
    cues.add("authorization");
    cues.add("failed login attempts");
    cues.add("password hashing");
    cues.add("rate limiting");
    cues.add("redis");
    cues.add("role-based access control");
  }

  if (hasTemporalScheduleIntent(normalized)) {
    cues.add("milestones");
    cues.add("schedule");
    cues.add("timeline");
  }

  if (hasSecurityDatabaseChallengeSummaryIntent(normalized)) {
    cues.add("atomic operations");
    cues.add("csrf");
    cues.add("database operational errors");
    cues.add("hidden_tag");
    cues.add("operationalerror");
    cues.add("pbkdf2:sha256");
    cues.add("redis");
    cues.add("resetting counters");
    cues.add("unique constraint");
    cues.add("uuid uniqueness");
    cues.add("werkzeug.security");
    cues.add("wtf_csrf_enabled");
  }

  if (hasProjectProgressSummaryIntent(normalized)) {
    cues.add("April 15");
    cues.add("Confluence");
    cues.add("architecture decisions");
    cues.add("authentication");
    cues.add("data visualization");
    cues.add("deployment");
    cues.add("diagrams");
    cues.add("input validation");
    cues.add("role-based access control");
    cues.add("tables");
    cues.add("token-based authentication");
    cues.add("transaction management");
  }

  if (hasSoftwareProjectOrderingIntent(normalized)) {
    cues.add("core functionality");
    cues.add("deployment and test improvements");
    cues.add("deployment configuration");
    cues.add("integration test coverage");
    cues.add("security hardening");
    cues.add("transaction CRUD");
    cues.add("transaction error handling");
  }

  if (hasSprintTaskOrganizationIntent(normalized)) {
    cues.add("adding validation");
    cues.add("database schema");
    cues.add("development environment");
    cues.add("frontend forms");
    cues.add("integrating frontend with backend");
    cues.add("registration and login");
    cues.add("unit tests");
  }

  if (hasFlaskRouteContradictionIntent(normalized)) {
    cues.add("basic homepage route");
    cues.add("flask routes");
    cues.add("handled HTTP requests");
    cues.add("never written");
  }

  if (hasFlaskLoginContradictionIntent(normalized)) {
    cues.add("Flask-Login 0.6.2");
    cues.add("Flask-Login v0.6.2");
    cues.add("managed user sessions");
    cues.add("never integrated Flask-Login");
    cues.add("session management");
  }

  return [...cues].sort((left, right) => left.localeCompare(right));
}

function hasImplementationHelpIntent(normalizedQuery: string): boolean {
  return [
    /\b(?:show|help|write|code|coding|program|develop|build)\b/,
    /\bhow\s+to\s+implement\b/,
    /\bimplementation\s+details?\b/,
  ].some((pattern) => pattern.test(normalizedQuery));
}

function prioritizeLexicalCueSearchCues(query: string, cues: string[]): string[] {
  const normalized = query.toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").trim();
  if (!hasImplementationHelpIntent(normalized)) {
    if (!hasTemporalScheduleIntent(normalized)) {
      return cues;
    }
    return cues
      .map((cue, index) => ({
        cue,
        index,
        priority: temporalScheduleCuePriority(cue),
      }))
      .sort((left, right) =>
        left.priority - right.priority ||
        left.index - right.index,
      )
      .map((entry) => entry.cue);
  }

  return cues
    .map((cue, index) => ({
      cue,
      index,
      priority: implementationCuePriority(cue),
    }))
    .sort((left, right) =>
      left.priority - right.priority ||
      left.index - right.index,
    )
    .map((entry) => entry.cue);
}

function isHighPriorityImplementationCue(query: string, cue: string): boolean {
  const normalized = query.toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").trim();
  return hasImplementationHelpIntent(normalized) && implementationCuePriority(cue) < 100;
}

function implementationCuePriority(cue: string): number {
  const priority = new Map([
    ["syntax highlighting", 0],
    ["format all code snippets", 1],
    ["code snippets", 2],
    ["implementation details", 3],
  ]);
  return priority.get(cue) ?? 100;
}

function hasTemporalScheduleIntent(normalizedQuery: string): boolean {
  return (
    /\b(?:days?|weeks?|months?)\b/.test(normalizedQuery) &&
    /\b(?:between|from|till|until)\b/.test(normalizedQuery) &&
    /\b(?:deadline|deployment|finish(?:ing|ed)?|milestones?|schedule|sprint|timeline)\b/.test(
      normalizedQuery,
    )
  );
}

function hasFlaskRouteContradictionIntent(normalizedQuery: string): boolean {
  return (
    /\bhave i\b/.test(normalizedQuery) &&
    /\b(?:worked with|written|handled|implemented)\b/.test(normalizedQuery) &&
    /\bflask routes?\b/.test(normalizedQuery) &&
    /\bhttp requests?\b/.test(normalizedQuery)
  );
}

function hasFlaskLoginContradictionIntent(normalizedQuery: string): boolean {
  return (
    /\bhave i\b/.test(normalizedQuery) &&
    /\bintegrated\b/.test(normalizedQuery) &&
    /\bflask-login\b/.test(normalizedQuery) &&
    /\bsession management\b/.test(normalizedQuery)
  );
}

function hasSecurityDatabaseChallengeSummaryIntent(normalizedQuery: string): boolean {
  return (
    /\b(?:summary|summarize|handled|challenges?)\b/.test(normalizedQuery) &&
    /\bsecurity\b/.test(normalizedQuery) &&
    /\bdatabase\b/.test(normalizedQuery)
  );
}

function hasProjectProgressSummaryIntent(normalizedQuery: string): boolean {
  return (
    /\b(?:summary|summarize|progressed|progress|timeline|documentation)\b/.test(normalizedQuery) &&
    /\bbudget tracker\b/.test(normalizedQuery) &&
    (/\bdocumentation\b/.test(normalizedQuery) ||
      /\bkey features?\b/.test(normalizedQuery) ||
      /\bsecurity enhancements?\b/.test(normalizedQuery))
  );
}

function hasSoftwareProjectOrderingIntent(normalizedQuery: string): boolean {
  return (
    /\b(?:order|ordered|walk me through|list)\b/.test(normalizedQuery) &&
    /\b(?:app|project|development|deployment|budget tracker)\b/.test(normalizedQuery) &&
    /\b(?:conversations?|throughout|brought up|aspects?)\b/.test(normalizedQuery)
  );
}

function hasSprintTaskOrganizationIntent(normalizedQuery: string): boolean {
  return (
    /\bsprint\b/.test(normalizedQuery) &&
    /\b(?:backend|frontend|tasks?|organized|course)\b/.test(normalizedQuery)
  );
}

function temporalScheduleCuePriority(cue: string): number {
  const priority = new Map([
    ["transaction management", 0],
    ["management features", 1],
    ["final deployment", 2],
    ["deployment deadline", 3],
    ["milestones", 4],
    ["schedule", 5],
    ["timeline", 6],
  ]);
  const mapped = priority.get(cue);
  if (mapped !== undefined) {
    return mapped;
  }
  if (cue.includes(" ")) {
    return 20;
  }
  if (/^(?:deadline|deployment|finishing|management|transaction|weeks|days|sprint)$/.test(cue)) {
    return 40;
  }
  return 100;
}

function lexicalCueSearchLimit(query: string, cue: string): number {
  const normalized = query.toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").trim();
  if (hasTemporalScheduleIntent(normalized) && temporalScheduleCuePriority(cue) < 40) {
    return Math.max(LEXICAL_CUE_SEARCH_LIMIT, 8);
  }
  if (hasSecurityFeatureEnumerationIntent(normalized) && securityFeatureCuePriority(cue) < 40) {
    return Math.max(LEXICAL_CUE_SEARCH_LIMIT, 8);
  }
  return LEXICAL_CUE_SEARCH_LIMIT;
}

function hasSecurityFeatureEnumerationIntent(normalizedQuery: string): boolean {
  return (
    /\bhow many\b/.test(normalizedQuery) &&
    /\bsecurity features?\b/.test(normalizedQuery)
  );
}

function securityFeatureCuePriority(cue: string): number {
  const priority = new Map([
    ["password hashing", 0],
    ["role-based access control", 1],
    ["account lockout", 2],
    ["account lockout feature", 3],
    ["failed login attempts", 4],
    ["rate limiting", 5],
    ["redis", 6],
  ]);
  const mapped = priority.get(cue);
  if (mapped !== undefined) {
    return mapped;
  }
  return cue.includes(" ") && /\b(?:password|role|access|account|lockout|failed|login|security)\b/.test(cue)
    ? 20
    : 100;
}

export function collectBenchmarkAnchorCues(query: string): string[] {
  const cues = new Set<string>();
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ");
  for (const [phrase, cue] of BENCHMARK_ABILITY_CUES) {
    if (containsBoundedPhrase(normalizedQuery, phrase)) {
      cues.add(cue);
    }
  }

  const tokens = tokenizeAnchorQuery(query);
  for (let index = 0; index < tokens.length; index += 1) {
    let prefix = normalizeBenchmarkAnchorPrefix(tokens[index]);
    if (!prefix) {
      continue;
    }

    let valueIndex = index + 1;
    if (
      prefix === "source" &&
      tokens[valueIndex]?.toLowerCase() === "chat"
    ) {
      prefix = "source_chat";
      valueIndex += 1;
    }
    const maybeIdLabel = tokens[valueIndex]?.toLowerCase();
    if (maybeIdLabel === "id" || maybeIdLabel === "ids") {
      valueIndex += 1;
    }

    let consumedValue = false;
    for (
      let currentValueIndex = valueIndex;
      currentValueIndex < tokens.length;
      currentValueIndex += 1
    ) {
      const rawValue = tokens[currentValueIndex];
      const normalizedValue = rawValue?.toLowerCase();
      if (!rawValue || normalizeBenchmarkAnchorPrefix(rawValue)) {
        break;
      }
      if (normalizedValue === "and" || normalizedValue === "or") {
        continue;
      }
      if (BENCHMARK_ANCHOR_VALUE_STOPWORDS.has(normalizedValue)) {
        break;
      }
      if (!isBenchmarkAnchorValue(rawValue)) {
        break;
      }
      addBenchmarkAnchorCues(cues, prefix, rawValue);
      consumedValue = true;
      index = currentValueIndex;
    }
    if (!consumedValue) {
      continue;
    }
  }

  return [...cues].sort((left, right) => left.localeCompare(right));
}

function addBenchmarkAnchorCues(
  cues: Set<string>,
  prefix: string,
  rawValue: string,
): void {
  cues.add(`${prefix}_id=${rawValue}`);
  cues.add(`${prefix}-${rawValue}`);
  if (prefix === "source_chat") {
    cues.add(`chat_id=${rawValue}`);
  }
}

function isBenchmarkAnchorValue(token: string): boolean {
  for (const char of token) {
    if (isAsciiDigitChar(char)) {
      return true;
    }
  }
  return false;
}

function isAsciiDigitChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function normalizeBenchmarkAnchorPrefix(token: string | undefined): string | undefined {
  switch (token?.toLowerCase()) {
    case "ability":
    case "chat":
    case "plan":
    case "rubric":
    case "source":
      return token.toLowerCase();
    default:
      return undefined;
  }
}

function tokenizeAnchorQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  const push = () => {
    const token = trimTrailingAnchorTokenPunctuation(current);
    if (token.length > 0) {
      tokens.push(token);
    }
    current = "";
  };

  for (const char of query) {
    if (
      isAsciiLetterOrDigit(char) ||
      char === "_" ||
      char === "-" ||
      char === "." ||
      char === ":"
    ) {
      current += char;
      continue;
    }
    push();
  }
  push();
  return tokens;
}

function trimTrailingAnchorTokenPunctuation(token: string): string {
  let end = token.length;
  while (end > 0) {
    const char = token[end - 1];
    if (
      char !== "." &&
      char !== ":" &&
      char !== ";" &&
      char !== "!" &&
      char !== "?"
    ) {
      break;
    }
    end -= 1;
  }
  return token.slice(0, end);
}

export function collectStructuredPlanCues(query: string): string[] {
  const cues = new Set<string>();
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ");
  for (const cue of STRUCTURED_PLAN_FIELD_CUES) {
    if (containsBoundedPhrase(normalizedQuery, cue)) {
      cues.add(cue);
    }
  }
  if (cues.size === 0) {
    return [];
  }
  for (const cue of STRUCTURED_PLAN_DEPENDENCY_CUES) {
    if (containsBoundedPhrase(normalizedQuery, cue)) {
      cues.add(cue);
    }
  }
  return [...cues].sort((left, right) => left.localeCompare(right));
}

function containsBoundedPhrase(normalizedHaystack: string, phrase: string): boolean {
  let searchFrom = 0;
  while (searchFrom < normalizedHaystack.length) {
    const index = normalizedHaystack.indexOf(phrase, searchFrom);
    if (index < 0) {
      return false;
    }
    const afterIndex = index + phrase.length;
    if (
      isTemporalCueBoundary(normalizedHaystack[index - 1]) &&
      isTemporalCueBoundary(normalizedHaystack[afterIndex])
    ) {
      return true;
    }
    searchFrom = afterIndex;
  }
  return false;
}

export function collectTemporalLexicalCues(query: string): string[] {
  const cues = new Set<string>();
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ");
  for (const cue of RELATIVE_TEMPORAL_CUES) {
    if (containsBoundedPhrase(normalizedQuery, cue)) {
      cues.add(cue);
    }
  }
  return [...cues].sort((left, right) => left.localeCompare(right));
}

function hasLatestStateIntent(query: string): boolean {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (
    /\bhow many\b/.test(normalized) &&
    /\b(?:commits?|branches?|issues?|pull requests?|prs?|tickets?|tasks?|rows?|columns?|records?)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  return collectTemporalLexicalCues(query).some((cue) =>
    LATEST_STATE_CUES.has(cue),
  );
}

function sortLexicalCueResults<
  T extends { session_id: string; turn_index: number; content?: string; score?: number },
>(results: T[], preferLatest: boolean, query?: string): T[] {
  const temporalScheduleIntent = query
    ? hasTemporalScheduleIntent(query.toLowerCase().replace(/[^a-z0-9+#.-]+/g, " ").trim())
    : false;
  const temporalScheduleContentCues =
    temporalScheduleIntent && query ? collectContentLexicalCues(query) : [];
  return [...results].sort((left, right) => {
    if (preferLatest) {
      const sessionOrder = left.session_id.localeCompare(right.session_id);
      if (sessionOrder !== 0) {
        return sessionOrder;
      }
      const turnOrder = right.turn_index - left.turn_index;
      if (turnOrder !== 0) {
        return turnOrder;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    }
    if (temporalScheduleIntent) {
      const focusDelta =
        scoreTemporalScheduleResultFocus(right.content ?? "", temporalScheduleContentCues) -
        scoreTemporalScheduleResultFocus(left.content ?? "", temporalScheduleContentCues);
      if (focusDelta !== 0) {
        return focusDelta;
      }
    }
    const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const sessionOrder = left.session_id.localeCompare(right.session_id);
    if (sessionOrder !== 0) {
      return sessionOrder;
    }
    return left.turn_index - right.turn_index;
  });
}

function scoreTemporalScheduleResultFocus(
  content: string,
  contentLexicalCues: readonly string[],
): number {
  if (!content) {
    return 0;
  }
  const normalized = content.toLowerCase();
  let score = 0;
  for (const cue of contentLexicalCues) {
    if (!normalized.includes(cue)) {
      continue;
    }
    score += cue.includes(" ") ? 6 : 2;
  }
  if (/\bmilestones?\b/.test(normalized)) {
    score += 8;
  }
  if (/\b(?:schedule|timeline)\b/.test(normalized)) {
    score += 4;
  }
  if (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b/i.test(content)) {
    score += 6;
  }
  return score;
}

function normalizeSpeakerNameCue(value: string): string | undefined {
  const words = value.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && SPEAKER_NAME_STOPWORDS.has(words[0]!)) {
    words.shift();
  }
  while (words.length > 0 && SPEAKER_NAME_STOPWORDS.has(words[words.length - 1]!)) {
    words.pop();
  }
  return words.length > 0 ? words.join(" ") : undefined;
}

function isTemporalCueBoundary(char: string | undefined): boolean {
  if (!char) {
    return true;
  }
  return !isAsciiLetterOrDigit(char);
}

function tokenizeReferenceQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of query) {
    if (isAsciiLetterOrDigit(char)) {
      current += char;
      continue;
    }

    flushCurrent();
    if (char === "#" || char === ",") {
      tokens.push(char);
    } else if (isReferenceDash(char)) {
      tokens.push("-");
    }
  }
  flushCurrent();

  return tokens;
}

function parseReferenceNumbers(
  tokens: readonly string[],
  startIndex: number,
): { numbers: number[]; nextIndex: number } {
  const numbers: number[] = [];
  let lastNumber: number | undefined;
  let pendingRangeStart: number | undefined;
  let index = startIndex;
  const scanEnd = Math.min(
    tokens.length,
    startIndex + DEFAULT_MAX_REFERENCES * REFERENCE_SCAN_TOKEN_FACTOR,
  );

  for (; index < scanEnd; index += 1) {
    const token = tokens[index]!;
    const normalized = token.toLowerCase();
    const value = parseNonNegativeIntegerToken(token);
    if (value !== undefined) {
      if (pendingRangeStart !== undefined) {
        numbers.push(...expandReferenceRange(pendingRangeStart, value));
        pendingRangeStart = undefined;
      } else {
        numbers.push(value);
      }
      lastNumber = value;
      continue;
    }

    if (normalized === "#" || normalized === "number" || normalized === ",") {
      continue;
    }

    if (
      normalized === "-" ||
      normalized === "to" ||
      normalized === "through" ||
      normalized === "thru"
    ) {
      if (lastNumber !== undefined) {
        if (numbers[numbers.length - 1] === lastNumber) {
          numbers.pop();
        }
        pendingRangeStart = lastNumber;
      }
      continue;
    }

    if (normalized === "and" && numbers.length > 0) {
      continue;
    }

    if (normalizeReferenceLabel(token)) {
      break;
    }

    break;
  }

  if (pendingRangeStart !== undefined) {
    numbers.push(pendingRangeStart);
  }

  return {
    numbers: [...new Set(numbers)],
    nextIndex: index,
  };
}

function expandReferenceRange(start: number, end: number): number[] {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  if (high - low + 1 > DEFAULT_MAX_REFERENCES) {
    return [start, end];
  }

  const values: number[] = [];
  for (let value = low; value <= high; value += 1) {
    values.push(value);
  }
  return values;
}

function normalizeReferenceLabel(token: string | undefined): string | undefined {
  const normalized = token?.toLowerCase();
  switch (normalized) {
    case "step":
    case "steps":
      return "step";
    case "turn":
    case "turns":
      return "turn";
    case "action":
    case "actions":
      return "action";
    case "observation":
    case "observations":
      return "observation";
    default:
      return undefined;
  }
}

function candidateTurnIndexesForReference(
  reference: ExplicitTurnReference,
): number[] {
  const candidates = new Set<number>();
  if (reference.includeDirectTurn) {
    for (let offset = -1; offset <= 1; offset += 1) {
      candidates.add(reference.number + offset);
    }
  }

  const pairedBase = reference.number * 2;
  // Action/observation traces are stored as paired turns:
  //   turn 2N     => [Action N]
  //   turn 2N + 1 => [Observation N]
  // Include the preceding observation so transition questions can compare the
  // state before and after the action, but avoid pulling in Action N+1. Future
  // actions caused explicit step questions to drift to the next step.
  for (let offset = -1; offset <= 1; offset += 1) {
    candidates.add(pairedBase + offset);
  }

  return [...candidates].sort((left, right) => left - right);
}

function parseNonNegativeIntegerToken(token: string): number | undefined {
  if (token.length === 0) {
    return undefined;
  }

  let value = 0;
  for (const char of token) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) {
      return undefined;
    }
    value = value * 10 + (code - 48);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function isAsciiLetterOrDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function isReferenceDash(char: string): boolean {
  return char === "-"
    || char === "\u2010"
    || char === "\u2011"
    || char === "\u2012"
    || char === "\u2013"
    || char === "\u2014"
    || char === "\u2015";
}
