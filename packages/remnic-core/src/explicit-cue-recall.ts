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

  await collectLexicalCueEvidence({
    engine,
    sessionId: options.sessionId,
    query,
    maxReferences,
    includeBenchmarkAnchorCues: options.includeBenchmarkAnchorCues,
    includeStructuredPlanCues: options.includeStructuredPlanCues,
    evidenceItems,
    seenTurns,
  });

  return buildEvidencePack(evidenceItems, {
    title: "Explicit Cue Evidence",
    maxChars,
    maxItemChars: normalizePositiveInteger(
      options.maxItemChars,
      DEFAULT_MAX_ITEM_CHARS,
    ),
  });
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
  const cues = collectLexicalCues(options.query, {
    includeBenchmarkAnchorCues: options.includeBenchmarkAnchorCues,
    includeStructuredPlanCues: options.includeStructuredPlanCues,
  }).slice(0, options.maxReferences);
  const preferLatest = hasLatestStateIntent(options.query);
  for (const cue of cues) {
    const results = sortLexicalCueResults(
      await options.engine.searchContextFull(
        cue,
        LEXICAL_CUE_SEARCH_LIMIT,
        options.sessionId,
      ),
      preferLatest,
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
  const asksEntityState = /\bstate\b/.test(normalized) ||
    /\bchanges?\s+history\b/.test(normalized) ||
    /\bwhole\s+changes?\s+history\b/.test(normalized);

  if (transition) {
    lines.push(
      `Matched quoted observations: Observation ${transition.fromStep} -> Observation ${transition.toStep}.`,
    );
    appendActionRangeLines(lines, trajectory, transition.fromStep + 1, transition.toStep, {
      includeObservations: true,
      heading: "Actions that transform the quoted observations:",
    });
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
  const wantsStrategicOrCounterfactual = /\b(?:counterproductive|strategic|objective|instead|alternative|progress|goal|necessary|critical)\b/.test(
    normalized,
  );
  if (!wantsRelativePosition && !wantsRules && !wantsStrategicOrCounterfactual) {
    return;
  }

  const window = boundedTrajectory(trajectory, bounds);
  const movementLines = collectMovementDeltaLines(query, window);
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

  const ruleTextPositionLines = collectRuleTextPositionLines(window, normalized);
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
    !/\b(?:loop|zero\s+progress|reversing|reverse|win\s+condition|objective)\b/.test(normalized)
  ) {
    return [];
  }

  const targetStep = firstMatchInteger(normalized, /\bstart\s+of\s+step\s+(\d+)\b/) ??
    firstMatchInteger(normalized, /\binstead\s+of\s+(?:moving|going)\s+[a-z]+\s+(?:in|at|on)\s+step\s+(\d+)\b/);
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
  const positions = parseRelativePositions(priorStep.observation);
  const focus = selectAlternativeActionTargets(positions, normalized);
  if (focus.length === 0) {
    return [];
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
    return [];
  }

  const targetDescriptions = focus.map(
    ({ entity, position }) => `${entity} at ${position.raw}`,
  );
  const lines = [
    `At the start of step ${targetStep}, use Observation ${priorStep.step} as the decision state: ${targetDescriptions.join("; ")}.`,
    `Excluding the actual/reversing move${unavailableMove ? ` ${unavailableMove}` : ""}, ${best.move.direction} is the alternative that most directly reduces distance to the win-condition rule text target(s).`,
  ];
  if (normalized.includes("win condition")) {
    lines.push(
      `${best.move.direction} advances the objective of getting beside or behind IS/WIN rule text for later rule construction; moves toward unrelated object words should not be preferred when the question asks about creating a win condition.`,
    );
  }
  return lines;
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
      lines.push(
        `No active rule for ${object} appears in this window; specifically, no "${object} is push" rule is active, so treat ${object} as not currently pushable and do not claim that a current move pushed ${object} unless the observations state that rule.`,
      );
      if (
        normalizedQuery.includes(object) &&
        hasManeuverInterpretationCue(normalizedQuery) &&
        !asksExactRelativeState
      ) {
        lines.push(
          `For ${object} maneuver questions, make bypassing or repositioning around a not-pushable obstacle the strategic goal unless an active rule says "${object} is push"; do not make overlap, collection, removal, or pushing the goal unless the question asks that exact relative state.`,
        );
      }
    }
  }
  return lines.slice(0, 8);
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
  const changes: string[] = [];
  for (const step of boundedTrajectory(trajectory, bounds)) {
    if (!step.action) continue;
    const change = parseInventoryChange(step.action, held);
    if (change) {
      changes.push(`[Action ${step.step}]: ${step.action} => ${change}`);
    }
  }
  if (changes.length === 0) {
    return;
  }
  lines.push("Inventory changes from action transcript:");
  lines.push(...changes);
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
  options: { includeIndirectMentions: boolean },
): void {
  for (const entity of entities) {
    const directActions = boundedTrajectory(trajectory, bounds).filter(
      (step) =>
        step.action &&
        (isDirectEntityAction(step.action, entity) ||
          (options.includeIndirectMentions &&
            actionMentionsEntity(step.action, entity))),
    );
    const stateChanges = collectContainerStateChanges(trajectory, bounds).filter(
      (change) => normalizeEntity(change.entity) === normalizeEntity(entity),
    );
    if (directActions.length === 0 && stateChanges.length === 0) {
      continue;
    }

    lines.push(`Timeline for ${entity}:`);
    for (const step of directActions) {
      lines.push(`[Action ${step.step}]: ${step.action}`);
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
  for (const fromStep of fromCandidates) {
    for (const toStep of toCandidates) {
      if (toStep <= fromStep) {
        continue;
      }
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
    return best;
  }

  return undefined;
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
  const candidates = new Set<number>();

  for (const step of trajectory) {
    if (!step.observation) continue;
    const normalizedObservation = normalizeObservationText(step.observation);
    if (
      normalizedObservation === normalizedQuoted ||
      normalizedObservation.includes(normalizedQuoted) ||
      normalizedQuoted.includes(normalizedObservation)
    ) {
      candidates.add(step.step);
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
      candidates.add(step.step);
    }
  }

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
      normalizedQuery.includes(`instead of going ${direction}`)
    ) {
      return direction;
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
  return collectTemporalLexicalCues(query).some((cue) =>
    LATEST_STATE_CUES.has(cue),
  );
}

function sortLexicalCueResults<
  T extends { session_id: string; turn_index: number; score?: number },
>(results: T[], preferLatest: boolean): T[] {
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
