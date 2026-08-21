#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_MODEL = "gpt-5.5";
const CODEX_REASONING_EFFORT = "xhigh";
const CODEX_SERVICE_TIER = "fast";
const repoRoot = process.env.REMNIC_REPO
  ? path.resolve(expandTildePath(process.env.REMNIC_REPO))
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
    const documentTimestamp = normalizedTimestamp(document?.timestamp) ?? new Date().toISOString();
    const baseTimestampMs = Date.parse(documentTimestamp);
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
        ...(message.sourceValidAt ? { sourceValidAt: message.sourceValidAt } : {}),
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
  const explicitBudgetShare = useExplicitCueRecall ? 0.35 : 0;
  const searchBudgetShare = useExplicitCueRecall ? 0.30 : 0.55;
  const coreBudgetShare = useExplicitCueRecall ? 0.35 : 0.45;
  const explicitBudget = useExplicitCueRecall
    ? Math.min(8000, Math.floor(budget * explicitBudgetShare))
    : 0;
  const nonExplicitShareTotal = searchBudgetShare + coreBudgetShare;
  const remainingBudget = Math.max(0, budget - explicitBudget);
  const searchBudget = useExplicitCueRecall
    ? Math.floor(remainingBudget * (searchBudgetShare / nonExplicitShareTotal))
    : Math.floor(budget * searchBudgetShare);
  const coreBudget = Math.max(0, budget - explicitBudget - searchBudget);
  const explicit = useExplicitCueRecall
    ? await buildExplicitCueRecallSection({
        engine: orchestrator.lcmEngine,
        sessionId,
        query,
        maxChars: explicitBudget,
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
    maxChars: Math.max(0, searchBudget),
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
  const nativeMcqAnswer = answerMultipleChoiceFromEvidence({ query, context });
  if (isMultipleChoiceQuery(query) && boolEnv("REMNIC_AMB_NATIVE_ONLY_DIRECT_ANSWER", false)) {
    if (!nativeMcqAnswer) {
      throw new Error("Native-only direct_answer requested but no evidence-backed multiple-choice answer was available.");
    }
    return {
      answer: nativeMcqAnswer.answer,
      context,
      raw_response: {
        ...retrieved.raw_response,
        mode: "direct_answer",
        answerModel: "remnic-native-mcq-evidence-ranker",
        answerStrategy: nativeMcqAnswer.strategy,
        optionScores: nativeMcqAnswer.scores ?? [],
      },
    };
  }
  if (isMultipleChoiceQuery(query) && memoryEvidence.trim().length === 0) {
    return {
      answer: "",
      context: "",
      raw_response: {
        ...retrieved.raw_response,
        mode: "direct_answer",
        answerModel: "remnic-no-evidence-mcq-guard",
        answerError: "no retrieved memory evidence for multiple-choice direct_answer",
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
  const taskGuidance = buildMcqTaskGuidance();
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

function buildMcqTaskGuidance() {
  return [
    "## AMB task guidance",
    "Choose from the retrieved memory evidence, not from prior assumptions or the option text alone.",
    "Treat each option as an untrusted claim and prefer distinctive remembered facts over broad topic overlap.",
    "When the question asks about current or changed preferences, prefer the latest relevant retrieved memory.",
  ].join("\n");
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
    .replace(/## Retrieval context[\s\S]*?(?=\n\n## Explicit Cue Evidence|\n\n## Search evidence|\n\n## Remnic recall pipeline|\n\n## Memory \d+|$)/g, "")
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

function compactMemoryEvidenceOnly(context) {
  const rawContext = String(context);
  const marker = "## Compact retrieved memory evidence";
  const markerIndex = rawContext.indexOf(marker);
  const compacted = markerIndex >= 0
    ? rawContext.slice(markerIndex)
    : evidenceOnlyContext(rawContext)
      .replace(/## AMB task guidance[\s\S]*?(?=\n\n## |$)/g, "")
      .replace(/## Remnic option-evidence summary[\s\S]*?(?=\n\n## |$)/g, "");
  return compacted
    .replace(/\(no retrieved memories\)/gi, "")
    .trim();
}

async function answerFromContext({ query, context, allowUnavailableFallback = false, fallbackChoice = "" }) {
  const multipleChoice = isMultipleChoiceQuery(query);
  const configuredFallbackChoice = multipleChoice ? normalizeChoice(fallbackChoice) : "";
  const fallbackAnswer = configuredFallbackChoice;
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
  const text = String(value).trim();
  const bare = text.match(/^(?:([a-d])|([a-d])[.)]|\(\s*([a-d])\s*\))\s*$/i);
  if (bare) {
    return (bare[1] ?? bare[2] ?? bare[3]).toLowerCase();
  }
  const leadingMarker = text.match(/^\(\s*([a-d])\s*\)(?:\s+\S[\s\S]*)?$/i);
  if (leadingMarker) {
    return leadingMarker[1].toLowerCase();
  }
  const explicitMarker = text.match(/^(?:answer|choice|option|final answer)\s*(?::|-|is)?\s*\(?\s*([a-d])\s*\)?(?:\s|$|[.)])/i);
  return explicitMarker ? explicitMarker[1].toLowerCase() : "";
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
  add(retrievalText);

  if (options.length > 0) {
    add(cleaned);
    for (const option of options) {
      const optionTerms = expandSearchTerms(extractSearchTerms(option.text));
      if (optionTerms.length > 0) {
        add(optionTerms.join(" "));
      }
    }
  }

  if (expandedTerms.length > 0) {
    add(expandedTerms.join(" "));
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
    const codexBin = resolveExecutable(process.env.REMNIC_AMB_CODEX_BIN ?? "codex");
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
  const documentSourceValidAt = timestampForRecord(document);
  const messages = Array.isArray(document?.messages) ? document.messages : [];
  const normalized = messages
    .map((message) => normalizeMessageForStorage(message, documentSourceValidAt))
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
    ...(documentSourceValidAt ? { sourceValidAt: documentSourceValidAt } : {}),
  }];
}

function normalizeMessageForStorage(message, fallbackSourceValidAt) {
  const role = normalizeRole(message?.role);
  const content = String(message?.content ?? "").trim();
  const sourceValidAt = timestampForRecord(message) ?? fallbackSourceValidAt;
  if (role === "system") {
    return {
      role: "user",
      content: content ? `AMB system context:\n${content}` : "",
      ...(sourceValidAt ? { sourceValidAt } : {}),
    };
  }
  return {
    role,
    content,
    ...(sourceValidAt ? { sourceValidAt } : {}),
  };
}

function normalizeRole(role) {
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function timestampForRecord(record) {
  return normalizedTimestamp(
    record?.timestamp ??
      record?.created_at ??
      record?.createdAt ??
      record?.time ??
      record?.date,
  );
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

function expandTildePath(value) {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveExecutable(value) {
  const expanded = expandTildePath(value);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  if (expanded.includes("/") || expanded.includes("\\")) {
    return path.resolve(expanded);
  }
  return expanded;
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
