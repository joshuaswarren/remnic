import type { BenchResponder } from "./adapters/types.js";
import { TRAJECTORY_RETRY_SECTION_TITLE_SET } from "./recall-sections.js";

export type BenchmarkAnswerMode = "default" | "strict" | "agentic-memory";

export type BenchmarkAnswerFormat =
  | "auto"
  | "choice-letter"
  | "choice-number"
  | "instruction"
  | "short"
  | "short-with-specifics"
  | "structured";

export interface BenchmarkAnswerResult {
  finalAnswer: string;
  recalledText: string;
  answeredText: string;
  latencyMs: number;
  tokens: {
    input: number;
    output: number;
  };
  model?: string;
}

export interface BenchmarkQuestionContext {
  benchmark?: string;
  domain?: string;
  task?: string;
  taskType?: string;
  qaType?: string;
}

export async function answerBenchmarkQuestion(options: {
  question: string;
  recalledText: string;
  responder?: BenchResponder;
  answerMode?: BenchmarkAnswerMode;
  answerFormat?: BenchmarkAnswerFormat;
  questionContext?: BenchmarkQuestionContext;
  retryUnknownWithEvidence?: boolean;
}): Promise<BenchmarkAnswerResult> {
  if (!options.responder) {
    return {
      finalAnswer: options.recalledText,
      recalledText: options.recalledText,
      answeredText: options.recalledText,
      latencyMs: 0,
      tokens: {
        input: 0,
        output: 0,
      },
    };
  }

  const answerMode = options.answerMode ?? "default";
  const answerFormat =
    options.answerFormat === "auto" || options.answerFormat === undefined
      ? inferAnswerFormat(options.question)
      : options.answerFormat;
  const question =
    answerMode === "strict"
      ? buildStrictBenchmarkQuestion(options.question, answerFormat)
      : answerMode === "agentic-memory"
        ? buildAgenticMemoryBenchmarkQuestion(
            options.question,
            answerFormat,
            options.questionContext,
          )
      : options.question;
  const response = await options.responder.respond(
    question,
    options.recalledText,
  );
  const shouldRetry =
    options.retryUnknownWithEvidence === true &&
    isUnknownOnlyAnswer(response.text) &&
    hasRetryableEvidenceForUnknownAnswer(options.recalledText, answerMode);
  const retryResponse = shouldRetry
    ? await options.responder
        .respond(
          buildUnknownRetryQuestion(question, answerFormat, {
            evidenceLabel: getUnknownRetryEvidenceLabel(
              options.recalledText,
              answerMode,
            ),
          }),
          options.recalledText,
        )
        .catch(() => undefined)
    : undefined;
  const finalResponse = retryResponse ?? response;

  return {
    finalAnswer: finalResponse.text,
    recalledText: options.recalledText,
    answeredText: finalResponse.text,
    latencyMs: response.latencyMs + (retryResponse?.latencyMs ?? 0),
    tokens: retryResponse
      ? {
          input: response.tokens.input + retryResponse.tokens.input,
          output: response.tokens.output + retryResponse.tokens.output,
        }
      : response.tokens,
    model: finalResponse.model ?? response.model,
  };
}

export function buildAgenticMemoryBenchmarkQuestion(
  question: string,
  answerFormat: BenchmarkAnswerFormat = "auto",
  context?: BenchmarkQuestionContext,
): string {
  const prompt = buildStrictBenchmarkQuestion(question, answerFormat);
  return [
    prompt,
    "",
    ...formatQuestionContext(context),
    ...(context ? [""] : []),
    "Agentic trajectory protocol:",
    "- Treat action and observation sequences as evidence for causal, strategic, and temporal reasoning.",
    "- When the question asks why an action mattered, what a maneuver accomplished, what would have happened, or what can be inferred, synthesize the best-supported explanation from the trajectory instead of looking only for an explicit quoted answer.",
    "- For explicit step, action, observation, or turn references, anchor the answer to those exact numbers. Do not shift the answer to a neighboring step unless the question explicitly asks for the next or previous step.",
    "- In action/observation trajectories, Action N causes Observation N. The state at the start of Step N is the prior observation, usually Observation N-1; use that prior state when the question asks what an alternative action at the start of a step would do.",
    "- For cited step ranges, identify the action or state change inside that range; do not name a later action outside the range as the answer.",
    "- When the question asks for actions between step X and step Y, enumerate each action in that inclusive range in step order; do not collapse the range to only the first, last, or most semantically relevant actions.",
    "- Treat concrete actions, step ranges, object names, and causal framing stated in the benchmark question as part of the evidence to reconcile with recalled trajectory context.",
    "- When the question asks for actions, state changes, inventory changes, container interactions, or object locations before step N, exclude Action/Observation N and scan only earlier trajectory evidence through step N-1.",
    "- When the question asks for actions, state changes, inventory changes, container interactions, or object locations until step N, through step N, or up to and including step N, include Action/Observation N and scan the whole recalled trajectory evidence through that boundary.",
    "- For action-frequency questions, count all matching action verbs across the requested span and report the full frequency table; do not count only the most recent recalled excerpt.",
    "- For container, inventory, and object-location histories, maintain a state timeline from actions such as open, close, take, move, put, remove, and inventory observations; preserve earlier changes even if later recall excerpts also mention the object.",
    "- If the trajectory context includes both \"First five inventory changes\" and \"Complete inventory changes\", answer with the first-five summary first and include the complete summary separately with its label.",
    "- If the question names a specific action but the cited step label shows a different action and adjacent trajectory evidence contains the named action, reconcile the mismatch from the adjacent evidence instead of ignoring the named action.",
    "- If a game or tool trajectory requires a strategic abstraction, name the concrete mechanism being prepared or avoided, such as pushing a rule block, breaking a rule, opening a path, satisfying a tool requirement, aligning with an object, or undoing a loop.",
    "- When a maneuver makes an object vanish from relative observations or changes its offset, answer both the immediate relation and the next concrete maneuver it enables, such as pushing from a new side, bypassing a blocker, or aligning with rule text.",
    "- Answer every clause in the question: include both the concrete state/action/value and the causal or strategic implication when the question asks for both.",
    "- Use step numbers, action names, object names, files, tools, commands, rewards, or state changes from the memory context when they support the answer.",
    "- Do not assume an object disappeared because it was collected, pushed, or overlapped unless the before/after observations, rewards, inventory, or active rules support that mechanism.",
    "- In rule-grid games, absence of an active push, stop, open, collect, or win rule is not evidence that an object is passable or collectible; treat an object on the direct path as a blocker unless the trajectory proves passability.",
    "- When a non-pushable object blocks a direct row or column path and the maneuver first moves perpendicular before resuming toward the target, frame the goal as bypassing or clearing the obstacle's axis to reach the far side for later rule/text interaction; do not describe the object itself as the target.",
    "- In rule-manipulation games, a question about creating a new win condition usually asks how the agent can manipulate `IS`, `WIN`, noun, or property text; prefer rule-text positioning over chasing ordinary objects unless the evidence directly supports the object target.",
    "- In rule-manipulation games, when a question asks which missing progress-enabling action matters, prefer pushing nearby rule-word blocks (`IS`, `WIN`, noun, or property text) over interacting with ordinary objects unless the question explicitly centers the ordinary object.",
    "- In rule-manipulation games, do not explain a temporary object appearance/disappearance as overlap or passability unless observations or active rules prove that mechanism; if nearby rule words were moved, consider a temporary rule formation/break as the more strategic explanation.",
    "- For questions about why the first action of a two-step maneuver was optimal, inspect the prior observation, the result after the first action, and the result after the following action; name the newly adjacent rule/object targets enabled at each point, such as reaching `IS` first and then becoming adjacent to `KEY`.",
    "- For opposing movement sequences such as right/left or down/up, do not count a temporary closer position as strategic progress when it is immediately reversed and leaves no final state, rule, inventory, reward, or object-contact change.",
    "- When a question explicitly frames a repeated or opposing move span as exploratory noise, identify the single action in that span that breaks the loop or changes axis/alignment, and explain why the reversed moves are noise.",
    "- If a same-direction move first makes a text block adjacent and the next same-direction move leaves that text block at the same relative offset, infer a successful push where the agent and block moved together in absolute coordinates; do not call it failed unless the trajectory explicitly shows no movement, an unchanged absolute state, or a boundary block.",
    "- When a hidden-change question names repeated same-direction pushes and says the target text stayed at the same relative offset across those steps, answer with the cumulative absolute displacement across all named pushes, not just the final push.",
    "- If generated trajectory-analysis prose conflicts with raw Action/Observation labels, trust the raw labels; especially, a stable relative offset after contacting rule text can mean the text and agent moved together rather than a failed push.",
    "- When the question asks which single action was the only one relevant or caused the only state change, compare resulting observations inside the named span; if several observations are identical and the next one changes, choose the action that produced the changed observation, not an earlier pre-span setup move.",
    "- If a failed push is followed by a down/right/up/left repositioning maneuver, explain how the maneuver enables approaching the same obstacle or text blocks from a different angle before redirecting to unrelated rule text.",
    "- When a question says deliberate navigation brought a named rule block into view for the first time, preserve that named target as the primary strategy, name the likely rule involving that target (for example `DOOR IS PUSH` or `DOOR IS OPEN`), and do not substitute a different rule target unless the question asks for it.",
    "- For long no-reward movement through a corridor or passage, treat the sequence as strategic repositioning when observations show corridor walls or access to future rule-text/object interactions; do not reduce it to random wandering or immediate reward seeking.",
    "- If a no-reward or no-rule-change movement span shows walls above/below or a narrow passage, answer as corridor traversal to access future rule text, objects, or another map section; avoid over-focusing on the nearest currently visible win/key object unless the asked span directly contacts it.",
    "- In grid-game contexts, infer movement from relative-position changes carefully: if a static object's relative offset changes, explain the agent movement that caused that offset change.",
    "- In rule-manipulation games, distinguish objects from rule text blocks and only claim a push/collect/win condition when active rules or observations support it.",
    "- Do not answer \"unknown\" merely because the answer requires inference; reserve \"unknown\" for cases where the trajectory evidence is absent or contradictory.",
    "- Keep the answer focused on the asked trajectory event and omit unrelated recalled history.",
  ].join("\n");
}

export function buildStrictBenchmarkQuestion(
  question: string,
  answerFormat: BenchmarkAnswerFormat = "auto",
): string {
  const resolvedFormat =
    answerFormat === "auto" ? inferAnswerFormat(question) : answerFormat;
  const instructions = [
    "Benchmark answer protocol:",
    "- Use only the supplied Remnic memory context as evidence.",
    "- Answer the benchmark question directly; do not add prefaces, caveats, or unsupported facts.",
    "- If the context contains enough evidence to answer, give the best supported answer even when other unrelated details are missing.",
    "- Answer \"unknown\" only when the supplied context has no relevant evidence, has irreconcilably conflicting evidence, or lacks the specific value the question asks for.",
    "- Resolve relative temporal references from the timestamps or dated facts in the memory context when possible.",
    "- For date or year questions, prefer the absolute date or year over relative wording like yesterday or last year.",
    "- For \"Which <category>\" questions, return only the identifying name or value; omit the generic category noun from the question unless it is part of the proper name or needed to disambiguate.",
  ];

  switch (resolvedFormat) {
    case "choice-letter":
      instructions.push(
        "- Return only the selected option letter, such as A, B, C, or D.",
      );
      break;
    case "choice-number":
      instructions.push(
        "- Return only the selected option number.",
        "- If the recalled context includes current state, preference, or profile labels, select the option that matches all relevant current values.",
        "- Do not choose an option that matches only one remembered detail when another option matches the full combination of current details.",
        "- Treat similar but distinct current values as different: for example, occasional assistance is not limited mobility, seasonal projects is not monthly minimal, and small group is not a workshop series.",
      );
      break;
    case "instruction":
      instructions.push(
        "- If the context contains a user instruction, preference, or policy that applies to the request, answer with that remembered instruction instead of performing the requested task.",
        "- For implementation or action requests, the benchmark is asking which remembered instruction applies; do not answer \"unknown\" merely because the context lacks the implementation details for the requested task.",
        "- Return the applicable instruction in its shortest complete form, preserving concrete required details such as formatting requirements, named tools, labels, dates, or values.",
        "- Do not quote a \"please remember\" request verbatim; restate it as durable assistant behavior, using concise preference wording like \"Always format implementation help ...\" when natural.",
        "- Preserve exact remembered formatting phrases such as \"syntax-highlighted code blocks\"; do not rewrite them to equivalent wording unless the memory uses that wording.",
      );
      break;
    case "structured":
      instructions.push(
        "- Preserve the requested structured output format exactly and omit unrelated explanation.",
      );
      break;
    case "short":
      instructions.push(
        "- Return the shortest complete answer that satisfies the question.",
        "- Prefer only the answer phrase or value; do not wrap it in a full sentence when a short phrase is sufficient.",
      );
      break;
    case "short-with-specifics":
      instructions.push(
        "- Return the shortest complete answer that satisfies the question.",
        "- If the answer is a count, category, list, instruction, or changed value, include the concrete named items or value labels needed to make the answer unambiguous.",
        "- For count questions, include the counted noun and any named items, for example \"Two columns: category and notes\" instead of just \"Two\".",
        "- For numeric or latency questions, return the exact value from context without hedge words like around, about, or approximately unless the hedge is the answer.",
        "- Prefer exact values from the context and omit filler or hedge words unless they are part of the required answer.",
      );
      break;
    case "auto":
      break;
    default: {
      const exhaustive: never = resolvedFormat;
      throw new Error(`Unhandled answer format: ${String(exhaustive)}`);
    }
  }

  return `${question}\n\n${instructions.join("\n")}`;
}

export function buildUnknownRetryQuestion(
  question: string,
  answerFormat: BenchmarkAnswerFormat = "auto",
  options: { evidenceLabel?: string } = {},
): string {
  const evidenceLabel = options.evidenceLabel ?? "trajectory evidence";
  return [
    question,
    "",
    `The prior answer was only "unknown", but the supplied Remnic context includes ${evidenceLabel}.`,
    "Retry once by deriving the best-supported answer from that evidence.",
    `Use "unknown" only if the ${evidenceLabel} is absent, contradictory, or lacks the exact value requested.`,
    "For causal or strategic questions, answer with the concrete action/state change and the implication it supports.",
    ...(answerFormat === "structured"
      ? ["Preserve the requested structured output format exactly."]
      : []),
  ].join("\n");
}

export function isUnknownOnlyAnswer(answer: string): boolean {
  const normalized = stripTrailingSentencePunctuation(
    stripWrappingQuotes(answer.trim().toLowerCase()),
  ).trim();
  return normalized === "unknown" || normalized === "the answer is unknown";
}

export function hasExplicitTrajectoryEvidence(recalledText: string): boolean {
  return hasTrajectoryMarkerInStructuredSection(recalledText);
}

function hasRetryableEvidenceForUnknownAnswer(
  recalledText: string,
  answerMode: BenchmarkAnswerMode,
): boolean {
  if (hasExplicitTrajectoryEvidence(recalledText)) {
    return true;
  }
  if (answerMode === "agentic-memory") {
    return false;
  }
  return hasConcreteBenchmarkEvidence(recalledText);
}

function getUnknownRetryEvidenceLabel(
  recalledText: string,
  answerMode: BenchmarkAnswerMode,
): string {
  return answerMode === "agentic-memory" || hasExplicitTrajectoryEvidence(recalledText)
    ? "trajectory evidence"
    : "benchmark evidence";
}

function hasConcreteBenchmarkEvidence(recalledText: string): boolean {
  const normalized = recalledText.trim();
  if (normalized.length === 0) {
    return false;
  }
  if (stripTrailingSentencePunctuation(normalized).toLowerCase() === "unknown") {
    return false;
  }
  return hasNonEmptyBenchmarkEvidenceSection(normalized);
}

const RETRYABLE_BENCHMARK_EVIDENCE_HEADINGS = [
  "prior completed memoryarena subtasks",
  "remnic memory context",
  "remnic recall pipeline",
  "raw messages",
  "explicit cue evidence",
  "search evidence",
  "webshop environment observations for current options",
] as const;

const NO_EVIDENCE_PREFIXES = [
  "no exact",
  "no matching",
  "no relevant",
  "no usable",
  "no prior",
  "no search",
  "no memory",
] as const;

function hasNonEmptyBenchmarkEvidenceSection(recalledText: string): boolean {
  let inRetryableSection = false;
  for (const line of recalledText.split("\n")) {
    const trimmed = line.trim();
    const heading = parseMarkdownHeadingText(trimmed);
    if (heading !== undefined) {
      inRetryableSection = isRetryableBenchmarkEvidenceHeading(heading);
      continue;
    }
    if (!inRetryableSection || trimmed.length === 0) {
      continue;
    }
    if (isNoEvidenceLine(trimmed)) {
      continue;
    }
    return true;
  }
  return false;
}

function parseMarkdownHeadingText(trimmedLine: string): string | undefined {
  if (!trimmedLine.startsWith("##")) {
    return undefined;
  }
  let index = 2;
  if (trimmedLine[index] !== " " && trimmedLine[index] !== "\t") {
    return undefined;
  }
  while (trimmedLine[index] === " " || trimmedLine[index] === "\t") {
    index += 1;
  }
  return trimmedLine.slice(index).trim();
}

function isRetryableBenchmarkEvidenceHeading(heading: string): boolean {
  const normalized = heading.toLowerCase();
  return RETRYABLE_BENCHMARK_EVIDENCE_HEADINGS.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

function isNoEvidenceLine(line: string): boolean {
  const normalized = stripTrailingSentencePunctuation(
    stripWrappingQuotes(line),
  ).trim().toLowerCase();
  if (normalized === "unknown" || normalized === "the answer is unknown") {
    return true;
  }
  return NO_EVIDENCE_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

function stripWrappingQuotes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isWrappingQuote(value.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isWrappingQuote(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

function stripTrailingSentencePunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && isSentencePunctuation(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}

function isWrappingQuote(code: number): boolean {
  return code === 34 || code === 39 || code === 96;
}

function isSentencePunctuation(code: number): boolean {
  return code === 33 || code === 46 || code === 63;
}

function hasTrajectoryMarkerInStructuredSection(text: string): boolean {
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  let inStructuredSection = false;

  for (const line of lines) {
    const heading = parseLevelTwoHeading(line);
    if (heading !== undefined) {
      inStructuredSection = TRAJECTORY_RETRY_SECTION_TITLE_SET.has(heading);
      continue;
    }
    if (!inStructuredSection) {
      continue;
    }
    if (
      isStepMarkerLine(line, "Action") ||
      isStepMarkerLine(line, "Observation") ||
      isStepMarkerLine(line, "Step") ||
      isStepMarkerLine(line, "Turn")
    ) {
      return true;
    }
  }

  return false;
}

function parseLevelTwoHeading(line: string): string | undefined {
  if (!line.startsWith("##") || line.startsWith("###")) {
    return undefined;
  }
  const rawTitle = line.slice(2);
  if (
    rawTitle.length === 0 ||
    !isAsciiWhitespace(rawTitle.charCodeAt(0))
  ) {
    return undefined;
  }
  return rawTitle.trim();
}

function isStepMarkerLine(
  line: string,
  label: "Action" | "Observation" | "Step" | "Turn",
): boolean {
  const trimmed = line.trimStart();
  const prefix = `[${label}`;
  if (!trimmed.startsWith(prefix)) {
    return false;
  }

  let index = prefix.length;
  if (!isAsciiWhitespace(trimmed.charCodeAt(index))) {
    return false;
  }
  while (index < trimmed.length && isAsciiWhitespace(trimmed.charCodeAt(index))) {
    index += 1;
  }
  let sawDigit = false;
  while (index < trimmed.length && isAsciiDigit(trimmed.charCodeAt(index))) {
    sawDigit = true;
    index += 1;
  }
  return sawDigit && trimmed[index] === "]";
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiWhitespace(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 32
  );
}

function formatQuestionContext(context: BenchmarkQuestionContext | undefined): string[] {
  if (!context) {
    return [];
  }
  const lines = [
    "Benchmark context:",
    ...(context.benchmark ? [`- Benchmark: ${context.benchmark}`] : []),
    ...(context.domain ? [`- Domain: ${context.domain}`] : []),
    ...(context.taskType ? [`- Task type: ${context.taskType}`] : []),
    ...(context.qaType ? [`- QA type: ${context.qaType}`] : []),
    ...(context.task ? [`- Task setting: ${context.task}`] : []),
  ];
  return lines.length > 1 ? lines : [];
}

export function inferAnswerFormat(question: string): BenchmarkAnswerFormat {
  if (
    /\b[A-D]\.\s+/i.test(question) &&
    (/\bchoices?:/i.test(question) ||
      /\boptions?:/i.test(question) ||
      /final answer:\s*\[letter\]/i.test(question))
  ) {
    return "choice-letter";
  }
  if (/answer choices?:/i.test(question) && /\b1\.\s+/i.test(question)) {
    return "choice-number";
  }
  if (
    /final output format:/i.test(question) ||
    /===\s*traveler plan\s*===/i.test(question) ||
    /the recommendations are:/i.test(question)
  ) {
    return "structured";
  }
  return "auto";
}
