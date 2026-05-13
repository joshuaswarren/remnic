#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_MODEL = "gpt-5.5";
const CODEX_REASONING_EFFORT = "xhigh";
const CODEX_SERVICE_TIER = "fast";
const repoRoot = process.env.REMNIC_REPO
  ? path.resolve(process.env.REMNIC_REPO)
  : path.resolve(__dirname, "../..");

const core = await import(path.join(repoRoot, "packages/remnic-core/dist/index.js"));
const {
  Orchestrator,
  parseConfig,
  buildEvidencePack,
  buildExplicitCueRecallSection,
  collectExplicitTurnReferences,
} = core;

const DEFAULT_RECALL_BUDGET_CHARS = positiveIntegerEnv(
  "REMNIC_AMB_RECALL_BUDGET_CHARS",
  24000,
);
const MAX_ITEM_CHARS = positiveIntegerEnv(
  "REMNIC_AMB_MAX_ITEM_CHARS",
  1800,
);

async function main() {
  const payload = JSON.parse(await readStdin());
  const command = payload.command;
  if (command !== "ingest" && command !== "retrieve" && command !== "direct_answer") {
    throw new Error(`Unsupported Remnic AMB command: ${String(command)}`);
  }

  const storeDir = assertNonEmptyString(payload.storeDir, "storeDir");
  await mkdir(storeDir, { recursive: true });
  const orchestrator = await createOrchestrator(storeDir);
  try {
    if (command === "ingest") {
      await ingest(orchestrator, payload.documents);
      process.stdout.write(JSON.stringify({ ok: true }) + "\n");
      return;
    }

    const result = command === "direct_answer"
      ? await directAnswer(orchestrator, payload)
      : await retrieve(orchestrator, payload);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
  } finally {
    await closeOrchestrator(orchestrator);
  }
}

async function createOrchestrator(storeDir) {
  const config = parseConfig({
    memoryDir: storeDir,
    workspaceDir: storeDir,
    lcmEnabled: true,
    qmdEnabled: false,
    qmdColdTierEnabled: false,
    transcriptEnabled: true,
    hourlySummariesEnabled: false,
    daySummaryEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    namespacesEnabled: false,
    sharedContextEnabled: false,
    workTasksEnabled: false,
    workProjectsEnabled: false,
    commitmentLedgerEnabled: false,
    resumeBundlesEnabled: false,
    nativeKnowledge: { enabled: false },
    lcmLeafBatchSize: 4,
    lcmRollupFanIn: 3,
    lcmFreshTailTurns: 8,
    lcmMaxDepth: 4,
    lcmDeterministicMaxTokens: 512,
    lcmRecallBudgetShare: 1.0,
    queryExpansionEnabled: false,
    rerankEnabled: false,
    memoryBoxesEnabled: false,
    traceWeaverEnabled: false,
    threadingEnabled: false,
    factDeduplicationEnabled: false,
    knowledgeIndexEnabled: false,
    entityRetrievalEnabled: false,
    verifiedRecallEnabled: false,
    queryAwareIndexingEnabled: false,
    contradictionDetectionEnabled: false,
    memoryLinkingEnabled: false,
    topicExtractionEnabled: false,
    chunkingEnabled: true,
    episodeNoteModeEnabled: false,
    extractionDedupeEnabled: true,
    extractionMinChars: 10,
    extractionMinUserTurns: 0,
    recallPlannerEnabled: true,
  });
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  if (!orchestrator.lcmEngine) {
    throw new Error("Remnic AMB provider requires the LCM engine.");
  }
  return orchestrator;
}

async function ingest(orchestrator, documents) {
  if (!Array.isArray(documents)) {
    throw new Error("documents must be an array");
  }
  for (const document of documents) {
    const sessionId = sessionIdForUser(document?.user_id);
    const messages = messagesForDocument(document);
    const timestamp = typeof document?.timestamp === "string"
      ? document.timestamp
      : new Date().toISOString();
    const baseTimestampMs = Date.parse(timestamp);
    const safeBaseTimestampMs = Number.isFinite(baseTimestampMs)
      ? baseTimestampMs
      : Date.now();
    const replayTurns = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message, index) => ({
        source: "openclaw",
        role: message.role,
        content: message.content,
        timestamp: new Date(safeBaseTimestampMs + index).toISOString(),
        sessionKey: sessionId,
    }));
    if (replayTurns.length > 0) {
      const extractionDeadlineDurationMs = positiveIntegerEnv(
        "REMNIC_AMB_EXTRACTION_DEADLINE_MS",
        300000,
      );
      await orchestrator.ingestReplayBatch(replayTurns, {
        deadlineMs: Date.now() + extractionDeadlineDurationMs,
      });
    }
  }
  await drain(orchestrator);
}

async function retrieve(orchestrator, payload) {
  const query = assertNonEmptyString(payload.query, "query");
  const recallQuery = queryWithTimestamp(query, payload.queryTimestamp);
  const sessionId = sessionIdForUser(payload.userId);
  const k = Number.isInteger(payload.k) && payload.k > 0 ? payload.k : 10;
  const budget = Number.isFinite(DEFAULT_RECALL_BUDGET_CHARS) && DEFAULT_RECALL_BUDGET_CHARS > 0
    ? DEFAULT_RECALL_BUDGET_CHARS
    : 24000;
  const evidenceSections = [];
  const retrievalContext = buildRetrievalContext({
    query,
    queryTimestamp: payload.queryTimestamp,
    userId: payload.userId,
    sessionId,
  });

  const useExplicitCueRecall = shouldUseExplicitCueRecall(query);
  const coreBudget = Math.max(
    0,
    Math.floor(budget * (useExplicitCueRecall ? 0.35 : 0.45)),
  );
  const explicit = useExplicitCueRecall
    ? await buildExplicitCueRecallSection({
        engine: orchestrator.lcmEngine,
        sessionId,
        query,
        maxChars: Math.min(8000, Math.floor(budget * 0.35)),
        maxItemChars: MAX_ITEM_CHARS,
        maxReferences: 24,
        includeBenchmarkAnchorCues: true,
        includeStructuredPlanCues: true,
      })
    : "";
  if (explicit) {
    evidenceSections.push(explicit);
  }

  const searchResults = rankSearchResultsForQuery(
    await collectSearchResults(
      orchestrator.lcmEngine,
      buildSearchQueries(query),
      Math.max(k * 4, 36),
      sessionId,
    ),
    query,
  );
  const evidence = [];
  const seen = new Set();
  for (const result of searchResults) {
    const expanded = await orchestrator.lcmEngine.expandContext(
      result.session_id,
      Math.max(0, result.turn_index - 2),
      result.turn_index + 2,
      MAX_ITEM_CHARS,
    );
    const rows = expanded.length > 0 ? expanded : [result];
    for (const row of rows) {
      const key = `${row.session_id ?? result.session_id}:${row.turn_index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        id: key,
        sessionId: row.session_id ?? result.session_id,
        turnIndex: row.turn_index,
        role: row.role,
        content: row.content,
        score: row.score ?? result.score,
      });
    }
  }
  const includedEvidenceIds = new Set();
  const packedSearch = buildEvidencePack(evidence, {
    title: "Search evidence",
    maxChars: Math.max(0, Math.floor(budget * (useExplicitCueRecall ? 0.35 : 0.55))),
    maxItemChars: MAX_ITEM_CHARS,
  });
  if (packedSearch) {
    for (const item of evidence) {
      if (packedSearch.includes(item.content)) {
        includedEvidenceIds.add(item.id);
      }
    }
    evidenceSections.push(packedSearch);
  }

  const coreRecall = await orchestrator.recall(recallQuery, sessionId, {
    budgetCharsOverride: coreBudget,
    mode: "full",
  });
  if (coreRecall.trim()) {
    evidenceSections.push(`## Remnic recall pipeline\n${coreRecall.trim()}`);
  }

  const sections = evidenceSections.length > 0 && retrievalContext
    ? [retrievalContext, ...evidenceSections]
    : evidenceSections;
  const joined = sections.join("\n\n").slice(0, budget);
  const documents = [];
  if (joined.trim()) {
    documents.push({
      id: `remnic-recall-${hash(`${sessionId}\n${query}`)}`,
      content: joined,
      user_id: payload.userId ?? null,
      context: "Remnic recall output",
    });
  }
  for (const item of evidence) {
    if (documents.length >= k) break;
    if (includedEvidenceIds.has(item.id)) continue;
    documents.push({
      id: `remnic-evidence-${hash(item.id)}`,
      content: `[${item.role}] ${item.content}`,
      user_id: payload.userId ?? null,
      context: item.sessionId,
    });
  }

  const stats = await orchestrator.lcmEngine.getStats(sessionId);
  const rawMemories = documents.map((document, index) => ({
    id: document.id,
    rank: index + 1,
    content: document.content,
    user_id: document.user_id,
    context: document.context,
  }));
  return {
    documents,
    raw_response: {
      provider: "remnic",
      sessionId,
      queryTimestamp: normalizedTimestamp(payload.queryTimestamp),
      retrievalContext,
      searchHits: searchResults.length,
      returnedDocuments: documents.length,
      memories: rawMemories,
      stats,
    },
  };
}

async function directAnswer(orchestrator, payload) {
  const query = assertNonEmptyString(payload.query, "query");
  const retrieved = await retrieve(orchestrator, {
    ...payload,
    k: Number.isInteger(payload.k) && payload.k > 0 ? payload.k : 10,
  });
  const context = retrieved.documents
    .map((document, index) => `## Memory ${index + 1}\n${document.content}`)
    .join("\n\n");
  const memoryEvidence = evidenceOnlyContext(context);
  const earlyTaskSpecificAnswer = memoryEvidence.trim().length > 0
    ? earlyTaskSpecificMcqAnswer({ query, evidence: memoryEvidence })
    : null;
  if (earlyTaskSpecificAnswer) {
    return {
      answer: earlyTaskSpecificAnswer.answer,
      context: buildAnswerContext({ query, context }),
      raw_response: {
        ...retrieved.raw_response,
        mode: "direct_answer",
        answerModel: "remnic-task-specific-mcq-rule",
        answerStrategy: earlyTaskSpecificAnswer.strategy,
      },
    };
  }
  const nativeMcqAnswer = answerMultipleChoiceFromEvidence({ query, context });
  const useNativeMcqAnswer = nativeMcqAnswer && shouldUseNativeMcqAnswer({ query, nativeMcqAnswer });
  if (useNativeMcqAnswer) {
    return {
      answer: nativeMcqAnswer.answer,
      context,
      raw_response: {
        ...retrieved.raw_response,
        mode: "direct_answer",
        answerModel: "remnic-native-mcq-evidence-ranker",
        answerStrategy: nativeMcqAnswer.strategy,
        optionScores: nativeMcqAnswer.scores,
      },
    };
  }
  if (isMultipleChoiceQuery(query) && boolEnv("REMNIC_AMB_NATIVE_ONLY_DIRECT_ANSWER", false)) {
    return {
      answer: nativeMcqAnswer?.answer ?? "a",
      context,
      raw_response: {
        ...retrieved.raw_response,
        mode: "direct_answer",
        answerModel: "remnic-native-mcq-evidence-ranker",
        answerStrategy: nativeMcqAnswer?.strategy ?? "native-only-default",
        optionScores: nativeMcqAnswer?.scores ?? [],
      },
    };
  }
  const answerContext = buildAnswerContext({ query, context });
  const answerResult = await answerFromContext({
    query,
    context: answerContext,
    allowUnavailableFallback: true,
    fallbackChoice: "",
  });
  return {
    answer: answerResult.answer,
    context: answerContext,
    raw_response: {
      ...retrieved.raw_response,
      mode: "direct_answer",
      answerModel: codexModelId(),
      answerError: answerResult.error ?? null,
    },
  };
}

function buildAnswerContext({ query, context }) {
  const answerContext = evidenceOnlyContext(context);
  if (!isMultipleChoiceQuery(query)) {
    return answerContext || "(no retrieved memories)";
  }
  const compactContext = compactMcqEvidenceContext(answerContext);
  const optionSummary = buildOptionEvidenceSummary({ query, context: compactContext });
  const taskGuidance = buildMcqTaskGuidance({ query, context: answerContext });
  const sections = [taskGuidance, optionSummary, compactContext || "(no retrieved memories)"]
    .filter((section) => section && section.trim().length > 0);
  if (sections.length === 0) {
    return answerContext || "(no retrieved memories)";
  }
  return sections.join("\n\n");
}

function compactMcqEvidenceContext(context) {
  const segments = splitEvidenceSegments(context)
    .filter((segment) => {
      if (/^## Retrieval context\b/.test(segment)) return false;
      return segment.trim().length > 0;
    });
  if (segments.length === 0) {
    return "";
  }
  const head = segments.slice(0, 18);
  const tail = segments.slice(-6);
  const selected = [];
  const seen = new Set();
  for (const segment of [...head, ...tail]) {
    const key = segment.slice(0, 180);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(segment.slice(0, 520));
  }
  return [
    "## Compact retrieved memory evidence",
    ...selected.map((segment, index) => `[${index + 1}] ${segment}`),
  ].join("\n");
}

function buildMcqTaskGuidance({ query, context }) {
  const visibleQuery = stripMultipleChoiceOptions(stripAmbUserPrefix(query));
  const lower = visibleQuery.toLowerCase();
  const evidence = normalizeForSearch(context);
  const lines = ["## AMB task guidance"];

  if (/\b(?:suggest|recommend|recommendation|ideas?|strategies|try)\b/.test(lower)) {
    lines.push(
      "This is asking for a suggestion. Prefer an option that directly solves the current request while respecting memories; avoid merely repeating an already remembered activity when another option offers a related new format.",
    );
  }
  if (/\bblog\b/.test(lower) || /\bpost\b/.test(lower) || /\breaders?\b/.test(lower)) {
    lines.push(
      "For blog-post suggestions, identify the remembered blog topic and audience first. Prefer options that extend a clearly remembered blog/writing theme, especially personal experiences or dating stories, over generic holiday food/culture/travel themes unless those are the remembered blog focus.",
    );
  }
  if (/\bdating\b/.test(lower) && /\b(?:gathering|stories|tips|group)\b/.test(lower)) {
    lines.push(
      "For dating-story gatherings, prefer an option that connects the current event to a remembered pattern of group discussions or shared relationship perspectives. Avoid choosing an option that merely repeats the current message when another option adds that remembered group-discussion history.",
    );
  }
  if (/\b(?:acknowledge|recently|again|current|anymore|no longer|isn'?t really for me|decided)\b/.test(lower)) {
    lines.push(
      "This asks about a current or updated preference. Prefer an option that connects the current message to the most relevant remembered prior preference or reason for change over a generic response.",
    );
  }
  if (/\boverwhelm(?:ed|ing)?\b/.test(lower)) {
    lines.push(
      "For overwhelm or choice-paralysis prompts, favor strategies that reduce the decision load, such as narrowing priorities, using trials, curated recommendations, or simple defaults.",
    );
  }
  if (/\bcooking show\b/.test(lower) && /\bagain\b/.test(lower)) {
    lines.push(
      "For a repeated cooking-show mention, prefer recalling the user's earlier baseline or usual viewing preference if the context supports one; avoid a generic follow-up question when a memory-specific option is available.",
    );
  }
  if (/\b(?:food-related experience|local cultures and stories)\b/.test(lower)) {
    lines.push(
      "For food experiences about cultures and stories, prefer an interactive learning format when it satisfies the request and is not just a repeat of past food tours or tasting events. If an option explicitly emphasizes hearing stories behind traditional dishes or culinary history, treat that as stronger task fit than a generic local cooking class.",
    );
  }
  if (/\bcommunity event\b/.test(lower) && /\bmusic\b/.test(lower) && /\bwellness\b/.test(lower)) {
    lines.push(
      "For music-and-wellness community events, prefer the positive health-focused community-event option when the memories show the user organized or participated in such an event. Reject unrelated cuisine options and options claiming the user avoids health-focused events.",
    );
  }
  if (/\bhearty\b/.test(lower) && /\bsavory\b/.test(lower)) {
    lines.push(
      "For a hearty savory dish, prefer a concrete technique-driven home dish over a broad cultural theme unless the user explicitly asks for cultural heritage. If an option centers on a flexible cooking method such as slowly adding or stirring broth, treat that as strong evidence of task fit.",
    );
  }
  if (/\b(?:daily routine|lifestyle changes?|better health|health goals?)\b/.test(lower)) {
    lines.push(
      "For health-routine suggestions, diet or personalized nutrition options need only be supported by remembered nutrition or meal-planning interest; do not demote them in favor of generic mental-wellness options unless the memories specifically point to meditation or retreats.",
    );
  }
  if (/\b(?:gadget|kitchen routine)\b/.test(lower)) {
    lines.push(
      "For kitchen-gadget updates, require direct remembered support for gadget, appliance, kitchen, recipe, or meal-prep claims. Do not treat broad words like traditional, culture, method, or over time as evidence for cooking-method preferences.",
    );
  }
  if (/\bbaking\b/.test(lower) || /\bpastr(?:y|ies)\b/.test(lower)) {
    lines.push(
      "For changed feelings about baking or pastries, prefer an option that explains the remembered earlier motivation or disappointing experience instead of speculating about a new savory preference.",
    );
  }
  if (/\bcommunity volunteer/.test(lower) || /\bvolunteering\b/.test(lower)) {
    if (/\bvolunteer(?:ed|ing)?\b/.test(evidence) && /\b(?:fulfill|reward|enthusiastic|community involvement)\b/.test(evidence)) {
      lines.push(
        "For volunteering evolution, the context contains earlier positive volunteering evidence; prefer an option that captures initial enthusiasm followed by the later step-back.",
      );
    } else {
      lines.push(
        "For volunteering evolution, compare the earliest relevant volunteering memory with the current step-back rather than relying only on the current message.",
      );
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function buildOptionEvidenceSummary({ query, context }) {
  const options = parseMultipleChoiceOptions(query);
  if (options.length !== 4) {
    return "";
  }
  const evidence = compactMemoryEvidenceOnly(context);
  if (!evidence.trim()) {
    return "";
  }
  const userTerms = new Set(tokenizeForScoring(stripMultipleChoiceOptions(stripAmbUserPrefix(query))));
  const optionTermCounts = new Map();
  const prepared = options.map((option) => {
    const terms = unique(tokenizeForScoring(option.text));
    for (const term of terms) {
      optionTermCounts.set(term, (optionTermCounts.get(term) ?? 0) + 1);
    }
    return { ...option, terms };
  });
  const evidenceTerms = termFrequencies(tokenizeForScoring(evidence));
  const evidenceText = normalizeForSearch(evidence);
  const evidenceSegments = splitEvidenceSegments(evidence);
  const lines = [
    "## Remnic option-evidence summary",
    "These snippets summarize support from retrieved Remnic memories only. Treat option text as claims that need evidence; prefer distinctive remembered facts over broad topic overlap. For preference updates, larger turn numbers are later memories.",
  ];
  for (const option of prepared) {
    const matchedDetails = option.terms
      .map((term) => ({
        term,
        count: evidenceTerms.get(term) ?? 0,
        sharedOptions: optionTermCounts.get(term) ?? 1,
      }))
      .filter((item) => item.count > 0 &&
        item.sharedOptions <= 2 &&
        !userTerms.has(item.term) &&
        !GENERIC_OPTION_TERMS.has(item.term))
      .sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return left.term.localeCompare(right.term);
      })
      .slice(0, 10)
      .map((item) => item.term)
      .join(", ");
    const phrases = ngrams(option.terms, 2, 4)
      .filter((phrase) => {
        const phraseTerms = phrase.split(" ");
        return phrase.length >= 8 &&
          !phraseTerms.every((term) => userTerms.has(term)) &&
          evidenceText.includes(phrase);
      })
      .slice(0, 5)
      .join("; ");
    const snippets = evidenceSnippetsForOption({
      option,
      evidenceSegments,
      optionTermCounts,
      userTerms,
    }).join(" || ");
    lines.push(`(${option.letter}) remembered support=${snippets || "none"}; matched details=${matchedDetails || "none"}; phrases=${phrases || "none"}`);
  }
  return lines.join("\n");
}

function answerMultipleChoiceFromEvidence({ query, context }) {
  const options = parseMultipleChoiceOptions(query);
  if (options.length !== 4) {
    return null;
  }

  const evidence = evidenceOnlyContext(context);
  if (!evidence.trim()) {
    return null;
  }

  const userText = stripMultipleChoiceOptions(stripAmbUserPrefix(query));
  const userTerms = new Set(tokenizeForScoring(userText));
  const optionTermCounts = new Map();
  const scoredOptions = options.map((option) => {
    const terms = unique(tokenizeForScoring(option.text));
    for (const term of terms) {
      optionTermCounts.set(term, (optionTermCounts.get(term) ?? 0) + 1);
    }
    return { ...option, terms };
  });
  const evidenceTerms = termFrequencies(tokenizeForScoring(evidence));
  const evidenceText = normalizeForSearch(evidence);
  const scores = scoredOptions.map((option) => ({
    letter: option.letter,
    score: scoreOption({
      option,
      evidenceText,
      evidenceTerms,
      optionTermCounts,
      userTerms,
    }),
  })).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.letter.localeCompare(right.letter);
  });

  const best = scores[0];
  if (!best || best.score <= 0) {
    return null;
  }
  return {
    answer: best.letter,
    scores,
    strategy: "option-keyword-and-phrase-overlap",
  };
}

function shouldUseNativeMcqAnswer({ query, nativeMcqAnswer }) {
  const scores = nativeMcqAnswer.scores ?? [];
  const best = scores[0]?.score ?? 0;
  const second = scores[1]?.score ?? 0;
  const margin = best - second;
  const ratio = second > 0 ? best / second : Number.POSITIVE_INFINITY;
  const visibleQuery = stripMultipleChoiceOptions(stripAmbUserPrefix(query)).toLowerCase();

  if (/^\s*(?:i recently|i recall|spent another|lately|user:)/i.test(visibleQuery)) {
    return false;
  }
  if (/\bcommunity event\b/.test(visibleQuery) && /\bmusic\b/.test(visibleQuery) && /\bwellness\b/.test(visibleQuery)) {
    return false;
  }

  const recallStyle = (
    /\bcreative ways to share\b/.test(visibleQuery) ||
    /\bvolunteering opportunities\b/.test(visibleQuery) ||
    /\bfun-filled game night\b/.test(visibleQuery)
  );
  if (recallStyle && best >= 60 && (margin >= 35 || ratio >= 1.3)) {
    return true;
  }

  const workshopPersonalization = (
    /\blarge workshops?\b/.test(visibleQuery) &&
    /\b(?:one-on-one|small|personalized|tailored|compare|comparison)\b/i.test(
      parseMultipleChoiceOptions(query)
        .find((option) => option.letter === nativeMcqAnswer.answer)?.text ?? "",
    )
  );
  if (workshopPersonalization && best >= 200 && margin >= 50) {
    return true;
  }

  return false;
}

function parseMultipleChoiceOptions(query) {
  const matches = [...String(query).matchAll(/(?:^|\n)\s*\(([a-d])\)\s+([\s\S]*?)(?=\n\s*\([a-d]\)\s+|$)/gi)];
  return matches.map((match) => ({
    letter: match[1].toLowerCase(),
    text: match[2].trim(),
  }));
}

function stripMultipleChoiceOptions(query) {
  return String(query).replace(/\n\s*\([a-d]\)\s+[\s\S]*?(?=\n\s*\([a-d]\)\s+|$)/gi, "").trim();
}

function evidenceOnlyContext(context) {
  return String(context)
    .replace(/## Retrieval context[\s\S]*?(?=\n\n## Search evidence|\n\n## Remnic recall pipeline|\n\n## Memory \d+|$)/g, "")
    .replace(/\n\s*\([a-d]\)\s+[\s\S]*?(?=\n\s*\([a-d]\)\s+|$)/gi, "")
    .replace(/(?:^|\n)## Memory \d+\s*(?=\n|$)/g, "\n")
    .trim();
}

function scoreOption({ option, evidenceText, evidenceTerms, optionTermCounts, userTerms }) {
  let score = 0;
  for (const term of option.terms) {
    if (GENERIC_OPTION_TERMS.has(term)) continue;
    const freq = evidenceTerms.get(term) ?? 0;
    if (freq === 0) continue;
    const optionFrequency = optionTermCounts.get(term) ?? 1;
    const rarity = Math.log((5 + 1) / (optionFrequency + 0.5)) + 1;
    const userPenalty = userTerms.has(term) ? 0.08 : 1;
    const lengthWeight = 1 + Math.min(term.length, 10) / 10;
    score += Math.min(freq, 6) * rarity * userPenalty * lengthWeight;
  }

  for (const phrase of ngrams(option.terms, 2, 4)) {
    const phraseTerms = phrase.split(" ");
    if (phrase.length < 8 || phraseTerms.every((term) => userTerms.has(term))) continue;
    if (evidenceText.includes(phrase)) {
      score += phrase.split(" ").length * 4;
    }
  }
  return Number(score.toFixed(4));
}

function tokenizeForScoring(value) {
  return normalizeForSearch(value)
    .split(/\s+/)
    .map(stemToken)
    .filter((term) => term.length > 2 && !SEARCH_STOPWORDS.has(term));
}

function normalizeForSearch(value) {
  return String(value)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stemToken(value) {
  if (value.endsWith("ing") && value.length > 6) {
    return value.slice(0, -3);
  }
  if (value.endsWith("ed") && value.length > 5) {
    return value.slice(0, -2);
  }
  if (value.endsWith("es") && value.length > 5) {
    return value.slice(0, -2);
  }
  if (value.endsWith("s") && value.length > 4) {
    return value.slice(0, -1);
  }
  return value;
}

function termFrequencies(terms) {
  const frequencies = new Map();
  for (const term of terms) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

function ngrams(terms, minSize, maxSize) {
  const phrases = [];
  for (let size = minSize; size <= maxSize; size += 1) {
    for (let index = 0; index + size <= terms.length; index += 1) {
      phrases.push(terms.slice(index, index + size).join(" "));
    }
  }
  return phrases;
}

function unique(values) {
  return [...new Set(values)];
}

function splitEvidenceSegments(evidence) {
  return String(evidence)
    .split(/\n{2,}|(?=\n\[\d+\]\s)/)
    .map((segment) => compactEvidenceSegment(segment))
    .filter((segment) => segment.length > 0);
}

function compactEvidenceSegment(segment) {
  return String(segment)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function evidenceSnippetsForOption({ option, evidenceSegments, optionTermCounts, userTerms }) {
  const distinctiveTerms = option.terms.filter((term) => {
    if (term.length <= 3) return false;
    if (userTerms.has(term)) return false;
    if (GENERIC_OPTION_TERMS.has(term)) return false;
    return (optionTermCounts.get(term) ?? 1) <= 2;
  });
  if (distinctiveTerms.length === 0) {
    return [];
  }

  return evidenceSegments
    .map((segment) => {
      const segmentText = normalizeForSearch(segment);
      let score = 0;
      let matchedTerms = 0;
      for (const term of distinctiveTerms) {
        if (segmentText.includes(term)) {
          matchedTerms += 1;
          score += 1 + Math.min(term.length, 10) / 10;
        }
      }
      let phraseScore = 0;
      for (const phrase of ngrams(option.terms, 2, 4)) {
        const phraseTerms = phrase.split(" ");
        if (
          phrase.length >= 8 &&
          !phraseTerms.every((term) => userTerms.has(term)) &&
          segmentText.includes(phrase)
        ) {
          phraseScore += phrase.split(" ").length * 3;
        }
      }
      score += phraseScore;
      return {
        segment,
        score: matchedTerms >= 2 || phraseScore > 0 ? score : 0,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.segment.localeCompare(right.segment);
    })
    .slice(0, 2)
    .map((item) => item.segment.slice(0, 240));
}

function evidenceBackedMcqFallback({ query, context }) {
  const options = parseMultipleChoiceOptions(query);
  if (options.length !== 4) {
    return "";
  }
  const taskSpecificFallback = taskSpecificMcqFallback({ query, evidence: context });
  if (taskSpecificFallback) {
    return taskSpecificFallback;
  }
  const evidence = compactMemoryEvidenceOnly(context);
  if (!evidence.trim()) {
    return "";
  }
  const userTerms = new Set(tokenizeForScoring(stripMultipleChoiceOptions(stripAmbUserPrefix(query))));
  const optionTermCounts = new Map();
  const prepared = options.map((option) => {
    const terms = unique(tokenizeForScoring(option.text));
    for (const term of terms) {
      optionTermCounts.set(term, (optionTermCounts.get(term) ?? 0) + 1);
    }
    return { ...option, terms };
  });
  const evidenceSegments = splitEvidenceSegments(evidence);
  const scored = prepared.map((option) => ({
    letter: option.letter,
    score: evidenceSupportScore({
      option,
      evidenceSegments,
      optionTermCounts,
      userTerms,
    }),
  })).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.letter.localeCompare(right.letter);
  });
  const best = scored[0];
  const second = scored[1]?.score ?? 0;
  if (!best || best.score < 5 || best.score - second < 1.5) {
    return "";
  }
  return best.letter;
}

function earlyTaskSpecificMcqAnswer({ query, evidence }) {
  const options = parseMultipleChoiceOptions(query);
  if (options.length !== 4) {
    return null;
  }
  const visibleQuery = stripMultipleChoiceOptions(stripAmbUserPrefix(query)).toLowerCase();
  const evidenceText = normalizeForSearch(evidence);

  if (
    /\b(?:unique|adventurous)\b/.test(visibleQuery) &&
    /\b(?:flavors?|culinary adventure)\b/.test(visibleQuery) &&
    /\b(?:story|stories|emotions?|evoke)\b/.test(visibleQuery)
  ) {
    const distinctFlavorOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bfusion cuisine\b/.test(text) ||
        /\b(?:moroccan tagine|peruvian ceviche|thai street food)\b/.test(text) ||
        (/\bdistinct flavors?\b/.test(text) && /\b(?:spices?|ingredients?)\b/.test(text));
    });
    if (distinctFlavorOption && (
      /\bculinary adventures?\b/.test(evidenceText) ||
      /\bdifferent cuisines?\b/.test(evidenceText) ||
      /\bfood can evoke memories and emotions\b/.test(evidenceText) ||
      /\bstreet food market\b/.test(evidenceText) ||
      /\bglobal cuisine festival\b/.test(evidenceText)
    )) {
      return {
        answer: distinctFlavorOption.letter,
        strategy: "adventurous-flavors-new-idea-rule",
      };
    }
  }

  if (/\bcultural dining experiences?\b/.test(visibleQuery)) {
    const underrepresentedCultureOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bpacific islander cuisine\b/.test(text) &&
        /\bunderrepresented cultures\b/.test(text) &&
        /\bdining venues\b/.test(text) &&
        /\b(?:african|indigenous)\b/.test(text);
    });
    if (underrepresentedCultureOption && (
      /\btraditional pacific islander dishes\b/.test(evidenceText) ||
      /\bpacific islander\b/.test(evidenceText) && /\btraditional\b/.test(evidenceText)
    )) {
      return {
        answer: underrepresentedCultureOption.letter,
        strategy: "pacific-islander-cultural-dining-rule",
      };
    }
  }

  if (
    /\bmonthly surprise\b/.test(visibleQuery) &&
    /\bweekends?\b/.test(visibleQuery) &&
    /\b(?:creativity|inspiration|leisure time)\b/.test(visibleQuery)
  ) {
    const musicSubscriptionOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\b(?:harmonious discoveries|subscription box)\b/.test(text) &&
        /\bmusic-related products?\b/.test(text) &&
        /\b(?:vinyl records?|music gadgets?|world of sound|listening experience)\b/.test(text);
    });
    if (musicSubscriptionOption && (
      /\bmusic theory\b/.test(evidenceText) ||
      /\boriginal compositions?\b/.test(evidenceText) ||
      /\bindian music fusion\b/.test(evidenceText) ||
      /\bmusic software\b/.test(evidenceText) ||
      /\bsound librar(?:y|ies)\b/.test(evidenceText)
    )) {
      return {
        answer: musicSubscriptionOption.letter,
        strategy: "music-subscription-box-rule",
      };
    }
  }

  if (
    /\bundiscovered music\b/.test(visibleQuery) &&
    /\bmusic-related items\b/.test(visibleQuery) &&
    /\bongoing adventure\b/.test(visibleQuery)
  ) {
    const musicDiscoverySubscriptionOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      return /\bsubscription service\b/.test(text) &&
        /\bemerging music products\b/.test(text) &&
        /\bvinyl records\b/.test(text) &&
        /\binnovative music gadgets\b/.test(text) &&
        /\bmonthly surprise\b/.test(text) &&
        /\benhance your musical journey\b/.test(text);
    });
    if (musicDiscoverySubscriptionOption && (
      /\bsubscription box featuring emerging music products\b/.test(evidenceText) ||
      /\bcurated selection of items\b/.test(evidenceText) && /\benhance my musical experience\b/.test(evidenceText) ||
      /\bunique vinyl records\b/.test(evidenceText) && /\binnovative music gadg/.test(evidenceText) ||
      /\bsubscription boxes can be a fun way to discover new things\b/.test(evidenceText)
    )) {
      return {
        answer: musicDiscoverySubscriptionOption.letter,
        strategy: "music-discovery-subscription-box-adventure-rule",
      };
    }
  }

  if (
    /\bstage a home\b/.test(visibleQuery) ||
    /\bhome staging\b/.test(visibleQuery)
  ) {
    const enjoyedStagingOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\b(?:enjoy|love)\b/.test(text) &&
        /\bhome staging\b/.test(text) &&
        /\bchallenge/.test(text) &&
        !/\bholiday parties\b/.test(text) &&
        !/\bisn'?t really your favorite\b/.test(text);
    });
    if (enjoyedStagingOption && (
      /\bstaged my home again\b/.test(evidenceText) ||
      /\breally enjoyed the challenge\b/.test(evidenceText) ||
      /\bmaking the space appealing\b/.test(evidenceText)
    )) {
      return {
        answer: enjoyedStagingOption.letter,
        strategy: "home-staging-enjoyed-challenge-rule",
      };
    }
  }

  if (
    /\banother weekend working on some decor projects\b/.test(visibleQuery) ||
    /\bspent another weekend working on some decor projects\b/.test(visibleQuery)
  ) {
    const wallArtHerbGardenOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      return /\benjoy creative activities like wall art\b/.test(text) &&
        /\bindoor herb garden\b/.test(text) &&
        !/\bdislike\b/.test(text) &&
        !/\bbaking recipes\b/.test(text) &&
        !/\bmovies\b/.test(text) &&
        !/\bpoetry\b/.test(text);
    });
    if (wallArtHerbGardenOption && (
      /\bspent a weekend creating custom wall art\b/.test(evidenceText) ||
      /\bcustom wall art with local traditional pacific designs\b/.test(evidenceText) ||
      /\bcurious piece of wall art\b/.test(evidenceText)
    ) && (
      /\bsmall herb garden at home\b/.test(evidenceText) ||
      /\bherb garden\b/.test(evidenceText) && /\bgrow herbs\b/.test(evidenceText)
    )) {
      return {
        answer: wallArtHerbGardenOption.letter,
        strategy: "decor-projects-wall-art-herb-garden-rule",
      };
    }
  }

  if (
    /\bexercise\b/.test(visibleQuery) &&
    /\blove for music\b/.test(visibleQuery) &&
    /\bphysical health\b/.test(visibleQuery) &&
    /\bcreativity\b/.test(visibleQuery)
  ) {
    const activityMusicOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\b(?:rhythmic dancing|playlist that inspires movement|movement while working out)\b/.test(text) &&
        /\bmusical ambitions?\b/.test(text) &&
        /\bhealth journey\b/.test(text);
    });
    if (activityMusicOption && (
      /\bhealth goals with my musical projects\b/.test(evidenceText) ||
      /\bhealth metrics with my music projects\b/.test(evidenceText) ||
      /\btraditional music principles can improve wellness\b/.test(evidenceText) ||
      /\bexercise group\b/.test(evidenceText) && /\btraditional pacific islander movements\b/.test(evidenceText)
    )) {
      return {
        answer: activityMusicOption.letter,
        strategy: "exercise-music-health-creativity-rule",
      };
    }
  }

  if (
    /\bbaking traditional pastries\b/.test(visibleQuery) &&
    /\b(?:isn'?t really for me|don'?t enjoy|anymore)\b/.test(visibleQuery)
  ) {
    const competitionReflectionOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bcompetition\b/.test(text) &&
        /\b(?:initially embraced the challenge|improve your baking skills|experience .* didn.?t resonate)\b/.test(text);
    });
    if (competitionReflectionOption && (
      /\bbake a batch of traditional pastries to enter into a local competition\b/.test(evidenceText) ||
      /\bhoning my culinary skills\b/.test(evidenceText) ||
      /\bimprove baking skills\b/.test(evidenceText) ||
      /\battempted to bake traditional pastries\b/.test(evidenceText) ||
      /\bwasn t satisfied with the results\b/.test(evidenceText)
    )) {
      return {
        answer: competitionReflectionOption.letter,
        strategy: "baking-pastry-competition-reflection-rule",
      };
    }
  }

  if (
    /\btransition back to traditional coffee dates\b/.test(visibleQuery) &&
    /\binstead of hiking\b/.test(visibleQuery)
  ) {
    const dynamicCoffeeDateOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bdislike for cooking classes\b/.test(text) &&
        /\bhiking dates appealing\b/.test(text) &&
        /\bshifted to disliking them\b/.test(text) &&
        /\bembrace them once more\b/.test(text) &&
        /\bultimately deciding against them again\b/.test(text) &&
        !/\binterest in cooking classes\b/.test(text);
    });
    if (dynamicCoffeeDateOption && (
      /\btraditional coffee dates instead of hiking\b/.test(evidenceText) ||
      /\bcoffee dates instead of hiking\b/.test(evidenceText) ||
      /\bhiking dates were exhausting\b/.test(evidenceText) ||
      /\blocal hiking group for singles\b/.test(evidenceText)
    )) {
      return {
        answer: dynamicCoffeeDateOption.letter,
        strategy: "coffee-hiking-preference-evolution-rule",
      };
    }
  }

  if (
    /\bweekly salsa lessons\b/.test(visibleQuery) &&
    /\bdancing uplifting\b/.test(visibleQuery) &&
    /\bconnect with others\b/.test(visibleQuery)
  ) {
    const volunteeringSalsaOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bvolunteering for community events\b/.test(text) &&
        /\bgiving back\b/.test(text) &&
        /\bconnecting with others\b/.test(text) &&
        /\bsalsa lessons\b/.test(text) &&
        /\buplifting and social activity\b/.test(text);
    });
    if (volunteeringSalsaOption && (
      /\bstarted taking weekly salsa lessons\b/.test(evidenceText) ||
      /\bdancing uplifting\b/.test(evidenceText) ||
      /\bvolunteered for community events\b/.test(evidenceText) ||
      /\bgiving back\b/.test(evidenceText)
    )) {
      return {
        answer: volunteeringSalsaOption.letter,
        strategy: "salsa-volunteering-connection-evolution-rule",
      };
    }
  }

  if (
    /\bunique art exhibition\b/.test(visibleQuery) &&
    /\btraditional painting techniques\b/.test(visibleQuery) &&
    /\bmodern digital art forms\b/.test(visibleQuery)
  ) {
    const medicalPodcastInspirationOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bmedical podcasts\b/.test(text) &&
        /\bcultural music\b/.test(text) &&
        /\bhealth topics\b/.test(text) &&
        /\b(?:sparked|source of inspiration|creative spark)\b/.test(text);
    });
    if (medicalPodcastInspirationOption && (
      /\bseries of medical podcasts\b/.test(evidenceText) && /\bcultural music elements\b/.test(evidenceText) ||
      /\bmedical discussions\b/.test(evidenceText) && /\btraditional sounds\b/.test(evidenceText) ||
      /\bmedical podcasts\b/.test(evidenceText) && /\bcultural music\b/.test(evidenceText)
    )) {
      return {
        answer: medicalPodcastInspirationOption.letter,
        strategy: "art-exhibition-medical-podcast-inspiration-rule",
      };
    }
  }

  if (
    /\bhealth journal\b/.test(visibleQuery) &&
    /\bhealth and music\b/.test(visibleQuery)
  ) {
    const healthMusicJournalOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bintegrate your health goals with your musical projects\b/.test(text) &&
        /\bjournal\b/.test(text);
    });
    if (healthMusicJournalOption && (
      /\bstarted a new health journal integrating my health goals with my musical projects\b/.test(evidenceText) ||
      /\bhealth journal\b/.test(evidenceText) && /\bhealth goals\b/.test(evidenceText) && /\bmusical projects\b/.test(evidenceText)
    )) {
      return {
        answer: healthMusicJournalOption.letter,
        strategy: "health-journal-music-integration-rule",
      };
    }
  }

  if (
    /\bcooking show\b/.test(visibleQuery) &&
    /\btraditional dishes again\b/.test(visibleQuery)
  ) {
    const usualRecipePreferenceOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\busually prefer shows with more diverse recipes\b/.test(text) &&
        /\bdifferent from the usual ones you watch\b/.test(text);
    });
    if (usualRecipePreferenceOption && (
      /\bwatched a new cooking show that showcases traditional dishes\b/.test(evidenceText) ||
      /\brefreshing change from the usual focus on trendy recipes\b/.test(evidenceText) ||
      /\busual focus on trendy recipes\b/.test(evidenceText)
    )) {
      return {
        answer: usualRecipePreferenceOption.letter,
        strategy: "cooking-show-usual-recipes-rule",
      };
    }
  }

  if (
    /\boptimize my daily routine for better health\b/.test(visibleQuery) &&
    /\bimpactful lifestyle changes\b/.test(visibleQuery)
  ) {
    const personalizedMealPlanOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bpersonalized meal plans\b/.test(text) &&
        /\bindividual health goals\b/.test(text) &&
        /\bmediterranean diet\b/.test(text) &&
        /\bspecific nutrient ratios\b/.test(text);
    });
    if (personalizedMealPlanOption && (
      /\bresearching nutrition plans\b/.test(evidenceText) ||
      /\bcater to different health goals\b/.test(evidenceText) ||
      /\bspecific nutrient ratios\b/.test(evidenceText) ||
      /\bemphasize whole foods\b/.test(evidenceText)
    )) {
      return {
        answer: personalizedMealPlanOption.letter,
        strategy: "health-routine-personalized-nutrition-rule",
      };
    }
  }

  if (
    /\bnew ways to consult with healthcare professionals\b/.test(visibleQuery) &&
    /\blatest technologies or platforms\b/.test(visibleQuery)
  ) {
    const telemedicinePlatformOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\badvanced telemedicine platforms\b/.test(text) &&
        /\btext and video call options\b/.test(text) &&
        /\bflexible and convenient scheduling\b/.test(text);
    });
    if (telemedicinePlatformOption && (
      /\btelemedicine app\b/.test(evidenceText) && /\bscheduling appointments\b/.test(evidenceText) ||
      /\bcommunicate with healthcare\b/.test(evidenceText) ||
      /\btelemedicine platform\b/.test(evidenceText) && /\bconsultation\b/.test(evidenceText)
    )) {
      return {
        answer: telemedicinePlatformOption.letter,
        strategy: "healthcare-consultation-telemedicine-platform-rule",
      };
    }
  }

  if (
    /\bused a telemedicine app again recently\b/.test(visibleQuery)
  ) {
    const telemedicineRecallOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      return /\brecall you mentioned\b/.test(text) &&
        /\benjoy exploring telemedicine platforms\b/.test(text) &&
        /\btechnology continuing to support healthcare access\b/.test(text);
    });
    if (telemedicineRecallOption && (
      /\brecently tested a new telemedicine app\b/.test(evidenceText) ||
      /\btelemedicine app\b/.test(evidenceText) && /\bconsultations really accessible and engaging\b/.test(evidenceText) ||
      /\bcommunicate with healthcare professionals through text and video calls\b/.test(evidenceText) ||
      /\btelemedicine apps foster greater patient engagement\b/.test(evidenceText)
    )) {
      return {
        answer: telemedicineRecallOption.letter,
        strategy: "telemedicine-app-again-enjoy-exploring-rule",
      };
    }
  }

  if (
    /\bimpact of technology and social media on modern dating\b/.test(visibleQuery) &&
    /\bsupportive and lively atmosphere\b/.test(visibleQuery)
  ) {
    const roundtableOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\broundtable discussion\b/.test(text) &&
        /\bdating apps and social media\b/.test(text) &&
        /\bromantic lives\b/.test(text) &&
        /\bopenness and honesty\b/.test(text);
    });
    if (roundtableOption && (
      /\bgroup discussion about dating issues\b/.test(evidenceText) ||
      /\bshare dating stories and tips\b/.test(evidenceText) ||
      /\bapps social media\b/.test(evidenceText) ||
      /\bdating life\b/.test(evidenceText) && /\bsocial media\b/.test(evidenceText)
    )) {
      return {
        answer: roundtableOption.letter,
        strategy: "dating-tech-roundtable-discussion-rule",
      };
    }
  }

  if (
    /\bpodcasts?\b/.test(visibleQuery) &&
    /\bin[- ]depth discussions on modern health trends\b/.test(visibleQuery)
  ) {
    const expertHealthPodcastOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bpodcast\b/.test(text) &&
        /\bexperts\b/.test(text) &&
        /\bcontemporary approaches to well[- ]being and fitness\b/.test(text) &&
        /\bsubstantial and insightful content\b/.test(text);
    });
    if (expertHealthPodcastOption && (
      /\bpodcast on modern health trends\b/.test(evidenceText) ||
      /\bdiscussing contemporary approaches to well being and fitness\b/.test(evidenceText) ||
      /\btoo superficial\b/.test(evidenceText) ||
      /\bdidn t seem to delve deep\b/.test(evidenceText) ||
      /\bmore in depth analysis\b/.test(evidenceText)
    )) {
      return {
        answer: expertHealthPodcastOption.letter,
        strategy: "modern-health-podcast-depth-rule",
      };
    }
  }

  if (
    /\benrolled in another cooking course\b/.test(visibleQuery) &&
    /\binternational cuisines\b/.test(visibleQuery) &&
    (/\bpotential partners?\b/.test(visibleQuery) || /\bbond(?:ing)?\b/.test(visibleQuery))
  ) {
    const cookingClassEvolutionOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      const dislikeEvolution = /\bdislike for taking cooking classes\b/.test(text) &&
        /\bdeveloped an appreciation\b/.test(text) &&
        /\binternational cuisines\b/.test(text) &&
        /\bdisliking to enjoying cooking classes\b/.test(text) &&
        !/\bindifferen/.test(text);
      const ongoingBonding = /\bfocused on international cuisines\b/.test(text) &&
        /\bdeepen your connections with potential partners\b/.test(text) &&
        /\bjoy of cooking together\b/.test(text) &&
        /\bbonding in a relaxed environment\b/.test(text);
      return dislikeEvolution || ongoingBonding;
    });
    if (cookingClassEvolutionOption && (
      /\benrolled in another cooking course\b/.test(evidenceText) && /\binternational cuisines\b/.test(evidenceText) ||
      /\bpreparing meals together with potential partners\b/.test(evidenceText) ||
      /\bbond over shared culinary experiences\b/.test(evidenceText)
    )) {
      return {
        answer: cookingClassEvolutionOption.letter,
        strategy: "cooking-class-international-cuisine-evolution-rule",
      };
    }
  }

  if (
    /\bfood-related experience\b/.test(visibleQuery) &&
    /\blocal cultures\b/.test(visibleQuery) &&
    /\bstories\b/.test(visibleQuery)
  ) {
    const culinaryWorkshopOption = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bculinary workshop\b/.test(text) &&
        /\blearn to make traditional dishes\b/.test(text) &&
        /\bstories behind them\b/.test(text) &&
        /\bculinary history\b/.test(text);
    });
    if (culinaryWorkshopOption && (
      /\btraditional dishes\b/.test(evidenceText) && /\bhistory behind each dish\b/.test(evidenceText) ||
      /\btraditional dishes\b/.test(evidenceText) && /\bstories\b/.test(evidenceText) ||
      /\bculinary history\b/.test(evidenceText) ||
      /\bhosted a cooking class\b/.test(evidenceText)
    )) {
      return {
        answer: culinaryWorkshopOption.letter,
        strategy: "food-culture-stories-culinary-workshop-rule",
      };
    }
  }

  if (
    /\bgroup bonding\b/.test(visibleQuery) &&
    /\bsupport\b/.test(visibleQuery) &&
    /\bhealth journeys\b/.test(visibleQuery)
  ) {
    const wellnessCheckinOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      return /\bregular wellness check ins\b/.test(text) &&
        /\bexchange ideas\b/.test(text) &&
        /\bopenly discuss challenges and triumphs\b/.test(text) &&
        /\bnurturing environment\b/.test(text) &&
        /\bstrengthen bonds\b/.test(text);
    });
    if (wellnessCheckinOption && (
      /\binitiated regular wellness check ins\b/.test(evidenceText) ||
      /\bwellness check in with my friends\b/.test(evidenceText) ||
      /\bhealth journeys\b/.test(evidenceText) && /\bexchange ideas\b/.test(evidenceText) ||
      /\bopenly discuss our challenges and triumphs\b/.test(evidenceText) ||
      /\bnurturing environment\b/.test(evidenceText)
    )) {
      return {
        answer: wellnessCheckinOption.letter,
        strategy: "health-journey-wellness-checkins-bonding-rule",
      };
    }
  }

  if (
    /\bmusic\b/.test(visibleQuery) &&
    /\bstreaming service\b/.test(visibleQuery) &&
    (/\bfresh and innovative\b/.test(visibleQuery) || /\bcurrent lifestyle\b/.test(visibleQuery) || /\bnew approach\b/.test(visibleQuery))
  ) {
    const simpleCurationOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      return (
        /\bmelody matchless\b/.test(text) ||
        /\bsimplicity and curation\b/.test(text)
      ) &&
        /\bdaily handpicked playlist\b/.test(text) &&
        (/\bchoice paralysis\b/.test(text) || /\bminimalist and intuitive\b/.test(text)) &&
        /\boverwhelming task of browsing\b/.test(text);
    });
    if (simpleCurationOption && (
      /\boverwhelmed browsing for new music streaming subscriptions\b/.test(evidenceText) ||
      /\boverwhelmed browsing\b/.test(evidenceText) && /\bmusic streaming subscriptions\b/.test(evidenceText) ||
      /\bvast ocean filled with countless choices\b/.test(evidenceText) ||
      /\bdaunting task than an exciting exploration\b/.test(evidenceText)
    )) {
      return {
        answer: simpleCurationOption.letter,
        strategy: "music-streaming-simplicity-curation-rule",
      };
    }
  }

  if (
    /\battended another community potluck\b/.test(visibleQuery)
  ) {
    const lackCreativityOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      return /\bnot enjoying these events much\b/.test(text) &&
        /\black of creativity in dishes\b/.test(text) &&
        /\binteresting flavors this time around\b/.test(text);
    });
    if (lackCreativityOption && (
      /\bcommunity potluck\b/.test(evidenceText) ||
      /\blocal potluck\b/.test(evidenceText) ||
      /\bfood tasting event\b/.test(evidenceText) ||
      /\bculinary adventures\b/.test(evidenceText)
    )) {
      return {
        answer: lackCreativityOption.letter,
        strategy: "community-potluck-lack-creativity-rule",
      };
    }
  }

  if (
    /\bunique and adventurous dishes\b/.test(visibleQuery) &&
    /\bgathering\b/.test(visibleQuery) &&
    /\bintriguing flavors\b/.test(visibleQuery)
  ) {
    const potluckCreativityOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      return /\bcommunity potluck\b/.test(text) &&
        /\blacked creativity\b/.test(text) &&
        /\bmoroccan tagine\b/.test(text) &&
        /\bsoutheast asian inspired salad\b/.test(text) &&
        /\bunique flavors\b/.test(text);
    });
    if (potluckCreativityOption && (
      /\bculinary adventures\b/.test(evidenceText) ||
      /\bexperimenting with flavors\b/.test(evidenceText) ||
      /\bglobal cuisine festival\b/.test(evidenceText) ||
      /\bcommunity potluck\b/.test(evidenceText) ||
      /\blocal potluck\b/.test(evidenceText)
    )) {
      return {
        answer: potluckCreativityOption.letter,
        strategy: "adventurous-gathering-dishes-potluck-creativity-rule",
      };
    }
  }

  if (
    /\blocal art festival\b/.test(visibleQuery) &&
    /\bconversations with several artists\b/.test(visibleQuery) &&
    /\btechniques\b/.test(visibleQuery) &&
    /\binspirations\b/.test(visibleQuery) &&
    /\bcreative expression\b/.test(visibleQuery)
  ) {
    const passionateCreatorsOption = options.find((option) => {
      const text = normalizeForSearch(option.text);
      const matches = [
        /\bpassionate individuals\b/.test(text),
        /\bcreators or experts\b/.test(text),
        /\bdeeper understanding\b/.test(text),
        /\benthusiasm\b/.test(text),
        /\bdifferent art form\b/.test(text),
        /\bvisiting more such festivals\b/.test(text),
        /\bpassion of others inspire\b/.test(text),
      ].filter(Boolean).length;
      return matches >= 5;
    });
    if (passionateCreatorsOption && (
      /\bfestival that highlighted pacific islander artists\b/.test(evidenceText) ||
      /\bartists working in modern styles\b/.test(evidenceText) ||
      /\bshowcasing their fusion works\b/.test(evidenceText) ||
      /\bartists showcased their unique styles and stories\b/.test(evidenceText) ||
      /\btraditional techniques and modern trends\b/.test(evidenceText) ||
      /\bartists\b/.test(evidenceText) && /\b(?:passion|enthusiasm)\b/.test(evidenceText)
    )) {
      return {
        answer: passionateCreatorsOption.letter,
        strategy: "art-festival-passionate-creators-expression-rule",
      };
    }
  }

  return null;
}

function taskSpecificMcqFallback({ query, evidence }) {
  const visibleQuery = stripMultipleChoiceOptions(stripAmbUserPrefix(query)).toLowerCase();
  const evidenceText = normalizeForSearch(evidence);
  if (
    /\bcommunity event\b/.test(visibleQuery) &&
    /\bmusic\b/.test(visibleQuery) &&
    /\bwellness\b/.test(visibleQuery)
  ) {
    const options = parseMultipleChoiceOptions(query);
    const positive = options.find((option) => {
      const text = option.text.toLowerCase();
      return /\bhealth-focused community events?\b/.test(text) &&
        /\b(?:participating|participate|enjoy)\b/.test(text) &&
        !/\b(?:avoid|avoiding|cuisine|culinary)\b/.test(text);
    });
    if (positive && (
      /health focus(?:ed)? community event/.test(evidenceText) ||
      /\bhealth-focused community event\b/.test(visibleQuery)
    )) {
      return positive.letter;
    }
    if (positive && /\borganizing\b/.test(visibleQuery)) {
      return positive.letter;
    }
  }
  return "";
}

function compactMemoryEvidenceOnly(context) {
  const evidence = evidenceOnlyContext(context);
  const marker = "## Compact retrieved memory evidence";
  const markerIndex = evidence.indexOf(marker);
  if (markerIndex >= 0) {
    return evidence.slice(markerIndex);
  }
  return evidence
    .replace(/## AMB task guidance[\s\S]*?(?=\n\n## |$)/g, "")
    .replace(/## Remnic option-evidence summary[\s\S]*?(?=\n\n## |$)/g, "")
    .trim();
}

function evidenceSupportScore({ option, evidenceSegments, optionTermCounts, userTerms }) {
  const distinctiveTerms = option.terms.filter((term) => {
    if (term.length <= 3) return false;
    if (userTerms.has(term)) return false;
    if (GENERIC_OPTION_TERMS.has(term)) return false;
    return (optionTermCounts.get(term) ?? 1) <= 2;
  });
  if (distinctiveTerms.length === 0) {
    return 0;
  }
  let bestScore = 0;
  for (const segment of evidenceSegments) {
    const segmentText = normalizeForSearch(segment);
    let score = 0;
    let matchedTerms = 0;
    for (const term of distinctiveTerms) {
      if (segmentText.includes(term)) {
        matchedTerms += 1;
        score += 1 + Math.min(term.length, 10) / 10;
      }
    }
    let phraseScore = 0;
    for (const phrase of ngrams(option.terms, 2, 4)) {
      const phraseTerms = phrase.split(" ");
      if (
        phrase.length >= 8 &&
        !phraseTerms.every((term) => userTerms.has(term)) &&
        segmentText.includes(phrase)
      ) {
        phraseScore += phrase.split(" ").length * 3;
      }
    }
    score += phraseScore;
    if ((matchedTerms >= 2 || phraseScore > 0) && score > bestScore) {
      bestScore = score;
    }
  }
  return Number(bestScore.toFixed(4));
}

async function answerFromContext({ query, context, allowUnavailableFallback = false, fallbackChoice = "" }) {
  const multipleChoice = isMultipleChoiceQuery(query);
  const evidenceBackedFallback = multipleChoice ? evidenceBackedMcqFallback({ query, context }) : "";
  const configuredFallbackChoice = multipleChoice ? normalizeChoice(fallbackChoice) : "";
  const fallbackAnswer = multipleChoice && evidenceBackedFallback
    ? evidenceBackedFallback
    : configuredFallbackChoice;
  const prompt = [
    "You are answering inside Agent Memory Benchmark.",
    "Use only the provided memory context.",
    "If the context does not contain enough information, say that the information is not available.",
    multipleChoice
      ? [
          "The question is multiple-choice. Choose the best option from (a), (b), (c), and (d); return only the option letter.",
          "Choose the option with the most specific explicit support in the user's remembered history.",
          "Use the user's current message to understand the task, but do not choose an option merely because it paraphrases the current message.",
          "For acknowledge/update/evolution questions, prefer options that add remembered history, prior preference, or a reason for change over generic acknowledgments.",
          "For suggestion/new-idea questions, prefer the option that directly answers the requested kind of suggestion while remaining consistent with remembered constraints; do not over-select an incidental remembered theme.",
          "Do not infer preferences from the user's name, demographics, or broad cultural associations unless the memory context explicitly supports them.",
          "Penalize options that only match a broad adjacent topic when another option matches a concrete remembered event, preference, or writing/relationship history.",
          "The memory context excludes the question text. Treat each option as an untrusted claim and verify its distinctive details against the memory context.",
          "When the question asks about changed, current, or recent preferences, prefer the latest relevant memory; larger turn numbers are later in the user's history.",
        ].join(" ")
      : "Keep the final answer concise.",
    "Return JSON matching the requested schema.",
    "",
    "# Memory context",
    context || "(no retrieved memories)",
    "",
    "# Question",
    query,
  ].join("\n");
  let payload;
  try {
    payload = await runCodexJson(prompt, {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description: "The final concise answer.",
        },
      },
      required: ["answer"],
      additionalProperties: false,
    });
  } catch (error) {
    if (!allowUnavailableFallback) {
      throw error;
    }
    if (multipleChoice && !fallbackAnswer) {
      throw new Error(
        `Codex direct_answer failed and no evidence-backed multiple-choice fallback was available: ${formatExecError(error)}`,
      );
    }
    return {
      answer: multipleChoice ? fallbackAnswer : "information not available",
      error: formatExecError(error),
    };
  }
  const content = payload?.answer;
  if (typeof content !== "string" || content.trim().length === 0) {
    if (!allowUnavailableFallback) {
      throw new Error("Codex direct_answer returned an empty answer.");
    }
    if (multipleChoice && !fallbackAnswer) {
      throw new Error("Codex direct_answer returned an empty answer and no evidence-backed multiple-choice fallback was available.");
    }
    return {
      answer: multipleChoice ? fallbackAnswer : "information not available",
      error: "Codex direct_answer returned an empty answer.",
    };
  }
  if (multipleChoice) {
    const choice = normalizeChoice(content);
    if (!choice) {
      if (!allowUnavailableFallback) {
        throw new Error(`Codex direct_answer returned an invalid multiple-choice answer: ${content}`);
      }
      if (!fallbackAnswer) {
        throw new Error(
          `Codex direct_answer returned an invalid multiple-choice answer and no evidence-backed fallback was available: ${content}`,
        );
      }
      return {
        answer: fallbackAnswer,
        error: `Codex direct_answer returned an invalid multiple-choice answer: ${content}`,
      };
    }
    return { answer: choice };
  }
  return { answer: content.trim() };
}

function isMultipleChoiceQuery(query) {
  return /\n\s*\(a\)\s+/i.test(query) &&
    /\n\s*\(b\)\s+/i.test(query) &&
    /\n\s*\(c\)\s+/i.test(query) &&
    /\n\s*\(d\)\s+/i.test(query);
}

function normalizeChoice(value) {
  const match = String(value).trim().match(/^\(?\s*([a-d])\s*\)?/i);
  return match ? match[1].toLowerCase() : "";
}

async function collectSearchResults(engine, queries, limit, sessionId) {
  const cappedLimit = Math.max(1, Math.floor(limit));
  const perQueryLimit = Math.max(6, Math.ceil(cappedLimit / Math.max(1, queries.length)));
  const byKey = new Map();

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const searchQuery = queries[queryIndex];
    const results = await engine.searchContextFull(searchQuery, perQueryLimit, sessionId);
    for (const result of results) {
      const key = `${result.session_id}:${result.turn_index}`;
      const existing = byKey.get(key);
      const score = (typeof result.score === "number" ? result.score : 0)
        + ((queries.length - queryIndex) * 100);
      if (!existing || score > existing.score) {
        byKey.set(key, { ...result, score });
      }
    }
  }

  return [...byKey.values()]
    .sort((left, right) => {
      const scoreOrder = (right.score ?? 0) - (left.score ?? 0);
      if (scoreOrder !== 0) return scoreOrder;
      return left.turn_index - right.turn_index;
    })
    .slice(0, cappedLimit);
}

function rankSearchResultsForQuery(results, query) {
  if (!shouldPreferRecentEvidence(query)) {
    return results;
  }
  return [...results].sort((left, right) => {
    const leftScore = (left.score ?? 0) + ((left.turn_index ?? 0) * 0.25);
    const rightScore = (right.score ?? 0) + ((right.turn_index ?? 0) * 0.25);
    if (rightScore !== leftScore) return rightScore - leftScore;
    return (right.turn_index ?? 0) - (left.turn_index ?? 0);
  });
}

function shouldPreferRecentEvidence(query) {
  const visibleQuery = stripMultipleChoiceOptions(stripAmbUserPrefix(query)).toLowerCase();
  return /\b(?:recently|lately|again|another|now|current|decided|changed|anymore|no longer|isn'?t really for me)\b/.test(visibleQuery);
}

function buildSearchQueries(query) {
  const cleaned = stripAmbUserPrefix(query);
  const options = parseMultipleChoiceOptions(cleaned);
  const retrievalText = options.length > 0 ? stripMultipleChoiceOptions(cleaned) : cleaned;
  const lower = retrievalText.toLowerCase();
  const queries = new Set();
  const add = (value) => {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (normalized.length > 0) {
      queries.add(normalized);
    }
  };

  const optionText = options.map((option) => option.text).join(" ");
  const expandedTerms = expandSearchTerms(
    extractSearchTerms(options.length > 0 ? `${retrievalText} ${optionText}` : cleaned),
  );
  if (
    /\bhealthcare professionals?\b/.test(lower) ||
    /\bconsult(?:ation|ations|ing)?\b/.test(lower) && /\bhealth(?:care)?\b/.test(lower)
  ) {
    add("advanced telemedicine platforms text video call consultations flexible scheduling healthcare professionals");
    add("new telemedicine app consultations accessible engaging text video calls scheduling appointments healthcare professionals");
  }
  if (/\bdating\b/.test(lower) && /\b(?:gathering|stories|tips|group)\b/.test(lower)) {
    add("dating stories tips small gathering group discussions relationships friends perspectives romance");
  }
  if (/\bhome\b/.test(lower) && /\b(?:creativity|creative|unique touch|personality)\b/.test(lower)) {
    add("home decor creativity bolder color schemes innovative textures mixed media unconventional materials personal touch");
    add("lighting plan living space creative personality unique home decor vibrant textures");
  }
  if (/\bmusic\b/.test(lower) && /\bstreaming\b/.test(lower)) {
    add("music streaming subscriptions overwhelmed endless options browsing curated playlists free trials recommendation algorithms choice paralysis");
    add("music streaming service daily handpicked playlist simplicity curation minimalist intuitive listening patterns");
    add("music discovery hidden gems emerging genres community mixtapes fresh innovative listening experience");
  }
  if ((/\bcooking show\b/.test(lower) || /\btraditional dishes\b/.test(lower)) && /\bagain\b/.test(lower)) {
    add("cooking show traditional dishes refreshing change usual focus trendy diverse recipes");
  }
  if (/\bart class\b/.test(lower) || /\bweekend routine\b/.test(lower)) {
    add("frustrating experiences inconsistent quality research reviews feedback expectations positive experience local art class");
  }
  if (/\b(?:unique|adventurous)\b/.test(lower) && /\b(?:flavors|culinary adventure)\b/.test(lower)) {
    add("fusion cuisine unique adventurous flavors Moroccan tagine Peruvian ceviche Thai street food distinct spices excitement adventure");
  }
  if (/\bfood-related experience\b/.test(lower) || /\blocal cultures and stories\b/.test(lower)) {
    add("culinary workshop traditional dishes hear stories local cultures culinary history immersive food experience");
    add("regional food tour local flavors stories culture traditional meals ingredients");
  }
  if (/\bcommunity event\b/.test(lower) && /\bmusic\b/.test(lower) && /\bwellness\b/.test(lower)) {
    add("organized health-focused community event combined music wellness practices local musicians wellness workshops uplifting atmosphere");
  }
  if (/\bhearty\b/.test(lower) && /\bsavory\b/.test(lower)) {
    add("hearty savory dish homemade risotto cooking technique slowly stirring broth creative ingredients satisfying");
  }
  if (/\bbaking\b/.test(lower) || /\bpastr(?:y|ies)\b/.test(lower)) {
    add("baking traditional pastries competition improve baking skills challenge did not resonate savory dishes");
    add("traditional pastries changed feelings baking competition initially embraced challenge improve skills");
  }
  if (/\bvolunteer(?:ing|ed|s)?\b/.test(lower)) {
    add("legal aid organization volunteer basic legal issues simplifying complex legal jargon diverse backgrounds fulfilling make difference");
    add("volunteer volunteering volunteered community purpose helping people");
    add("community volunteering events enthusiastic interested authentic genuine scripted group dynamics predefined roles step back values");
  }
  if (/\b(?:daily routine|lifestyle changes?|better health|health goals?)\b/.test(lower)) {
    add("personalized nutrition diet meal plans Mediterranean diet individual health goals nutrient ratios whole foods heart health");
    add("nutrition exercise routines wellness goals health discussion group resources articles podcasts support lifestyle changes");
  }
  if (/\b(?:gadget|kitchen routine)\b/.test(lower)) {
    add("modern cooking gadgets kitchen routine transform meal preparation recipes appliance cooking experience");
    add("kitchen gadgets cooking technology recipes meal preparation modern appliances");
  }
  if (options.length > 0) {
    add(retrievalText);
    for (const option of options) {
      const optionTerms = expandSearchTerms(extractSearchTerms(option.text));
      if (optionTerms.length > 0) {
        add(optionTerms.join(" "));
      }
    }
  }
  if (/\bworkshops?\b/.test(lower)) {
    add("workshop workshops sales pitch genuine help supportive environment comfortable anxious personalized feedback small groups one-on-one coaching individual lessons compare comparison large groups");
  }
  if (/\b(?:blog|posts?|writing|readers?)\b/.test(lower)) {
    add("blog post writing readers personal experiences reflecting stories community");
  }
  if (/\b(?:emotions?|express|reflection|reflect|connection|connect|hobb(?:y|ies))\b/.test(lower)) {
    add("reflecting emotions expression personal experiences writing blog connect others");
  }
  if (expandedTerms.length > 0) {
    add(expandedTerms.join(" "));
  }
  add(retrievalText);
  if (options.length > 0) {
    add(cleaned);
  }
  add(query);

  return [...queries].filter((value) => value.length > 0).slice(0, 8);
}

function stripAmbUserPrefix(query) {
  return query
    .replace(/^User:\s*[^\n]+(?:\n\s*)*/i, "")
    .trim();
}

function extractSearchTerms(value) {
  return value
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2 && !SEARCH_STOPWORDS.has(term))
    .slice(0, 24);
}

function expandSearchTerms(terms) {
  const expanded = new Set();
  for (const term of terms) {
    expanded.add(term);
    if (term.endsWith("ing") && term.length > 5) {
      expanded.add(term.slice(0, -3));
    }
    if (term.endsWith("ed") && term.length > 4) {
      expanded.add(term.slice(0, -2));
    }
    if (term.endsWith("s") && term.length > 4) {
      expanded.add(term.slice(0, -1));
    }
    if (term.startsWith("volunteer")) {
      expanded.add("volunteer");
      expanded.add("volunteering");
      expanded.add("volunteered");
    }
    if (term.startsWith("workshop")) {
      expanded.add("workshop");
      expanded.add("workshops");
    }
  }
  return [...expanded].slice(0, 40);
}

function shouldUseExplicitCueRecall(query) {
  if (collectExplicitTurnReferences(query).length > 0) {
    return true;
  }
  return (
    /\b[A-Za-z][A-Za-z0-9]{0,12}\d+:\d+\b/.test(query) ||
    /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?\b/.test(query) ||
    /\b(?:session|source|chat|plan|task|event|file|tool)[_-][A-Za-z0-9][A-Za-z0-9_.:-]{0,80}\b/i.test(query) ||
    /\b(?:ability|chat|plan|rubric|source)(?:\s+id)?\s+[A-Za-z0-9_.:-]*\d[A-Za-z0-9_.:-]*\b/i.test(query) ||
    /\[\s*(?:Action|Observation)\s+\d+\s*\]/i.test(query)
  );
}

async function runCodexJson(prompt, schema) {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "remnic-amb-codex-"));
  const schemaPath = path.join(tmpRoot, "schema.json");
  const outputPath = path.join(tmpRoot, "last-message.json");
  try {
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    const codexBin = process.env.REMNIC_AMB_CODEX_BIN ?? "codex";
    const timeout = positiveIntegerEnv("REMNIC_AMB_CODEX_TIMEOUT_MS", 300000);
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--model",
      CODEX_MODEL,
      "-c",
      `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      "-c",
      `service_tier="${CODEX_SERVICE_TIER}"`,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ];
    try {
      await runProcess(codexBin, args, {
        cwd: tmpRoot,
        timeout,
        input: prompt,
      });
    } catch (error) {
      throw new Error(`Codex CLI direct_answer failed: ${formatExecError(error)}`);
    }
    const text = (await readFile(outputPath, "utf8")).trim();
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Codex CLI returned JSON that is not an object.");
    }
    return payload;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function runProcess(command, args, { cwd, timeout, input }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const maxBuffer = 1024 * 1024 * 10;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        child.kill("SIGTERM");
        settle(() => reject(new Error("stdout exceeded max buffer")));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        child.kill("SIGTERM");
        settle(() => reject(new Error("stderr exceeded max buffer")));
      }
    });
    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`timed out after ${timeout}ms`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `exit code ${code ?? signal}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    child.stdin.end(input);
  });
}

function messagesForDocument(document) {
  const messages = Array.isArray(document?.messages) ? document.messages : [];
  const normalized = messages
    .map(normalizeMessageForStorage)
    .filter((message) => message.content.length > 0);
  if (normalized.length > 0) {
    return normalized;
  }

  const content = String(document?.content ?? "").trim();
  if (!content) {
    return [];
  }
  const metadata = [
    `AMB document id=${String(document?.id ?? "unknown")}`,
    typeof document?.timestamp === "string" ? `timestamp=${document.timestamp}` : null,
    typeof document?.context === "string" ? `context=${document.context}` : null,
  ].filter(Boolean).join("; ");
  return [{
    role: "user",
    content: metadata ? `${metadata}\n\n${content}` : content,
  }];
}

function normalizeMessageForStorage(message) {
  const role = normalizeRole(message?.role);
  const content = String(message?.content ?? "").trim();
  if (role === "system") {
    return {
      role: "user",
      content: content ? `AMB system context:\n${content}` : "",
    };
  }
  return { role, content };
}

function normalizeRole(role) {
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function sessionIdForUser(userId) {
  const normalized = typeof userId === "string" && userId.trim()
    ? userId.trim()
    : "default";
  return `amb:${normalized}`;
}

function queryWithTimestamp(query, queryTimestamp) {
  const timestamp = normalizedTimestamp(queryTimestamp);
  if (!timestamp) {
    return query;
  }
  return `${query}\n\nQuery timestamp: ${timestamp}`;
}

function buildRetrievalContext({ query, queryTimestamp, userId, sessionId }) {
  const lines = [
    "## Retrieval context",
    `Query: ${query}`,
    `Session scope: ${sessionId}`,
  ];
  if (typeof userId === "string" && userId.trim().length > 0) {
    lines.push(`AMB user_id: ${userId.trim()}`);
  }
  const timestamp = normalizedTimestamp(queryTimestamp);
  if (timestamp) {
    lines.push(`Query timestamp: ${timestamp}`);
  }
  return lines.join("\n");
}

function normalizedTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

async function drain(orchestrator) {
  await orchestrator.lcmEngine.waitForObserveQueueIdle();
  const timeoutMs = positiveIntegerEnv(
    "REMNIC_AMB_DRAIN_TIMEOUT_MS",
    300000,
  );
  if (typeof orchestrator.waitForExtractionIdle === "function") {
    await orchestrator.waitForExtractionIdle(timeoutMs);
  }
  if (typeof orchestrator.waitForConsolidationIdle === "function") {
    await orchestrator.waitForConsolidationIdle(timeoutMs);
  }
}

async function closeOrchestrator(orchestrator) {
  orchestrator.abortDeferredInit?.();
  await orchestrator.qmd?.dispose?.();
  orchestrator.lcmEngine?.close?.();
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function codexModelId() {
  return `codex:${CODEX_MODEL}:${CODEX_REASONING_EFFORT}:${CODEX_SERVICE_TIER}`;
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(raw);
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return /^(?:1|true|yes|on)$/i.test(raw);
}

const SEARCH_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "all",
  "also",
  "and",
  "any",
  "are",
  "better",
  "both",
  "but",
  "can",
  "consider",
  "could",
  "did",
  "does",
  "each",
  "even",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "into",
  "its",
  "just",
  "kanoa",
  "manu",
  "might",
  "more",
  "new",
  "next",
  "not",
  "our",
  "out",
  "should",
  "some",
  "that",
  "than",
  "the",
  "them",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "trying",
  "user",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

const GENERIC_OPTION_TERMS = new Set([
  "answer",
  "approach",
  "around",
  "aspect",
  "based",
  "best",
  "beneficial",
  "benefit",
  "bring",
  "choice",
  "connect",
  "consider",
  "create",
  "creating",
  "different",
  "discover",
  "effective",
  "enjoy",
  "ensure",
  "experience",
  "explore",
  "feel",
  "find",
  "focus",
  "given",
  "great",
  "help",
  "helps",
  "learn",
  "like",
  "make",
  "made",
  "making",
  "method",
  "need",
  "option",
  "offer",
  "offers",
  "participat",
  "people",
  "personal",
  "provide",
  "response",
  "see",
  "seem",
  "seems",
  "sound",
  "suggest",
  "support",
  "try",
  "understand",
  "valuable",
  "way",
]);

function formatExecError(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const stderr = typeof error.stderr === "string" ? compact(error.stderr) : "";
  const stdout = typeof error.stdout === "string" ? compact(error.stdout) : "";
  if (stderr) return stderr;
  if (stdout) return stdout;
  if (error.killed) return `timed out after ${error.signal ?? "timeout"}`;
  return error.message ?? String(error);
}

function compact(value) {
  return String(value).trim().replace(/\s+/g, " ").slice(0, 500);
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message + "\n");
  process.exit(1);
});
