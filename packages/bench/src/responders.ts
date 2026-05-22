import {
  FallbackLlmClient,
  type FallbackLlmRuntimeContext,
  type GatewayConfig,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchJudgeResult,
  BenchResponder,
  BenchResponse,
} from "./adapters/types.js";
import { createProvider } from "./providers/factory.js";
import type {
  LlmProvider,
  ProviderFactoryConfig,
} from "./providers/types.js";
import type { StructuredJudge } from "./judges/sealed-rubric.js";

const DEFAULT_RESPONDER_SYSTEM_PROMPT = [
  "You answer benchmark questions using only the supplied Remnic memory context.",
  "If the context does not contain enough information, say that the answer is unknown.",
  "Do not invent facts that are not grounded in the provided context.",
  "When the question includes an output protocol, follow it exactly.",
  "Prefer absolute dates or years over relative wording when memory evidence supports them.",
].join(" ");

const DEFAULT_JUDGE_SYSTEM_PROMPT = [
  "You are grading a benchmark answer against an expected answer.",
  "Return only a numeric score from 0.00 to 1.00 inclusive.",
  "Use 1.00 for a fully correct answer, 0.00 for a fully incorrect answer, and fractional values for partial matches.",
].join(" ");

const AMA_BENCH_RECOMMENDED_JUDGE_SYSTEM_PROMPT = [
  "You are evaluating an AMA-Bench long-horizon memory question.",
  "Decide whether the predicted answer correctly answers the question using the reference answer as ground truth.",
  "Award 1 only when the predicted answer contains the same essential information as the reference answer.",
  "Award 0 when the answer is wrong, missing, contradictory, or only vaguely related.",
  "Ignore harmless wording differences, formatting differences, and extra explanation that does not change the answer.",
  'Return only JSON: {"score":0 or 1,"reason":"short reason"}.',
].join(" ");

const SCORE_CUE_REGEX = /\b(score|rated|rating|grade|graded|result|overall|final)\b/;
const CONTEXT_COMPACTION_MARKER = "[...omitted unrelated recalled context...]";
const COMPACTED_CONTEXT_PREFIX =
  "[Remnic memory context compacted for the responder prompt; full recalled text is preserved in the benchmark artifact.]";
const TRAJECTORY_ANALYSIS_HEADING = "## Trajectory analysis";
const TRAJECTORY_LABELS = Object.freeze([
  "action",
  "observation",
  "step",
  "turn",
]);

export interface GatewayResponderOptions {
  gatewayConfig?: GatewayConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  llmFactory?: (
    gatewayConfig: GatewayConfig,
    runtimeContext: FallbackLlmRuntimeContext,
  ) => Pick<FallbackLlmClient, "chatCompletion">;
}

export interface ProviderResponderOptions {
  contextBudgetChars?: number;
  promptBudgetChars?: number;
}

export function createResponderFromProvider(
  provider: LlmProvider,
  options: ProviderResponderOptions = {},
): BenchResponder {
  return {
    async respond(
      question: string,
      recalledText: string,
      control,
    ): Promise<BenchResponse> {
      const responderQuestion = options.promptBudgetChars === undefined
        ? question
        : compactResponderQuestion(question, options.promptBudgetChars);
      const responderContext = options.contextBudgetChars === undefined
        ? recalledText
        : compactResponderContext(
          recalledText,
          question,
          options.contextBudgetChars,
        );
      const completion = await provider.complete(
        [
          `QUESTION: ${responderQuestion}`,
          "",
          "REMNIC_MEMORY_CONTEXT:",
          responderContext.trim().length > 0
            ? responderContext
            : "(no memory context available)",
          "",
          "Answer the question using only the supplied memory context.",
        ].join("\n"),
        {
          systemPrompt: DEFAULT_RESPONDER_SYSTEM_PROMPT,
          temperature: 0,
          maxTokens: 256,
          signal: control?.signal,
        },
      );

      return {
        text: completion.text,
        tokens: completion.tokens,
        latencyMs: completion.latencyMs,
        model: completion.model,
      };
    },
  };
}

export function createProviderBackedResponder(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): BenchResponder {
  validateProviderConfig(config, "responder");
  return createResponderFromProvider(providerInstance ?? createProvider(config), {
    contextBudgetChars: config.responderContextBudgetChars,
    promptBudgetChars: config.responderPromptBudgetChars,
  });
}

export function compactResponderQuestion(
  question: string,
  maxChars: number,
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("responder prompt budget must be a positive integer");
  }
  if (question.length <= maxChars) {
    return question;
  }

  const baseQuestion = extractBenchmarkQuestionText(question);
  const conciseProtocol = question.includes("Agentic trajectory protocol:")
    ? buildConciseAgenticProtocol(question)
    : question.includes("Benchmark answer protocol:")
      ? buildConciseStrictProtocol(question)
      : "";
  const compacted = [baseQuestion, conciseProtocol]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  if (compacted.length <= maxChars) {
    return compacted;
  }

  if (baseQuestion.length >= maxChars - 40) {
    return headTailCompact(baseQuestion, maxChars);
  }

  const separator = "\n\n";
  const protocolBudget = maxChars - baseQuestion.length - separator.length;
  return `${baseQuestion}${separator}${headTailCompact(
    conciseProtocol,
    protocolBudget,
  )}`;
}

function extractBenchmarkQuestionText(question: string): string {
  const strictIndex = question.indexOf("\n\nBenchmark answer protocol:");
  if (strictIndex >= 0) {
    return question.slice(0, strictIndex).trim();
  }
  const agenticIndex = question.indexOf("\n\nAgentic trajectory protocol:");
  if (agenticIndex >= 0) {
    return question.slice(0, agenticIndex).trim();
  }
  return question.trim();
}

function buildConciseStrictProtocol(question: string): string {
  const instructions = [
    "Benchmark answer protocol:",
    "- Use only the supplied Remnic memory context.",
    "- Answer directly and briefly; do not add unsupported facts.",
    "- Say \"unknown\" only when relevant evidence is absent, contradictory, or lacks the requested value.",
    "- Preserve any requested output format.",
  ];
  appendFormatSpecificInstruction(question, instructions);
  return instructions.join("\n");
}

function buildConciseAgenticProtocol(question: string): string {
  const instructions = [
    buildConciseStrictProtocol(question),
    "",
    "Agentic trajectory protocol:",
    "- Treat Action/Observation/Step/Turn lines as causal evidence; Action N causes Observation N and the prior state for Step N is usually Observation N-1.",
    "- Honor exact cited numbers and boundaries; for ranges, before, until, counts, or lists, scan the requested span and include all requested actions or state changes.",
    "- For causal or strategic questions, infer the concrete mechanism from trajectory evidence and answer every clause.",
    "- In grid/rule games, distinguish objects from rule text; only claim passability, collection, disappearance, or win conditions when active rules or observations support it.",
    "- If context gives both First five and Complete inventory summaries, answer with First five first and then Complete as a separate labeled summary.",
    "- Keep the answer focused on the asked event.",
  ];
  return instructions.join("\n");
}

function appendFormatSpecificInstruction(
  question: string,
  instructions: string[],
): void {
  if (question.includes("- Return only the selected option letter")) {
    instructions.push("- Return only the selected option letter.");
  } else if (question.includes("- Return only the selected option number")) {
    instructions.push("- Return only the selected option number.");
  } else if (question.includes("- Preserve the requested structured output format")) {
    instructions.push("- Preserve the requested structured output format exactly.");
  } else if (question.includes("- Return the shortest complete answer")) {
    instructions.push("- Return the shortest complete answer that satisfies the question.");
  }
}

export function compactResponderContext(
  recalledText: string,
  question: string,
  maxChars: number,
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("responder context budget must be a positive integer");
  }

  const normalized = recalledText.trim();
  if (normalized.length <= maxChars) {
    return recalledText;
  }

  const stepRefs = extractReferencedTrajectoryNumbers(question);
  const trajectoryAnalysis = extractContextSection(
    normalized,
    TRAJECTORY_ANALYSIS_HEADING,
  );
  const focusedTranscript = stepRefs.size > 0
    ? buildTrajectoryFocusedContext(normalized, stepRefs)
    : "";
  const body = joinCompactedContextSections(
    trajectoryAnalysis,
    focusedTranscript,
  );
  const compactedBody = body.trim().length > 0
    ? body.trim()
    : headTailCompact(normalized, maxChars);
  const withPrefix = `${COMPACTED_CONTEXT_PREFIX}\n${compactedBody}`;
  if (withPrefix.length <= maxChars) {
    return withPrefix;
  }

  const bodyBudget = maxChars - COMPACTED_CONTEXT_PREFIX.length - 1;
  if (bodyBudget < 40) {
    return withPrefix.slice(0, maxChars);
  }

  return `${COMPACTED_CONTEXT_PREFIX}\n${headTailCompact(compactedBody, bodyBudget)}`;
}

function extractContextSection(
  text: string,
  heading: string,
): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return "";
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("## ") && trimmed !== heading) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

function joinCompactedContextSections(...sections: string[]): string {
  const rendered: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    rendered.push(trimmed);
  }
  return rendered.join(`\n\n${CONTEXT_COMPACTION_MARKER}\n\n`);
}

function extractReferencedTrajectoryNumbers(question: string): Set<number> {
  const refs = new Set<number>();
  const lower = question.toLowerCase();
  for (let index = 0; index < lower.length; index += 1) {
    for (const label of TRAJECTORY_LABELS) {
      const matchedLength = matchedTrajectoryLabelLength(lower, index, label);
      if (matchedLength === 0) {
        continue;
      }
      const parsed = parseNumberRangeAfterLabel(lower, index + matchedLength);
      if (!parsed) {
        continue;
      }
      addBoundedRange(refs, parsed.start, parsed.end);
      index = Math.max(index, parsed.nextIndex - 1);
      break;
    }
  }
  return refs;
}

function matchedTrajectoryLabelLength(
  text: string,
  index: number,
  label: string,
): number {
  if (!isWordBoundary(text[index - 1])) {
    return 0;
  }
  if (text.startsWith(label, index) && isWordBoundary(text[index + label.length])) {
    return label.length;
  }
  const plural = `${label}s`;
  if (text.startsWith(plural, index) && isWordBoundary(text[index + plural.length])) {
    return plural.length;
  }
  return 0;
}

function parseNumberRangeAfterLabel(
  text: string,
  index: number,
): { start: number; end: number; nextIndex: number } | undefined {
  let cursor = skipNumberLeadIn(text, index);
  const first = parseUnsignedIntegerAt(text, cursor);
  if (!first) {
    return undefined;
  }
  cursor = skipWhitespace(text, first.nextIndex);

  let end = first.value;
  if (isRangeDash(text[cursor])) {
    cursor = skipWhitespace(text, cursor + 1);
    const second = parseUnsignedIntegerAt(text, cursor);
    if (second) {
      end = second.value;
      cursor = second.nextIndex;
    }
  }

  return {
    start: first.value,
    end,
    nextIndex: cursor,
  };
}

function skipNumberLeadIn(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === " " || char === "\t" || char === ":" || char === "#" || char === "-") {
      cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor += 1;
  }
  return cursor;
}

function parseUnsignedIntegerAt(
  text: string,
  index: number,
): { value: number; nextIndex: number } | undefined {
  let cursor = index;
  let raw = "";
  while (cursor < text.length && isDigit(text[cursor])) {
    raw += text[cursor];
    cursor += 1;
  }
  if (raw.length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return undefined;
  }
  return { value, nextIndex: cursor };
}

function addBoundedRange(refs: Set<number>, start: number, end: number): void {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  for (let value = low; value <= high && value - low <= 50; value += 1) {
    refs.add(value);
  }
}

function buildTrajectoryFocusedContext(
  recalledText: string,
  stepRefs: Set<number>,
): string {
  const lines = recalledText.split("\n");
  const include = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (isContextHeading(lines[index])) {
      include.add(index);
      continue;
    }

    const trajectoryNumber = parseTrajectoryLineNumber(lines[index]);
    if (trajectoryNumber === undefined) {
      continue;
    }

    if (isNearReferencedStep(stepRefs, trajectoryNumber)) {
      include.add(index);
      if (index > 0) {
        include.add(index - 1);
      }
      if (index + 1 < lines.length) {
        include.add(index + 1);
      }
    }
  }

  if (include.size === 0) {
    return "";
  }

  const rendered: string[] = [];
  let lastIncluded = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!include.has(index)) {
      continue;
    }
    if (
      lastIncluded >= 0 &&
      index > lastIncluded + 1 &&
      rendered.at(-1) !== CONTEXT_COMPACTION_MARKER
    ) {
      rendered.push(CONTEXT_COMPACTION_MARKER);
    }
    rendered.push(lines[index]);
    lastIncluded = index;
  }
  return rendered.join("\n");
}

function isContextHeading(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("#") ||
    trimmed === "REMNIC_MEMORY_CONTEXT:" ||
    trimmed.startsWith("Memory context") ||
    trimmed.startsWith("Relevant");
}

function parseTrajectoryLineNumber(line: string): number | undefined {
  const trimmed = line.trimStart();
  const bracketStart = trimmed[0] === "[" ? 1 : 0;
  const bracketEnd = bracketStart === 1 ? trimmed.indexOf("]") : -1;
  const candidate = bracketEnd > bracketStart
    ? trimmed.slice(bracketStart, bracketEnd)
    : trimmed.slice(0, 48);
  const lower = candidate.toLowerCase();
  for (const label of TRAJECTORY_LABELS) {
    if (!lower.startsWith(label)) {
      continue;
    }
    const parsed = parseNumberRangeAfterLabel(lower, label.length);
    return parsed?.start;
  }
  return undefined;
}

function isNearReferencedStep(stepRefs: Set<number>, value: number): boolean {
  return stepRefs.has(value) || stepRefs.has(value - 1) || stepRefs.has(value + 1);
}

function headTailCompact(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= CONTEXT_COMPACTION_MARKER.length + 20) {
    return text.slice(0, maxChars);
  }
  const marker = `\n${CONTEXT_COMPACTION_MARKER}\n`;
  const remaining = maxChars - marker.length;
  const headChars = Math.ceil(remaining * 0.6);
  const tailChars = remaining - headChars;
  return `${text.slice(0, headChars).trimEnd()}${marker}${
    text.slice(text.length - tailChars).trimStart()
  }`;
}

function isWordBoundary(char: string | undefined): boolean {
  return char === undefined || !isAsciiAlnum(char);
}

function isAsciiAlnum(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122);
}

function isDigit(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isRangeDash(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  return char === "-" || code === 8211 || code === 8212;
}

function createJudgeFromProvider(provider: LlmProvider): BenchJudge {
  async function scoreBinaryPrompt(
    prompt: string,
    control?: { signal?: AbortSignal },
  ): Promise<BenchJudgeResult> {
    const completion = await provider.complete(prompt, {
      systemPrompt: "Answer the benchmark judging question with yes or no only.",
      temperature: 0,
      maxTokens: 10,
      signal: control?.signal,
    });

    return {
      score: parseYesNoJudgeScore(completion.text),
      tokens: completion.tokens,
      latencyMs: completion.latencyMs,
      model: completion.model,
    };
  }

  async function scoreWithMetrics(
    question: string,
    predicted: string,
    expected: string,
    control?: { signal?: AbortSignal },
  ): Promise<BenchJudgeResult> {
    const completion = await provider.complete(
      [
        `QUESTION: ${question}`,
        "",
        `EXPECTED_ANSWER: ${expected}`,
        "",
        `PREDICTED_ANSWER: ${predicted}`,
        "",
        "Score the predicted answer against the expected answer.",
      ].join("\n"),
      {
        systemPrompt: DEFAULT_JUDGE_SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 16,
        signal: control?.signal,
      },
    );

    return {
      score: parseScalarJudgeScore(completion.text),
      tokens: completion.tokens,
      latencyMs: completion.latencyMs,
      model: completion.model,
    };
  }

  return {
    async score(
      question: string,
      predicted: string,
      expected: string,
      control,
    ): Promise<number> {
      return (await scoreWithMetrics(question, predicted, expected, control)).score;
    },
    scoreWithMetrics,
    scoreBinaryPrompt,
  };
}

export function createProviderBackedJudge(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): BenchJudge {
  validateProviderConfig(config, "judge");
  return createJudgeFromProvider(providerInstance ?? createProvider(config));
}

function createAmaBenchRecommendedJudgeFromProvider(provider: LlmProvider): BenchJudge {
  async function scoreWithMetrics(
    question: string,
    predicted: string,
    expected: string,
    control?: { signal?: AbortSignal },
  ): Promise<BenchJudgeResult> {
    const completion = await provider.complete(
      [
        `QUESTION: ${question}`,
        "",
        `REFERENCE_ANSWER: ${expected}`,
        "",
        `PREDICTED_ANSWER: ${predicted}`,
        "",
        "Judge the predicted answer under the AMA-Bench binary accuracy protocol.",
      ].join("\n"),
      {
        systemPrompt: AMA_BENCH_RECOMMENDED_JUDGE_SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 128,
        signal: control?.signal,
      },
    );

    return {
      score: parseAmaBenchBinaryJudgeScore(completion.text),
      tokens: completion.tokens,
      latencyMs: completion.latencyMs,
      model: completion.model,
    };
  }

  return {
    async score(
      question: string,
      predicted: string,
      expected: string,
      control,
    ): Promise<number> {
      return (await scoreWithMetrics(question, predicted, expected, control)).score;
    },
    scoreWithMetrics,
  };
}

export function createProviderBackedAmaBenchRecommendedJudge(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): BenchJudge {
  validateProviderConfig(config, "AMA-Bench recommended judge");
  return createAmaBenchRecommendedJudgeFromProvider(
    providerInstance ?? createProvider(config),
  );
}

export function createStructuredJudgeFromProvider(
  provider: LlmProvider,
): StructuredJudge {
  return {
    async evaluate(request) {
      const completion = await provider.complete(request.user, {
        systemPrompt: request.system,
        temperature: 0,
        maxTokens: 512,
      });
      return completion.text;
    },
  };
}

export function createProviderBackedStructuredJudge(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): StructuredJudge {
  validateProviderConfig(config, "judge");
  return createStructuredJudgeFromProvider(providerInstance ?? createProvider(config));
}

export function createGatewayResponder(
  options: GatewayResponderOptions,
): BenchResponder {
  if (!options.gatewayConfig) {
    throw new Error("gateway responder requires gatewayConfig");
  }

  const runtimeContext: FallbackLlmRuntimeContext = {
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  };
  const llm = options.llmFactory?.(options.gatewayConfig, runtimeContext)
    ?? new FallbackLlmClient(options.gatewayConfig, runtimeContext);

  return {
    async respond(
      question: string,
      recalledText: string,
      control,
    ): Promise<BenchResponse> {
      const startedAt = performance.now();
      const response = await llm.chatCompletion(
        [
          { role: "system", content: DEFAULT_RESPONDER_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `QUESTION: ${question}`,
              "",
              "REMNIC_MEMORY_CONTEXT:",
              recalledText.trim().length > 0
                ? recalledText
                : "(no memory context available)",
              "",
              "Answer the question using only the supplied memory context.",
            ].join("\n"),
          },
        ],
        {
          temperature: 0,
          agentId: options.agentId,
          signal: control?.signal,
        },
      );

      if (!response?.content) {
        throw new Error("gateway responder returned no content");
      }

      return {
        text: response.content,
        tokens: {
          input: response.usage?.inputTokens ?? 0,
          output: response.usage?.outputTokens ?? 0,
        },
        latencyMs: Math.round(performance.now() - startedAt),
        model: response.modelUsed,
      };
    },
  };
}

function validateProviderConfig(
  config: ProviderFactoryConfig,
  kind: "responder" | "judge" | "AMA-Bench recommended judge",
): void {
  if (typeof config.model !== "string" || config.model.trim().length === 0) {
    throw new Error(`provider-backed ${kind} requires a non-empty model`);
  }
}

function parseScalarJudgeScore(raw: string): number {
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const score = (parsed as { score?: unknown }).score;
      if (typeof score === "number" && isPlausibleScalarScore(score)) {
        return clampNormalizedScore(score);
      }
    }
  } catch {
    // Fall through to text parsing.
  }

  const scoreCueMatches = [
    ...trimmed.matchAll(
      /\b(?:final\s+score|score|rating)\b\s*[:=]\s*(-?\d+(?:\.\d+)?)(?:\s*(%|\/\s*(-?\d+(?:\.\d+)?)))?/gi,
    ),
  ];
  for (const match of scoreCueMatches.reverse()) {
    const numerator = Number.parseFloat(match[1]);
    const suffix = match[2];
    const denominatorRaw = match[3];
    if (suffix === "%") {
      if (Number.isFinite(numerator)) {
        return clampNormalizedScore(numerator / 100);
      }
      continue;
    }
    if (denominatorRaw !== undefined) {
      const denominator = Number.parseFloat(denominatorRaw);
      if (isPlausibleScoreFraction(numerator, denominator)) {
        return clampNormalizedScore(numerator / denominator);
      }
      continue;
    }
    if (isPlausibleScalarScore(numerator)) {
      return clampNormalizedScore(numerator);
    }
  }

  const fractionMatches = [
    ...trimmed.matchAll(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g),
  ];
  for (const match of fractionMatches.reverse()) {
    const numerator = Number.parseFloat(match[1]);
    const denominator = Number.parseFloat(match[2]);
    if (isPlausibleSlashScoreFraction(trimmed, match, numerator, denominator)) {
      return clampNormalizedScore(numerator / denominator);
    }
  }

  const percentMatches = [...trimmed.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)];
  for (const match of percentMatches.reverse()) {
    const percent = Number.parseFloat(match[1]);
    if (Number.isFinite(percent)) {
      return clampNormalizedScore(percent / 100);
    }
  }

  const outOfMatches = [
    ...trimmed.matchAll(/(-?\d+(?:\.\d+)?)\s+out\s+of\s+(-?\d+(?:\.\d+)?)/gi),
  ];
  for (const match of outOfMatches.reverse()) {
    const numerator = Number.parseFloat(match[1]);
    const denominator = Number.parseFloat(match[2]);
    if (isPlausibleScoreFraction(numerator, denominator)) {
      return clampNormalizedScore(numerator / denominator);
    }
  }

  const scalarMatches = [...trimmed.matchAll(/-?\d+(?:\.\d+)?/g)];
  for (const match of scalarMatches.reverse()) {
    const value = Number.parseFloat(match[0]);
    if (isPlausibleScalarScore(value)) {
      return clampNormalizedScore(value);
    }
  }

  return -1;
}

function parseYesNoJudgeScore(raw: string): number {
  const normalized = raw.trim().toLowerCase();
  const firstLabel = normalized.match(/\b(yes|no)\b/)?.[1];
  if (firstLabel === "yes") {
    return 1;
  }
  if (firstLabel === "no") {
    return 0;
  }
  const scalar = parseScalarJudgeScore(raw);
  if (scalar < 0) {
    return -1;
  }
  return scalar >= 0.5 ? 1 : 0;
}

function parseAmaBenchBinaryJudgeScore(raw: string): number {
  const trimmed = raw.trim();
  const jsonCandidates = extractJsonObjects(trimmed);
  for (const jsonCandidate of jsonCandidates.reverse()) {
    try {
      const parsed = JSON.parse(jsonCandidate) as { score?: unknown };
      if (parsed.score === 0 || parsed.score === 1) {
        return parsed.score;
      }
      if (parsed.score === "0" || parsed.score === "1") {
        return Number(parsed.score);
      }
    } catch {
      // Keep scanning for a later score object.
    }
  }

  const scalar = parseScalarJudgeScore(trimmed);
  if (scalar === 0 || scalar === 1) {
    return scalar;
  }
  if (scalar > 0.5) {
    return 1;
  }
  if (scalar >= 0) {
    return 0;
  }
  if (/^\s*no[.!]?\s*$/i.test(trimmed)) {
    return 0;
  }
  if (
    /\b(?:not|never|isn'?t|wasn'?t|doesn'?t|didn'?t|cannot|can'?t)\b(?:\s+\w+){0,3}\s+(?:incorrect|false|fail(?:ed|s|ing)?)\b/i.test(
      trimmed,
    )
  ) {
    return 1;
  }
  if (/\b(incorrect|false|fail(?:ed|s)?)\b/i.test(trimmed)) {
    return 0;
  }
  if (
    /\b(?:not|never|isn'?t|wasn'?t|doesn'?t|didn'?t|cannot|can'?t)\b(?:\s+\w+){0,3}\s+(?:correct|true|pass(?:ed|es|ing)?|match(?:es|ed|ing)?|same)\b/i.test(
      trimmed,
    )
  ) {
    return 0;
  }
  if (/\b(correct|yes|true|pass)\b/i.test(trimmed)) {
    return 1;
  }
  return -1;
}

function extractJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function isPlausibleScoreFraction(
  numerator: number,
  denominator: number,
): boolean {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return false;
  }

  if (denominator <= 0 || numerator < 0 || numerator > denominator) {
    return false;
  }

  return denominator <= 10 || denominator === 100 || denominator % 5 === 0;
}

function isPlausibleSlashScoreFraction(
  raw: string,
  match: RegExpMatchArray,
  numerator: number,
  denominator: number,
): boolean {
  if (!isPlausibleScoreFraction(numerator, denominator)) {
    return false;
  }

  const start = match.index ?? -1;
  if (start < 0) {
    return false;
  }

  if (denominator <= 10 || denominator === 100) {
    const end = start + match[0].length;
    const afterContext = raw.slice(end);
    if (/^\s*\/\s*\d/.test(afterContext)) {
      return false;
    }
    return isStandaloneSlashScore(raw, start, end) || hasScoreCueBefore(raw, start);
  }

  const end = start + match[0].length;
  if (isStandaloneSlashScore(raw, start, end)) {
    return true;
  }

  return hasScoreCueBefore(raw, start);
}

function isStandaloneSlashScore(
  raw: string,
  start: number,
  end: number,
): boolean {
  return raw.slice(0, start).trim().length === 0 &&
    /^[\s.!?]*$/.test(raw.slice(end));
}

function hasScoreCueBefore(raw: string, start: number): boolean {
  const beforeContext = raw
    .slice(Math.max(0, start - 20), start)
    .toLowerCase();

  return SCORE_CUE_REGEX.test(beforeContext);
}

function isPlausibleScalarScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function clampNormalizedScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
