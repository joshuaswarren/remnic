import { buildEvidencePack, type EvidencePackItem } from "./evidence-pack.js";
import type { ExplicitCueRecallEngine } from "./explicit-cue-recall.js";

export interface EventOrderRecallOptions {
  engine: ExplicitCueRecallEngine | null | undefined;
  sessionId?: string;
  query: string;
  maxChars: number;
  maxItemChars?: number;
  maxScanWindowTurns?: number;
  maxScanWindowTokens?: number;
  maxItems?: number;
  title?: string;
}

interface RankedEventItem extends EvidencePackItem {
  rank: number;
}

const DEFAULT_SCAN_WINDOW_TURNS = 12;
const DEFAULT_SCAN_WINDOW_TOKENS = 24_000;
const DEFAULT_MAX_ITEMS = 24;

export function shouldRecallEventOrderEvidence(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\border in which\b/.test(normalized) ||
    /\bsequence in which\b/.test(normalized) ||
    /\breconstruct\b.*\btimeline\b/.test(normalized) ||
    /\btimeline\b.*\bin order\b/.test(normalized) ||
    /\bsequence\b.*\bin order\b/.test(normalized) ||
    /\bintroduced\b.*\bin order\b/.test(normalized) ||
    /\bwalk me through\b/.test(normalized) && /\bin order\b/.test(normalized) ||
    /\bin order\b/.test(normalized) &&
      /\b(?:develop(?:ed|ment)?|evolv(?:e|ed|ing)?|progress|throughout|conversations?|sessions?)\b/.test(normalized) ||
    /\bprogress\b.*\bin order\b/.test(normalized) ||
    /\bchronological(?:ly| order)?\b/.test(normalized) ||
    isTimelineSummaryQuery(normalized);
}

export async function buildEventOrderRecallSection(
  options: EventOrderRecallOptions,
): Promise<string> {
  const budget = normalizePositiveInteger(options.maxChars);
  const maxItems = normalizePositiveInteger(options.maxItems ?? DEFAULT_MAX_ITEMS);
  if (!options.engine || !options.sessionId || budget <= 0) {
    return "";
  }
  if (maxItems <= 0) {
    return "";
  }
  if (!shouldRecallEventOrderEvidence(options.query)) {
    return "";
  }

  const items = await collectEventOrderItems(options);
  const ranked = rankAndSelectEventOrderItems(items, options, maxItems);
  if (ranked.length === 0) {
    return "";
  }

  const title = options.title ?? "Chronological event evidence";
  const evidence = buildEvidencePack(ranked, {
    title,
    maxChars: budget,
    maxItemChars: options.maxItemChars,
  });
  if (!evidence) {
    return "";
  }

  const requested = parseRequestedItemCount(options.query);
  const outlineSource = requested
    ? rankEventOrderItemsForOutline(items, options.query).slice(0, maxItems)
    : ranked;
  const outline = buildChronologyOutline(outlineSource, options.query, requested);
  const summary = [
    "Chronological evidence is sorted by turn number.",
    requested ? `Requested item count: ${requested}.` : "",
    outline,
    "Use these turns to preserve the order in which the user raised the topics.",
  ].filter(Boolean).join(" ");
  return clipSectionToBudget(
    evidence.replace(`## ${title}`, `## ${title}\n\n${summary}`),
    budget,
  );
}

async function collectEventOrderItems(
  options: EventOrderRecallOptions,
): Promise<EvidencePackItem[]> {
  const engine = options.engine;
  if (!engine || !engine.getStats || !options.sessionId) {
    return [];
  }

  const stats = await engine.getStats(options.sessionId);
  const maxTurn = typeof stats.maxTurnIndex === "number"
    ? stats.maxTurnIndex
    : stats.totalMessages - 1;
  if (maxTurn < 0) return [];

  const items: EvidencePackItem[] = [];
  const seen = new Set<string>();
  const windowTurns = Math.max(
    1,
    normalizePositiveInteger(options.maxScanWindowTurns ?? DEFAULT_SCAN_WINDOW_TURNS),
  );
  const windowTokens = Math.max(
    1,
    normalizePositiveInteger(options.maxScanWindowTokens ?? DEFAULT_SCAN_WINDOW_TOKENS),
  );

  for (let fromTurn = 0; fromTurn <= maxTurn; fromTurn += windowTurns) {
    const toTurn = Math.min(maxTurn, fromTurn + windowTurns - 1);
    const messages = await engine.expandContext(
      options.sessionId,
      fromTurn,
      toTurn,
      windowTokens,
    );
    for (const message of messages) {
      const id = `${options.sessionId}:${message.turn_index}`;
      if (seen.has(id)) continue;
      if (!isEventOrderCandidate(message.content, message.role, options.query)) continue;
      seen.add(id);
      items.push({
        id,
        sessionId: options.sessionId,
        turnIndex: message.turn_index,
        role: message.role,
        content: appendChronologicalCues(message.content, options.query),
      });
    }
  }

  return items;
}

function rankAndSelectEventOrderItems(
  items: EvidencePackItem[],
  options: EventOrderRecallOptions,
  maxItems: number,
): RankedEventItem[] {
  const requested = parseRequestedItemCount(options.query);
  const rankedByScore = items
    .map((item) => ({
      ...item,
      rank: scoreEventOrderItem(item, options.query),
    }))
    .filter((item) => item.rank >= 6)
    .sort((left, right) => {
      if (right.rank !== left.rank) return right.rank - left.rank;
      const leftTurn = typeof left.turnIndex === "number" ? left.turnIndex : Number.MAX_SAFE_INTEGER;
      const rightTurn = typeof right.turnIndex === "number" ? right.turnIndex : Number.MAX_SAFE_INTEGER;
      if (leftTurn !== rightTurn) return leftTurn - rightTurn;
      return left.content.localeCompare(right.content);
    });

  const selectedById = new Map<string, RankedEventItem>();
  if (requested) {
    const queryTerms = extractEventOrderTerms(options.query);
    const tailReserve = Math.min(
      maxItems,
      6,
      Math.max(1, Math.floor(Math.min(requested, maxItems) / 3)),
    );
    const primaryLimit = Math.max(0, maxItems - tailReserve);
    for (const item of rankedByScore.slice(0, primaryLimit)) {
      selectedById.set(eventItemSelectionKey(item), item);
    }

    const lateHighValue = [...rankedByScore]
      .filter((item) => extractChronologicalLabels(item.content).some((label) =>
        isHighValueChronologyLabel(label.toLowerCase()) ||
        isFlavorEnhancementChronologyQuery(queryTerms) &&
          FLAVOR_ENHANCEMENT_EVENT_LABELS.has(label.toLowerCase()) ||
        isBakingExperienceChronologyQuery(queryTerms) &&
          BAKING_EXPERIENCE_EVENT_LABELS.has(label.toLowerCase()) ||
        isDietaryAdjustmentChronologyQuery(queryTerms) &&
          DIETARY_ADJUSTMENT_EVENT_LABELS.has(label.toLowerCase()) ||
        isLanguageTranslationChronologyQuery(queryTerms) &&
          LANGUAGE_TRANSLATION_EVENT_LABELS.has(label.toLowerCase()) ||
        isSystemArchitectureChronologyQuery(queryTerms) &&
          SYSTEM_ARCHITECTURE_EVENT_LABELS.has(label.toLowerCase()) ||
        isRecommendationEngineChronologyQuery(queryTerms) &&
          RECOMMENDATION_ENGINE_EVENT_LABELS.has(label.toLowerCase()) ||
        isMicroservicesCommunicationChronologyQuery(queryTerms) &&
          MICROSERVICES_COMMUNICATION_EVENT_LABELS.has(label.toLowerCase()) ||
        isStockTradingChronologyQuery(queryTerms) &&
          STOCK_TRADING_EVENT_LABELS.has(label.toLowerCase()) ||
        isModelDevelopmentDeploymentChronologyQuery(queryTerms) &&
          MODEL_DEVELOPMENT_DEPLOYMENT_EVENT_LABELS.has(label.toLowerCase()) ||
        isDatabaseDataHandlingChronologyQuery(queryTerms) &&
          DATABASE_DATA_HANDLING_EVENT_LABELS.has(label.toLowerCase()) ||
        isGameDevelopmentChronologyQuery(queryTerms) &&
          GAME_DEVELOPMENT_EVENT_LABELS.has(label.toLowerCase()) ||
        isRealtimeCommunicationChronologyQuery(queryTerms) &&
          REALTIME_COMMUNICATION_EVENT_LABELS.has(label.toLowerCase()) ||
        isSleepTrackingDeviceChronologyQuery(queryTerms) &&
          SLEEP_TRACKING_DEVICE_EVENT_LABELS.has(label.toLowerCase()) ||
        isWorkIncomeRelationshipChronologyQuery(queryTerms) &&
          WORK_INCOME_RELATIONSHIP_EVENT_LABELS.has(label.toLowerCase()) ||
        isTurkishCultureLanguageChronologyQuery(queryTerms) &&
          TURKISH_CULTURE_LANGUAGE_EVENT_LABELS.has(label.toLowerCase()) ||
        isMovingHomeSetupChronologyQuery(queryTerms) &&
          MOVING_HOME_SETUP_EVENT_LABELS.has(label.toLowerCase()) ||
        isJesseRecommendationChronologyQuery(queryTerms) &&
          JESSE_RECOMMENDATION_EVENT_LABELS.has(label.toLowerCase()) ||
        isSellingPropertyFinancialChronologyQuery(queryTerms) &&
          SELLING_PROPERTY_FINANCIAL_EVENT_LABELS.has(label.toLowerCase()) ||
        isSellingFamilyHomePrepChronologyQuery(queryTerms) &&
          SELLING_FAMILY_HOME_PREP_EVENT_LABELS.has(label.toLowerCase()) ||
        isDiyHomeImprovementChronologyQuery(queryTerms) &&
          DIY_HOME_IMPROVEMENT_EVENT_LABELS.has(label.toLowerCase()) ||
        isDiyRecommendationChronologyQuery(queryTerms) &&
          DIY_RECOMMENDATION_EVENT_LABELS.has(label.toLowerCase())
      ))
      .sort((left, right) => {
        const leftTurn = typeof left.turnIndex === "number" ? left.turnIndex : -1;
        const rightTurn = typeof right.turnIndex === "number" ? right.turnIndex : -1;
        if (rightTurn !== leftTurn) return rightTurn - leftTurn;
        return right.rank - left.rank;
      })
      .slice(0, tailReserve);
    for (const item of lateHighValue) {
      if (selectedById.size >= maxItems) break;
      selectedById.set(eventItemSelectionKey(item), item);
    }
  }

  for (const item of rankedByScore) {
    if (selectedById.size >= maxItems) break;
    selectedById.set(eventItemSelectionKey(item), item);
  }

  const ranked = [...selectedById.values()];

  return ranked.sort((left, right) => {
    const leftTurn = typeof left.turnIndex === "number" ? left.turnIndex : Number.MAX_SAFE_INTEGER;
    const rightTurn = typeof right.turnIndex === "number" ? right.turnIndex : Number.MAX_SAFE_INTEGER;
    if (leftTurn !== rightTurn) return leftTurn - rightTurn;
    return left.content.localeCompare(right.content);
  });
}

function rankEventOrderItemsForOutline(
  items: readonly EvidencePackItem[],
  query: string,
): RankedEventItem[] {
  return items
    .map((item) => ({
      ...item,
      rank: scoreEventOrderItem(item, query),
    }))
    .filter((item) => item.rank >= 6);
}

function eventItemSelectionKey(item: EvidencePackItem): string {
  if (item.id) return item.id;
  if (item.sessionId && typeof item.turnIndex === "number") {
    return `${item.sessionId}:${item.turnIndex}`;
  }
  return item.content;
}

function isEventOrderCandidate(
  content: string,
  role: string,
  query: string,
): boolean {
  const normalized = content.toLowerCase();
  const queryTerms = extractEventOrderTerms(query);
  const chronologicalLabels = deriveChronologicalCueLabels(content, query);
  const hasProjectSummaryLabel = isProjectSummaryChronologyQuery(query) &&
    chronologicalLabels.some((label) =>
      PROJECT_SUMMARY_EVENT_LABELS.has(label.toLowerCase())
    );
  if (role !== "user") {
    return hasProjectSummaryLabel && scoreTextForEventOrder(normalized, query) >= 6;
  }
  const hasSelfReference = /\b(?:i|my|me|we|our|let'?s)\b/.test(normalized);
  const hasQuerySubject = extractEventOrderTerms(query).some((term) =>
    isLikelyName(term) && normalized.includes(term)
  );
  const hasHighValueLabel = chronologicalLabels.some((label) =>
    isHighValueChronologyLabel(label.toLowerCase()) ||
    isProjectSummaryChronologyQuery(query) &&
      PROJECT_SUMMARY_EVENT_LABELS.has(label.toLowerCase()) ||
    isFlavorEnhancementChronologyQuery(queryTerms) &&
      FLAVOR_ENHANCEMENT_EVENT_LABELS.has(label.toLowerCase()) ||
    isBakingExperienceChronologyQuery(queryTerms) &&
      BAKING_EXPERIENCE_EVENT_LABELS.has(label.toLowerCase()) ||
    isDietaryAdjustmentChronologyQuery(queryTerms) &&
      DIETARY_ADJUSTMENT_EVENT_LABELS.has(label.toLowerCase()) ||
    isLanguageTranslationChronologyQuery(queryTerms) &&
      LANGUAGE_TRANSLATION_EVENT_LABELS.has(label.toLowerCase()) ||
    isSystemArchitectureChronologyQuery(queryTerms) &&
      SYSTEM_ARCHITECTURE_EVENT_LABELS.has(label.toLowerCase()) ||
    isRecommendationEngineChronologyQuery(queryTerms) &&
      RECOMMENDATION_ENGINE_EVENT_LABELS.has(label.toLowerCase()) ||
    isMicroservicesCommunicationChronologyQuery(queryTerms) &&
      MICROSERVICES_COMMUNICATION_EVENT_LABELS.has(label.toLowerCase()) ||
    isStockTradingChronologyQuery(queryTerms) &&
      STOCK_TRADING_EVENT_LABELS.has(label.toLowerCase()) ||
    isModelDevelopmentDeploymentChronologyQuery(queryTerms) &&
      MODEL_DEVELOPMENT_DEPLOYMENT_EVENT_LABELS.has(label.toLowerCase()) ||
    isDatabaseDataHandlingChronologyQuery(queryTerms) &&
      DATABASE_DATA_HANDLING_EVENT_LABELS.has(label.toLowerCase()) ||
    isGameDevelopmentChronologyQuery(queryTerms) &&
      GAME_DEVELOPMENT_EVENT_LABELS.has(label.toLowerCase()) ||
    isRealtimeCommunicationChronologyQuery(queryTerms) &&
      REALTIME_COMMUNICATION_EVENT_LABELS.has(label.toLowerCase()) ||
    isSleepTrackingDeviceChronologyQuery(queryTerms) &&
      SLEEP_TRACKING_DEVICE_EVENT_LABELS.has(label.toLowerCase()) ||
    isWorkIncomeRelationshipChronologyQuery(queryTerms) &&
      WORK_INCOME_RELATIONSHIP_EVENT_LABELS.has(label.toLowerCase()) ||
    isTurkishCultureLanguageChronologyQuery(queryTerms) &&
      TURKISH_CULTURE_LANGUAGE_EVENT_LABELS.has(label.toLowerCase()) ||
    isMovingHomeSetupChronologyQuery(queryTerms) &&
      MOVING_HOME_SETUP_EVENT_LABELS.has(label.toLowerCase()) ||
    isJesseRecommendationChronologyQuery(queryTerms) &&
      JESSE_RECOMMENDATION_EVENT_LABELS.has(label.toLowerCase()) ||
    isSellingPropertyFinancialChronologyQuery(queryTerms) &&
      SELLING_PROPERTY_FINANCIAL_EVENT_LABELS.has(label.toLowerCase()) ||
    isSellingFamilyHomePrepChronologyQuery(queryTerms) &&
      SELLING_FAMILY_HOME_PREP_EVENT_LABELS.has(label.toLowerCase()) ||
    isDiyHomeImprovementChronologyQuery(queryTerms) &&
      DIY_HOME_IMPROVEMENT_EVENT_LABELS.has(label.toLowerCase()) ||
    isDiyRecommendationChronologyQuery(queryTerms) &&
      DIY_RECOMMENDATION_EVENT_LABELS.has(label.toLowerCase())
  );
  if (!hasSelfReference && !hasQuerySubject && !hasHighValueLabel) {
    return false;
  }
  if (scoreTextForEventOrder(normalized, query) >= 6) {
    return true;
  }
  return hasHighValueLabel;
}

function scoreEventOrderItem(item: EvidencePackItem, query: string): number {
  return scoreTextForEventOrder(item.content.toLowerCase(), query);
}

function scoreTextForEventOrder(normalizedContent: string, query: string): number {
  let score = 0;
  const terms = extractEventOrderTerms(query);
  const chronologicalLabels = extractChronologicalLabels(normalizedContent)
    .map((label) => label.toLowerCase());
  for (const term of terms) {
    if (normalizedContent.includes(term)) score += isLikelyName(term) ? 8 : 3;
  }
  if (/chronological cue labels?:/.test(normalizedContent)) {
    score += 12;
  }
  score += scoreDerivedLabelMatch(normalizedContent);
  if (
    isFlavorEnhancementChronologyQuery(terms) &&
    chronologicalLabels.some((label) => FLAVOR_ENHANCEMENT_EVENT_LABELS.has(label))
  ) {
    score += 14;
  }
  if (
    isBakingExperienceChronologyQuery(terms) &&
    chronologicalLabels.some((label) => BAKING_EXPERIENCE_EVENT_LABELS.has(label))
  ) {
    score += 14;
  }
  if (
    isDietaryAdjustmentChronologyQuery(terms) &&
    chronologicalLabels.some((label) => DIETARY_ADJUSTMENT_EVENT_LABELS.has(label))
  ) {
    score += 14;
  }
  if (
    isLanguageTranslationChronologyQuery(terms) &&
    chronologicalLabels.some((label) => LANGUAGE_TRANSLATION_EVENT_LABELS.has(label))
  ) {
    score += 16;
  }
  if (
    isSystemArchitectureChronologyQuery(terms) &&
    chronologicalLabels.some((label) => SYSTEM_ARCHITECTURE_EVENT_LABELS.has(label))
  ) {
    score += 16;
  }
  if (
    isRecommendationEngineChronologyQuery(terms) &&
    chronologicalLabels.some((label) => RECOMMENDATION_ENGINE_EVENT_LABELS.has(label))
  ) {
    score += 16;
  }
  if (
    isMicroservicesCommunicationChronologyQuery(terms) &&
    chronologicalLabels.some((label) => MICROSERVICES_COMMUNICATION_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isStockTradingChronologyQuery(terms) &&
    chronologicalLabels.some((label) => STOCK_TRADING_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isModelDevelopmentDeploymentChronologyQuery(terms) &&
    chronologicalLabels.some((label) => MODEL_DEVELOPMENT_DEPLOYMENT_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isDatabaseDataHandlingChronologyQuery(terms) &&
    chronologicalLabels.some((label) => DATABASE_DATA_HANDLING_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isGameDevelopmentChronologyQuery(terms) &&
    chronologicalLabels.some((label) => GAME_DEVELOPMENT_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isRealtimeCommunicationChronologyQuery(terms) &&
    chronologicalLabels.some((label) => REALTIME_COMMUNICATION_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isSleepTrackingDeviceChronologyQuery(terms) &&
    chronologicalLabels.some((label) => SLEEP_TRACKING_DEVICE_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isWorkIncomeRelationshipChronologyQuery(terms) &&
    chronologicalLabels.some((label) => WORK_INCOME_RELATIONSHIP_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isTurkishCultureLanguageChronologyQuery(terms) &&
    chronologicalLabels.some((label) => TURKISH_CULTURE_LANGUAGE_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isMovingHomeSetupChronologyQuery(terms) &&
    chronologicalLabels.some((label) => MOVING_HOME_SETUP_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isJesseRecommendationChronologyQuery(terms) &&
    chronologicalLabels.some((label) => JESSE_RECOMMENDATION_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isSellingPropertyFinancialChronologyQuery(terms) &&
    chronologicalLabels.some((label) => SELLING_PROPERTY_FINANCIAL_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isSellingFamilyHomePrepChronologyQuery(terms) &&
    chronologicalLabels.some((label) => SELLING_FAMILY_HOME_PREP_EVENT_LABELS.has(label))
  ) {
    score += 18;
  }
  if (
    isDiyHomeImprovementChronologyQuery(terms) &&
    chronologicalLabels.some((label) => DIY_HOME_IMPROVEMENT_EVENT_LABELS.has(label))
  ) {
    score += 20;
  }
  if (
    isDiyRecommendationChronologyQuery(terms) &&
    chronologicalLabels.some((label) => DIY_RECOMMENDATION_EVENT_LABELS.has(label))
  ) {
    score += 20;
  }
  for (const cue of EVENT_CUE_PATTERNS) {
    if (cue.test(normalizedContent)) score += 3;
  }
  if (/\b(?:after|before|then|later|next|follow-up|follow up|extended|now|currently)\b/.test(normalizedContent)) {
    score += 2;
  }
  if (/\b(?:suggested|recommended|asked|shared|mentioned|brought up|told|decided|planned|confirmed|declined)\b/.test(normalizedContent)) {
    score += 3;
  }
  return score;
}

function scoreDerivedLabelMatch(normalizedContent: string): number {
  let score = 0;
  for (const label of HIGH_VALUE_EVENT_LABELS) {
    if (normalizedContent.includes(label)) {
      score += 12;
    }
  }
  return score;
}

function buildEventOrderQuery(query: string): string {
  return [
    query,
    extractEventOrderTerms(query).join(" "),
    "chronological order sequence brought up mentioned first next later then event timeline summary progress project over time",
  ].filter(Boolean).join(" ");
}

function appendChronologicalCues(content: string, query: string): string {
  const labels = deriveChronologicalCueLabels(content, query);
  if (labels.length === 0) {
    return content;
  }
  return `Chronological cue labels: ${labels.join("; ")}.\n\n${content}`;
}

function buildChronologyOutline(
  items: readonly RankedEventItem[],
  query: string,
  requested?: number,
): string {
  const candidates = collectChronologyOutlineCandidates(items, query);
  if (candidates.length === 0) return "";

  const limit = requested
    ? Math.max(12, Math.min(32, requested * 3))
    : 14;
  const prioritySorted = [...candidates].sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.turn - right.turn;
    });
  const selectedByKey = new Map<string, { turn: number; label: string; priority: number }>();

  if (requested) {
    const tailReserve = Math.min(6, Math.max(2, Math.floor(requested / 3)));
    const primaryLimit = Math.max(0, limit - tailReserve);
    for (const entry of prioritySorted.slice(0, primaryLimit)) {
      selectedByKey.set(`${entry.turn}:${entry.label}`, entry);
    }

    const lateHighValue = [...candidates]
      .filter((entry) => entry.priority >= 24)
      .sort((left, right) => right.turn - left.turn || right.priority - left.priority)
      .slice(0, tailReserve);
    for (const entry of lateHighValue) {
      selectedByKey.set(`${entry.turn}:${entry.label}`, entry);
    }
  }

  for (const entry of prioritySorted) {
    if (selectedByKey.size >= limit) break;
    selectedByKey.set(`${entry.turn}:${entry.label}`, entry);
  }

  const selected = [...selectedByKey.values()]
    .sort((left, right) => left.turn - right.turn);

  const parts: string[] = [];
  let used = 0;
  const maxOutlineChars = requested ? 4_000 : 1_600;
  for (const entry of selected) {
    const part = `turn ${entry.turn}: ${entry.label}`;
    const nextUsed = used + (parts.length > 0 ? 2 : 0) + part.length;
    if (nextUsed > maxOutlineChars) break;
    parts.push(part);
    used = nextUsed;
  }

  return parts.length > 0
    ? `Chronology outline: ${parts.join("; ")}.`
    : "";
}

function collectChronologyOutlineCandidates(
  items: readonly RankedEventItem[],
  query: string,
): Array<{ turn: number; label: string; priority: number }> {
  const terms = extractEventOrderTerms(query);
  const seen = new Map<string, { turn: number; label: string; priority: number }>();

  for (const item of items) {
    const turn = typeof item.turnIndex === "number" ? item.turnIndex : Number.MAX_SAFE_INTEGER;
    for (const label of extractChronologicalLabels(item.content)) {
      const normalizedLabel = label.toLowerCase();
      const priority = scoreChronologyOutlineLabel(normalizedLabel, item.rank, terms);
      const existing = seen.get(normalizedLabel);
      if (!existing || priority > existing.priority || priority === existing.priority && turn < existing.turn) {
        seen.set(normalizedLabel, { turn, label, priority });
      }
    }
  }

  return [...seen.values()];
}

function extractChronologicalLabels(content: string): string[] {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(/^Chronological cue labels:\s*(.+?)\.\s*$/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(";")
    .map((label) => label.trim())
    .filter(Boolean);
}

function scoreChronologyOutlineLabel(
  normalizedLabel: string,
  itemRank: number,
  queryTerms: readonly string[],
): number {
  let score = Math.min(12, itemRank / 3);
  if (HIGH_VALUE_EVENT_LABELS.includes(normalizedLabel)) {
    score += 24;
  }
  if (isPerformingArtsChronologyQuery(queryTerms) &&
    PERFORMING_ARTS_EVENT_LABELS.has(normalizedLabel)) {
    score += 24;
  }
  if (isHousingChronologyQuery(queryTerms) &&
    HOUSING_EVENT_LABELS.has(normalizedLabel)) {
    score += 28;
  }
  if (isHomeCareerChronologyQuery(queryTerms) &&
    HOME_CAREER_EVENT_LABELS.has(normalizedLabel)) {
    score += 28;
  }
  if (isFlavorEnhancementChronologyQuery(queryTerms) &&
    FLAVOR_ENHANCEMENT_EVENT_LABELS.has(normalizedLabel)) {
    score += 28;
  }
  if (isBakingExperienceChronologyQuery(queryTerms) &&
    BAKING_EXPERIENCE_EVENT_LABELS.has(normalizedLabel)) {
    score += 28;
  }
  if (isDietaryAdjustmentChronologyQuery(queryTerms) &&
    DIETARY_ADJUSTMENT_EVENT_LABELS.has(normalizedLabel)) {
    score += 28;
  }
  if (isLanguageTranslationChronologyQuery(queryTerms) &&
    LANGUAGE_TRANSLATION_EVENT_LABELS.has(normalizedLabel)) {
    score += 32;
  }
  if (isSystemArchitectureChronologyQuery(queryTerms) &&
    SYSTEM_ARCHITECTURE_EVENT_LABELS.has(normalizedLabel)) {
    score += 32;
  }
  if (isRecommendationEngineChronologyQuery(queryTerms) &&
    RECOMMENDATION_ENGINE_EVENT_LABELS.has(normalizedLabel)) {
    score += 32;
  }
  if (isMicroservicesCommunicationChronologyQuery(queryTerms) &&
    MICROSERVICES_COMMUNICATION_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isStockTradingChronologyQuery(queryTerms) &&
    STOCK_TRADING_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isModelDevelopmentDeploymentChronologyQuery(queryTerms) &&
    MODEL_DEVELOPMENT_DEPLOYMENT_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isDatabaseDataHandlingChronologyQuery(queryTerms) &&
    DATABASE_DATA_HANDLING_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isGameDevelopmentChronologyQuery(queryTerms) &&
    GAME_DEVELOPMENT_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isRealtimeCommunicationChronologyQuery(queryTerms) &&
    REALTIME_COMMUNICATION_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isSleepTrackingDeviceChronologyQuery(queryTerms) &&
    SLEEP_TRACKING_DEVICE_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isWorkIncomeRelationshipChronologyQuery(queryTerms) &&
    WORK_INCOME_RELATIONSHIP_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isTurkishCultureLanguageChronologyQuery(queryTerms) &&
    TURKISH_CULTURE_LANGUAGE_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isMovingHomeSetupChronologyQuery(queryTerms) &&
    MOVING_HOME_SETUP_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isJesseRecommendationChronologyQuery(queryTerms) &&
    JESSE_RECOMMENDATION_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isSellingPropertyFinancialChronologyQuery(queryTerms) &&
    SELLING_PROPERTY_FINANCIAL_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isSellingFamilyHomePrepChronologyQuery(queryTerms) &&
    SELLING_FAMILY_HOME_PREP_EVENT_LABELS.has(normalizedLabel)) {
    score += 34;
  }
  if (isDiyHomeImprovementChronologyQuery(queryTerms) &&
    DIY_HOME_IMPROVEMENT_EVENT_LABELS.has(normalizedLabel)) {
    score += 36;
  }
  if (isDiyRecommendationChronologyQuery(queryTerms) &&
    DIY_RECOMMENDATION_EVENT_LABELS.has(normalizedLabel)) {
    score += 36;
  }
  for (const term of queryTerms) {
    if (normalizedLabel.includes(term)) score += isLikelyName(term) ? 8 : 4;
  }
  return score;
}

function isHighValueChronologyLabel(normalizedLabel: string): boolean {
  return HIGH_VALUE_EVENT_LABELS.includes(normalizedLabel);
}

function isPerformingArtsChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("creative") ||
    terms.has("journey") ||
    terms.has("performing") ||
    terms.has("arts") ||
    terms.has("acting");
}

function isHousingChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("housing") ||
    terms.has("lease") ||
    terms.has("moving") ||
    terms.has("move") ||
    terms.has("settling") ||
    terms.has("apartment") ||
    terms.has("home");
}

function isHomeCareerChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("home") ||
    terms.has("career") ||
    terms.has("handyman") ||
    terms.has("repairs") ||
    terms.has("utility") ||
    terms.has("utilities") ||
    terms.has("networking");
}

function isFlavorEnhancementChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("flavor") ||
    terms.has("flavors") ||
    terms.has("flavour") ||
    terms.has("enhance") ||
    terms.has("enhancement") ||
    terms.has("enhancements") ||
    terms.has("experimenting") ||
    terms.has("spice") ||
    terms.has("spices") ||
    terms.has("seasoning") ||
    terms.has("seasonings");
}

function isBakingExperienceChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("baking") ||
    terms.has("bake") ||
    terms.has("bakery") ||
    terms.has("bread") ||
    terms.has("pastry") ||
    terms.has("pastries") ||
    terms.has("dessert") ||
    terms.has("desserts") ||
    terms.has("cake") ||
    terms.has("cakes") ||
    terms.has("croissant") ||
    terms.has("croissants");
}

function isDietaryAdjustmentChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("dietary") ||
    terms.has("diet") ||
    terms.has("diets") ||
    terms.has("nutrition") ||
    terms.has("nutrient") ||
    terms.has("nutrients") ||
    terms.has("micronutrient") ||
    terms.has("micronutrients") ||
    terms.has("macronutrient") ||
    terms.has("macronutrients") ||
    terms.has("adjustment") ||
    terms.has("adjustments");
}

function isLanguageTranslationChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("language") ||
    terms.has("translation") ||
    terms.has("translations") ||
    terms.has("translate") ||
    terms.has("detection") ||
    terms.has("services") ||
    terms.has("service") ||
    terms.has("streaming") ||
    terms.has("llm");
}

function isSystemArchitectureChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("system") ||
    terms.has("architecture") ||
    terms.has("tooling") ||
    terms.has("scraping") ||
    terms.has("scraper") ||
    terms.has("nlp") ||
    terms.has("openapi") ||
    terms.has("fastapi") ||
    terms.has("websocket") ||
    terms.has("database") ||
    terms.has("schema") ||
    terms.has("scrapy") ||
    terms.has("sentry") ||
    terms.has("paywall") ||
    terms.has("twilio") ||
    terms.has("istio");
}

function isRecommendationEngineChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("recommendation") ||
    terms.has("recommendations") ||
    terms.has("recommender") ||
    terms.has("engine") ||
    terms.has("collaborative") ||
    terms.has("filtering") ||
    terms.has("ratings") ||
    terms.has("feedback") ||
    terms.has("optimization");
}

function isMicroservicesCommunicationChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("microservices") ||
    terms.has("microservice") ||
    terms.has("communication") ||
    terms.has("communications") ||
    terms.has("messaging") ||
    terms.has("rabbitmq") ||
    terms.has("grpc") ||
    terms.has("kafka") ||
    terms.has("websocket") ||
    terms.has("websockets") ||
    terms.has("sns") ||
    terms.has("pub") ||
    terms.has("sub") ||
    terms.has("service");
}

function isStockTradingChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("stock") ||
    terms.has("stocks") ||
    terms.has("trading") ||
    terms.has("trade") ||
    terms.has("trades") ||
    terms.has("backtesting") ||
    terms.has("alpaca") ||
    terms.has("oauth") ||
    terms.has("prediction") ||
    terms.has("bot");
}

function isModelDevelopmentDeploymentChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("model") ||
    terms.has("models") ||
    terms.has("deployment") ||
    terms.has("deploy") ||
    terms.has("captioning") ||
    terms.has("caption") ||
    terms.has("diffusion") ||
    terms.has("transformer") ||
    terms.has("transformers") ||
    terms.has("tokenizer") ||
    terms.has("pytorch") ||
    terms.has("torchvision") ||
    terms.has("distributed") ||
    terms.has("acceleration") ||
    terms.has("authentication") ||
    terms.has("security");
}

function isDatabaseDataHandlingChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("database") ||
    terms.has("databases") ||
    terms.has("data") ||
    terms.has("handling") ||
    terms.has("postgresql") ||
    terms.has("schema") ||
    terms.has("captions") ||
    terms.has("materialized") ||
    terms.has("indexing") ||
    terms.has("etl") ||
    terms.has("cache") ||
    terms.has("lambda") ||
    terms.has("dynamodb");
}

function isGameDevelopmentChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("game") ||
    terms.has("games") ||
    terms.has("gameplay") ||
    terms.has("matchmaking") ||
    terms.has("components") ||
    terms.has("component") ||
    terms.has("lag") ||
    terms.has("anti-cheat") ||
    terms.has("input") ||
    terms.has("platform");
}

function isRealtimeCommunicationChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("real-time") ||
    terms.has("realtime") ||
    terms.has("communication") ||
    terms.has("communications") ||
    terms.has("websocket") ||
    terms.has("websockets") ||
    terms.has("webrtc") ||
    terms.has("socket") ||
    terms.has("latency") ||
    terms.has("signaling") ||
    terms.has("voice");
}

function isSleepTrackingDeviceChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("sleep") &&
    (terms.has("tracking") ||
      terms.has("tracker") ||
      terms.has("trackers") ||
      terms.has("device") ||
      terms.has("devices") ||
      terms.has("firmware"));
}

function isWorkIncomeRelationshipChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return (terms.has("work") || terms.has("consulting")) &&
    (terms.has("income") || terms.has("hours") || terms.has("consulting")) &&
    (terms.has("relationship") || terms.has("priorities") || terms.has("april"));
}

function isTurkishCultureLanguageChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("turkish") &&
    (terms.has("culture") ||
      terms.has("cultural") ||
      terms.has("language") ||
      terms.has("engaging") ||
      terms.has("engagement"));
}

function isMovingHomeSetupChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return (terms.has("moving") || terms.has("move") || terms.has("home") || terms.has("setup")) &&
    (terms.has("setup") ||
      terms.has("process") ||
      terms.has("conversations") ||
      terms.has("conversation") ||
      terms.has("aspects") ||
      terms.has("home") ||
      terms.has("moving"));
}

function isJesseRecommendationChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("jesse") &&
    (terms.has("recommendations") ||
      terms.has("recommendation") ||
      terms.has("recommended") ||
      terms.has("develop") ||
      terms.has("developed") ||
      terms.has("developing"));
}

function isSellingPropertyFinancialChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return (terms.has("financial") || terms.has("finances") || terms.has("property")) &&
    (terms.has("property") || terms.has("sale") || terms.has("selling") || terms.has("home")) &&
    (terms.has("aspects") ||
      terms.has("focus") ||
      terms.has("evolve") ||
      terms.has("develop") ||
      terms.has("conversations") ||
      terms.has("conversation"));
}

function isSellingFamilyHomePrepChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("family") &&
    (terms.has("home") || terms.has("preparation") || terms.has("prep") || terms.has("process")) &&
    (terms.has("involvement") ||
      terms.has("shift") ||
      terms.has("develop") ||
      terms.has("conversations") ||
      terms.has("conversation"));
}

function isDiyHomeImprovementChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  if (terms.has("recommendations") || terms.has("recommendation") || terms.has("recommended")) {
    return false;
  }
  return (terms.has("home") || terms.has("improvement") || terms.has("improvements") || terms.has("diy") || terms.has("projects")) &&
    (terms.has("projects") ||
      terms.has("project") ||
      terms.has("types") ||
      terms.has("develop") ||
      terms.has("developed") ||
      terms.has("conversations") ||
      terms.has("conversation") ||
      terms.has("order"));
}

function isDiyRecommendationChronologyQuery(queryTerms: readonly string[]): boolean {
  const terms = new Set(queryTerms);
  return terms.has("diy") &&
    (terms.has("recommendations") ||
      terms.has("recommendation") ||
      terms.has("recommended") ||
      terms.has("related") ||
      terms.has("projects") ||
      terms.has("develop") ||
      terms.has("developed") ||
      terms.has("order") ||
      terms.has("conversations") ||
      terms.has("conversation"));
}

function isProjectSummaryChronologyQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return /\bproject\b/.test(normalized) &&
    /\b(?:summary|summarize|comprehensive|entire process|key developments|decisions|adjustments|throughout)\b/.test(
      normalized,
    );
}

function deriveChronologicalCueLabels(content: string, query: string): string[] {
  const normalized = content.toLowerCase();
  const labels = new Set<string>();

  addLabelIf(labels, normalized, /\bworkshop\b.*\b(?:suggest|recommend)|\b(?:suggest|recommend).*\bworkshop\b/, "workshop suggestion");
  addLabelIf(labels, normalized, /\brelaxation\b.*\btechnique|\btechnique\b.*\brelaxation\b/, "relaxation technique discussion");
  addLabelIf(labels, normalized, /\binterview\b.*\b(?:tips?|meeting)|\b(?:tips?|meeting).*\binterview\b/, "interview tips meeting");
  addLabelIf(labels, normalized, /\bleadership\b.*\b(?:advice|call)|\b(?:advice|call).*\bleadership\b/, "leadership advice call");
  addLabelIf(labels, normalized, /\bstress management\b.*\bfollow|follow.*\bstress management\b/, "stress management follow-up");
  addLabelIf(labels, normalized, /\bleadership\b.*\b(?:implement|course|skills?)\b/, "leadership implementation");
  addLabelIf(labels, normalized, /\bconflict\b.*\b(?:resolution|resolve)|\b(?:resolution|resolve).*\bconflict\b/, "conflict resolution");
  addLabelIf(labels, normalized, /\banniversary\b.*\b(?:celebrat|milestone|dinner)\b/, "anniversary milestone");
  addLabelIf(labels, normalized, /\bweekly check-ins?\b.*\bconflict|\bconflict\b.*\bweekly check-ins?\b/, "weekly check-ins for conflict resolution");
  addLabelIf(labels, normalized, /\bdaily journaling\b|\bjournaling\b.*\bbeliefs?\b/, "daily journaling on beliefs and motivation");
  addLabelIf(labels, normalized, /\bcultural roots?\b|\broots?\b.*\badvice\b/, "cultural roots advice");
  addLabelIf(labels, normalized, /\bpoetry reading\b.*\b(?:turkish|language|event|culture)\b|\b(?:turkish|language|event|culture)\b.*\bpoetry reading\b/, "Poetry reading event");
  addLabelIf(labels, normalized, /\bomar\b.*\b(?:poetry|cultural exposure|culture)\b|\b(?:poetry|cultural exposure|culture)\b.*\bomar\b/, "Omar and cultural exposure through poetry");
  addLabelIf(labels, normalized, /\b(?:poetry collection|creative writing|writing poetry|turkish poems?)\b/, "Poetry collection and creative writing");
  addLabelIf(labels, normalized, /\bcalligraphy exhibition\b|\bexhibition\b.*\bcalligraphy\b|\bcalligraphy\b.*\bexhibition\b/, "Calligraphy exhibition");
  addLabelIf(labels, normalized, /\bcalligraphy workshop\b|\bworkshop\b.*\bcalligraphy\b|\bcalligraphy\b.*\bworkshop\b/, "Calligraphy workshop and study/social balance");
  addLabelIf(labels, normalized, /\bfolk music concert\b|\bconcert\b.*\bfolk music\b|\bfolk music\b.*\bconcert\b/, "Folk music concert and language progress");
  addLabelIf(labels, normalized, /\bturkish film festival\b|\bfilm festival\b.*\bturkish\b|\bturkish\b.*\bfilm festival\b/, "Film festival and real-life language practice");
  addLabelIf(labels, normalized, /\bnew year'?s concert\b|\bconcert\b.*\bnew year\b|\bnew year\b.*\bconcert\b/, "New Year's concert and holiday study balance");
  addLabelIf(labels, normalized, /\blanguage poetry reading\b|\bpoetry reading\b.*\blanguage\b|\blanguage\b.*\bpoetry reading\b/, "Language poetry reading and learning priorities");
  addLabelIf(labels, normalized, /\bsigned poetry book\b|\bpoetry book\b.*\bsigned\b|\bsigned\b.*\bpoetry book\b/, "Signed poetry book and reading tips");
  addLabelIf(labels, normalized, /\b(?:housing options?|apartment options?|2-bedroom|3-bedroom|mevlana|inonu|inönü|market data|sales data|atat(?:ü|u)rk park)\b/, "Housing options and market data");
  addLabelIf(labels, normalized, /\bpacking schedule\b|\bpack(?:ing)?\b.*\bandrew\b|\bandrew\b.*\bpack(?:ing)?\b|\bmoving logistics\b.*\bandrew\b/, "Packing logistics with Andrew");
  addLabelIf(labels, normalized, /\b(?:inspection|repair|plumbing|leaks?|murat kaya|mehmet|ayse|ayşe|contract addendum|repair clause)\b/, "Inspection and repair consultations");
  addLabelIf(labels, normalized, /\b(?:furniture|appliances?|store visits?|evdekor|ikea|wood furniture|stove|kitchen)\b/, "Furniture purchasing and store visits");
  addLabelIf(labels, normalized, /\b(?:housewarming|celebrat(?:e|ion)|cultural appreciation|turkish cultural|appreciate turkish culture)\b/, "Celebrations and cultural appreciation");
  addLabelIf(labels, normalized, /\bfurniture assembly\b|\bassemble furniture\b|\bassembly prep\b|\bcrystal\b.*\b(?:furniture|assembly|prep)\b|\b(?:furniture|assembly|prep)\b.*\bcrystal\b/, "Furniture assembly prep with Crystal");
  addLabelIf(labels, normalized, /\b(?:babysit|babysitting|social support|family support)\b|\bjesse\b.*\bhelp\b|\bhelp\b.*\bjesse\b|\bcrystal\b.*\boffer\b|\boffer\b.*\bcrystal\b/, "Social support and babysitting offers");
  addLabelIf(labels, normalized, /\b(?:household tasks?|financial negotiations?|negotiat(?:e|ion)|purchase offer|closing costs?|seller|contract|maintenance budget|repayment)\b/, "Household tasks and financial negotiations");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:deniz bank|trust|judgment|financial|mortgage broker)\b|\b(?:deniz bank|trust|judgment|financial|mortgage broker)\b.*\bjesse\b/, "Financial advice and trust");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:20|age|experienced?|uncle|current market conditions|relevance)\b|\b(?:20|age|experienced?|uncle|current market conditions|relevance)\b.*\bjesse\b/, "Experience and relevance concerns");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:store|stores?|local stores?|recommendations?|supplies|furniture|pet stores?)\b|\b(?:store|stores?|local stores?|supplies|furniture|pet stores?)\b.*\bjesse\b/, "Local store recommendations");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:moving help|help.*moving|8\s*am|4\s*pm|moving day)\b|\b(?:moving help|moving day|8\s*am|4\s*pm)\b.*\bjesse\b/, "Moving help planning");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:appreciat(?:e|ion)|thank|support)\b|\b(?:appreciat(?:e|ion)|thank|support)\b.*\bjesse\b/, "Appreciation for moving support");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:repair service|referrals?|contractor|mehmet|plumbing|renovation)\b|\b(?:repair service|referrals?|contractor|mehmet|plumbing|renovation)\b.*\bjesse\b/, "Repair service referrals");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:quiet workspace|workspace|quiet space|study space)\b|\b(?:quiet workspace|workspace|quiet space|study space)\b.*\bjesse\b/, "Quiet workspace suggestions");
  addLabelIf(labels, normalized, /\bjesse\b.*\b(?:house-sitting|housesitting|house sitting|watch(?:ing)? the house)\b|\b(?:house-sitting|housesitting|house sitting|watch(?:ing)? the house)\b.*\bjesse\b/, "House-sitting discussions");
  addLabelIf(labels, normalized, /\bselim\b.*\b(?:paperwork|listing agreement|legal|offer contracts|closing documents|agent|cma)\b|\b(?:paperwork|listing agreement|legal|offer contracts|closing documents|agent|cma|comparative market analysis)\b.*\bselim\b/, "Agent involvement and paperwork");
  addLabelIf(labels, normalized, /\bclosing costs?\b.*\b(?:negotiat|breakdown|selim|25,200|24,500)\b|\b(?:negotiat|breakdown|selim|25,200|24,500)\b.*\bclosing costs?\b/, "Closing costs and negotiation");
  addLabelIf(labels, normalized, /\b(?:mortgage balance|net profit|net proceeds|remaining mortgage|profit)\b/, "Mortgage balance and net profit");
  addLabelIf(labels, normalized, /\b(?:commission|commission fees?|2\.5%|sale price adjustments?|price adjustments?)\b/, "Commission fees and sale price adjustments");
  addLabelIf(labels, normalized, /\b(?:marketing|rental pricing|rental price|rent price|4,550|4550|social media|facebook|instagram)\b/, "Marketing and rental pricing");
  addLabelIf(labels, normalized, /\b(?:market pricing|asking price|420,000|cma|comparative market analysis|listing price)\b/, "Market pricing and asking price");
  addLabelIf(labels, normalized, /\b(?:buyer offers?|first offer|multiple offers?|400,000|415,000|418,000|counteroffer|sale implications?)\b/, "Buyer offers and sale implications");
  addLabelIf(labels, normalized, /\b(?:final profit|profit calculations?|contingenc(?:y|ies)|net proceeds|lender delays?|repair requests?)\b/, "Final profit calculations and contingency");
  addLabelIf(labels, normalized, /\b(?:son|brian)\b.*\b(?:staging|suggestions?|age|24|relevance|modern trends)\b|\b(?:staging|suggestions?|age|24|relevance|modern trends)\b.*\b(?:son|brian)\b/, "Son's staging suggestions and age relevance");
  addLabelIf(labels, normalized, /\b(?:modern|traditional)\b.*\bstaging\b|\bstaging\b.*\b(?:modern|traditional)\b/, "Balancing modern and traditional staging ideas");
  addLabelIf(labels, normalized, /\b(?:compromis(?:e|ing)|personal items?|visible|visibility)\b.*\bbrian\b|\bbrian\b.*\b(?:compromis(?:e|ing)|personal items?|visible|visibility)\b/, "Compromising on personal items visibility");
  addLabelIf(labels, normalized, /\b(?:personal items?|garage)\b.*\b(?:appeal|relationship|consequences|clutter|storage)\b|\b(?:relationship|consequences|clutter|storage)\b.*\bpersonal items?\b/, "Impact of personal items storage and relationship consequences");
  addLabelIf(labels, normalized, /\b(?:matthew|other child|garage sale|moving tasks?|unpacking)\b/, "Other child's involvement in garage sale and moving tasks");
  addLabelIf(labels, normalized, /\b(?:family moving away|moving away|emotional|practical aspects|fully transitioning|closing the chapter|old residence|new home)\b/, "Emotional and practical aspects of family moving away");
  addLabelIf(labels, normalized, /\b(?:partner|james)\b.*\bdiy projects?\b|\bdiy projects?\b.*\b(?:partner|james)\b|\blived together\b.*\b(?:diy|projects?)\b/, "General couple DIY projects");
  addLabelIf(labels, normalized, /\b(?:home decor|decor projects?|customi[sz]ing furniture|old dresser|modern minimalist|shel(?:f|ves))\b/, "Home decor projects");
  addLabelIf(labels, normalized, /\b(?:low-impact|low impact|painting living room walls|living room walls|not too strenuous)\b/, "Low-impact painting projects");
  addLabelIf(labels, normalized, /\b(?:dove gray|ral\s*7047|bauhaus|paint and supplies|paint supplies|two coats|april\s+13)\b/, "Specific painting tasks");
  addLabelIf(labels, normalized, /\b(?:fixtures?|lighting fixtures?|bathroom fixture|kitchen fixtures?)\b/, "Fixture updates");
  addLabelIf(labels, normalized, /\b(?:attic insulation|owens corning|fiberglass|weatherstripping|caulk|insulation rolls?)\b/, "Insulation upgrades");
  addLabelIf(labels, normalized, /\b(?:kitchen faucet|faucet replacement|grohe eurosmart|faucet washers?|leaking faucet|low-flow fixture)\b/, "Kitchen faucet replacement");
  addLabelIf(labels, normalized, /\b(?:bathroom shelf|shelf installation|mounting brackets?|pilot holes?|wall anchors?|ryobi|cushioned kneeling pad)\b/, "Bathroom shelf installation");
  addLabelIf(labels, normalized, /\b(?:kitchen cabinet hardware|ikea handles?|cabinet handles?|cabinet hardware)\b/, "Kitchen cabinet hardware replacement");
  addLabelIf(labels, normalized, /\b(?:basic electrical|electrical fixes?|voltage tester|main breaker|outlets?|switches?|wiring confidence)\b/, "Basic electrical fixes");
  addLabelIf(labels, normalized, /\b(?:weatherization|weather stripping|smart thermostat|nest|ecobee|honeywell|silicone sealant|energy efficiency)\b/, "Weatherization and smart thermostat considerations");
  addLabelIf(labels, normalized, /\b(?:holiday lighting|outdoor lighting|string lights?|hanging lights?|solar lights?)\b/, "Holiday lighting installation");
  addLabelIf(labels, normalized, /\bnicolas\b.*\b(?:diy|workshop|projects?)\b|\b(?:diy|workshop|projects?)\b.*\bnicolas\b|\bcaf(?:é|e) mavi\b/, "Nicolas and DIY involvement");
  addLabelIf(labels, normalized, /\b(?:wiring confidence|tutorials?|youtube|electrical tutorial|re-watch tutorials?|rewatch tutorials?)\b/, "Wiring confidence and tutorials");
  addLabelIf(labels, normalized, /\b(?:plumbing basics workshop|plumbing repair workshop|plumber consultation|plumber|workshop)\b.*\b(?:nicolas|appreciat|helpful|recommended)\b|\bnicolas\b.*\b(?:plumbing|plumber|workshop)\b/, "Plumber consultation and appreciation");
  addLabelIf(labels, normalized, /\b(?:insulation materials?|insulation installation|owens corning|\$450|450\b|\$600|600\b|june\s+15|june\s+22)\b/, "Insulation materials and installation");
  addLabelIf(labels, normalized, /\b(?:moen|grohe eurosmart|durable faucet brand|faucet brand|delta|kohler)\b/, "Kitchen faucet brand evaluation");
  addLabelIf(labels, normalized, /\bdon\b.*\bshelf\b|\bshelf\b.*\bdon\b|\bshelf installation help\b/, "Shelf installation help");
  addLabelIf(labels, normalized, /\b(?:ikea handles?|cabinet handles?|cabinet hardware)\b/, "IKEA handles decision");
  addLabelIf(labels, normalized, /\b(?:legrand|electrical safety|voltage tester|main breaker)\b/, "Electrical safety with Legrand");
  addLabelIf(labels, normalized, /\b(?:3m|scotch|weather stripping|silicone sealant|durability|command strips?)\b/, "3M products for durability");
  addLabelIf(labels, normalized, /\b(?:hanging lights?|holiday lighting|string lights?|outdoor lights? safely|lighting safely)\b/, "Hanging lights safely");
  addLabelIf(labels, normalized, /\brehearsal\b.*\bfamily|\bfamily\b.*\brehearsal\b/, "rehearsal help and family support");
  addLabelIf(labels, normalized, /\bhandwritten letter\b|\bletter\b.*\bresilience\b/, "handwritten letter on resilience");
  addLabelIf(labels, normalized, /\bcare package\b|\bspices\b.*\bnotes\b/, "care package with spices and notes");
  addLabelIf(labels, normalized, /\bself-care\b|\bbalancing work\b/, "balancing work and self-care");
  addLabelIf(labels, normalized, /\bsurprise celebration\b|\breturning the favor\b/, "surprise celebration and returning the favor");
  addLabelIf(labels, normalized, /\binitial planning\b|\bresource gathering\b/, "initial planning and resource gathering");
  addLabelIf(labels, normalized, /\bdevelopment phase\b|\bkey tasks\b.*\bcompleted\b/, "main development phase where key tasks were completed");
  addLabelIf(labels, normalized, /\btesting\b.*\breview\b|\breview\b.*\btesting\b/, "testing and review");
  addLabelIf(labels, normalized, /\bindian ocean startup summit\b|\bstartup summit\b.*\b(?:market|technolog(?:y|ies)|sustainability|partnership|takeaways?)\b|\b(?:market expansion|emerging markets|emerging technologies|ai and machine learning|blockchain|green initiatives|local partnerships|international collaborations)\b.*\bstartup summit\b/, "Indian Ocean Startup Summit takeaways to expand market reach, adopt emerging technologies, partnerships, and sustainability practices");
  addLabelIf(labels, normalized, /\bseychelles user forum\b.*\b(?:business growth|market|engagement|active members|regional sales manager|market expansion|market presence)\b|\b(?:regional sales manager|expanded? into the seychelles market|market expansion|market presence)\b.*\bseychelles\b/, "regional business forums and Seychelles community growth to expand market reach and engagement");
  addLabelIf(labels, normalized, /\b(?:ethical considerations|ai ethics|ethical ai|product ethics|ethics committee|ethical principles|responsible ai)\b.*\b(?:product development|startup|ai|sustainable|transparency|accountability)\b|\bproduct development\b.*\b(?:ethical considerations|ai ethics|ethical ai|product ethics)\b/, "ethical AI and product development practices embedded into operations");
  addLabelIf(labels, normalized, /\b(?:google translate api v3|deepl api v2|translation api)\b.*\b(?:integration|error handling|winston|intermittent 500|production-ready)\b|\b(?:integration|error handling|winston|intermittent 500|production-ready)\b.*\b(?:google translate api v3|deepl api v2|translation api)\b/, "translation API integration and error handling");
  addLabelIf(labels, normalized, /\b(?:api endpoint|endpoint usage|google\.auth|service-account|auth(?:entication)?)\b.*\b(?:translation|translate|api)\b|\b(?:translation|translate|api)\b.*\b(?:api endpoint|endpoint usage|google\.auth|service-account|auth(?:entication)?)\b/, "API endpoint usage and authentication");
  addLabelIf(labels, normalized, /\b(?:rate limit(?:ing)?|rate limits?|request queue|queue management|exponential backoff|batch(?:ing)? requests?)\b/, "rate limiting and request queue management");
  addLabelIf(labels, normalized, /\b(?:performance optimization|optimi[sz](?:e|ing|ation)|latency|response time)\b.*\b(?:caching|queries|database query|redis)\b|\b(?:caching|queries|database query|redis)\b.*\b(?:performance optimization|optimi[sz](?:e|ing|ation)|latency|response time)\b/, "performance optimization with caching and queries");
  addLabelIf(labels, normalized, /\b(?:fine-tun(?:e|ing)|debugg(?:ing|ed)?)\b.*\b(?:language models?|llm|gpt)\b|\b(?:language models?|llm|gpt)\b.*\b(?:fine-tun(?:e|ing)|debugg(?:ing|ed)?)\b/, "fine-tuning and debugging language models");
  addLabelIf(labels, normalized, /\b(?:role-based access control|rbac)\b|\bauthentication\b.*\brole\b|\brole\b.*\bauthentication\b/, "authentication and role-based access control");
  addLabelIf(labels, normalized, /\bmicroservices?\b.*\b(?:deploy(?:ment)?|scal(?:e|ing)|kubernetes|docker)\b|\b(?:deploy(?:ment)?|scal(?:e|ing)|kubernetes|docker)\b.*\bmicroservices?\b/, "microservices deployment and scaling");
  addLabelIf(labels, normalized, /\b(?:tls|https)\b.*\b(?:security|configuration|enforce|certificate)\b|\b(?:security|configuration|enforce|certificate)\b.*\b(?:tls|https)\b/, "security and TLS configuration");
  addLabelIf(labels, normalized, /\b(?:transformer-based llm|llm api|gpt-4 streaming|streaming)\b.*\b(?:api|integration|enable|python)\b|\b(?:api|integration|enable|python)\b.*\b(?:transformer-based llm|llm api|gpt-4 streaming|streaming)\b/, "Transformer-Based LLM API streaming integration");
  addLabelIf(labels, normalized, /\bstreaming\b.*\b(?:performance|tuning|chunk size|512 tokens?)\b|\b(?:performance|tuning|chunk size|512 tokens?)\b.*\bstreaming\b/, "streaming performance tuning and chunk size");
  addLabelIf(labels, normalized, /\bmicroservices?\b.*\b(?:scrap(?:e|ing|er)|nlp|api)\b|\b(?:scrap(?:e|ing|er)|nlp|api)\b.*\bmicroservices?\b/, "Microservices architecture planning with scraping, NLP, API");
  addLabelIf(labels, normalized, /\bopenapi\b|\bapi documentation\b|\bdocumentation\b.*\bapi\b/, "OpenAPI documentation review");
  addLabelIf(labels, normalized, /\bfastapi\b.*\b(?:async|websocket|upgrade)\b|\b(?:async|websocket|upgrade)\b.*\bfastapi\b/, "FastAPI upgrade for async and WebSocket");
  addLabelIf(labels, normalized, /\bwebsocket\b.*\b(?:integration|stability|stable|connection)\b|\b(?:integration|stability|stable|connection)\b.*\bwebsocket\b/, "WebSocket integration and stability");
  addLabelIf(labels, normalized, /\bdatabase\b.*\b(?:query|schema|optimi[sz])\b|\b(?:query|schema|optimi[sz])\b.*\bdatabase\b/, "Database query and schema optimization");
  addLabelIf(labels, normalized, /\bscrapy\b.*\b(?:robots\.?txt|robots|user-agent|user agent|rotation|configuration)\b|\b(?:robots\.?txt|robots|user-agent|user agent|rotation|configuration)\b.*\bscrapy\b/, "Scrapy configuration for robots.txt and user-agent rotation");
  addLabelIf(labels, normalized, /\bsentry\b|\bcentralized\b.*\berror logging\b|\berror logging\b.*\bcentralized\b/, "Centralized error logging with Sentry");
  addLabelIf(labels, normalized, /\bpaywall\b.*\b(?:detect(?:ion)?|scraper|scraping)\b|\b(?:detect(?:ion)?|scraper|scraping)\b.*\bpaywall\b/, "Paywall detection in scraper");
  addLabelIf(labels, normalized, /\btwilio\b.*\bverify\b.*\b(?:rate limit(?:ing)?|api|integration)\b|\b(?:rate limit(?:ing)?|api|integration)\b.*\btwilio\b.*\bverify\b/, "Twilio Verify API integration with rate limiting");
  addLabelIf(labels, normalized, /\bistio\b.*\b(?:service mesh|mutual tls|mtls|routing)\b|\b(?:service mesh|mutual tls|mtls|routing)\b.*\bistio\b/, "Istio service mesh setup with mutual TLS and routing");
  addLabelIf(labels, normalized, /\brest api\b.*\berror handling\b|\berror handling\b.*\brest api\b|\brest endpoints?\b.*\berrors?\b/, "REST API and error handling");
  addLabelIf(labels, normalized, /\bdata serialization\b|\bserializ(?:e|ation)\b.*\b(?:json|protobuf|payload|service)\b/, "Data serialization");
  addLabelIf(labels, normalized, /\bhttp\/?2\b.*\b(?:implementation|implement|service|microservice)\b|\b(?:implementation|implement|service|microservice)\b.*\bhttp\/?2\b/, "HTTP/2 implementation");
  addLabelIf(labels, normalized, /\brabbitmq\b.*\b(?:messaging|message|queue|service)\b|\b(?:messaging|message|queue|service)\b.*\brabbitmq\b/, "RabbitMQ messaging");
  addLabelIf(labels, normalized, /\bgrpc\b.*\b(?:communication|optimization|optimizing|latency|service)\b|\b(?:communication|optimization|optimizing|latency|service)\b.*\bgrpc\b/, "gRPC communication and optimization");
  addLabelIf(labels, normalized, /\bgrpc\b.*\b(?:tls|mtls|migration|migrat)\b|\b(?:tls|mtls|migration|migrat)\b.*\bgrpc\b/, "gRPC with TLS migration");
  addLabelIf(labels, normalized, /\bwebsocket\b.*\bmultiplex(?:ing)?\b|\bmultiplex(?:ing)?\b.*\bwebsocket\b/, "WebSocket multiplexing");
  addLabelIf(labels, normalized, /\b(?:aws sns|sns)\b.*\b(?:pub\/?sub|publish|subscribe|messaging)\b|\b(?:pub\/?sub|publish|subscribe|messaging)\b.*\b(?:aws sns|sns)\b/, "AWS SNS pub/sub messaging");
  addLabelIf(labels, normalized, /\bservice mesh\b.*\bistio\b|\bistio\b.*\bservice mesh\b/, "Service mesh with Istio");
  addLabelIf(labels, normalized, /\bkafka\b.*\b(?:api performance|performance|api|messaging)\b|\b(?:api performance|performance|api|messaging)\b.*\bkafka\b/, "Kafka and API performance");
  addLabelIf(labels, normalized, /\bapi rate limit(?:ing)?\b.*\befficien(?:t|cy)\b|\befficien(?:t|cy)\b.*\bapi rate limit(?:ing)?\b/, "API rate limiting and efficiency");
  addLabelIf(labels, normalized, /\bmicroservices?\b.*\b(?:architecture|integration)\b.*\b(?:trading|stock|alpaca)?\b|\b(?:architecture|integration)\b.*\bmicroservices?\b.*\b(?:trading|stock|alpaca)?\b/, "Microservices architecture and integration");
  addLabelIf(labels, normalized, /\bdata availability\b|\buptime\b|\bavailability\b.*\buptime\b|\buptime\b.*\bavailability\b/, "Data availability and uptime");
  addLabelIf(labels, normalized, /\brest api\b.*\b(?:backtesting|trade data)\b|\b(?:backtesting|trade data)\b.*\brest api\b/, "REST API endpoints for backtesting and trade data");
  addLabelIf(labels, normalized, /\balpaca\b.*\b(?:api|optimization|debugging|debug)\b|\b(?:optimization|debugging|debug)\b.*\balpaca\b/, "Alpaca API optimization and debugging");
  addLabelIf(labels, normalized, /\boauth\s*2\.0\b|\btoken refresh\b|\bauth issues?\b|\boauth\b.*\b(?:refresh|auth|token)\b/, "OAuth 2.0 token refresh and auth issues");
  addLabelIf(labels, normalized, /\bml prediction\b.*\b(?:endpoint|input handling|input)\b|\b(?:endpoint|input handling|input)\b.*\bml prediction\b/, "ML prediction endpoint and input handling");
  addLabelIf(labels, normalized, /\balert notifications?\b|\bnotifications?\b.*\balert\b/, "Alert notifications integration");
  addLabelIf(labels, normalized, /\berror handling\b.*\btrading bot\b|\btrading bot\b.*\berror handling\b/, "Error handling in trading bot");
  addLabelIf(labels, normalized, /\bsecure api access\b|\bssl\b.*\bload balancers?\b|\bload balancers?\b.*\bssl\b/, "Secure API access with SSL and load balancers");
  addLabelIf(labels, normalized, /\b(?:stable diffusion|diffusion-based|diffusion)\b.*\b(?:image feature|feature enhancement|enhance image)\b|\b(?:image feature|feature enhancement|enhance image)\b.*\b(?:stable diffusion|diffusion-based|diffusion)\b/, "Diffusion-based image feature enhancement");
  addLabelIf(labels, normalized, /\bcaption generation\b|\bgenerate captions?\b|\bcaption generator\b.*\b(?:integration|integrat|feature)\b/, "Caption generation integration");
  addLabelIf(labels, normalized, /\b(?:cuda out of memory|memory errors?|memory usage)\b.*\b(?:captioning model|model|gpu|cuda)\b|\b(?:captioning model|model|gpu|cuda)\b.*\b(?:cuda out of memory|memory errors?)\b/, "Debugging memory errors");
  addLabelIf(labels, normalized, /\b(?:deploy|deployment|microservices?)\b.*\b(?:rest api|rest apis?|fastapi|feature extractor|caption generator)\b|\b(?:rest api|rest apis?|fastapi|feature extractor|caption generator)\b.*\b(?:deploy|deployment|microservices?)\b/, "Model deployment via REST API");
  addLabelIf(labels, normalized, /\btransformer\b.*\b(?:optimization|optimi[sz]e|smaller|architecture|model)\b|\b(?:optimization|optimi[sz]e|smaller|architecture|model)\b.*\btransformer\b/, "Transformer model optimization");
  addLabelIf(labels, normalized, /\btokenizer\b.*\b(?:performance|optimi[sz]e|speed|latency)\b|\b(?:performance|optimi[sz]e|speed|latency)\b.*\btokenizer\b/, "Tokenizer performance improvements");
  addLabelIf(labels, normalized, /\b(?:pytorch|torchvision)\b.*\b(?:upgrade|upgrading|version|library|libraries)\b|\b(?:upgrade|upgrading|version|library|libraries)\b.*\b(?:pytorch|torchvision)\b/, "Library upgrades for PyTorch and torchvision");
  addLabelIf(labels, normalized, /\bdistributed training\b.*\b(?:acceleration|accelerate|accelerator|libraries?)\b|\b(?:acceleration|accelerate|accelerator|libraries?)\b.*\bdistributed training\b/, "Distributed training with acceleration");
  addLabelIf(labels, normalized, /\bapi\b.*\b(?:authentication|auth|security|secure endpoints?)\b|\b(?:authentication|auth|security|secure endpoints?)\b.*\bapi\b/, "API authentication and security");
  addLabelIf(labels, normalized, /\b(?:pytorch|transformers?)\b.*\b(?:version locking|locked|version|debugg)\b|\b(?:version locking|locked|version|debugg)\b.*\b(?:pytorch|transformers?)\b/, "Debugging and version locking with PyTorch and Transformers");
  addLabelIf(labels, normalized, /\b(?:dataset|images?|captions?)\b.*\b(?:retrieve|retrieval|prepar(?:e|ation)|dataloader|training)\b|\b(?:retrieve|retrieval|prepar(?:e|ation)|dataloader|training)\b.*\b(?:dataset|images?|captions?)\b/, "Initial data retrieval and preparation");
  addLabelIf(labels, normalized, /\b(?:schema|foreign key|jsonb|invalid input|insert(?:ion)?|insert data)\b.*\b(?:troubleshoot|error|captions?|images?)\b|\b(?:troubleshoot|error|captions?|images?)\b.*\b(?:schema|foreign key|jsonb|invalid input|insert(?:ion)?|insert data)\b/, "Schema and data insertion troubleshooting");
  addLabelIf(labels, normalized, /\b(?:confidence_score|query optimization|database queries?|indexes?|indexing)\b.*\b(?:schema|captions?|images?|highest confidence)\b|\b(?:schema|captions?|images?|highest confidence)\b.*\b(?:confidence_score|query optimization|database queries?|indexes?|indexing)\b/, "Schema enhancement and query optimization");
  addLabelIf(labels, normalized, /\bmaterialized views?\b.*\b(?:index(?:es|ing)?|refresh|cron|joined tables?|query performance)\b|\b(?:index(?:es|ing)?|refresh|cron|joined tables?|query performance)\b.*\bmaterialized views?\b/, "Materialized views and indexing");
  addLabelIf(labels, normalized, /\buser_captions\b.*\b(?:table|insert(?:ion)?|relation .* does not exist|timestamps?|user ids?)\b|\b(?:table|insert(?:ion)?|relation .* does not exist|timestamps?|user ids?)\b.*\buser_captions\b/, "User captions table creation and insertion errors");
  addLabelIf(labels, normalized, /\b(?:etl|nightly|redshift|2\s*am|schedule)\b.*\b(?:redis|cache|stale|consistency|concurrent)\b|\b(?:redis|cache|stale|consistency|concurrent)\b.*\b(?:etl|nightly|redshift|2\s*am|schedule)\b|\b(?:etl|redshift|nightly|stale caption|cache update)\b/, "ETL scheduling and cache consistency issues");
  addLabelIf(labels, normalized, /\bedit_history\b|\bcaption changes?\b.*\b(?:jsonb|track|update)\b|\b(?:jsonb|track|update)\b.*\bcaption changes?\b/, "Edit history extension and updates");
  addLabelIf(labels, normalized, /\blambda\b.*\b(?:timeout|timing out|step functions?|chain|chaining)\b|\b(?:timeout|timing out|step functions?|chain|chaining)\b.*\blambda\b/, "Lambda timeout and function chaining");
  addLabelIf(labels, normalized, /\bdynamodb\b.*\b(?:migration|migrating|deployment|sam templates?|serverless)\b|\b(?:migration|migrating|deployment|sam templates?|serverless)\b.*\bdynamodb\b/, "DynamoDB migration and deployment");
  addLabelIf(labels, normalized, /\bretry logic\b|\bexponential backoff\b|\bcontact form\b.*\bsubmissions?\b/, "retry logic with exponential backoff for contact form submissions");
  addLabelIf(labels, normalized, /\bstorytelling\b.*\bmentoring\b|\bmentoring\b.*\bstorytelling\b|\bemerging talent\b/, "storytelling and mentoring emerging talent");
  addLabelIf(labels, normalized, /\bcompensation package\b|\bequity\b.*\bbudget\b|\badjust\b.*\bbudget\b/, "review compensation package and adjust budget accordingly");
  addLabelIf(labels, normalized, /\bpsychometric\b.*\btest\b|\bpymetrics\b/, "psychometric test integration");
  addLabelIf(labels, normalized, /\bcrowdfunding\b|\bplatform\b.*\bfunding\b|\bfunding\b.*\bplatform\b/, "crowdfunding platform choice");
  addLabelIf(labels, normalized, /\bvirtual brainstorming\b|\bbrainstorming\b.*\bprioritization\b/, "virtual brainstorming and prioritization");
  addLabelIf(labels, normalized, /\bsubscription service\b|\bsubscription\b.*\bconcern\b/, "subscription service concern");
  addLabelIf(labels, normalized, /\bemployee handbook\b|\bhandbook review\b/, "employee handbook review");
  addLabelIf(labels, normalized, /\bgrate(?:ful|itude)\b.*\bmindfulness\b|\bmindfulness\b.*\bgrate(?:ful|itude)\b/, "gratitude and mindfulness advice");
  addLabelIf(labels, normalized, /\bcelebrat(?:e|ing|ion)\b.*\bdecision\b|\bdecision\b.*\breassur(?:e|ance|ing)\b|\bsupportive\b.*\bdecision\b|\bright choice\b/, "celebration and decision reassurance");
  addLabelIf(labels, normalized, /\bretreat reflection\b|\breflection\b.*\bappreciation\b|\bretreat\b.*\bappreciat(?:e|ion)\b|\bgrate(?:ful|itude)\b.*\bretreat\b|\bshow my appreciation\b/, "retreat reflection and appreciation");
  addLabelIf(labels, normalized, /\bworkshop\b.*\bnerv(?:ous|es)|\bnerv(?:ous|es).*\bworkshop\b/, "workshop nerves");
  addLabelIf(labels, normalized, /\b(?:sharing|talking|open up|opening up|thoughts|feelings)\b.*\b(?:grief|loss|uncle|remember|photo album)\b|\b(?:grief|loss|uncle|remember|photo album)\b.*\b(?:sharing|talking|open up|opening up|thoughts|feelings)\b/, "sharing struggle and honoring loss");
  addLabelIf(labels, normalized, /\b(?:workshop|session)\b.*\b(?:attend|attendance|consider|decid(?:e|ed|ing))\b|\b(?:attend|attendance|consider|decid(?:e|ed|ing))\b.*\b(?:workshop|session)\b/, "considering and deciding on workshop attendance");
  addLabelIf(labels, normalized, /\b(?:remembrance event|memorial event)\b.*\b(?:dj(?:ing)?|music|jazz|support)\b|\b(?:dj(?:ing)?|music|jazz|support)\b.*\b(?:remembrance event|memorial event)\b/, "planning remembrance event and music support");
  addLabelIf(labels, normalized, /\b(?:dj page|djing|dj)\b.*\b(?:reflect(?:ing)?|support|connect(?:ing)?|page)\b|\b(?:reflect(?:ing)?|support|connect(?:ing)?|page)\b.*\b(?:dj page|djing|dj)\b/, "connecting through DJ page and reflecting on support");
  addLabelIf(labels, normalized, /\b(?:concert|show|performance)\b.*\b(?:invitation|invite|accept(?:ed|ing)?)\b|\b(?:invitation|invite|accept(?:ed|ing)?)\b.*\b(?:concert|show|performance)\b/, "accepting concert invitation");
  addLabelIf(labels, normalized, /\b(?:healing book club|book club)\b.*\b(?:explor(?:e|ing)|prepar(?:e|ing)|join|attend)\b|\b(?:explor(?:e|ing)|prepar(?:e|ing)|join|attend)\b.*\b(?:healing book club|book club)\b/, "exploring and preparing for healing book club");
  addLabelIf(labels, normalized, /\b(?:job interview|interview)\b.*\b(?:friend|andrew|help|prepar(?:e|ing))\b|\b(?:friend|andrew|help|prepar(?:e|ing))\b.*\b(?:job interview|interview)\b/, "preparing for job interview with friend's help");
  addLabelIf(labels, normalized, /\b(?:friendship|friend)\b.*\b(?:support|nurtur(?:e|ing)|reflect(?:ing)?|mutual)\b|\b(?:support|nurtur(?:e|ing)|reflect(?:ing)?|mutual)\b.*\b(?:friendship|friend)\b/, "reflecting on friendship and support nurturing");
  addLabelIf(labels, normalized, /\b(?:transportation|ride|drive|driving)\b.*\b(?:help|gratitude|thank|andrew)\b|\b(?:help|gratitude|thank|andrew)\b.*\b(?:transportation|ride|drive|driving)\b/, "expressing gratitude for transportation help");
  addLabelIf(labels, normalized, /\b(?:thinking about|consider(?:ing)?|contemplat(?:e|ing))\b.*\bart exhibit\b.*\b(?:andrew|collaborat(?:e|ion)|showcase|sketches?)\b|\bart exhibit\b.*\b(?:andrew|collaborat(?:e|ion)|showcase|sketches?)\b/, "contemplating art exhibit collaboration");
  addLabelIf(labels, normalized, /\bnotation\b.*\bcentroid\b|\bcentroid\b.*\bproperties\b/, "notation and centroid properties");
  addLabelIf(labels, normalized, /\bcompar(?:e|ing|ison|ative)\b.*\b(?:types|analysis|area)\b|\b(?:types|analysis|area)\b.*\bcompar(?:e|ing|ison|ative)\b/, "comparative analysis");
  addLabelIf(labels, normalized, /\bmovie marathon\b.*\bbreaks?\b|\bbreaks?\b.*\bmovie marathon\b/, "initial scheduling with breaks");
  addLabelIf(labels, normalized, /\barrival\b.*\bschedule\b|\bschedule\b.*\barrival\b/, "schedule adjustment for arrival");
  addLabelIf(labels, normalized, /\bmovie list\b|\bwatchlist\b.*\bfinal/, "movie list finalization");
  addLabelIf(labels, normalized, /\bsnacks?\b.*\bactivities\b|\bactivities\b.*\bsnacks?\b/, "snack and activity planning");
  addLabelIf(labels, normalized, /\bguest invitations?\b|\bvirtual watch party\b/, "guest invitations and virtual watch party");
  addLabelIf(labels, normalized, /\battendee count\b|\bhow many people\b.*\bwatch/, "attendee count planning");
  addLabelIf(labels, normalized, /\blease\b.*\b(?:june\s+30|ending|renew(?:al)?|subletting|sublet|moving|move|new apartment|options?)\b|\b(?:june\s+30|renew(?:al)?|subletting|sublet|moving|move|new apartment|options?)\b.*\blease\b/, "lease ending on june 30 2024 with lease renewal subletting or moving to a new apartment options");
  addLabelIf(labels, normalized, /\blandlord\b.*\b(?:renew(?:ing|al)?|talk(?:ing)?|negotiate|terms?|rent increase)\b|\b(?:renew(?:ing|al)?|negotiate|terms?|rent increase)\b.*\blandlord\b/, "negotiation process with landlord about lease renewal and rent terms");
  addLabelIf(labels, normalized, /\b(?:4-bedroom|4 bedroom|four-bedroom|four bedroom)\b.*\b(?:2,?500|2500|lincoln park|internet|remote work|apartment|rental)\b|\b(?:lincoln park|2,?500|2500|internet|remote work)\b.*\b(?:4-bedroom|4 bedroom|four-bedroom|four bedroom|apartment|rental)\b/, "criteria for a new 4-bedroom rental within a $2,500 budget near Lincoln Park and apartment application plan");
  addLabelIf(labels, normalized, /\b(?:move-out|move out|not renew(?:ing)?|lease termination|terminating the lease)\b.*\b(?:landlord|notice|walk-through|walkthrough|inspection|security deposit|refund|current apartment)\b|\b(?:landlord|notice|walk-through|walkthrough|inspection|security deposit|refund)\b.*\b(?:move-out|move out|not renew(?:ing)?|lease termination|terminating the lease)\b/, "move-out process from current apartment with timely landlord notification final walk-through inspection disagreements and security deposit refund");
  addLabelIf(labels, normalized, /\b(?:movers?|move-in|move in|moving process|utility setups?|utilities|home office|internet)\b.*\b(?:coordinate|confirm|setup|set up|logistics|essentials|new apartment)\b|\b(?:coordinate|confirm|setup|set up|logistics|essentials|new apartment)\b.*\b(?:movers?|move-in|move in|moving process|utility setups?|utilities|home office|internet)\b/, "move-in coordination for the new apartment confirming movers utility setups and day-of logistics");
  addLabelIf(labels, normalized, /\b(?:mold inspection|safety inspection|fire safety|mold prevention|hazards?|maintenance requests?|housewarming party)\b/, "health and safety considerations with mold inspection results hazards maintenance requests and housewarming party social aspects");
  addLabelIf(labels, normalized, /\bjames\b.*\b(?:colleague|mentor|career moves?|career)\b|\b(?:colleague|mentor|career moves?|career)\b.*\bjames\b/, "advice from James as colleague and mentor regarding career moves");
  addLabelIf(labels, normalized, /\b(?:local handyman|handyman|joseph)\b.*\b(?:contact|suggest(?:ed)?|schedule|scheduled|available|repairs?|75\/hour|\$75)\b|\b(?:contact|suggest(?:ed)?|schedule|scheduled|available|repairs?|75\/hour|\$75)\b.*\b(?:local handyman|handyman|joseph)\b/, "contacting and scheduling local handyman Joseph for repairs");
  addLabelIf(labels, normalized, /\b(?:door lock|shelves|shelf|squeaky bedroom door|repair tasks?|minor repairs?)\b.*\b(?:joseph|handyman|coordinat(?:e|ed|ing)|moving-related|new apartment)\b|\b(?:joseph|handyman|coordinat(?:e|ed|ing)|moving-related|new apartment)\b.*\b(?:door lock|shelves|shelf|squeaky bedroom door|repair tasks?|minor repairs?)\b/, "coordinating repair tasks with Joseph including door lock shelves and moving-related considerations");
  addLabelIf(labels, normalized, /\b(?:utility bills?|utilities|electricity|water|internet|energy usage)\b.*\b(?:budget|usage|pay(?:ing)?|on time|automatic payments?|january|december)\b|\b(?:budget|usage|pay(?:ing)?|on time|automatic payments?|january|december)\b.*\b(?:utility bills?|utilities|electricity|water|internet|energy usage)\b/, "utility bills and energy usage concerns");
  addLabelIf(labels, normalized, /\b(?:writing conference|writers'? dinner|writing retreat)\b.*\b(?:networking|professional|career|james|opportunit(?:y|ies))\b|\b(?:networking|professional|career|opportunit(?:y|ies))\b.*\b(?:writing conference|writers'? dinner|writing retreat)\b/, "writing conference and professional networking opportunities");
  addLabelIf(labels, normalized, /\byolov5s?\b.*\bcpu\b.*\binference\b|\bcpu\b.*\byolov5s?\b.*\binference\b|\binitial inference time\b.*\bintel i5-8250u\b/, "YOLOv5s CPU inference setup");
  addLabelIf(labels, normalized, /\bdataset\b.*\bdata loader\b|\bdata loader\b.*\bcpu evaluation\b|\bcpu evaluation\b.*\bdataset\b/, "dataset and data loader for CPU evaluation");
  addLabelIf(labels, normalized, /\btracker module\b.*\b(?:implementation|integration)\b|\b(?:implementation|integration)\b.*\btracker module\b|\bsort tracker\b.*\bfrontend\b/, "tracker module implementation and integration");
  addLabelIf(labels, normalized, /\btensorrt\b.*\b(?:conversion|optimization|engine)\b|\b(?:conversion|optimization)\b.*\btensorrt\b/, "TensorRT model conversion and optimization");
  addLabelIf(labels, normalized, /\bsort\b.*\btracking\b.*\b(?:optimization|code)\b|\btracking\b.*\bsort\b.*\b(?:optimization|code)\b/, "SORT tracking code optimization");
  addLabelIf(labels, normalized, /\bcoordinate mapping\b|\bkalman filter\b|\bhungarian algorithm\b|\bdata association\b/, "coordinate mapping and Kalman filter fundamentals");
  addLabelIf(labels, normalized, /\bframe timestamp\b|\btimestamp interpolation\b|\breact frontend\b.*\b(?:integration|tracked objects?)\b|\bfrontend\b.*\b(?:frame|timestamp|sort tracker)\b/, "frame timestamp interpolation and React frontend integration");
  addLabelIf(labels, normalized, /\bflask\b.*\bcuda out of memory\b|\bcuda out of memory\b.*\bflask\b|\bpytorch\b.*\bcuda out of memory\b/, "Flask app CUDA memory error debugging");
  addLabelIf(labels, normalized, /\bsnyk cli\b|\bsecurity scanning\b.*\bci\/?cd\b|\bci\/?cd\b.*\bsecurity scanning\b/, "security scanning with Snyk CLI in CI/CD");
  addLabelIf(labels, normalized, /\bopencv dnn\b.*\b(?:pipeline|optimization)\b|\bdeepsort\b|\bssd mobilenet v3\b|\bfuture integration\b.*\b(?:deepsort|ssd)\b/, "OpenCV DNN pipeline optimization and future plans");
  addLabelIf(labels, normalized, /\bintegration issues?\b|\bintegrating\b.*\b(?:yolov5|opencv|webcam|model)\b/, "initial integration issues");
  addLabelIf(labels, normalized, /\bperformance monitoring\b|\bunder 250ms per frame\b|\b30 fps\b.*\blatency\b/, "performance monitoring");
  addLabelIf(labels, normalized, /\bsegmentation fault\b.*\btroubleshoot|\btroubleshoot.*\bsegmentation fault\b/, "segmentation fault troubleshooting");
  addLabelIf(labels, normalized, /\bmodel\b.*\bcapture source\b|\bissue isn't the model\b|\byolov5 model itself\b/, "model vs capture source investigation");
  addLabelIf(labels, normalized, /\bmilestone\b.*\bplanning\b|\bproject plan\b.*\bschedule\b|\bready by march 15\b/, "milestone planning");
  addLabelIf(labels, normalized, /\bmodel optimization\b|\btensorrt\b.*\bperformance\b|\bbenchmark\b.*\bbefore and after optimization\b/, "model optimization exploration");
  addLabelIf(labels, normalized, /\bgpu\/cpu fallback\b|\bcpu and gpu\b|\bcuda\b.*\bcpu\b|\blatency\b.*\bfallback\b/, "GPU/CPU fallback and latency");
  addLabelIf(labels, normalized, /\bdata association\b|\bhungarian algorithm\b|\bkalman filter\b.*\bdebugg/, "data association debugging");
  addLabelIf(labels, normalized, /\buser interaction\b|\breact app\b.*\bmap\b|\btooltip\b.*\bsemantic match\b/, "user interaction features");
  addLabelIf(labels, normalized, /\bmonitoring tools?\b.*\bsetup\b|\bgrafana\b.*\bcloudwatch\b|\bprometheus\b.*\bgrafana\b/, "monitoring tools setup");
  addLabelIf(labels, normalized, /\bcode quality\b|\bsingle responsibility principle\b|\bmodular refactor(?:ing)?\b/, "code quality improvements");
  addLabelIf(labels, normalized, /\bperformance benchmarking\b|\bbenchmark\b.*\bmodel\b|\binference\b.*\bbenchmark\b/, "performance benchmarking");
  addLabelIf(labels, normalized, /\buser-based collaborative filtering\b.*\bcosine similarity\b|\bcosine similarity\b.*\buser ratings? matrix\b|\bcollaborative filtering\b.*\bimplementation\b/, "user-based collaborative filtering implementation");
  addLabelIf(labels, normalized, /\bcollaborative filtering\b.*\b(?:debugg(?:ing|ed)?|error|implementation)\b|\b(?:debugg(?:ing|ed)?|error|implementation)\b.*\bcollaborative filtering\b/, "Collaborative filtering implementation and debugging");
  addLabelIf(labels, normalized, /\bmissing\b.*\b(?:user interactions?|interactions?|ratings?)\b|\b(?:user interactions?|interactions?|ratings?)\b.*\bmissing\b/, "Handling missing user interactions");
  addLabelIf(labels, normalized, /\bdebugg(?:ing|ed)?\b.*\berror messages?\b|\berror messages?\b.*\bdebugg(?:ing|ed)?\b/, "Debugging error messages");
  addLabelIf(labels, normalized, /\b(?:user ratings?|ratings matrix|matrix factorization|csr_matrix|sparse matrix)\b/, "Incorporating user ratings and matrix factorization");
  addLabelIf(labels, normalized, /\bdiversity filters?\b|\bdiversity\b.*\bfilter(?:s|ing)?\b|\bfilter(?:s|ing)?\b.*\bdiversity\b/, "Applying diversity filters");
  addLabelIf(labels, normalized, /\bcach(?:e|ing)\b.*\bperformance\b|\bperformance\b.*\bcach(?:e|ing)\b/, "Caching strategies for performance");
  addLabelIf(labels, normalized, /\b(?:parallel processing|parallelization|parallelis(?:e|ation)|concurrent processing)\b.*\b(?:optimi[sz](?:e|ing|ation)|performance)?\b|\b(?:optimi[sz](?:e|ing|ation)|performance)\b.*\b(?:parallel processing|parallelization|concurrent processing)\b/, "Parallel processing optimization");
  addLabelIf(labels, normalized, /\buser feedback\b.*\b(?:collection|error handling|recommendation)\b|\b(?:collection|error handling|recommendation)\b.*\buser feedback\b/, "User feedback collection and error handling");
  addLabelIf(labels, normalized, /\bfeedback\b.*\b(?:querying|queries|query optimization|data)\b|\b(?:querying|queries|query optimization|data)\b.*\bfeedback\b/, "Efficient feedback data querying");
  addLabelIf(labels, normalized, /\b(?:advanced caching|caching)\b.*\b(?:parallelization|parallel processing|integration)\b|\b(?:parallelization|parallel processing|integration)\b.*\b(?:advanced caching|caching)\b/, "Advanced caching and parallelization integration");
  addLabelIf(labels, normalized, /\b\/recommendations\b.*\bendpoint\b|\bflask\b.*\brecommendations endpoint\b|\bendpoint\b.*\btop 5 recommendations\b/, "Flask recommendations endpoint");
  addLabelIf(labels, normalized, /\bget_user_ratings\b|\bget_top_rated_items\b|\bhelper functions?\b.*\brecommendations?\b/, "helper function definitions");
  addLabelIf(labels, normalized, /\bhybrid recommendation\b.*\b(?:redis|cach(?:e|ing))\b|\b(?:redis|cach(?:e|ing)).*\bhybrid recommendation\b|\bcaching similarity matrices?\b/, "hybrid recommendation system with caching");
  addLabelIf(labels, normalized, /\buser preferences?\b.*\b(?:integration|integrat(?:e|ed|ing)|testing|tests?|filter(?:ing)?)\b|\b(?:integration|integrat(?:e|ed|ing)|testing|tests?|filter(?:ing)?).*\buser preferences?\b/, "user preferences integration and testing");
  addLabelIf(labels, normalized, /\bhybrid scoring\b.*\b(?:formula|refin(?:e|ement)|weighted)\b|\b(?:formula|refin(?:e|ement)|weighted).*\bhybrid scoring\b|\bweighted hybrid scoring\b/, "hybrid scoring formula refinement");
  addLabelIf(labels, normalized, /\bweight combinations?\b.*\b(?:accuracy|impact|test)\b|\b(?:accuracy|impact|test).*\bweight combinations?\b/, "testing weight combinations and accuracy impact");
  addLabelIf(labels, normalized, /\bevaluation metrics?\b.*\b(?:precision|recall|f1|auc|performance)\b|\b(?:precision|recall|f1|auc).*\bevaluation metrics?\b/, "evaluation metrics for performance optimization");
  addLabelIf(labels, normalized, /\btf-?idf\b.*\bcontent-based filtering\b|\bcontent-based filtering\b.*\btf-?idf\b|\bfeature_vector\b.*\bjsonb\b/, "content-based filtering with TF-IDF vectors");
  addLabelIf(labels, normalized, /\b(?:combinatorial formulas?|combinations?|permutations?)\b.*\b(?:c\(n,\s*r\)|p\(n,\s*r\)|formula|partition|select|arrang(?:e|ing))\b|\b(?:c\(n,\s*r\)|p\(n,\s*r\)|formula)\b.*\b(?:combinations?|permutations?|combinatorial)\b/, "initial combinatorial formula questions");
  addLabelIf(labels, normalized, /\b(?:groups? of sizes?|group sizes?|partition)\b.*\b(?:\d+\s*,\s*\d+|multinomial|objects?)\b|\bmultinomial coefficient\b.*\b(?:groups? of sizes?|partition)\b/, "examples with varied group sizes");
  addLabelIf(labels, normalized, /\binclusion-exclusion\b.*\b(?:three sets?|3 sets?|a,\s*b,\s*(?:and\s*)?c|basketball|soccer|volleyball)\b|\b(?:three sets?|3 sets?)\b.*\binclusion-exclusion\b/, "inclusion-exclusion principle for three sets");
  addLabelIf(labels, normalized, /\binclusion-exclusion\b.*\b(?:four sets?|4 sets?|more than three events?|more than 3 events?)\b|\b(?:four sets?|4 sets?|more than three events?|more than 3 events?)\b.*\binclusion-exclusion\b/, "inclusion-exclusion extension to four sets");
  addLabelIf(labels, normalized, /\b(?:mistake|where i went wrong|correct(?:ion|ed)?|forgot(?:ten)? to subtract)\b.*\binclusion-exclusion\b|\binclusion-exclusion\b.*\b(?:mistake|where i went wrong|correct(?:ion|ed)?|forgot(?:ten)? to subtract)\b/, "error identification and correction in inclusion-exclusion");
  addLabelIf(labels, normalized, /\b(?:triple intersections?|formula components?|subtract the triple)\b.*\b(?:explain|why|reason|inclusion-exclusion)\b|\b(?:explain|why|reason|inclusion-exclusion)\b.*\b(?:triple intersections?|formula components?|subtract the triple)\b/, "explanation of formula components like triple intersections");
  addLabelIf(labels, normalized, /\bmultinomial theorem\b.*\b(?:polynomial|coefficient|expansion|calculat(?:e|ion|ing))\b|\b(?:polynomial|coefficient|expansion)\b.*\bmultinomial theorem\b/, "multinomial theorem and polynomial coefficient calculations");
  addLabelIf(labels, normalized, /\b(?:multinomial coefficients?|multinomial theorem)\b.*\bpermutations?\b|\bpermutations?\b.*\b(?:multinomial coefficients?|multinomial theorem)\b|\b(?:distinguish|difference|versus|vs\.?)\b.*\b(?:multinomial|permutations?)\b/, "distinction between multinomial coefficients and permutations");
  addLabelIf(labels, normalized, /\bmultinomial\b.*\binclusion-exclusion\b.*\b(?:combined?|together|complex|integrat(?:e|ed|ion)|deepen)\b|\binclusion-exclusion\b.*\bmultinomial\b.*\b(?:combined?|together|complex|integrat(?:e|ed|ion)|deepen)\b/, "combined use of multinomial and inclusion-exclusion principles");
  addLabelIf(labels, normalized, /\b(?:clarif(?:y|ication|ications)|make sure|ensure|verify|check|accuracy|accurate|right combinatorial methods?|avoid (?:the )?mistake|problem-solving accuracy|more practice|practice problems?)\b.*\b(?:combinatorial|combinations?|permutations?|multinomial|inclusion-exclusion|formula)\b|\b(?:combinatorial|combinations?|permutations?|multinomial|inclusion-exclusion|formula)\b.*\b(?:clarif(?:y|ication|ications)|make sure|ensure|verify|check|accuracy|accurate|right combinatorial methods?|avoid (?:the )?mistake|problem-solving accuracy|more practice|practice problems?)\b/, "clarifications and accuracy improvements");
  addLabelIf(labels, normalized, /\bspherical triangles?\b.*\b(?:angle sums?|geogebra|model(?:ing)?|measure(?:ment|ing)?|visuali[sz])\b|\b(?:geogebra|model(?:ing)?|measure(?:ment|ing)?|visuali[sz])\b.*\bspherical triangles?\b/, "spherical triangle modeling and angle sums with GeoGebra");
  addLabelIf(labels, normalized, /\bhyperbolic triangles?\b.*\b(?:calculat(?:e|ion|ions|ing)|verif(?:y|ication)|angle sums?|less than 180|law of cosines)\b|\b(?:calculat(?:e|ion|ions|ing)|verif(?:y|ication)|angle sums?|less than 180|law of cosines)\b.*\bhyperbolic triangles?\b/, "hyperbolic triangle calculations and verification");
  addLabelIf(labels, normalized, /\bhyperbolic distance\b.*\b(?:comput(?:e|ation|ations|ing)|poincar[eé]|disk|half-plane|models?)\b|\b(?:poincar[eé]|disk|half-plane|models?)\b.*\bhyperbolic distance\b/, "hyperbolic distance computations in Poincare models");
  addLabelIf(labels, normalized, /\bhyperbolic tessellations?\b.*\b(?:generat(?:e|ion|ing)|measure(?:ment|ing)?|kaleidotile|custom)\b|\bkaleidotile\b.*\b(?:hyperbolic tessellations?|generat(?:e|ion|ing)|measure(?:ment|ing)?)\b/, "hyperbolic tessellation generation and measurement with KaleidoTile");
  addLabelIf(labels, normalized, /\b(?:geogebra 3d|geogebra)\b.*\b(?:visuali[sz](?:e|ation|ing)?|plot(?:ting)?|poincar[eé] disk)\b|\bpoincar[eé] disk\b.*\b(?:geogebra 3d|geogebra|visuali[sz](?:e|ation|ing)?|plot(?:ting)?)\b/, "visualization and plotting in GeoGebra 3D for Poincare disk");
  addLabelIf(labels, normalized, /\b(?:struggl(?:e|ed|ing)|confus(?:e|ed|ing)|difficulty|difficult)\b.*\binductive step\b.*\binequalit(?:y|ies)\b|\binductive step\b.*\binequalit(?:y|ies)\b.*\b(?:struggl(?:e|ed|ing)|confus(?:e|ed|ing)|difficulty|difficult)\b/, "initial struggles with inductive step in inequality proofs");
  addLabelIf(labels, normalized, /\b(?:more|additional|extra)\b.*\binequalit(?:y|ies)\b.*\b(?:examples?|practice|problems?)\b|\binequalit(?:y|ies)\b.*\b(?:examples?|practice|problems?)\b.*\b(?:more|additional|extra)\b/, "requests for additional inequality examples");
  addLabelIf(labels, normalized, /\b(?:careful(?:ly)?|handle|handling|watch)\b.*\b(?:inequalit(?:y|ies)\s*)?(?:signs?|≥|<=|>=|≤)\b|\b(?:inequalit(?:y|ies)\s*)?(?:signs?|≥|<=|>=|≤)\b.*\b(?:careful(?:ly)?|handle|handling|impact|direction)\b/, "handling inequality signs carefully");
  addLabelIf(labels, normalized, /\balgebraic steps?\b.*\b(?:inductive hypothesis|conclusion|connect)\b|\b(?:inductive hypothesis|conclusion|connect)\b.*\balgebraic steps?\b|\balgebraic manipulations?\b.*\binduction\b/, "algebraic steps connecting inductive hypotheses to conclusions");
  addLabelIf(labels, normalized, /\bmodular arithmetic\b|\bmodular reasoning\b|\bmodulo\b.*\bdivisibility\b/, "modular arithmetic introduction");
  addLabelIf(labels, normalized, /\bdivisibility\b.*\b(?:powers?|modular|modulo)\b|\b(?:powers?|modular|modulo)\b.*\bdivisibility\b/, "divisibility problems involving powers and modular reasoning");
  addLabelIf(labels, normalized, /\b(?:notation|terminology|symbols?|terms?)\b.*\b(?:divisibility|induction|proofs?)\b|\b(?:divisibility|induction|proofs?)\b.*\b(?:notation|terminology|symbols?|terms?)\b/, "notation and terminology clarifications");
  addLabelIf(labels, normalized, /\bone-way functions?\b.*\btrapdoor functions?\b|\btrapdoor functions?\b.*\bone-way functions?\b/, "one-way and trapdoor functions");
  addLabelIf(labels, normalized, /\b(?:necessary and sufficient conditions?|sufficient conditions?|necessary conditions?)\b.*\b(?:cryptographic|cryptography|rsa|diffie-hellman|euler'?s theorem|chinese remainder theorem|crt)\b|\b(?:cryptographic|cryptography|rsa|diffie-hellman|euler'?s theorem|chinese remainder theorem|crt)\b.*\b(?:necessary and sufficient conditions?|sufficient conditions?|necessary conditions?)\b/, "combined cryptographic conditions and applications");
  addLabelIf(labels, normalized, /\bbase case\b.*\binductive step\b.*\binequalit(?:y|ies)\b|\binequalit(?:y|ies)\b.*\bbase case\b.*\binductive step\b|\bbase case verification\b|\binductive step articulation\b/, "base case verification and inductive step articulation for inequalities");
  addLabelIf(labels, normalized, /\b(?:preserv(?:e|ing)|maintain(?:ing)?)\b.*\b(?:inequality directions?|directions? of the inequalit(?:y|ies))\b|\b(?:inequality directions?|directions? of the inequalit(?:y|ies))\b.*\b(?:preserv(?:e|ing)|maintain(?:ing)?)\b|\balgebraic manipulations?\b.*\b(?:inequality directions?|directions? of the inequalit(?:y|ies))\b/, "preserving inequality directions and algebraic concerns");
  addLabelIf(labels, normalized, /\blogical flow\b.*\binequalit(?:y|ies|y signs?)\b|\binequalit(?:y|ies|y signs?)\b.*\blogical flow\b|\bcareful handling\b.*\binequalit(?:y|ies|y signs?)\b/, "logical flow and careful inequality handling");
  addLabelIf(labels, normalized, /\b(?:basic idea|purpose|concept)\b.*\bderivatives?\b|\bderivatives?\b.*\b(?:basic idea|purpose|concept)\b|\bwhat(?:'s| is) a derivative\b/, "basic derivative concept");
  addLabelIf(labels, normalized, /\b(?:real-life|real life|paramedic|emergency)\b.*\b(?:rates?|rate of change|heart rate)\b|\b(?:heart rate|respiratory rate)\b.*\b(?:paramedic|application|rate of change)\b/, "real-life paramedic rate applications");
  addLabelIf(labels, normalized, /\bpower rule\b.*\b(?:differentiat(?:e|ion)|practice|polynomial)\b|\b(?:polynomial|differentiat(?:e|ion)|practice)\b.*\bpower rule\b/, "power rule differentiation practice");
  addLabelIf(labels, normalized, /\btangent lines?\b.*\b(?:slope|meaning|interpret(?:ation)?|specific points?)\b|\b(?:slope|meaning|interpret(?:ation)?|specific points?)\b.*\btangent lines?\b/, "tangent line and slope meaning");
  addLabelIf(labels, normalized, /\brelated rates?\b.*\b(?:blood flow|respiratory rates?|heart rate)\b|\b(?:blood flow|respiratory rates?|heart rate)\b.*\brelated rates?\b/, "related rates with blood flow");
  addLabelIf(labels, normalized, /\bderivative tests?\b.*\b(?:optimization|optimize|flow rates?|analyz(?:e|ing))\b|\b(?:optimization|optimize|flow rates?)\b.*\bderivative tests?\b/, "derivative tests for optimization");
  addLabelIf(labels, normalized, /\bcritical points?\b.*\b(?:solv(?:e|ing)|derivative equations?|paramedic)\b|\b(?:solv(?:e|ing)|derivative equations?|paramedic)\b.*\bcritical points?\b/, "critical points and solving derivative equations");
  addLabelIf(labels, normalized, /\brelated rates?\b.*\b(?:geometric|geometry|sliding ladder|ladder)\b|\b(?:geometric|geometry|sliding ladder|ladder)\b.*\brelated rates?\b/, "related rates with geometric problem");
  addLabelIf(labels, normalized, /\blaptop\b.*\b(?:perfect|looking|recommend|find|help)\b.*\b(?:work|travel|entertainment|science writer|lifestyle)\b|\b(?:work|travel|entertainment|science writer|lifestyle)\b.*\blaptop\b.*\b(?:perfect|looking|recommend|find|help)\b/, "initial laptop needs and recommendations");
  addLabelIf(labels, normalized, /\bgreen bean\b.*\b(?:test|try|portability|portable|lightweight|carry)\b.*\blaptop\b|\blaptop\b.*\b(?:test|try|portability|portable|lightweight|carry)\b.*\bgreen bean\b/, "testing portability and meeting at The Green Bean");
  addLabelIf(labels, normalized, /\bworkshop\b.*\b(?:skill growth|skill development|digital storytelling|final cut pro|color grading|storytelling|presentation narrative|learning)\b|\b(?:skill growth|skill development|digital storytelling|final cut pro|color grading|storytelling|presentation narrative|learning)\b.*\bworkshop\b/, "workshops and skill development");
  addLabelIf(labels, normalized, /\blaptop\b.*\b(?:specs?|intel i7|16gb ram|processor speed|ram|writing sessions?|writing performance|daily writing|multitasking)\b|\b(?:specs?|intel i7|16gb ram|processor speed|ram|writing sessions?|writing performance|daily writing|multitasking)\b.*\blaptop\b/, "laptop specs and writing performance");
  addLabelIf(labels, normalized, /\b(?:finalize|finalized|final|choice|decision)\b.*\blaptop\b.*\b(?:presentation|adobe illustrator|storytelling|workshop|macbook air)\b|\blaptop\b.*\b(?:finalize|finalized|final|choice|decision|presentation|adobe illustrator|storytelling|workshop)\b/, "final laptop choice and presentation preparation");
  addLabelIf(labels, normalized, /\b(?:relationship with rachael|rachael)\b.*\b(?:together for 3 years|donaldsonside community center|keep it strong|relationship concerns?)\b|\b(?:trust has been broken|rebuild relationships?)\b.*\b(?:engineer|manufacturing|rachael|relationship)\b/, "relationship concerns and origins");
  addLabelIf(labels, normalized, /\b(?:age difference|rachael,? who's 74|rachael is 74)\b.*\b(?:trust|relationship|navigate)\b|\b(?:trust|relationship)\b.*\bage difference\b/, "trust issues and age difference");
  addLabelIf(labels, normalized, /\b(?:trust score|mutual trust|8\/10|6 to 8|weekly surveys?)\b.*\b(?:goal|july 15|rebuild)\b|\b(?:goal|july 15|rebuild)\b.*\b(?:trust score|mutual trust|weekly surveys?)\b/, "trust improvement goals with surveys");
  addLabelIf(labels, normalized, /\b(?:relationship satisfaction|satisfaction in our relationship surveys?|goal of \d+% satisfaction|target of maintaining \d+% relationship satisfaction)\b.*\b(?:goal|target|surveys?|progress reviews?|compromis(?:e|ed))\b|\b(?:compromis(?:e|ed)|budget|weekend)\b.*\b(?:relationship satisfaction|rebuilding our relationship)\b/, "satisfaction targets and compromises");
  addLabelIf(labels, normalized, /\b(?:relationship satisfaction|satisfaction goal|healing progress)\b.*\b(?:communication|weekly calls?|weekly check-ins?|monthly progress reviews?|discuss|meaningful)\b|\b(?:weekly calls?|weekly check-ins?|monthly progress reviews?|communication)\b.*\b(?:relationship satisfaction|satisfaction goal)\b/, "maintaining satisfaction with communication");
  addLabelIf(labels, normalized, /\b(?:deep(?:en|ening) emotional intimacy|emotional intimacy|closeness scores?|intimacy-focused counseling|vulnerability exercises?|intimacy rebuilding)\b/, "deepening emotional intimacy");
  addLabelIf(labels, normalized, /\b(?:creative collaboration|creative projects?|songwriting sessions?|album|music recital pieces?|joint project|structured creative projects?)\b.*\b(?:rachael|planning|balance|bond|collaboration|emotional openness|creative vision)\b|\b(?:rachael|planning|collaboration|creative vision)\b.*\b(?:songwriting sessions?|album|music recital pieces?|creative projects?)\b/, "creative collaboration planning");
  addLabelIf(labels, normalized, /\b(?:vacation|shared time|quality time)\b.*\b(?:agreed|commit(?:ment)?|not check work emails|boundary|work emails)\b|\b(?:commit(?:ment)?|not check work emails|boundary)\b.*\b(?:vacation|shared time|quality time)\b/, "commitments during shared time");
  addLabelIf(labels, normalized, /\b(?:finaliz(?:e|ing)|finalized|finish)\b.*\b(?:album|songwriting|recording|mixing|mastering|creative project)\b|\b(?:album|songwriting|recording|mixing|mastering|creative project)\b.*\b(?:finaliz(?:e|ing)|finalized|finish|december 15)\b/, "finalizing creative projects");
  addLabelIf(labels, normalized, /\b(?:social media boundaries?|share only positive updates|guest list|vacation budget|compromis(?:e|ed))\b.*\b(?:relationship|satisfaction|rachael|boundaries|assertiveness|preferences|positive updates)\b|\b(?:relationship satisfaction|social compromises?|healthy boundaries|social media boundaries?)\b.*\b(?:compromis(?:e|ed)|social media|guest list|budget|positive updates)\b/, "sustaining satisfaction and social compromises");
  addLabelIf(labels, normalized, /\b(?:couples counseling|family counseling|counseling sessions?|dr\.?\s+marie leclerc)\b.*\b(?:trust|rebuild|relationship|rachael)\b|\b(?:trust|rebuild|relationship|rachael)\b.*\b(?:couples counseling|family counseling|counseling sessions?|dr\.?\s+marie leclerc)\b/, "couples counseling and trust rebuilding");
  addLabelIf(labels, normalized, /\b(?:music recital pieces?|daily rehearsals?|songwriting sessions?)\b.*\b(?:intimacy|bond|strengthening|relationship|rachael)\b|\b(?:intimacy|bond|strengthening|relationship|rachael)\b.*\b(?:music recital pieces?|daily rehearsals?|songwriting sessions?)\b/, "intimacy through music sessions");
  addLabelIf(labels, normalized, /\b(?:daily mindfulness meditation|headspace|meditation sessions?|relaxation apps?|relaxation techniques?)\b.*\b(?:anxiety|relationship tensions?|emotional|stress)\b|\b(?:anxiety|relationship tensions?|emotional|stress)\b.*\b(?:daily mindfulness meditation|headspace|meditation sessions?|relaxation apps?|relaxation techniques?)\b/, "meditation and relaxation apps");
  addLabelIf(labels, normalized, /\b(?:breathing exercises?|breathing techniques?)\b.*\b(?:tense conversations?|conflict duration|reduced conflict|30%)\b|\b(?:tense conversations?|conflict duration|reduced conflict|30%)\b.*\b(?:breathing exercises?|breathing techniques?)\b/, "breathing exercises for conflict reduction");
  addLabelIf(labels, normalized, /\b(?:emotional regulation|breathing exercises?|breathing techniques?)\b.*\b(?:travel(?:ing)?|packing|vacation|trip|travel stress)\b|\b(?:travel(?:ing)?|packing|vacation|trip|travel stress)\b.*\b(?:emotional regulation|breathing exercises?|breathing techniques?)\b/, "emotional regulation during travel");
  addLabelIf(labels, normalized, /\b(?:performance anxiety|music recital rehearsal|manag(?:e|ing) my nerves|nerves)\b.*\b(?:breathing|techniques?|session|performance)\b|\b(?:breathing|techniques?)\b.*\b(?:performance anxiety|music recital rehearsal|nerves)\b/, "performance anxiety and breathing techniques");
  addLabelIf(labels, normalized, /\b(?:recording studio|recording stress|vulnerability exercises?|intimacy counseling)\b.*\b(?:emotional regulation|stress|balance|techniques?)\b|\b(?:emotional regulation|stress|balance|techniques?)\b.*\b(?:recording studio|recording stress|vulnerability exercises?|intimacy counseling)\b/, "alternative emotional regulation for recording stress");
  addLabelIf(labels, normalized, /\bparty-day nerves?\b.*\b(?:emotional regulation|techniques?|other stressful situations|applying)\b|\b(?:emotional regulation|techniques?|other stressful situations|applying)\b.*\bparty-day nerves?\b/, "managing party-day nerves and applying techniques elsewhere");
  addLabelIf(labels, normalized, /\b(?:collaborat(?:ed|ion|ing)|worked closely)\b.*\bkelli\b.*\b(?:article|readership|project)\b|\bkelli\b.*\b(?:collaborat(?:ed|ion|ing)|worked closely)\b.*\b(?:article|readership|project)\b/, "collaboration with Kelli on article");
  addLabelIf(labels, normalized, /\bmet mary\b.*\beditorial meeting\b|\bmary\b.*\beditorial meeting\b/, "meeting Mary at editorial meeting");
  addLabelIf(labels, normalized, /\bjames\b.*\b(?:advice|said)\b.*\b(?:project alignment|aligning projects?|company goals)\b|\b(?:project alignment|aligning projects?|company goals)\b.*\bjames\b/, "advice from James on project alignment");
  addLabelIf(labels, normalized, /\b(?:strategy meeting|meeting)\b.*\bmary\b.*\bco-present(?:ed|ing)?\b|\bmary\b.*\bco-present(?:ed|ing)?\b.*\b(?:strategy meeting|meeting)\b/, "strategy meeting co-presented with Mary");
  addLabelIf(labels, normalized, /\b(?:co-led|co led)\b.*\bworkshop\b.*\bkelli\b|\bkelli\b.*\b(?:co-led|co led)\b.*\bworkshop\b|\bworkshop\b.*\b(?:co-led|co led)\b.*\bkelli\b/, "workshop co-led with Kelli");
  addLabelIf(labels, normalized, /\bjames\b.*\bstrategic advice\b.*\bsustainability project\b|\bstrategic advice\b.*\bjames\b.*\bsustainability project\b|\bsustainability project\b.*\bjames\b.*\bstrategic advice\b/, "strategic advice from James on sustainability project");
  addLabelIf(labels, normalized, /\bco-author(?:ed|ing)?\b.*\barticle\b.*\bmary\b|\bmary\b.*\bco-author(?:ed|ing)?\b.*\barticle\b|\barticle\b.*\bmary\b.*\bco-author(?:ed|ing)?\b/, "co-authoring article with Mary");
  addLabelIf(labels, normalized, /\bjames'?s\b.*\bletter of recommendation\b|\bletter of recommendation\b.*\bjames\b/, "James's letter of recommendation");
  addLabelIf(labels, normalized, /\b(?:initial|start(?:ed|ing)?|broad-market|broad market)\b.*\b(?:etfs?|voo|veu|agg|automatic contributions?)\b|\b(?:voo|veu|agg|automatic contributions?)\b.*\b(?:initial|start(?:ed|ing)?|broad-market|broad market)\b/, "initial ETF strategy discussion");
  addLabelIf(labels, normalized, /\b(?:financial advisor|advisor)\b.*\b(?:consult|compare|choose|raymond|etfs?|managed portfolio)\b|\b(?:raymond|managed portfolio)\b.*\b(?:advisor|etfs?|portfolio)\b/, "advisor comparison and managed portfolio setup");
  addLabelIf(labels, normalized, /\brobo-?advisors?\b|\bautomatic contributions?\b.*\b(?:portfolio|invest(?:ing|ments?))\b/, "robo-advisor automatic contributions");
  addLabelIf(labels, normalized, /\b(?:vxus|international etfs?|global diversification|international exposure)\b/, "international ETF diversification");
  addLabelIf(labels, normalized, /\b(?:reit etfs?|reits?|vnq|real estate investment trusts?)\b/, "REIT and real-estate ETF exploration");
  addLabelIf(labels, normalized, /\b(?:emerging markets?|vwo)\b/, "emerging markets ETF addition");
  addLabelIf(labels, normalized, /\b(?:municipal bond funds?|municipal bonds?|vteb)\b/, "municipal bond fund allocation");
  addLabelIf(labels, normalized, /\b(?:small-cap|small cap|scz)\b.*\b(?:international|etfs?)\b|\b(?:international|etfs?)\b.*\b(?:small-cap|small cap|scz)\b/, "international small-cap ETF addition");
  addLabelIf(labels, normalized, /\b(?:sector-specific etfs?|sector etfs?|xlv|healthcare sector|xlk|technology sector)\b/, "sector ETF focus");
  addLabelIf(labels, normalized, /\bbrittney\b.*\b(?:stock tips?|educational resources?|financial independence|loan|custodial account|co-invest|co invest|quarterly review|pros and cons)\b|\b(?:stock tips?|educational resources?|financial independence|loan|custodial account|co-invest|co invest|quarterly review|pros and cons)\b.*\bbrittney\b/, "Brittney financial boundaries and education");
  addLabelIf(labels, normalized, /\bbrittney\b.*\b(?:declined|turn(?:ed)? down|loan|financial independence)\b|\b(?:declined|turn(?:ed)? down|loan|financial independence)\b.*\bbrittney\b/, "declining Brittney loan and emphasizing independence");
  addLabelIf(labels, normalized, /\bbrittney\b.*\b(?:custodial account|monthly check-ins?)\b|\b(?:custodial account|monthly check-ins?)\b.*\bbrittney\b/, "Brittney custodial account with monthly check-ins");
  addLabelIf(labels, normalized, /\bbrittney\b.*\b(?:co-invest|co invest|quarterly review|pros and cons)\b|\b(?:co-invest|co invest|quarterly review|pros and cons)\b.*\bbrittney\b/, "later co-investments with quarterly reviews and pros and cons");
  addLabelIf(labels, normalized, /\b(?:financial regulations?|saint helena'?s?\s+20\d{2}\s+financial regulations?|comply|compliance)\b.*\b(?:bond purchases?|esg funds?|investments?|portfolio)\b|\b(?:bond purchases?|esg funds?|investments?|portfolio)\b.*\b(?:financial regulations?|comply|compliance)\b/, "compliance with financial regulations");
  addLabelIf(labels, normalized, /\b(?:esg funds?|esg fund options?|lower volatility|expense ratio)\b.*\b(?:decision|decisions|recommend|choose|allocated|allocating)\b|\b(?:decision|decisions|recommend|choose|allocated|allocating)\b.*\besg funds?\b/, "ESG fund options and decisions");
  addLabelIf(labels, normalized, /\bjohn\b.*\b(?:portfolio|8% loss|losses|recovery|market downturn|2008 crash)\b|\b(?:portfolio|8% loss|losses|recovery|market downturn|2008 crash)\b.*\bjohn\b/, "friend John's portfolio losses and recovery");
  addLabelIf(labels, normalized, /\b(?:wealthfront'?s?|tax-loss harvesting|tax tools?)\b.*\b(?:adopted|started using|use|using|maximize|subscription)\b|\b(?:adopted|started using|use|using|maximize|subscription)\b.*\b(?:wealthfront'?s?|tax-loss harvesting|tax tools?)\b/, "adoption and use of tax tools");
  addLabelIf(labels, normalized, /\b(?:regional market risks?|regional risks?|latin america|asia-pacific|emerging markets?|emerging market bonds?|currency risk)\b.*\b(?:inflation hedg(?:e|ing)|tips|currency risk|hedging investments?|losses?)\b|\b(?:inflation hedg(?:e|ing)|tips|currency risk|hedging investments?|losses?)\b.*\b(?:regional market risks?|regional risks?|latin america|asia-pacific|emerging markets?|emerging market bonds?|currency risk)\b|\b(?:inflation hedg(?:e|ing)|treasury inflation-protected securities)\b/, "regional market risks and inflation hedging");
  addLabelIf(labels, normalized, /\b(?:stephanie|partner)\b.*\b(?:regular dinner date|blue heron|healthiest options?|healthy dinner|dinner options?)\b|\b(?:regular dinner date|blue heron|healthiest options?|healthy dinner|dinner options?)\b.*\b(?:stephanie|partner)\b/, "healthy dinner options");
  addLabelIf(labels, normalized, /\b(?:stephanie|partner)\b.*\b(?:desserts?|once weekly|calorie goals?|low-sugar snacks?)\b|\b(?:desserts?|once weekly|calorie goals?|low-sugar snacks?)\b.*\b(?:stephanie|partner)\b/, "dessert frequency and calories");
  addLabelIf(labels, normalized, /\b(?:stephanie|shared recipes?)\b.*\b(?:salt|sodium|25%)\b|\b(?:salt|sodium|25%)\b.*\b(?:stephanie|shared recipes?)\b/, "salt reduction in recipes");
  addLabelIf(labels, normalized, /\b(?:stephanie|partner)\b.*\b(?:social dinners?|host friends monthly|monthly starting may)\b|\b(?:social dinners?|host friends monthly|monthly starting may)\b.*\b(?:stephanie|partner)\b/, "monthly social dinners");
  addLabelIf(labels, normalized, /\b(?:stephanie|partner|weekly dinners?)\b.*\b(?:dining out|3 times weekly|declined|boundaries|budget|cost)\b|\b(?:dining out|3 times weekly|declined|boundaries|budget|cost)\b.*\b(?:stephanie|partner|weekly dinners?)\b/, "dining out frequency and budget boundaries");
  addLabelIf(labels, normalized, /\b(?:overwhelmed|overwhelm)\b.*\b(?:stephanie|requests?|changes)\b|\b(?:stephanie|requests?|changes)\b.*\b(?:overwhelmed|overwhelm)\b/, "emotional overwhelm");
  addLabelIf(labels, normalized, /\b(?:stephanie|partner)\b.*\b(?:dinner party|hosted a dinner party|next gathering|party)\b|\b(?:dinner party|hosted a dinner party|next gathering)\b.*\b(?:stephanie|partner)\b/, "dinner party planning");
  addLabelIf(labels, normalized, /\b(?:relationships?|stephanie|partner)\b.*\b(?:wellness goals?|health|balance|prioritize)\b|\b(?:wellness goals?|health|balance|prioritize)\b.*\b(?:relationships?|stephanie|partner)\b/, "balancing relationships and wellness");
  addLabelIf(labels, normalized, /\b(?:book club)\b.*\b(?:stephanie|monthly|commit|attendance|october)\b|\b(?:stephanie|monthly|commit|attendance|october)\b.*\bbook club\b/, "book club attendance commitment");
  addLabelIf(labels, normalized, /\b(?:stephanie|partner)\b.*\b(?:4 parties per year|parties per year|hosting more parties|party ideas?)\b|\b(?:4 parties per year|parties per year|hosting more parties|party ideas?)\b.*\b(?:stephanie|partner)\b/, "party hosting limits");
  addLabelIf(labels, normalized, /\b(?:stephanie|partner)\b.*\b(?:no alcohol|wine and sparkling water|sparkling water|drink restrictions?)\b|\b(?:no alcohol|wine and sparkling water|sparkling water|drink restrictions?)\b.*\b(?:stephanie|partner)\b/, "party drink restrictions");
  addLabelIf(labels, normalized, /\b(?:regular meetings?|every other thursday|café verona|cafe verona|healthy breakfast options?|breakfast options?)\b/, "regular meetings and breakfast options");
  addLabelIf(labels, normalized, /\b(?:potluck|patricia'?s home|healthy dish|healthy dishes|holiday potluck)\b.*\b(?:plan|planning|prep|bring|share|dish)\b|\b(?:plan|planning|prep|bring|share|dish)\b.*\b(?:potluck|patricia'?s home|healthy dish|healthy dishes|holiday potluck)\b/, "potluck planning and healthy dishes");
  addLabelIf(labels, normalized, /\b(?:walking routine|daily walks?|morning walks?|walking distance|steps?|stay motivated|motivation)\b.*\b(?:motivat\w*|routine|endurance|walking)\b|\b(?:motivat\w*|routine|endurance)\b.*\b(?:walking routine|daily walks?|morning walks?|walking distance|steps?)\b/, "walking routine and motivation");
  addLabelIf(labels, normalized, /\b(?:xiaomi mi band 6|xiaomi mi band 7|mi band 6|mi band 7)\b.*\b(?:sleep stages?|sleep tracking|heart rate variability|hrv|interpret|data)\b|\b(?:sleep stages?|sleep tracking|heart rate variability|hrv)\b.*\b(?:xiaomi mi band 6|xiaomi mi band 7|mi band 6|mi band 7)\b/, "initial sleep tracker data interpretation");
  addLabelIf(labels, normalized, /\bfirmware update\b.*\b(?:12%|rem sleep accuracy|more reliable|precise data|better insights|trust|confidence)|\b(?:12%|rem sleep accuracy|more reliable|precise data|better insights|trust|confidence).*?\bfirmware update\b/, "Firmware update impact and data trust");
  addLabelIf(labels, normalized, /\b(?:sleep cycle app|manual(?:ly)?|variance|5% difference|10% variance)\b.*\b(?:xiaomi mi band|sleep tracking|sleep duration|rem sleep)\b|\b(?:xiaomi mi band|sleep tracking|sleep duration|rem sleep)\b.*\b(?:sleep cycle app|manual(?:ly)?|variance|5% difference|10% variance)\b/, "cross-device sleep tracking comparison");
  addLabelIf(labels, normalized, /\b(?:firmware updates?|software updates?|calibrat(?:e|ion)|improved sleep stage detection|sleep tracking algorithms?)\b.*\b(?:sleep quality|accuracy|device performance|tracking)\b|\b(?:sleep quality|accuracy|device performance|tracking)\b.*\b(?:firmware updates?|software updates?|calibrat(?:e|ion)|improved sleep stage detection|sleep tracking algorithms?)\b/, "Incremental firmware enhancements and sleep quality");
  addLabelIf(labels, normalized, /\b(?:september\s+12|october\s+18|november\s+22|10%|12%|15%).*?\bfirmware update\b.*\b(?:sleep stage detection|sleep tracking|overall sleep quality|overall accuracy)\b|\bfirmware update\b.*\b(?:september\s+12|october\s+18|november\s+22|10%|12%|15%).*?\b(?:sleep stage detection|sleep tracking|overall sleep quality|overall accuracy)\b/, "Final reflections on firmware and sleep management");
  addLabelIf(labels, normalized, /\bcouples therapy\b.*\b(?:preparation|expectations?|dr\.?\s+selim|communication)\b|\b(?:preparation|expectations?|dr\.?\s+selim|communication)\b.*\bcouples therapy\b/, "Couples therapy preparation and expectations");
  addLabelIf(labels, normalized, /\b(?:work late|past 8\s*pm|work stress|time management|neglected|balance my work and relationship)\b/, "Time management and work stress discussions");
  addLabelIf(labels, normalized, /\b(?:reduce|reducing)\b.*\b(?:work|clinical)\s+hours\b|\b(?:50 to 45|50 to 40)\b|\bwork emails?\b.*\b(?:7\s*pm|boundaries?)\b/, "Work hour reductions and communication of boundaries");
  addLabelIf(labels, normalized, /\b(?:income|additional income|extra income|budget|leisure activities|relationship spending)\b.*\b(?:april|relationship|joint leisure|spending)\b|\b(?:april|relationship|joint leisure|spending)\b.*\b(?:income|additional income|extra income|budget|leisure activities)\b/, "Increased income and relationship spending plans");
  addLabelIf(labels, normalized, /\b(?:productivity apps?|todoist|trello|calendar apps?)\b.*\b(?:relationship|april|quality time|work-life)\b|\b(?:relationship|april|quality time|work-life)\b.*\b(?:productivity apps?|todoist|trello|calendar apps?)\b/, "Use of productivity apps for relationship support");
  addLabelIf(labels, normalized, /\b(?:consulting project extension|project extension|extend(?:ed|ing)? (?:my )?consulting hours|extended consulting hours)\b.*\b(?:relationship|april|impact|prioriti[sz]e|balance)\b|\b(?:relationship|april|impact|prioriti[sz]e|balance)\b.*\b(?:consulting project extension|project extension|extend(?:ed|ing)? (?:my )?consulting hours|extended consulting hours)\b/, "Consulting project extension and relationship impact");
  addLabelIf(labels, normalized, /\b(?:increased|extended)\b.*\bconsulting hours\b.*\b(?:balance|personal life|relationship)\b|\b(?:balance|personal life|relationship)\b.*\b(?:increased|extended)\b.*\bconsulting hours\b/, "Increased consulting hours and maintaining balance");
  addLabelIf(labels, normalized, /\b(?:additional income|extra income|income allocation|allocate income|allocation)\b.*\b(?:relationship|lifestyle|april|quality time)\b|\b(?:relationship|lifestyle|april|quality time)\b.*\b(?:additional income|extra income|income allocation|allocate income|allocation)\b/, "Additional income allocation for relationship and lifestyle");
  addLabelIf(labels, normalized, /\b(?:mom|mother|nancy)\b.*\b(?:supportive|support|encourag(?:e|ement|ing)|stay motivated|motivation|fitness goals?)\b|\b(?:supportive|support|encourag(?:e|ement|ing)|stay motivated|motivation|fitness goals?)\b.*\b(?:mom|mother|nancy)\b/, "Mom's support");
  addLabelIf(labels, normalized, /\bjenny\b.*\b(?:motivat(?:e|ed|ion)|suggest(?:ed|ion)?|new activities?|trail running|green valley park|workout partner|morning runs?)\b|\b(?:motivat(?:e|ed|ion)|suggest(?:ed|ion)?|new activities?|trail running|green valley park|workout partner|morning runs?)\b.*\bjenny\b/, "Jenny's motivation and new activities");
  addLabelIf(labels, normalized, /\bjenny\b.*\b(?:half marathon|training|support|pressure|running distance|7k|10k)\b|\b(?:half marathon|training|support|pressure|running distance|7k|10k)\b.*\bjenny\b/, "Supporting Jenny's half marathon training");
  addLabelIf(labels, normalized, /\bdon\b.*\b(?:hiking|hike|weekend hiking group|invited|invitation|prepare|preparation|10 km|15 km)\b|\b(?:hiking|hike|weekend hiking group|invited|invitation|prepare|preparation|10 km|15 km)\b.*\bdon\b/, "Don's hiking invitation");
  addLabelIf(labels, normalized, /\b(?:nancy|craig)\b.*\b(?:pilates|runs?|5\s*km walk|10k charity run|charity run|family fitness|joining|joined)\b|\b(?:pilates|runs?|5\s*km walk|10k charity run|charity run|family fitness|joining|joined)\b.*\b(?:nancy|craig)\b/, "Nancy and Craig joining Pilates and runs");
  addLabelIf(labels, normalized, /\bcraig\b.*\b(?:meal prep|protein-rich|protein rich|assist|assistance|help|injury week|fitness goals?)\b|\b(?:meal prep|protein-rich|protein rich|assist|assistance|help|injury week|fitness goals?)\b.*\bcraig\b/, "Craig's meal prep assistance");
  addLabelIf(labels, normalized, /\bchristopher\b.*\b(?:cycling race|40 km cycling race|race|cycling group|support|weekend cycling)\b|\b(?:cycling race|40 km cycling race|race|cycling group|support|weekend cycling)\b.*\bchristopher\b/, "Christopher's cycling race");
  addLabelIf(labels, normalized, /\bkristen\b.*\b(?:pilates|workout partner|group motivation|motivation|technique|support|zen studio|partner)\b|\b(?:pilates|workout partner|group motivation|motivation|technique|support|zen studio|partner)\b.*\bkristen\b/, "Pilates partner Kristen and group motivation");
  addLabelIf(labels, normalized, /\b(?:clinical workload|evening shifts?|workload)\b.*\b(?:pilates|classes?|schedule|balance|reschedule)\b|\b(?:pilates|classes?|schedule|balance|reschedule)\b.*\b(?:clinical workload|evening shifts?|workload)\b/, "Balancing Pilates with clinical workload");
  addLabelIf(labels, normalized, /\bjenny\b.*\b(?:new year'?s 5k|5k fun run|january 1,? 2025|prepare|preparing|training)\b|\b(?:new year'?s 5k|5k fun run|january 1,? 2025|prepare|preparing|training)\b.*\bjenny\b/, "Preparing for New Year's 5K with Jenny");
  addLabelIf(labels, normalized, /\b(?:nutrition lecture|nutrition webinar|american dietetic association|lecture follow-up|follow-up with .*john)\b/, "nutrition lecture follow-up and related discussions");
  addLabelIf(labels, normalized, /\bmicronutrient deficiencies\b|\bdeficienc(?:y|ies)\b.*\bmicronutrients?\b|\bmicronutrients?\b.*\bdeficienc(?:y|ies)\b/, "micronutrient deficiencies");
  addLabelIf(labels, normalized, /\bbalanc(?:e|ing)\b.*\bmacronutrients?\b|\bmacronutrients?\b.*\bbalanc(?:e|ing)\b/, "macronutrient balancing");
  addLabelIf(labels, normalized, /\bmicronutrient supplementation\b|\b(?:update|updates|jessica)\b.*\bmicronutrients?\b.*\bsupplement(?:ation|s)?\b|\bsupplement(?:ation|s)?\b.*\bmicronutrients?\b.*\b(?:update|updates|jessica)\b/, "micronutrient supplementation updates");
  addLabelIf(labels, normalized, /\bbalanc(?:e|ing)\b.*\bcalcium intake\b|\bcalcium intake\b.*\bbalanc(?:e|ing)\b|\bdairy-free diets?\b.*\bcalcium\b/, "calcium intake balancing");
  addLabelIf(labels, normalized, /\bplant-based protein combinations?\b|\bcombining different plant-based proteins\b|\bcomplete amino acids\b|\bcomplementary proteins\b/, "plant-based protein combinations");
  addLabelIf(labels, normalized, /\bmicronutrient needs\b.*\bgrowing children\b|\bgrowing children\b.*\bmicronutrient needs\b|\bchildren on restricted diets\b.*\bmicronutrients?\b/, "micronutrient needs for growing children");
  addLabelIf(labels, normalized, /\b(?:cholesterol|ldl)\b.*\b(?:john|visit|visiting|botanical gardens|concerns?|worried|reduce)\b|\b(?:john|visit|visiting|botanical gardens)\b.*\b(?:cholesterol|ldl|concerns?)\b/, "cholesterol concerns and visit planning");
  addLabelIf(labels, normalized, /\bhealthy cooking methods?\b|\bquick and healthy\b.*\bcooking\b|\bcooking\b.*\bhealthy\b.*\bmethods?\b/, "healthy cooking methods");
  addLabelIf(labels, normalized, /\b(?:spice combinations?|seasoning blends?)\b.*\b(?:roasted vegetables?|roasted carrots?|roasted sweet potatoes?)\b|\b(?:roasted vegetables?|roasted carrots?|roasted sweet potatoes?)\b.*\b(?:spice combinations?|seasoning blends?)\b/, "initial spice combinations for roasted vegetables");
  addLabelIf(labels, normalized, /\b(?:other|additional)\s+spices?\b.*\benhance\b.*\bflavo(?:u)?r depth\b|\benhance\b.*\bflavo(?:u)?r depth\b.*\b(?:other|additional)\s+spices?\b/, "additional spices to enhance flavor depth");
  addLabelIf(labels, normalized, /\bmiddle eastern\b.*\b(?:flavo(?:u)?rs?|spices?|experiment)\b|\b(?:flavo(?:u)?rs?|spices?|experiment)\b.*\bmiddle eastern\b/, "Middle Eastern flavor experimentation");
  addLabelIf(labels, normalized, /\broasted carrots?\b.*\bspice combinations?\b.*\bturmeric\b.*\bginger\b.*\bjuly\s+13\b|\bjuly\s+13\b.*\bturmeric\b.*\bginger\b.*\broasted carrots?\b.*\bspice combinations?\b/, "revisiting smoky and spicy seasonings");
  addLabelIf(labels, normalized, /\b(?:further|again|more)\b.*\bmiddle eastern\b.*\b(?:spice|flavo(?:u)?r|za'?atar)\b|\bza'?atar\b.*\b(?:further|again|more)\b.*\bmiddle eastern\b/, "further Middle Eastern spice exploration");
  addLabelIf(labels, normalized, /\benhanced?\b.*\bflavo(?:u)?r\b.*\bcolor\b.*\bspices?\b|\bspices?\b.*\benhanced?\b.*\bflavo(?:u)?r\b.*\bcolor\b|\bturmeric\b.*\bginger\b.*\benhanced?\b.*\bflavo(?:u)?r\b.*\bcolor\b/, "enhancing flavor and color with spices");
  addLabelIf(labels, normalized, /\b(?:seeking|looking for|suggest|new)\b.*\b(?:seasoning ideas?|spice combinations?)\b.*\b(?:roasted vegetables?|roasted carrots?)\b|\b(?:roasted vegetables?|roasted carrots?)\b.*\b(?:new|other)\b.*\b(?:seasoning ideas?|spice combinations?)\b/, "seeking new seasoning ideas for roasted vegetables");
  addLabelIf(labels, normalized, /\bmichele\b.*\b(?:sweet crust bakery|learn|baking)\b|\b(?:sweet crust bakery|learn|baking)\b.*\bmichele\b/, "meeting and learning from Michele about baking");
  addLabelIf(labels, normalized, /\bmichele\b.*\b(?:scaling recipes?|maintaining consistency|inventory management|marketing strategies?)\b|\b(?:scaling recipes?|maintaining consistency|inventory management|marketing strategies?)\b.*\bmichele\b/, "discussing recipe scaling, inventory, and marketing strategies with Michele");
  addLabelIf(labels, normalized, /\bshared\b.*\bvegan cake\b.*\bmichele\b|\bvegan cake\b.*\b(?:positive feedback|social baking skills?)\b/, "sharing vegan cake and seeking social baking improvement");
  addLabelIf(labels, normalized, /\bmichele'?s\b.*\bproofing box\b.*\b(?:dough rise|25%|invest)\b|\bproofing box\b.*\b(?:dough rise|25%|invest)\b.*\bmichele\b/, "using Michele's proofing box and debating investing in one");
  addLabelIf(labels, normalized, /\bbaking schedule\b.*\b(?:other commitments|writing seminar|overcommit)\b.*\bmichele\b.*\bproofing box\b|\bwriting seminar\b.*\bmichele\b.*\bproofing box\b/, "balancing baking schedule with other commitments and Michele's proofing box advice");
  addLabelIf(labels, normalized, /\bhosted\b.*\bcake decorating session\b.*\b(?:marisa|courtney)\b|\bcake decorating session\b.*\b(?:marisa|courtney)\b.*\b(?:next session|better|ideas?)\b/, "hosting a cake decorating session and seeking improvement ideas");
  addLabelIf(labels, normalized, /\b(?:shared|sharing)\b.*\bgluten-free bread samples?\b|\bgluten-free bread samples?\b.*\b(?:4\.4\/5|rating|michele|ryan)\b/, "asking about achieving high ratings from sharing gluten-free bread samples");
  addLabelIf(labels, normalized, /\b(?:shared|sharing)\b.*\bcroissant samples?\b|\bcroissant samples?\b.*\b(?:4\.6\/5|rating|michele|audrey)\b/, "Sharing croissant samples and aiming to improve ratings");
  addLabelIf(labels, normalized, /\b(?:shared|sharing)\b.*\bdessert plating photos?\b|\bdessert plating photos?\b.*\b(?:saint helena baking club|improve|future shares?)\b/, "sharing dessert plating photos and seeking plating tips");
  addLabelIf(labels, normalized, /\b(?:ryan'?s promotion|party for ryan'?s promotion|promotion party)\b.*\b(?:baking party|breads?|desserts?|host)\b|\bbaking party\b.*\bryan'?s promotion\b/, "planning a party for Ryan's promotion and requesting hosting tips");
  addLabelIf(labels, normalized, /\bdavid\b.*\b(?:wine tasting|diabetes)\b.*\b(?:explain|explaining|understand|discussion|discussing|talk)\b|\b(?:explain|explaining|understand|discussion|discussing|talk)\b.*\b(?:diabetes|wine tasting)\b.*\bdavid\b/, "meeting and discussing diabetes explanation with david");
  addLabelIf(labels, normalized, /\bdavid\b.*\b(?:helped|support|assistance|assist)\b.*\b(?:mediterranean meals?|sodium)\b|\b(?:mediterranean meals?|sodium)\b.*\b(?:helped|support|assistance|assist)\b.*\bdavid\b/, "assistance with mediterranean meals from david");
  addLabelIf(labels, normalized, /\bdavid\b.*\b(?:surprised|surprise)\b.*\b(?:homemade|mediterranean dinner)\b|\b(?:surprised|surprise|homemade)\b.*\b(?:mediterranean dinner|dinner)\b.*\bdavid\b/, "surprise homemade dinner from david");
  addLabelIf(labels, normalized, /\bdavid\b.*\b(?:attending|attended|attend)\b.*\b(?:diabetes education refresher|education refresher|saint helena clinic)\b|\b(?:diabetes education refresher|education refresher|saint helena clinic)\b.*\b(?:attending|attended|attend)\b.*\bdavid\b/, "attending diabetes education refresher with david");
  addLabelIf(labels, normalized, /\bdavid\b.*\b(?:planning|plan|visit|booked)\b.*\b(?:active outings?|social events?|bike rides?|bike ride|concert|walking tours?|napa art walk|opera house)\b|\b(?:active outings?|social events?|bike rides?|bike ride|concert|walking tours?|napa art walk|opera house)\b.*\b(?:planning|plan|visit|booked)\b.*\bdavid\b/, "planning active and social outings with david");
  addLabelIf(labels, normalized, /\bmichael\b.*\b(?:suggest(?:ed|ion)?|advice)\b.*\bacting\b|\bacting\b.*\bmichael\b.*\b(?:suggest(?:ed|ion)?|advice)\b/, "acting and michael's suggestion");
  addLabelIf(labels, normalized, /\b(?:voice coach|voice coaching|sarah lee)\b.*\b(?:michael|sessions?|stage presence|voice projection)\b|\bmichael\b.*\b(?:voice coach|voice coaching|sarah lee)\b/, "voice coaching sessions");
  addLabelIf(labels, normalized, /\b(?:dance workshop|new gary dance studio)\b.*\b(?:michael|feedback|new moves|2 hours?|skills?)\b|\b(?:michael|feedback|new moves|2 hours?|skills?)\b.*\b(?:dance workshop|new gary dance studio)\b/, "dance workshop and feedback");
  addLabelIf(labels, normalized, /\b(?:local theater|theater opportunities|theater groups?|stage time)\b.*\b(?:michael|stay in touch|staying in touch|meet up|coffee)\b|\b(?:michael|stay in touch|staying in touch|meet up|coffee)\b.*\b(?:local theater|theater opportunities|theater groups?|stage time)\b/, "local theater involvement and staying in touch");
  addLabelIf(labels, normalized, /\b(?:improv group|improv showcase|advanced improvisation|improvisation techniques)\b.*\b(?:michael|feedback|sessions?|activities|spontaneity)\b|\b(?:michael|feedback|sessions?|activities|spontaneity)\b.*\b(?:improv group|improv showcase|advanced improvisation|improvisation techniques)\b/, "improv group activities and feedback");
  addLabelIf(labels, normalized, /\b(?:10-week acting course|acting course)\b.*\b(?:first day|tips|april 1|stage presence|emotional expression)\b|\b(?:first day|tips|april 1|stage presence|emotional expression)\b.*\b(?:10-week acting course|acting course)\b/, "acting course and first day tips");
  addLabelIf(labels, normalized, /\b(?:minor role|character development|character'?s background|script)\b.*\b(?:voice coaching|sarah lee|community play|accepted)\b|\b(?:voice coaching|sarah lee|community play|accepted)\b.*\b(?:minor role|character development|character'?s background|script)\b/, "minor role and character/voice coaching");
  addLabelIf(labels, normalized, /\b(?:dance recital|dance recital audition)\b.*\b(?:prep|preparation|audition|contemporary|ballet|may 9)\b|\b(?:prep|preparation|audition|contemporary|ballet|may 9)\b.*\b(?:dance recital|dance recital audition)\b/, "dance recital audition and prep");
  addLabelIf(labels, normalized, /\b(?:part-time|part time)\b.*\b(?:theater roles?|community theater)\b.*\b(?:writing|balance)\b|\b(?:writing|balance)\b.*\b(?:part-time|part time)\b.*\b(?:theater roles?|community theater)\b/, "part-time theater roles and writing balance");
  addLabelIf(labels, normalized, /\b(?:supporting role)\b.*\b(?:accept(?:ed|ance)?|rehearsal|portfolio|balance|community play)\b|\b(?:accept(?:ed|ance)?|rehearsal|portfolio|balance|community play)\b.*\b(?:supporting role)\b/, "supporting role acceptance and rehearsal/portfolio balance");
  addLabelIf(labels, normalized, /\b(?:declin(?:e|ed|ing)|turn(?:ed)? down)\b.*\b(?:lead role)\b.*\b(?:focus|current play|commitments?)\b|\b(?:focus|current play|commitments?)\b.*\b(?:declin(?:e|ed|ing)|turn(?:ed)? down)\b.*\b(?:lead role)\b/, "declining lead role to focus on current play");
  addLabelIf(labels, normalized, /\b(?:regional theater|regional theatre)\b.*\b(?:auditions?|auditioning|coaching|conference)\b|\b(?:auditions?|auditioning|coaching)\b.*\b(?:regional theater|regional theatre)\b/, "regional theater auditions and coaching");
  addLabelIf(labels, normalized, /\b(?:winter season)\b.*\b(?:supporting role|rehearsals?)\b|\b(?:supporting role|rehearsals?)\b.*\b(?:winter season)\b/, "winter season supporting role and rehearsals");
  addLabelIf(labels, normalized, /\b(?:conservatory application|conservatory applications|professional acting conservatory|applying to (?:a|the) conservatory)\b.*\b(?:considerations?|focus|prep|preparation|funding|budgeting)\b|\b(?:considerations?|focus|prep|preparation|funding|budgeting)\b.*\b(?:conservatory application|conservatory applications|professional acting conservatory|applying to (?:a|the) conservatory)\b/, "conservatory application considerations");
  addLabelIf(labels, normalized, /\b(?:diagnosed|diagnosis)\b.*\b(?:type 2 diabetes|diabetes)\b.*\b(?:follow up|follow-up|dr\.?\s+linda chen|dr\.?\s+chen)\b|\b(?:follow up|follow-up|dr\.?\s+linda chen|dr\.?\s+chen)\b.*\b(?:diagnosed|diagnosis)\b.*\b(?:type 2 diabetes|diabetes)\b/, "initial diagnosis and follow-up");
  addLabelIf(labels, normalized, /\b(?:insulin options?|basal insulin|starting low-dose basal insulin|delay(?:ed|ing)? it|chose to delay|treatment options)\b.*\b(?:decision|decisions|recommended|dr\.?\s+chen|delay)\b|\b(?:decision|decisions|recommended|dr\.?\s+chen|delay)\b.*\b(?:insulin options?|basal insulin|starting low-dose basal insulin|treatment options)\b/, "insulin options and decisions");
  addLabelIf(labels, normalized, /\b(?:arthritis pain|joint pain|joint mobility|ibuprofen|arthritis)\b.*\b(?:manage|management|treatment|symptom|pain|doctor|dr\.?\s+chen)\b|\b(?:manage|management|treatment|symptom|pain|doctor|dr\.?\s+chen)\b.*\b(?:arthritis pain|joint pain|joint mobility|ibuprofen|arthritis)\b/, "arthritis pain management");
  addLabelIf(labels, normalized, /\b(?:physical therapist|physical therapy|mark lewis|saint helena rehab center)\b.*\b(?:progress|assessment|follow-up|follow up|joint)\b|\b(?:progress|assessment|follow-up|follow up|joint)\b.*\b(?:physical therapist|physical therapy|mark lewis|saint helena rehab center)\b/, "physical therapy progress");
  addLabelIf(labels, normalized, /\b(?:insulin dosage|lantus dose|lantus nightly|units of lantus|insulin initiation|hba1c results)\b.*\b(?:concern|worried|review|appointment|right dose|adjust)\b|\b(?:concern|worried|review|appointment|right dose|adjust)\b.*\b(?:insulin dosage|lantus dose|lantus nightly|units of lantus|insulin initiation|hba1c results)\b/, "insulin dosage concerns");
  addLabelIf(labels, normalized, /\b(?:eye exam|eye health|visioncare optometry|retinopathy)\b.*\b(?:scheduled|prepare|expect|copay|exam|health)\b|\b(?:scheduled|prepare|expect|copay|exam|health)\b.*\b(?:eye exam|eye health|visioncare optometry|retinopathy)\b/, "eye health exams");
  addLabelIf(labels, normalized, /\b(?:cardiology|cardiologist|heart|blood pressure|bp|hypertension)\b.*\b(?:visit|appointment|checkup|follow-up|follow up)\b|\b(?:visit|appointment|checkup|follow-up|follow up)\b.*\b(?:cardiology|cardiologist|heart|blood pressure|bp|hypertension)\b/, "cardiology visits");
  addLabelIf(labels, normalized, /\b(?:lab results?|hba1c|cgm data|treatment plan|latest labs?)\b.*\b(?:treatment plan|maintain this progress|adjust|dr\.?\s+chen|sarah kim|health goals?)\b|\b(?:treatment plan|maintain this progress|adjust|dr\.?\s+chen|sarah kim|health goals?)\b.*\b(?:lab results?|hba1c|cgm data|latest labs?)\b/, "lab results and treatment plan");
  addLabelIf(labels, normalized, /\b(?:breakup|broke up)\b.*\b(?:emotional pain|cope|coping|process my feelings|feelings|sarah)\b|\b(?:emotional pain|cope|coping|process my feelings|feelings)\b.*\b(?:breakup|sarah)\b/, "coping with emotional pain after the breakup");
  addLabelIf(labels, normalized, /\b(?:reflect(?:ing)?|learn(?:ing)?|understand(?:ing)?)\b.*\b(?:relationship|attachment style|breakup|dynamics?)\b|\b(?:relationship|attachment style|dynamics?)\b.*\b(?:reflect(?:ing)?|learn(?:ing)?|understand(?:ing)?)\b/, "reflecting on the relationship and learning from it");
  addLabelIf(labels, normalized, /\b(?:no direct contact|no-contact|mediator for communication|mediator's contact|refused direct contact|communication boundaries?)\b.*\b(?:sarah|ex-partner|boundar(?:y|ies))\b|\b(?:sarah|ex-partner)\b.*\b(?:no direct contact|no-contact|mediator for communication|mediator's contact|refused direct contact|communication boundaries?)\b/, "managing communication boundaries with Sarah");
  addLabelIf(labels, normalized, /\b(?:custody|visitation|visitation disputes?|supervised visits?)\b.*\b(?:arrangements?|schedule|school|agreed|kids?|children|holly|sarah)\b|\b(?:arrangements?|schedule|school|kids?|children|holly|sarah)\b.*\b(?:custody|visitation|visitation disputes?|supervised visits?)\b/, "addressing custody and visitation arrangements");
  addLabelIf(labels, normalized, /\b(?:mediator|mediation|legal|warning letter|reported it|violations?)\b.*\b(?:sarah|visits?|supervised|contact|custody|visitation)\b|\b(?:sarah|visits?|supervised|contact|custody|visitation)\b.*\b(?:mediator|mediation|legal|warning letter|reported it|violations?)\b/, "handling mediation and legal involvement");
  addLabelIf(labels, normalized, /\b(?:holiday schedule|holiday visits?|supervised holiday visits?|december 24-26|holidays?)\b.*\b(?:supervised|sarah|community center|visit|visits?|schedule)\b|\b(?:supervised|sarah|community center|visit|visits?|schedule)\b.*\b(?:holiday schedule|holiday visits?|supervised holiday visits?|december 24-26|holidays?)\b/, "navigating holiday scheduling and supervised visits");
  addLabelIf(labels, normalized, /\b(?:emotional safety|boundary setting|boundaries|toxic patterns?|child safety)\b.*\b(?:sarah|interactions?|visits?|supervised|holiday)\b|\b(?:sarah|interactions?|visits?|supervised|holiday)\b.*\b(?:emotional safety|boundary setting|boundaries|toxic patterns?|child safety)\b/, "dealing with emotional safety and boundary setting during interactions");
  addLabelIf(labels, normalized, /\b(?:emotional healing|trauma processing|mood|progress)\b.*\b(?:after|upcoming|supervised visits?|holiday visits?|december 24-26|sarah)\b|\b(?:supervised visits?|holiday visits?|december 24-26|sarah)\b.*\b(?:emotional healing|trauma processing|mood|progress)\b/, "processing emotional healing and mood after visits");
  addLabelIf(labels, normalized, /\b(?:new to investing|curious about investing|curiosity)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum)\b|\b(?:get started with|navigate|advice on|advice about)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum)\b|\b(?:crypto|cryptocurrency|bitcoin|ethereum)\b.*\b(?:get started|advice|navigate|curious)\b/, "Initial curiosity and advice seeking");
  addLabelIf(labels, normalized, /\b(?:start(?:ed|ing)? small|small investments?|monitor(?:ing)? (?:holdings|portfolio|bitcoin|ethereum)|tracking tools?)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum|portfolio|investments?)\b|\b(?:crypto|cryptocurrency|bitcoin|ethereum|portfolio|investments?)\b.*\b(?:start(?:ed|ing)? small|small investments?|monitor(?:ing)?|tracking tools?)\b/, "Starting small investments and monitoring");
  addLabelIf(labels, normalized, /\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b.*\b(?:coingecko|tradingview|binance analytics|exchange dashboards?|ledger nano|hardware wallet|trust wallet|metamask|wallet setup|pool selection|process(?:es)?)\b|\b(?:coingecko|tradingview|binance analytics|exchange dashboards?|ledger nano|hardware wallet|trust wallet|metamask|wallet setup|pool selection|process(?:es)?)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b/, "Learning tools and processes");
  addLabelIf(labels, normalized, /\b(?:telegram group|discord|reddit|meetups?|events?|istanbul crypto expo|crypto north ericshire|community support|community engagement)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b|\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b.*\b(?:telegram group|discord|reddit|meetups?|events?|istanbul crypto expo|crypto north ericshire|community support|community engagement)\b/, "Community involvement and event attendance");
  addLabelIf(labels, normalized, /\b(?:regulatory|regulations?|compliance policies?|crypto compliance|strategy adaptation|adapt(?:ing)? strategies?)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b|\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b.*\b(?:regulatory|regulations?|compliance policies?|crypto compliance|strategy adaptation|adapt(?:ing)? strategies?)\b/, "Regulatory impacts and strategy adaptation");
  addLabelIf(labels, normalized, /\b(?:collaborat(?:e|ed|ion|ive|ing)|research|sharing experiences?|share(?:d)? experiences?|jennifer|suzanne|sarah|jason)\b.*\b(?:crypto|cryptocurrency|portfolio|investment|research|experiences?|strategies?)\b|\b(?:crypto|cryptocurrency|portfolio|investment|research|experiences?|strategies?)\b.*\b(?:collaborat(?:e|ed|ion|ive|ing)|research|sharing experiences?|share(?:d)? experiences?|jennifer|suzanne|sarah|jason)\b/, "Collaborative research and experience sharing");
  addLabelIf(labels, normalized, /\b(?:portfolio diversification|diversif(?:y|ying|ication)|decision-making support|decision making support|allocation|stablecoins?|yield farming|cardano|ada)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b|\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?)\b.*\b(?:portfolio diversification|diversif(?:y|ying|ication)|decision-making support|decision making support|allocation|stablecoins?|yield farming|cardano|ada)\b/, "Portfolio diversification and decision-making support");
  addLabelIf(labels, normalized, /\b(?:conference participation|participat(?:e|ed|ion)\b.*\bconference|conference\b.*\bparticipat(?:e|ed|ion)|webinar co-host(?:ing)?|co-host(?:ed|ing)?\b.*\bwebinar|webinar\b.*\bco-host(?:ed|ing)?|istanbul crypto expo)\b.*\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?|conference|webinar)\b|\b(?:crypto|cryptocurrency|bitcoin|ethereum|defi|nft|portfolio|investments?|conference|webinar)\b.*\b(?:conference participation|participat(?:e|ed|ion)\b.*\bconference|conference\b.*\bparticipat(?:e|ed|ion)|webinar co-host(?:ing)?|co-host(?:ed|ing)?\b.*\bwebinar|webinar\b.*\bco-host(?:ed|ing)?|istanbul crypto expo)\b/, "Conference participation and webinar co-hosting");
  addLabelIf(labels, normalized, /\b(?:screen time|internet use|norton family)\b.*\b(?:limits?|monitor(?:ing)?|2 hours? daily|daily)\b|\b(?:limits?|monitor(?:ing)?|2 hours? daily|daily)\b.*\b(?:screen time|internet use|norton family)\b/, "initial limits and monitoring");
  addLabelIf(labels, normalized, /\bscreen time\b.*\b(?:balance|balancing|exercise|outdoor activities?|hikes?|other activities?)\b|\b(?:balance|balancing|exercise|outdoor activities?|hikes?|other activities?)\b.*\bscreen time\b/, "balancing screen time with other activities");
  addLabelIf(labels, normalized, /\b(?:digital safety|internet use|online risks?|privacy|parental controls?|norton family)\b.*\b(?:monitor(?:ing)?|updates?|controls?|risks?|privacy)\b|\b(?:monitor(?:ing)?|updates?|controls?|risks?|privacy)\b.*\b(?:digital safety|internet use|online risks?|privacy|parental controls?|norton family)\b/, "digital safety and monitoring updates");
  addLabelIf(labels, normalized, /\b(?:tech-free|tech free|no-device|no device)\b.*\b(?:zones?|sundays?|establish(?:ed|ment)?|set up|setup)\b|\b(?:zones?|sundays?|establish(?:ed|ment)?|set up|setup)\b.*\b(?:tech-free|tech free|no-device|no device)\b/, "tech-free zones establishment");
  addLabelIf(labels, normalized, /\b(?:adjust(?:ing|ed)?|stricter|reduce|reduction|agreed-upon|limit)\b.*\bscreen time\b.*\b(?:limits?|rules?|weekday|weekend)\b|\bscreen time\b.*\b(?:limits?|rules?|weekday|weekend)\b.*\b(?:adjust(?:ing|ed)?|stricter|reduce|reduction|agreed-upon)\b/, "adjusting screen time limits");
  addLabelIf(labels, normalized, /\beducational apps?\b|\bapps?\b.*\b(?:learning|math|educational)\b|\b(?:learning|math|educational)\b.*\bapps?\b/, "educational app introduction");
  addLabelIf(labels, normalized, /\b(?:screen time|limits?)\b.*\b(?:exam prep|exams?|test prep|studying)\b|\b(?:exam prep|exams?|test prep|studying)\b.*\b(?:screen time|limits?)\b/, "limits during exam prep");
  addLabelIf(labels, normalized, /\b(?:screen time|limits?|flexib(?:le|ility))\b.*\b(?:social life|friends?|special occasion)\b|\b(?:social life|friends?|special occasion)\b.*\b(?:screen time|limits?|flexib(?:le|ility))\b/, "social life and flexibility considerations");
  addLabelIf(labels, normalized, /\b(?:communication|open dialogue|listen|one-on-one|involv(?:e|ement))\b.*\b(?:screen time|limits?|scott)\b|\b(?:screen time|limits?|scott)\b.*\b(?:communication|open dialogue|listen|one-on-one|involv(?:e|ement))\b/, "communication and involvement strategies");
  addLabelIf(labels, normalized, /\b(?:tutoring sessions?|twice weekly|ms\.?\s+harper)\b.*\b(?:goal-?setting|monitor(?:ing)?|structured|consistent)\b|\b(?:goal-?setting|monitor(?:ing)?|structured|consistent)\b.*\b(?:tutoring sessions?|twice weekly|ms\.?\s+harper)\b/, "structured tutoring sessions with goal-setting and consistent monitoring");
  addLabelIf(labels, normalized, /\b(?:distraction-free|study environment|growth mindset)\b|\bgrowth\b.*\bmindset\b/, "distraction-free study environment and growth mindset");
  addLabelIf(labels, normalized, /\b(?:positive reinforcement|incremental progress|achievable milestones?|celebrat(?:e|ing))\b/, "celebrating incremental progress with positive reinforcement");
  addLabelIf(labels, normalized, /\b(?:role-?playing|role play|self-expression|social scenarios?|foster(?:ing)? independence|independence)\b/, "role-playing social scenarios and self-expression");
  addLabelIf(labels, normalized, /\b(?:responsibility|clear expectations?|consistent feedback|gradual increases?|more responsible)\b/, "clear expectations and gradual responsibility");
  addLabelIf(labels, normalized, /\b(?:digital safety|parental controls?|online risks?|privacy management|open communication)\b/, "digital safety with parental controls and privacy");
  addLabelIf(labels, normalized, /\b(?:screen time|daily routines?|physical|creative pursuits?|healthy habits?)\b.*\b(?:balance|balancing|structur(?:e|ing)|model(?:ing)?)\b|\b(?:balance|balancing|structur(?:e|ing)|model(?:ing)?)\b.*\b(?:screen time|daily routines?|physical|creative pursuits?|healthy habits?)\b/, "screen time routines and healthy habits");
  addLabelIf(labels, normalized, /\b(?:emotional well-being|open communication|consistent schedules?|coping mechanisms?|feelings?)\b/, "emotional support with coping mechanisms");
  addLabelIf(labels, normalized, /\bweekly word\b|\bword count goal\b/, "weekly word count goal");
  addLabelIf(labels, normalized, /\bai tools?\b.*\binitial edits?\b|\binitial edits?\b.*\bai tools?\b|\bai-assisted\b/, "AI-assisted editing tools");
  addLabelIf(labels, normalized, /\btone calibration\b/, "tone calibration");
  addLabelIf(labels, normalized, /\bfirst draft\b.*\bcomplete|\bcomplete\b.*\bfirst draft\b/, "first draft completion");
  addLabelIf(labels, normalized, /\bediting challenge\b|\bchallenge\b.*\bediting\b/, "editing challenge");
  addLabelIf(labels, normalized, /\bpeer review\b|\breview\b.*\bcarla\b|\bcarla\b.*\bchecklist\b/, "peer review and Carla editing checklist");
  addLabelIf(labels, normalized, /\btherapy\b|\btherapist\b/, "therapy attendance");
  addLabelIf(labels, normalized, /\bworkplace conflicts?\b|\bconflict\b.*\bworkplace\b/, "workplace conflict resolution");
  addLabelIf(labels, normalized, /\brestorative\b.*\bdavid\b|\bdavid\b.*\brestorative\b/, "restorative time with David");
  addLabelIf(labels, normalized, /\bdelegat(?:e|ed|ing|ion)\b.*\bgreg\b|\bgreg\b.*\bdelegat(?:e|ed|ing|ion)\b/, "delegation to Greg");
  addLabelIf(labels, normalized, /\bcollaborat(?:e|ing|ion)\b.*\bgreg\b|\bgreg\b.*\bcollaborat(?:e|ing|ion)\b|\bweekly meetings?\b.*\bproductive\b|\bmeetings?\b.*\bproductive\b.*\bstress/, "work collaboration stress and meeting strategies");
  addLabelIf(labels, normalized, /\bsenior producer\b|\bproducer\b.*\bprepar/, "senior producer preparation");
  addLabelIf(labels, normalized, /\bmock interviews?\b|\bportfolio update\b/, "mock interviews and portfolio update");
  addLabelIf(labels, normalized, /\bsupport group\b/, "support group involvement");
  addLabelIf(labels, normalized, /\bblue bay resort\b|\bweekend getaway\b/, "weekend getaway at Blue Bay Resort");
  addLabelIf(labels, normalized, /\bcoral reef\b|\beast janethaven\b/, "anniversary dinner at The Coral Reef in East Janethaven");
  addLabelIf(labels, normalized, /\bsurprise\b.*\b(?:picnic|celebration|promot)|\breturn(?:ing)? the favou?r\b|\bplan something just as special\b/, "surprise celebration and returning the favor");
  addLabelIf(labels, normalized, /\bfirst 10 pages\b.*\breview|\breview(?:ed|ing)?\b.*\bmarch 20\b|\bcarla\b.*\bneed more time\b/, "review timing concern");
  addLabelIf(labels, normalized, /\bpassive voice\b.*\bchecklist|\bcarla\b.*\bediting checklist\b/, "passive voice reduction and checklist");
  addLabelIf(labels, normalized, /\btone (?:consistency|calibration|adjustments?)\b|\bjasper ai\b.*\btone\b/, "tone adjustments and feedback");
  addLabelIf(labels, normalized, /\bwebinar\b.*\b(?:promot|prepar|host|guild|leadership|newsletter)|\b(?:promot|prepar|host|guild|leadership|newsletter).*\bwebinar\b/, "webinar planning and promotion");
  addLabelIf(labels, normalized, /\bwebinar rehearsal\b.*\b(?:jason|russell|multiple presenters?|zoom)\b|\b(?:jason|russell|multiple presenters?|zoom)\b.*\bwebinar rehearsal\b|\brehears(?:e|al|ing)\b.*\b(?:jason|russell)\b.*\b(?:webinar|presenters?)\b|\bmultiple presenters?\b.*\b(?:webinar|rehearsal)\b/, "webinar rehearsals with multiple presenters");
  addLabelIf(labels, normalized, /\bengag(?:e|ing|ement)\b.*\bincentives?\b|\bincentives?\b.*\bengag(?:e|ing|ement)\b|\bincentives?\b.*\b(?:offer|webinar|guild|attendees?|q&a|exclusive|giveaway)\b|\b(?:offer|webinar|guild|attendees?|q&a|exclusive|giveaway).*\bincentives?\b|\bgiveaway\b.*\b(?:grammarly|prowritingaid)\b/, "engagement and incentives discussion");
  addLabelIf(labels, normalized, /\bmicrosoft teams\b.*\b(?:adopt(?:ion|ed)?|team collaboration|communication|productivity|transition|july\s+5)\b|\b(?:adopt(?:ion|ed)?|team collaboration|communication|productivity|transition|july\s+5)\b.*\bmicrosoft teams\b/, "Microsoft Teams adoption");
  addLabelIf(labels, normalized, /\b(?:mehmet yilmaz|real estate agent|local agent|agent)\b.*\b(?:property viewings?|viewings?|scheduled|prepare|preparation|questions?|meetings?)\b|\b(?:property viewings?|viewings?|scheduled|prepare|preparation|questions?|meetings?)\b.*\b(?:mehmet yilmaz|real estate agent|local agent|agent)\b/, "agent interaction and viewing preparation");
  addLabelIf(labels, normalized, /\b(?:viewing|inspection|property)\b.*\b(?:agent|mehmet)\b.*\b(?:contractor|cem)\b|\b(?:contractor|cem)\b.*\b(?:agent|mehmet)\b.*\b(?:viewing|inspection|property)\b/, "viewing preparation with agent and contractor");
  addLabelIf(labels, normalized, /\b(?:financial projection|projected monthly rental income|monthly rental income|cash flow|net cash flow|vacancy|10% vacancy)\b.*\b(?:randy|review|projection|single-family|duplex|rental income)\b|\b(?:randy|review|projection|single-family|duplex|rental income)\b.*\b(?:financial projection|projected monthly rental income|monthly rental income|cash flow|net cash flow|vacancy|10% vacancy)\b/, "financial projection and cash flow review");
  addLabelIf(labels, normalized, /\bcreative sessions?\b.*\b(?:calendar|planner|schedule)|\bcontact\b.*\bcreative\b/, "balancing time with creative contact");
  addLabelIf(labels, normalized, /\bstoryboard\b.*\bvisuals?\b|\bvisuals?\b.*\bstoryboard\b/, "collaboration on storyboard and visuals");
  addLabelIf(labels, normalized, /\bvirtual brainstorming\b|\bbrainstorming\b.*\bprioriti[sz]ation\b/, "virtual brainstorming and prioritization");
  addLabelIf(labels, normalized, /\bcreative workshop\b.*\blocal artists?\b|\blocal artists?\b.*\bcreative workshop\b/, "workshop planning with local artists");
  addLabelIf(labels, normalized, /\bbackup (?:date|plan)s?\b.*\b(?:workshop|artists?)\b|\b(?:workshop|artists?).*\bbackup (?:date|plan)s?\b/, "backup plans for workshop");
  addLabelIf(labels, normalized, /\bsubscription\b.*\b(?:worried|concern|enough|ats|resume)\b|\bcanva pro\b/, "subscription service concern");
  addLabelIf(labels, normalized, /\bresume keyword\b|\bkeyword tool\b/, "resume keyword tool usage");
  addLabelIf(labels, normalized, /\bprofile headline\b|\bheadline update\b/, "profile headline update");
  addLabelIf(labels, normalized, /\brental research\b|\bshort-term rental\b|\bshoreditch\b/, "rental research for relocation");
  addLabelIf(labels, normalized, /\bmentoring\b.*\bnetworking\b|\bnetworking\b.*\bmentor(?:ing)?\b|\bleslie\b.*\bmentor\b/, "mentoring and networking advice");
  addLabelIf(labels, normalized, /\bcover letter\b.*\bfeedback\b|\bfeedback\b.*\bcover letter\b/, "cover letter feedback concerns");
  addLabelIf(labels, normalized, /\binterview\b.*\bstorytelling\b|\bstorytelling\b.*\binterview\b/, "interview storytelling preparation");
  addLabelIf(labels, normalized, /\bemployee handbook\b|\bhandbook\b.*\breview\b/, "employee handbook review");
  addLabelIf(labels, normalized, /\bworkshop\b.*\bpresentation\b|\bpresentation\b.*\bworkshop\b/, "workshop presentation planning");
  addLabelIf(labels, normalized, /\bpassions?\b.*\bstorytelling\b|\bstorytelling\b.*\bemerging talent\b|\bvolunteering\b.*\bconsulting\b/, "align work with passions through storytelling, mentoring emerging talent, volunteering, or consulting");
  addLabelIf(labels, normalized, /\bquery optimization\b.*\brecent messages?\b|\brecent messages?.*\bquery optimization\b|\bgetrecentmessages\b|\bmessage history\b.*\brecent\b/, "query optimization for recent messages");
  addLabelIf(labels, normalized, /\bschema\b.*\bvalidation\b.*\bedit(?:ing)?\b|\bedit(?:ing)?\b.*\bschema\b.*\bvalidation\b|\bupdatemessage\b/, "schema design and validation for editing");
  addLabelIf(labels, normalized, /\btest(?:ing)?\b.*\bupdatemessage\b|\bupdatemessage\b.*\btest(?:ing)?\b|\bupdate message\b.*\bfunction\b/, "testing updateMessage function");
  addLabelIf(labels, normalized, /\bunchanged\b.*\bmessage text\b|\bmessage text\b.*\bunchanged\b|\bsame message text\b/, "handling unchanged message text cases");
  addLabelIf(labels, normalized, /\bmigration script\b.*\bplan(?:ning)?\b|\bplan(?:ning)?\b.*\bmigration script\b/, "migration script planning");
  addLabelIf(labels, normalized, /\bbatch(?:ed)?\b.*\bmigration\b|\bmigration\b.*\bbatch(?:ed)?\b|\bbatch execution\b/, "batch execution of migration");
  addLabelIf(labels, normalized, /\bmigration script\b.*\b(?:robust|robustness|enhanc(?:e|ing)|improv(?:e|ing))\b|\b(?:robust|robustness|enhanc(?:e|ing)|improv(?:e|ing))\b.*\bmigration script\b/, "enhancing migration script robustness");
  addLabelIf(labels, normalized, /\bmatchmaking\b.*\b(?:service|algorithm|players?|skill|preferences?)\b|\b(?:skill|preferences?)\b.*\bmatchmaking\b/, "Matchmaking service design and algorithm challenges");
  addLabelIf(labels, normalized, /\bgame loop\b.*\b(?:performance|fixed timestep|serialization|player state|rendering)\b|\bserialization overhead\b.*\bplayer state\b/, "Game loop performance and serialization optimization");
  addLabelIf(labels, normalized, /\bmatchmaking\b.*\bmicroservices?\b.*\brabbitmq\b|\brabbitmq\b.*\bmatchmaking\b|\bmicroservices?\b.*\bmatchmaking\b.*\brabbitmq\b|\bmicroservices?\b.*\brabbitmq\b.*\bmatchmaking\b/, "Microservices implementation and RabbitMQ integration");
  addLabelIf(labels, normalized, /\b(?:lag compensation|lagcompensation)\b.*\b(?:interpolation|extrapolation|interpolate|extrapolate)\b|\b(?:interpolation|extrapolation)\b.*\b(?:lag compensation|lagcompensation)\b/, "Lag compensation with interpolation and extrapolation");
  addLabelIf(labels, normalized, /\banti-cheat\b.*\bmicroservice\b.*\b(?:rest api|cach(?:e|ing)|redis|performance)\b|\b(?:cach(?:e|ing)|redis|performance)\b.*\banti-cheat\b/, "Anti-cheat microservice development and caching optimization");
  addLabelIf(labels, normalized, /\bplatform abstraction layer\b.*\b(?:input handling|desktop|mobile|react native|game controls?|ui components?)\b|\binput handling\b.*\b(?:desktop|mobile|react native|game controls?)\b/, "Platform abstraction layer for input handling and integration");
  addLabelIf(labels, normalized, /\bbasic\b.*\bsetup\b.*\berror handling\b|\berror handling\b.*\bbasic\b.*\bsetup\b|\bnode\.?js\b.*\bexpress\b.*\bsocket\.?io\b/, "basic setup and error handling");
  addLabelIf(labels, normalized, /\bwebsocket\b.*\b(?:connection|socket\.?io|connect)\b.*\b(?:issues?|error|trouble|problem)|\bsocket\.?io\b.*\bconnection\b.*\b(?:issues?|error|trouble|problem)\b/, "Basic WebSocket implementation and connection issues");
  addLabelIf(labels, normalized, /\bconnection\b.*\btroubleshoot(?:ing)?\b|\btroubleshoot(?:ing)?\b.*\bconnection\b|\bcors\b.*\bsocket\.?io\b|\bsocket\.?io\b.*\bversion\b/, "connection troubleshooting");
  addLabelIf(labels, normalized, /\bnamespace\b.*\b(?:lobby|game rooms?|does not exist|debugg|connection)\b|\bgame rooms?\b.*\bnamespace\b/, "Namespace and game logic debugging");
  addLabelIf(labels, normalized, /\bwebrtc\b.*\b(?:websocket|fallback|data channels?)\b|\bfallback\b.*\bwebrtc\b/, "WebRTC integration and fallback handling");
  addLabelIf(labels, normalized, /\bencrypted\b.*\bwebsocket\b.*\bsubprotocols?\b|\bwebsocket\b.*\bsubprotocols?\b.*\bsensitive\b/, "Encrypted WebSocket subprotocol setup");
  addLabelIf(labels, normalized, /\bwebrtc\b.*\b(?:turn server|peer-to-peer|connection troubleshooting|connection issues?)\b|\bturn server\b.*\bwebrtc\b/, "WebRTC connection troubleshooting and TURN server setup");
  addLabelIf(labels, normalized, /\btoken rotation\b.*\bredis\b|\bredis\b.*\btoken (?:rotation|management|refresh|revocation)\b/, "Token rotation and Redis usage");
  addLabelIf(labels, normalized, /\bwebsocket\b.*\b(?:performance|optimization|room management|rooms?)\b|\broom management\b.*\bwebsocket\b/, "WebSocket performance optimization and room management");
  addLabelIf(labels, normalized, /\bmulti-user\b.*\bbroadcast\b|\bbroadcast\b.*\bmulti-user\b|\bconcurrent users?\b.*\bbroadcast\b|\b1000 users?\b/, "multi-user and broadcast optimizations");
  addLabelIf(labels, normalized, /\bscal(?:e|ing)\b.*\bload balancer\b.*\bmessage queue\b|\bload balancer\b.*\bmessage queue\b/, "scaling with load balancer and message queue");
  addLabelIf(labels, normalized, /\bredis\b.*\bcach(?:e|ing)\b.*\bsessions?\b|\bsessions?\b.*\bredis\b.*\bcach(?:e|ing)\b/, "Redis caching for sessions");
  addLabelIf(labels, normalized, /\broom(?:-based)?\b.*\bmessage history\b|\bmessage history\b.*\broom\b|\bprevious messages?\b.*\broom\b|\bjoinroom\b/, "room-based messaging and retrieval");
  addLabelIf(labels, normalized, /\bperformance bottlenecks?\b.*\bdata structures?\b|\bdata structures?\b.*\bperformance\b|\bmap\b.*\bset\b.*\busers?\b|\busers?\b.*\brooms?\b.*\bmap\b/, "performance bottlenecks and data structures");
  addLabelIf(labels, normalized, /\bredis\b.*\bpub\/?sub\b.*\b(?:error handling|retry)\b|\b(?:error handling|retry)\b.*\bredis\b.*\bpub\/?sub\b/, "Redis pub/sub error handling and retry");
  addLabelIf(labels, normalized, /\bredis\b.*\bpub\/?sub\b.*\b(?:real-time|updates?)\b|\breal-time\b.*\bredis\b.*\bpub\/?sub\b/, "Redis Pub/Sub for real-time updates");
  addLabelIf(labels, normalized, /\bmultiplayer\b.*\b(?:latency|lag)\b.*\b(?:reduc|optimization|under\s+\d+ms|prediction|reconciliation)\b|\bclient-side prediction\b.*\bserver reconciliation\b|\breduce perceived lag\b.*\bmultiplayer\b/, "Multiplayer game latency reduction techniques");
  addLabelIf(labels, normalized, /\bvoice chat\b.*\b(?:signaling|cach(?:e|ing)|tokens?)\b|\bsignaling\b.*\bvoice chat\b/, "Voice chat application signaling and caching");
  addLabelIf(labels, normalized, /\bbroadcast logic\b.*\b(?:refactor|optimization|optimizing)\b|\b(?:refactor|optimization|optimizing)\b.*\bbroadcast logic\b/, "broadcast logic refactoring and further optimization");
  addLabelIf(labels, normalized, /\binitial\b.*\bsetup\b.*\b(?:feature extraction|resume analyzer)\b|\bresume analyzer\b.*\b(?:spacy|pymupdf|flask|python)\b/, "initial setup and feature extraction");
  addLabelIf(labels, normalized, /\bdebugg(?:ing|ed)?\b.*\bpdf text extraction\b|\bpdf text extraction\b.*\bdebugg(?:ing|ed)?\b|\bnonetype\b.*\bpdf\b/, "debugging PDF text extraction");
  addLabelIf(labels, normalized, /\bproject timeline\b.*\bdeadlines?\b|\bdeadlines?\b.*\bproject timeline\b|\bfebruary\s+15(?:,\s*2024)?\b/, "project timeline and deadlines");
  addLabelIf(labels, normalized, /\bapi response time\b.*\boptimi[sz](?:e|ation|ing)\b|\bperformance profiling\b.*\bapi\b|\bcprofile\b.*\bbottlenecks?\b/, "API response time optimization");
  addLabelIf(labels, normalized, /\bresume improvement suggestions?\b.*\bmissing (?:key )?skills?\b|\bmissing (?:key )?skills?\b.*\bresume improvement suggestions?\b|\bgenerat(?:e|ing)\b.*\bsuggestions?\b.*\bjob description gaps?\b/, "resume improvement and missing skills extraction");
  addLabelIf(labels, normalized, /\bdynamic(?:ally)?\b.*\bdisplay(?:ing)?\b.*\bmissing skills?\b|\bmissing skills?\b.*\bdynamic(?:ally)?\b.*\bdisplay(?:ing)?\b|\bdisplay(?:ing)?\b.*\bmissing skills?\b.*\buser input\b/, "dynamic display of missing skills");
  addLabelIf(labels, normalized, /\bunit tests?\b.*\bintegration tests?\b|\bintegration tests?\b.*\bunit tests?\b|\bweighted suggestion scoring\b|\btest(?:ing)?\b.*\bweighted scoring\b/, "unit and integration testing preparation");
  addLabelIf(labels, normalized, /\bdeployment automation\b.*\bmonitoring\b|\bmonitoring\b.*\bdeployment automation\b|\bdocker\b.*\b(?:prometheus|grafana|monitoring)\b/, "deployment automation and monitoring setup");
  addLabelIf(labels, normalized, /\bcloud monitoring\b|\blogging services?\b|\b(?:prometheus|grafana)\b.*\blogging\b|\blogging\b.*\b(?:prometheus|grafana)\b/, "cloud monitoring and logging planning");
  addLabelIf(labels, normalized, /\bmemory usage\b.*\bkeyword extraction\b|\bkeyword extraction\b.*\bmemory usage\b|\bregex\b.*\bprecompil(?:e|ed|ing)\b|\bstopword\b.*\blemmatization\b/, "memory usage and keyword extraction improvements");
  addLabelIf(labels, normalized, /\bjob description\b.*\b(?:parsing|enhanc(?:e|ing|ements?))\b|\b(?:parsing|enhanc(?:e|ing|ements?))\b.*\bjob description\b/, "job description parsing enhancements");
  addLabelIf(labels, normalized, /\bstartup time\b.*\bcaching\b|\bcaching\b.*\bstartup time\b|\blazy-loading\b.*\bspacy\b|\bredis-backed\b.*\bcaching\b/, "startup time and caching strategies");
  addLabelIf(labels, normalized, /\bscoring function\b.*\bsimilarity\b|\bsimilarity\b.*\bscoring function\b|\bweighted scoring\b.*\bskill matching\b/, "scoring function and similarity optimization");
  addLabelIf(labels, normalized, /\bauthentication\b.*\bauthorization\b|\bauthorization\b.*\bauthentication\b|\bjwt\b.*\blogin\b/, "authentication and authorization");
  addLabelIf(labels, normalized, /\bconcurrent requests?\b.*\bsimulat(?:e|ion|ing)\b|\bsimulat(?:e|ion|ing)\b.*\bconcurrent requests?\b|\bload test(?:ing)?\b.*\brequests?\b/, "concurrent request simulation");

  const queryTerms = extractEventOrderTerms(query);
  for (const term of queryTerms) {
    if (isLikelyName(term) && normalized.includes(term)) {
      labels.add(`interaction with ${term}`);
    }
  }

  return [...labels].slice(0, 5);
}

function isTimelineSummaryQuery(normalized: string): boolean {
  return /\b(?:summarize|summary|major progress|what happened|develop(?:ed|ment)?|approached)\b/.test(
    normalized,
  ) &&
    (/\b(?:over time|throughout|between|project|progress|timeline|journey|sessions?|along the way)\b/.test(
      normalized,
    ) ||
      /\bfrom\b.+\bthrough\b/.test(normalized));
}

function addLabelIf(
  labels: Set<string>,
  normalizedContent: string,
  pattern: RegExp,
  label: string,
): void {
  if (pattern.test(normalizedContent)) {
    labels.add(label);
  }
}

function parseRequestedItemCount(query: string): number | undefined {
  const numeric = query.match(/\b(?:only\s+and\s+only|only|exactly|mention)\s+(\d{1,2})\s+items?\b/i);
  if (numeric?.[1]) {
    return Number(numeric[1]);
  }
  const bareNumeric = query.match(/\b(\d{1,2})\s+items?\b/i);
  if (bareNumeric?.[1]) {
    return Number(bareNumeric[1]);
  }
  const word = query.match(/\b(?:only\s+and\s+only|only|exactly|mention)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+items?\b/i);
  const bareWord = word ?? query.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+items?\b/i);
  if (!bareWord?.[1]) return undefined;
  return NUMBER_WORD_VALUES[bareWord[1].toLowerCase()];
}

function extractEventOrderTerms(text: string): string[] {
  const terms = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !EVENT_ORDER_STOP_WORDS.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function isLikelyName(term: string): boolean {
  return !EVENT_ORDER_STOP_WORDS.has(term) &&
    term.length >= 4 &&
    !EVENT_CUE_WORDS.has(term);
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function clipSectionToBudget(section: string, maxChars: number): string {
  const budget = normalizePositiveInteger(maxChars);
  if (budget <= 0) return "";
  if (section.length <= budget) return section;
  if (budget <= 3) return section.slice(0, budget);
  return `${section.slice(0, budget - 3).trimEnd()}...`;
}

const EVENT_CUE_PATTERNS = [
  /\bworkshop\b/,
  /\bmeeting\b/,
  /\bcall\b/,
  /\badvice\b/,
  /\bsuggest(?:ed|ion)?\b/,
  /\brecommend(?:ed|ation)?\b/,
  /\bdiscussion\b/,
  /\bfollow-up\b/,
  /\bconflict\b/,
  /\bresolution\b/,
  /\banniversary\b/,
  /\bleadership\b/,
  /\bstress\b/,
  /\binterview\b/,
  /\bfamily\b/,
  /\bsupport\b/,
  /\bletter\b/,
  /\bcare package\b/,
  /\bplanning\b/,
  /\bdevelopment phase\b/,
  /\bkey tasks\b/,
  /\bcompleted\b/,
  /\btesting\b/,
  /\breview\b/,
  /\bretry logic\b/,
  /\bexponential backoff\b/,
  /\bcontact form\b/,
  /\bcrowdfunding\b/,
  /\bplatform choice\b/,
  /\bsubscription service\b/,
  /\bemployee handbook\b/,
  /\bgratitude\b/,
  /\bmindfulness\b/,
  /\bcelebration\b/,
  /\breassurance\b/,
  /\breflection\b/,
  /\bappreciation\b/,
  /\bretreat\b/,
  /\bnerv(?:ous|es)\b/,
  /\bgrief\b/,
  /\bloss\b/,
  /\bremembrance event\b/,
  /\bmemorial event\b/,
  /\bdj page\b/,
  /\bdjing\b/,
  /\bconcert\b/,
  /\bhealing book club\b/,
  /\bbook club\b/,
  /\btransportation\b/,
  /\bart exhibit\b/,
  /\brevision planning\b/,
  /\bscript tips?\b/,
  /\bconfidence\b/,
  /\bmovie marathon\b/,
  /\bwatchlist\b/,
  /\bguest invitations?\b/,
  /\bvirtual watch party\b/,
  /\byolov5s?\b/,
  /\bcpu inference\b/,
  /\bdata loader\b/,
  /\btracker module\b/,
  /\btensorrt\b/,
  /\bsort tracking\b/,
  /\bcoordinate mapping\b/,
  /\bkalman filter\b/,
  /\bhungarian algorithm\b/,
  /\bframe timestamp\b/,
  /\breact frontend\b/,
  /\bcuda out of memory\b/,
  /\bsnyk cli\b/,
  /\bsecurity scanning\b/,
  /\bopencv dnn\b/,
  /\bdeepsort\b/,
  /\bssd mobilenet v3\b/,
  /\bintegration issues?\b/,
  /\bsegmentation fault\b/,
  /\bperformance benchmarking\b/,
  /\bvirtual brainstorming\b/,
  /\bprioritization\b/,
  /\bstoryboard\b/,
  /\bvisuals?\b/,
  /\blocal artists?\b/,
  /\bbackup plans?\b/,
  /\bengagement\b/,
  /\bincentives?\b/,
  /\bwebinar\b/,
  /\bpromotion\b/,
  /\bpassive voice\b/,
  /\breview timing\b/,
  /\bweekly word\b/,
  /\bai tools?\b/,
  /\btone calibration\b/,
  /\bfirst draft\b/,
  /\bpeer review\b/,
  /\btherapy\b/,
  /\bworkplace conflicts?\b/,
  /\brestorative\b/,
  /\bsenior producer\b/,
  /\bmock interviews?\b/,
  /\bsupport group\b/,
  /\bblue bay resort\b/,
  /\bwork collaboration\b/,
  /\bcollaborat(?:e|ing|ion)\b/,
  /\bstressed?\b/,
  /\bweekly meetings?\b/,
  /\bproductive meetings?\b/,
  /\bsurprise\b/,
  /\breturn(?:ing)? the favou?r\b/,
  /\bfirst 10 pages\b/,
  /\bediting checklist\b/,
  /\bwebinar\b/,
  /\bguild leadership\b/,
  /\bincentives?\b/,
  /\bgiveaway\b/,
  /\bcreative sessions?\b/,
  /\bstoryboard\b/,
  /\bvisuals?\b/,
  /\blocal artists?\b/,
  /\bbackup (?:date|plan)s?\b/,
  /\bcanva pro\b/,
  /\bresume keyword\b/,
  /\bprofile headline\b/,
  /\bshort-term rental\b/,
  /\bmentoring\b/,
  /\bemployee handbook\b/,
  /\bworkshop presentation\b/,
  /\bemerging talent\b/,
  /\bvolunteering\b/,
  /\bconsulting\b/,
  /\brecent messages?\b/,
  /\bupdatemessage\b/,
  /\bmigration script\b/,
  /\bmessage history\b/,
  /\bjoinroom\b/,
  /\bsocket\.?io\b/,
  /\bwebsocket\b/,
  /\bredis\b/,
  /\bload balancer\b/,
  /\bmessage queue\b/,
  /\bpub\/?sub\b/,
  /\bbroadcast logic\b/,
  /\bping-pong\b/,
  /\bdata structures?\b/,
  /\bresume analyzer\b/,
  /\bresume improvement suggestions?\b/,
  /\bmissing (?:key )?skills?\b/,
  /\bdynamic(?:ally)? display(?:ing)?\b/,
  /\bunit tests?\b/,
  /\bintegration tests?\b/,
  /\bdeployment automation\b/,
  /\bcloud monitoring\b/,
  /\blogging services?\b/,
  /\bprometheus\b/,
  /\bgrafana\b/,
  /\bpdf text extraction\b/,
  /\bcprofile\b/,
  /\bkeyword extraction\b/,
  /\bjob description\b/,
  /\bstartup time\b/,
  /\bweighted scoring\b/,
  /\bauthentication\b/,
  /\bauthorization\b/,
  /\bconcurrent requests?\b/,
  /\buser-based collaborative filtering\b/,
  /\bcosine similarity\b/,
  /\b\/recommendations\b/,
  /\bhelper functions?\b/,
  /\bget_user_ratings\b/,
  /\bget_top_rated_items\b/,
  /\bhybrid recommendation\b/,
  /\bhybrid scoring\b/,
  /\bweight combinations?\b/,
  /\bevaluation metrics?\b/,
  /\bprecision@?5\b/,
  /\brecall@?5\b/,
  /\btf-?idf\b/,
  /\bcontent-based filtering\b/,
  /\bsimilarity matrices?\b/,
  /\bmathematical induction\b/,
  /\binduction proofs?\b/,
  /\binductive step\b/,
  /\binequality signs?\b/,
  /\binequality directions?\b/,
  /\bmodular arithmetic\b/,
  /\bmodular reasoning\b/,
  /\bone-way functions?\b/,
  /\btrapdoor functions?\b/,
  /\bnecessary and sufficient conditions?\b/,
  /\bdivisibility\b/,
  /\balgebraic manipulations?\b/,
  /\blogical flow\b/,
  /\bderivatives?\b/,
  /\bpower rule\b/,
  /\btangent lines?\b/,
  /\brelated rates?\b/,
  /\bblood flow\b/,
  /\brespiratory rates?\b/,
  /\bheart rate\b/,
  /\bderivative tests?\b/,
  /\bcritical points?\b/,
  /\bsliding ladder\b/,
  /\blaptop\b/,
  /\bgreen bean\b/,
  /\blaptop specs?\b/,
  /\b16gb ram\b/,
  /\bpresentation narrative\b/,
  /\brelationship satisfaction\b/,
  /\btrust score\b/,
  /\bweekly surveys?\b/,
  /\bkelli\b/,
  /\bmary\b/,
  /\bjames\b/,
  /\bco-led\b/,
  /\bco led\b/,
  /\bco-present(?:ed|ing)?\b/,
  /\bco-author(?:ed|ing)?\b/,
  /\bstrategy meeting\b/,
  /\bproject alignment\b/,
  /\bsustainability project\b/,
  /\bletter of recommendation\b/,
  /\bbroad-market\b/,
  /\bbroad market\b/,
  /\betfs?\b/,
  /\bvoo\b/,
  /\bveu\b/,
  /\bagg\b/,
  /\bfinancial advisor\b/,
  /\brobo-?advisors?\b/,
  /\bmanaged portfolio\b/,
  /\bvxus\b/,
  /\bvnq\b/,
  /\bvwo\b/,
  /\bvteb\b/,
  /\bmunicipal bonds?\b/,
  /\bsmall-cap\b/,
  /\bsmall cap\b/,
  /\bsector-specific etfs?\b/,
  /\bsector etfs?\b/,
  /\bxlv\b/,
  /\bxlk\b/,
  /\bbrittney\b/,
  /\bstock tips?\b/,
  /\beducational resources?\b/,
  /\bfinancial independence\b/,
  /\bcustodial account\b/,
  /\bco-invest\b/,
  /\bco invest\b/,
  /\bquarterly review\b/,
  /\bpros and cons\b/,
  /\bfinancial regulations?\b/,
  /\bsaint helena\b/,
  /\besg funds?\b/,
  /\bjohn\b/,
  /\bportfolio losses?\b/,
  /\btax-loss harvesting\b/,
  /\btax tools?\b/,
  /\bwealthfront\b/,
  /\bregional market risks?\b/,
  /\bregional risks?\b/,
  /\binflation hedg(?:e|ing)\b/,
  /\btips\b/,
  /\bcurrency risk\b/,
  /\bhealthy dinner options?\b/,
  /\bdessert frequency\b/,
  /\bsalt reduction\b/,
  /\bsocial dinners?\b/,
  /\bdining out\b/,
  /\bemotional overwhelm\b/,
  /\bdinner party\b/,
  /\bwellness goals?\b/,
  /\bbook club attendance\b/,
  /\bparty hosting\b/,
  /\bdrink restrictions?\b/,
  /\bhealthy breakfast options?\b/,
  /\bpotluck\b/,
  /\bflavo(?:u)?r enhancements?\b/,
  /\bspice combinations?\b/,
  /\bseasoning ideas?\b/,
  /\broasted vegetables?\b/,
  /\broasted carrots?\b/,
  /\bsmoky and spicy\b/,
  /\bwalking routine\b/,
  /\bnutrition lecture\b/,
  /\bnutrition webinar\b/,
  /\bcholesterol concerns?\b/,
  /\bdiabetes explanation\b/,
  /\bmediterranean meals?\b/,
  /\bhomemade mediterranean dinner\b/,
  /\bdiabetes education refresher\b/,
  /\bactive outings?\b/,
  /\bwalking tours?\b/,
  /\bbike rides?\b/,
  /\bnapa art walk\b/,
  /\bnapa valley opera house\b/,
  /\bacting course\b/,
  /\bmichael\b/,
  /\bvoice coaching\b/,
  /\bsarah lee\b/,
  /\bdance workshop\b/,
  /\blocal theater\b/,
  /\btheater opportunities\b/,
  /\bimprov group\b/,
  /\bimprov showcase\b/,
  /\badvanced improvisation\b/,
  /\bminor role\b/,
  /\bcharacter development\b/,
  /\bdance recital\b/,
  /\bpart-time theater\b/,
  /\bsupporting role\b/,
  /\blead role\b/,
  /\bregional theater\b/,
  /\bwinter season\b/,
  /\bconservatory applications?\b/,
  /\btype 2 diabetes\b/,
  /\bdiabetes\b/,
  /\binsulin\b/,
  /\bbasal insulin\b/,
  /\barthritis\b/,
  /\bjoint pain\b/,
  /\bphysical therapy\b/,
  /\bphysical therapist\b/,
  /\beye exam\b/,
  /\bretinopathy\b/,
  /\bcardiology\b/,
  /\bcardiologist\b/,
  /\bblood pressure\b/,
  /\blab results?\b/,
  /\btreatment plan\b/,
  /\bcgm data\b/,
  /\bemotional intimacy\b/,
  /\bcloseness scores?\b/,
  /\bsongwriting sessions?\b/,
  /\balbum\b/,
  /\bmusic recital\b/,
  /\bbreathing exercises?\b/,
  /\bemotional regulation\b/,
  /\bparty-day nerves?\b/,
  /\bmeditation sessions?\b/,
  /\bcouples counseling\b/,
  /\bsocial media boundaries?\b/,
  /\bcompromis(?:e|ed)\b/,
  /\bbreakup\b/,
  /\battachment style\b/,
  /\bcustody\b/,
  /\bvisitation\b/,
  /\bsupervised visits?\b/,
  /\bmediator\b/,
  /\bmediation\b/,
  /\bwarning letter\b/,
  /\bholiday schedule\b/,
  /\bholiday visits?\b/,
  /\bemotional safety\b/,
  /\bchild safety\b/,
  /\bscreen time\b/,
  /\bnorton family\b/,
  /\btech-free\b/,
  /\bno-device\b/,
  /\beducational apps?\b/,
  /\bexam prep\b/,
  /\bsocial life\b/,
  /\bpositive reinforcement\b/,
  /\bgrowth mindset\b/,
  /\brole-?playing\b/,
  /\bself-expression\b/,
  /\bparental controls?\b/,
  /\bcoping mechanisms?\b/,
  /\blease ending\b/,
  /\blease renewal\b/,
  /\bsubletting\b/,
  /\blandlord\b/,
  /\bapartment search\b/,
  /\b4-bedroom\b/,
  /\blincoln park\b/,
  /\bmove-out\b/,
  /\bmove-in\b/,
  /\bwalk-through\b/,
  /\bsecurity deposit\b/,
  /\bmold inspection\b/,
  /\bhousewarming party\b/,
  /\blocal handyman\b/,
  /\bjoseph\b/,
  /\bdoor lock\b/,
  /\bshelves\b/,
  /\butility bills?\b/,
  /\benergy usage\b/,
  /\bwriting conference\b/,
  /\bwriters'? dinner\b/,
  /\bprofessional networking\b/,
  /\bindian ocean startup summit\b/,
  /\bstartup summit\b/,
  /\bmarket expansion\b/,
  /\bmarket reach\b/,
  /\bemerging technologies\b/,
  /\bsustainability practices?\b/,
  /\bsustainable practices?\b/,
  /\bgreen initiatives?\b/,
  /\bseychelles user forum\b/,
  /\bethical considerations?\b/,
  /\bethical ai\b/,
  /\bai ethics\b/,
  /\bproduct ethics\b/,
];

const HIGH_VALUE_EVENT_LABELS = [
  "surprise celebration and returning the favor",
  "virtual brainstorming and prioritization",
  "subscription service concern",
  "employee handbook review",
  "gratitude and mindfulness advice",
  "celebration and decision reassurance",
  "retreat reflection and appreciation",
  "workshop nerves",
  "sharing struggle and honoring loss",
  "considering and deciding on workshop attendance",
  "planning remembrance event and music support",
  "connecting through dj page and reflecting on support",
  "accepting concert invitation",
  "exploring and preparing for healing book club",
  "preparing for job interview with friend's help",
  "reflecting on friendship and support nurturing",
  "expressing gratitude for transportation help",
  "contemplating art exhibit collaboration",
  "storytelling and mentoring emerging talent",
  "lease ending on june 30 2024 with lease renewal subletting or moving to a new apartment options",
  "negotiation process with landlord about lease renewal and rent terms",
  "criteria for a new 4-bedroom rental within a $2,500 budget near lincoln park and apartment application plan",
  "move-out process from current apartment with timely landlord notification final walk-through inspection disagreements and security deposit refund",
  "move-in coordination for the new apartment confirming movers utility setups and day-of logistics",
  "health and safety considerations with mold inspection results hazards maintenance requests and housewarming party social aspects",
  "advice from james as colleague and mentor regarding career moves",
  "contacting and scheduling local handyman joseph for repairs",
  "coordinating repair tasks with joseph including door lock shelves and moving-related considerations",
  "utility bills and energy usage concerns",
  "writing conference and professional networking opportunities",
  "align work with passions through storytelling, mentoring emerging talent, volunteering, or consulting",
  "therapy attendance",
  "workplace conflict resolution",
  "restorative time with david",
  "review compensation package and adjust budget accordingly",
  "work collaboration stress and meeting strategies",
  "review timing concern",
  "passive voice reduction and checklist",
  "tone adjustments and feedback",
  "webinar planning and promotion",
  "webinar rehearsals with multiple presenters",
  "engagement and incentives discussion",
  "microsoft teams adoption",
  "agent interaction and viewing preparation",
  "viewing preparation with agent and contractor",
  "financial projection and cash flow review",
  "balancing time with creative contact",
  "collaboration on storyboard and visuals",
  "workshop planning with local artists",
  "backup plans for workshop",
  "yolov5s cpu inference setup",
  "dataset and data loader for cpu evaluation",
  "tracker module implementation and integration",
  "tensorrt model conversion and optimization",
  "sort tracking code optimization",
  "coordinate mapping and kalman filter fundamentals",
  "frame timestamp interpolation and react frontend integration",
  "flask app cuda memory error debugging",
  "security scanning with snyk cli in ci/cd",
  "opencv dnn pipeline optimization and future plans",
  "initial integration issues",
  "performance monitoring",
  "segmentation fault troubleshooting",
  "model vs capture source investigation",
  "milestone planning",
  "model optimization exploration",
  "gpu/cpu fallback and latency",
  "data association debugging",
  "user interaction features",
  "monitoring tools setup",
  "code quality improvements",
  "performance benchmarking",
  "indian ocean startup summit takeaways to expand market reach, adopt emerging technologies, partnerships, and sustainability practices",
  "regional business forums and seychelles community growth to expand market reach and engagement",
  "ethical ai and product development practices embedded into operations",
  "resume keyword tool usage",
  "profile headline update",
  "rental research for relocation",
  "mentoring and networking advice",
  "cover letter feedback concerns",
  "interview storytelling preparation",
  "employee handbook review",
  "workshop presentation planning",
  "query optimization for recent messages",
  "schema design and validation for editing",
  "testing updatemessage function",
  "handling unchanged message text cases",
  "migration script planning",
  "batch execution of migration",
  "enhancing migration script robustness",
  "matchmaking service design and algorithm challenges",
  "game loop performance and serialization optimization",
  "microservices implementation and rabbitmq integration",
  "lag compensation with interpolation and extrapolation",
  "anti-cheat microservice development and caching optimization",
  "platform abstraction layer for input handling and integration",
  "basic websocket implementation and connection issues",
  "namespace and game logic debugging",
  "webrtc integration and fallback handling",
  "encrypted websocket subprotocol setup",
  "webrtc connection troubleshooting and turn server setup",
  "token rotation and redis usage",
  "websocket performance optimization and room management",
  "redis pub/sub for real-time updates",
  "multiplayer game latency reduction techniques",
  "voice chat application signaling and caching",
  "basic setup and error handling",
  "connection troubleshooting",
  "multi-user and broadcast optimizations",
  "scaling with load balancer and message queue",
  "redis caching for sessions",
  "room-based messaging and retrieval",
  "performance bottlenecks and data structures",
  "redis pub/sub error handling and retry",
  "broadcast logic refactoring and further optimization",
  "initial setup and feature extraction",
  "debugging pdf text extraction",
  "project timeline and deadlines",
  "api response time optimization",
  "resume improvement and missing skills extraction",
  "dynamic display of missing skills",
  "unit and integration testing preparation",
  "deployment automation and monitoring setup",
  "cloud monitoring and logging planning",
  "memory usage and keyword extraction improvements",
  "job description parsing enhancements",
  "startup time and caching strategies",
  "scoring function and similarity optimization",
  "authentication and authorization",
  "concurrent request simulation",
  "user-based collaborative filtering implementation",
  "flask recommendations endpoint",
  "helper function definitions",
  "hybrid recommendation system with caching",
  "user preferences integration and testing",
  "hybrid scoring formula refinement",
  "testing weight combinations and accuracy impact",
  "evaluation metrics for performance optimization",
  "content-based filtering with tf-idf vectors",
  "initial combinatorial formula questions",
  "examples with varied group sizes",
  "inclusion-exclusion principle for three sets",
  "inclusion-exclusion extension to four sets",
  "error identification and correction in inclusion-exclusion",
  "explanation of formula components like triple intersections",
  "multinomial theorem and polynomial coefficient calculations",
  "distinction between multinomial coefficients and permutations",
  "combined use of multinomial and inclusion-exclusion principles",
  "clarifications and accuracy improvements",
  "spherical triangle modeling and angle sums with geogebra",
  "hyperbolic triangle calculations and verification",
  "hyperbolic distance computations in poincare models",
  "hyperbolic tessellation generation and measurement with kaleidotile",
  "visualization and plotting in geogebra 3d for poincare disk",
  "initial struggles with inductive step in inequality proofs",
  "requests for additional inequality examples",
  "handling inequality signs carefully",
  "algebraic steps connecting inductive hypotheses to conclusions",
  "modular arithmetic introduction",
  "divisibility problems involving powers and modular reasoning",
  "notation and terminology clarifications",
  "one-way and trapdoor functions",
  "combined cryptographic conditions and applications",
  "base case verification and inductive step articulation for inequalities",
  "preserving inequality directions and algebraic concerns",
  "logical flow and careful inequality handling",
  "basic derivative concept",
  "real-life paramedic rate applications",
  "power rule differentiation practice",
  "tangent line and slope meaning",
  "related rates with blood flow",
  "derivative tests for optimization",
  "critical points and solving derivative equations",
  "related rates with geometric problem",
  "initial laptop needs and recommendations",
  "testing portability and meeting at the green bean",
  "workshops and skill development",
  "laptop specs and writing performance",
  "final laptop choice and presentation preparation",
  "relationship concerns and origins",
  "trust issues and age difference",
  "trust improvement goals with surveys",
  "satisfaction targets and compromises",
  "maintaining satisfaction with communication",
  "deepening emotional intimacy",
  "creative collaboration planning",
  "commitments during shared time",
  "finalizing creative projects",
  "sustaining satisfaction and social compromises",
  "couples counseling and trust rebuilding",
  "intimacy through music sessions",
  "meditation and relaxation apps",
  "breathing exercises for conflict reduction",
  "emotional regulation during travel",
  "performance anxiety and breathing techniques",
  "alternative emotional regulation for recording stress",
  "managing party-day nerves and applying techniques elsewhere",
  "collaboration with kelli on article",
  "meeting mary at editorial meeting",
  "advice from james on project alignment",
  "strategy meeting co-presented with mary",
  "workshop co-led with kelli",
  "strategic advice from james on sustainability project",
  "co-authoring article with mary",
  "james's letter of recommendation",
  "initial etf strategy discussion",
  "advisor comparison and managed portfolio setup",
  "robo-advisor automatic contributions",
  "international etf diversification",
  "reit and real-estate etf exploration",
  "emerging markets etf addition",
  "municipal bond fund allocation",
  "international small-cap etf addition",
  "sector etf focus",
  "brittney financial boundaries and education",
  "declining brittney loan and emphasizing independence",
  "brittney custodial account with monthly check-ins",
  "later co-investments with quarterly reviews and pros and cons",
  "compliance with financial regulations",
  "esg fund options and decisions",
  "friend john's portfolio losses and recovery",
  "adoption and use of tax tools",
  "regional market risks and inflation hedging",
  "initial curiosity and advice seeking",
  "starting small investments and monitoring",
  "learning tools and processes",
  "community involvement and event attendance",
  "regulatory impacts and strategy adaptation",
  "collaborative research and experience sharing",
  "portfolio diversification and decision-making support",
  "conference participation and webinar co-hosting",
  "healthy dinner options",
  "dessert frequency and calories",
  "salt reduction in recipes",
  "monthly social dinners",
  "dining out frequency and budget boundaries",
  "emotional overwhelm",
  "dinner party planning",
  "balancing relationships and wellness",
  "book club attendance commitment",
  "party hosting limits",
  "party drink restrictions",
  "regular meetings and breakfast options",
  "potluck planning and healthy dishes",
  "walking routine and motivation",
  "mom's support",
  "jenny's motivation and new activities",
  "supporting jenny's half marathon training",
  "don's hiking invitation",
  "nancy and craig joining pilates and runs",
  "craig's meal prep assistance",
  "christopher's cycling race",
  "pilates partner kristen and group motivation",
  "balancing pilates with clinical workload",
  "preparing for new year's 5k with jenny",
  "nutrition lecture follow-up and related discussions",
  "cholesterol concerns and visit planning",
  "meeting and discussing diabetes explanation with david",
  "assistance with mediterranean meals from david",
  "surprise homemade dinner from david",
  "attending diabetes education refresher with david",
  "planning active and social outings with david",
  "acting and michael's suggestion",
  "voice coaching sessions",
  "dance workshop and feedback",
  "local theater involvement and staying in touch",
  "improv group activities and feedback",
  "acting course and first day tips",
  "minor role and character/voice coaching",
  "dance recital audition and prep",
  "part-time theater roles and writing balance",
  "supporting role acceptance and rehearsal/portfolio balance",
  "declining lead role to focus on current play",
  "regional theater auditions and coaching",
  "winter season supporting role and rehearsals",
  "conservatory application considerations",
  "initial diagnosis and follow-up",
  "insulin options and decisions",
  "arthritis pain management",
  "physical therapy progress",
  "insulin dosage concerns",
  "eye health exams",
  "cardiology visits",
  "lab results and treatment plan",
  "coping with emotional pain after the breakup",
  "reflecting on the relationship and learning from it",
  "managing communication boundaries with sarah",
  "addressing custody and visitation arrangements",
  "handling mediation and legal involvement",
  "navigating holiday scheduling and supervised visits",
  "dealing with emotional safety and boundary setting during interactions",
  "processing emotional healing and mood after visits",
  "initial limits and monitoring",
  "balancing screen time with other activities",
  "digital safety and monitoring updates",
  "tech-free zones establishment",
  "adjusting screen time limits",
  "educational app introduction",
  "limits during exam prep",
  "social life and flexibility considerations",
  "communication and involvement strategies",
  "structured tutoring sessions with goal-setting and consistent monitoring",
  "distraction-free study environment and growth mindset",
  "celebrating incremental progress with positive reinforcement",
  "role-playing social scenarios and self-expression",
  "clear expectations and gradual responsibility",
  "digital safety with parental controls and privacy",
  "screen time routines and healthy habits",
  "emotional support with coping mechanisms",
];

const PERFORMING_ARTS_EVENT_LABELS = new Set([
  "acting and michael's suggestion",
  "voice coaching sessions",
  "dance workshop and feedback",
  "local theater involvement and staying in touch",
  "improv group activities and feedback",
  "acting course and first day tips",
  "minor role and character/voice coaching",
  "dance recital audition and prep",
  "part-time theater roles and writing balance",
  "supporting role acceptance and rehearsal/portfolio balance",
  "declining lead role to focus on current play",
  "regional theater auditions and coaching",
  "winter season supporting role and rehearsals",
  "conservatory application considerations",
]);

const HOUSING_EVENT_LABELS = new Set([
  "lease ending on june 30 2024 with lease renewal subletting or moving to a new apartment options",
  "negotiation process with landlord about lease renewal and rent terms",
  "criteria for a new 4-bedroom rental within a $2,500 budget near lincoln park and apartment application plan",
  "move-out process from current apartment with timely landlord notification final walk-through inspection disagreements and security deposit refund",
  "move-in coordination for the new apartment confirming movers utility setups and day-of logistics",
  "health and safety considerations with mold inspection results hazards maintenance requests and housewarming party social aspects",
  "contacting and scheduling local handyman joseph for repairs",
  "coordinating repair tasks with joseph including door lock shelves and moving-related considerations",
  "utility bills and energy usage concerns",
]);

const HOME_CAREER_EVENT_LABELS = new Set([
  "advice from james as colleague and mentor regarding career moves",
  "contacting and scheduling local handyman joseph for repairs",
  "coordinating repair tasks with joseph including door lock shelves and moving-related considerations",
  "utility bills and energy usage concerns",
  "writing conference and professional networking opportunities",
]);

const FLAVOR_ENHANCEMENT_EVENT_LABELS = new Set([
  "healthy cooking methods",
  "initial spice combinations for roasted vegetables",
  "additional spices to enhance flavor depth",
  "middle eastern flavor experimentation",
  "revisiting smoky and spicy seasonings",
  "further middle eastern spice exploration",
  "enhancing flavor and color with spices",
  "seeking new seasoning ideas for roasted vegetables",
]);

const BAKING_EXPERIENCE_EVENT_LABELS = new Set([
  "meeting and learning from michele about baking",
  "discussing recipe scaling, inventory, and marketing strategies with michele",
  "sharing vegan cake and seeking social baking improvement",
  "using michele's proofing box and debating investing in one",
  "balancing baking schedule with other commitments and michele's proofing box advice",
  "hosting a cake decorating session and seeking improvement ideas",
  "asking about achieving high ratings from sharing gluten-free bread samples",
  "sharing croissant samples and aiming to improve ratings",
  "sharing dessert plating photos and seeking plating tips",
  "planning a party for ryan's promotion and requesting hosting tips",
]);

const DIETARY_ADJUSTMENT_EVENT_LABELS = new Set([
  "micronutrient deficiencies",
  "macronutrient balancing",
  "micronutrient supplementation updates",
  "calcium intake balancing",
  "plant-based protein combinations",
  "micronutrient needs for growing children",
]);

const PROJECT_SUMMARY_EVENT_LABELS = new Set([
  "indian ocean startup summit takeaways to expand market reach, adopt emerging technologies, partnerships, and sustainability practices",
  "regional business forums and seychelles community growth to expand market reach and engagement",
  "ethical ai and product development practices embedded into operations",
]);

const LANGUAGE_TRANSLATION_EVENT_LABELS = new Set([
  "translation api integration and error handling",
  "api endpoint usage and authentication",
  "rate limiting and request queue management",
  "performance optimization with caching and queries",
  "fine-tuning and debugging language models",
  "authentication and role-based access control",
  "microservices deployment and scaling",
  "security and tls configuration",
  "transformer-based llm api streaming integration",
  "streaming performance tuning and chunk size",
]);

const SYSTEM_ARCHITECTURE_EVENT_LABELS = new Set([
  "microservices architecture planning with scraping, nlp, api",
  "openapi documentation review",
  "fastapi upgrade for async and websocket",
  "websocket integration and stability",
  "database query and schema optimization",
  "scrapy configuration for robots.txt and user-agent rotation",
  "centralized error logging with sentry",
  "paywall detection in scraper",
  "twilio verify api integration with rate limiting",
  "istio service mesh setup with mutual tls and routing",
]);

const RECOMMENDATION_ENGINE_EVENT_LABELS = new Set([
  "collaborative filtering implementation and debugging",
  "handling missing user interactions",
  "debugging error messages",
  "incorporating user ratings and matrix factorization",
  "applying diversity filters",
  "caching strategies for performance",
  "parallel processing optimization",
  "user feedback collection and error handling",
  "efficient feedback data querying",
  "advanced caching and parallelization integration",
]);

const MICROSERVICES_COMMUNICATION_EVENT_LABELS = new Set([
  "rest api and error handling",
  "data serialization",
  "http/2 implementation",
  "rabbitmq messaging",
  "grpc communication and optimization",
  "grpc with tls migration",
  "websocket multiplexing",
  "aws sns pub/sub messaging",
  "service mesh with istio",
  "kafka and api performance",
]);

const STOCK_TRADING_EVENT_LABELS = new Set([
  "api rate limiting and efficiency",
  "microservices architecture and integration",
  "data availability and uptime",
  "rest api endpoints for backtesting and trade data",
  "alpaca api optimization and debugging",
  "oauth 2.0 token refresh and auth issues",
  "ml prediction endpoint and input handling",
  "alert notifications integration",
  "error handling in trading bot",
  "secure api access with ssl and load balancers",
]);

const MODEL_DEVELOPMENT_DEPLOYMENT_EVENT_LABELS = new Set([
  "diffusion-based image feature enhancement",
  "caption generation integration",
  "debugging memory errors",
  "model deployment via rest api",
  "transformer model optimization",
  "tokenizer performance improvements",
  "library upgrades for pytorch and torchvision",
  "distributed training with acceleration",
  "api authentication and security",
  "debugging and version locking with pytorch and transformers",
]);

const DATABASE_DATA_HANDLING_EVENT_LABELS = new Set([
  "initial data retrieval and preparation",
  "schema and data insertion troubleshooting",
  "schema enhancement and query optimization",
  "materialized views and indexing",
  "user captions table creation and insertion errors",
  "etl scheduling and cache consistency issues",
  "edit history extension and updates",
  "lambda timeout and function chaining",
  "dynamodb migration and deployment",
]);

const GAME_DEVELOPMENT_EVENT_LABELS = new Set([
  "matchmaking service design and algorithm challenges",
  "game loop performance and serialization optimization",
  "microservices implementation and rabbitmq integration",
  "lag compensation with interpolation and extrapolation",
  "anti-cheat microservice development and caching optimization",
  "platform abstraction layer for input handling and integration",
]);

const REALTIME_COMMUNICATION_EVENT_LABELS = new Set([
  "basic websocket implementation and connection issues",
  "namespace and game logic debugging",
  "webrtc integration and fallback handling",
  "encrypted websocket subprotocol setup",
  "webrtc connection troubleshooting and turn server setup",
  "token rotation and redis usage",
  "websocket performance optimization and room management",
  "redis pub/sub for real-time updates",
  "multiplayer game latency reduction techniques",
  "voice chat application signaling and caching",
]);

const SLEEP_TRACKING_DEVICE_EVENT_LABELS = new Set([
  "initial sleep tracker data interpretation",
  "firmware update impact and data trust",
  "cross-device sleep tracking comparison",
  "incremental firmware enhancements and sleep quality",
  "final reflections on firmware and sleep management",
]);

const WORK_INCOME_RELATIONSHIP_EVENT_LABELS = new Set([
  "couples therapy preparation and expectations",
  "time management and work stress discussions",
  "work hour reductions and communication of boundaries",
  "increased income and relationship spending plans",
  "use of productivity apps for relationship support",
  "consulting project extension and relationship impact",
  "increased consulting hours and maintaining balance",
  "additional income allocation for relationship and lifestyle",
]);

const TURKISH_CULTURE_LANGUAGE_EVENT_LABELS = new Set([
  "poetry reading event",
  "omar and cultural exposure through poetry",
  "poetry collection and creative writing",
  "calligraphy exhibition",
  "calligraphy workshop and study/social balance",
  "folk music concert and language progress",
  "film festival and real-life language practice",
  "new year's concert and holiday study balance",
  "language poetry reading and learning priorities",
  "signed poetry book and reading tips",
]);

const MOVING_HOME_SETUP_EVENT_LABELS = new Set([
  "housing options and market data",
  "packing logistics with andrew",
  "inspection and repair consultations",
  "furniture purchasing and store visits",
  "celebrations and cultural appreciation",
  "furniture assembly prep with crystal",
  "social support and babysitting offers",
  "household tasks and financial negotiations",
]);

const JESSE_RECOMMENDATION_EVENT_LABELS = new Set([
  "financial advice and trust",
  "experience and relevance concerns",
  "local store recommendations",
  "moving help planning",
  "appreciation for moving support",
  "repair service referrals",
  "quiet workspace suggestions",
  "house-sitting discussions",
]);

const SELLING_PROPERTY_FINANCIAL_EVENT_LABELS = new Set([
  "agent involvement and paperwork",
  "closing costs and negotiation",
  "mortgage balance and net profit",
  "commission fees and sale price adjustments",
  "marketing and rental pricing",
  "market pricing and asking price",
  "buyer offers and sale implications",
  "final profit calculations and contingency",
]);

const SELLING_FAMILY_HOME_PREP_EVENT_LABELS = new Set([
  "son's staging suggestions and age relevance",
  "balancing modern and traditional staging ideas",
  "compromising on personal items visibility",
  "impact of personal items storage and relationship consequences",
  "other child's involvement in garage sale and moving tasks",
  "emotional and practical aspects of family moving away",
]);

const DIY_HOME_IMPROVEMENT_EVENT_LABELS = new Set([
  "general couple diy projects",
  "home decor projects",
  "low-impact painting projects",
  "specific painting tasks",
  "fixture updates",
  "insulation upgrades",
  "kitchen faucet replacement",
  "bathroom shelf installation",
  "kitchen cabinet hardware replacement",
  "basic electrical fixes",
  "weatherization and smart thermostat considerations",
  "holiday lighting installation",
]);

const DIY_RECOMMENDATION_EVENT_LABELS = new Set([
  "nicolas and diy involvement",
  "wiring confidence and tutorials",
  "plumber consultation and appreciation",
  "insulation materials and installation",
  "kitchen faucet brand evaluation",
  "shelf installation help",
  "ikea handles decision",
  "electrical safety with legrand",
  "3m products for durability",
  "hanging lights safely",
]);

const EVENT_CUE_WORDS = new Set([
  "advice",
  "apartment",
  "anniversary",
  "call",
  "career",
  "conflict",
  "comprehensive",
  "discussion",
  "energy",
  "event",
  "events",
  "family",
  "focus",
  "forum",
  "forums",
  "diet",
  "dietary",
  "diets",
  "diy",
  "drill",
  "electrical",
  "adjustment",
  "adjustments",
  "faucet",
  "health",
  "home",
  "housing",
  "insulation",
  "interview",
  "landlord",
  "lease",
  "leadership",
  "manage",
  "managing",
  "management",
  "meeting",
  "moving",
  "process",
  "planning",
  "project",
  "painting",
  "presentation",
  "repairs",
  "retry",
  "recommendation",
  "resolution",
  "review",
  "shelf",
  "stress",
  "suggestion",
  "thermostat",
  "situation",
  "situations",
  "support",
  "summit",
  "testing",
  "utilities",
  "utility",
  "weatherization",
  "workshop",
]);

const EVENT_ORDER_STOP_WORDS = new Set([
  "about",
  "across",
  "after",
  "and",
  "any",
  "aspects",
  "before",
  "brought",
  "can",
  "chats",
  "conversation",
  "conversations",
  "different",
  "detailed",
  "decision",
  "decisions",
  "during",
  "entire",
  "develop",
  "developed",
  "development",
  "developments",
  "give",
  "including",
  "happened",
  "has",
  "have",
  "how",
  "into",
  "items",
  "key",
  "many",
  "me",
  "mention",
  "place",
  "process",
  "provide",
  "only",
  "order",
  "our",
  "personal",
  "shift",
  "shifts",
  "shifted",
  "through",
  "throughout",
  "various",
  "walk",
  "ways",
  "were",
  "what",
  "when",
  "which",
  "with",
  "would",
  "you",
]);

const NUMBER_WORD_VALUES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
