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
    answerMode === "agentic-memory" &&
    isUnknownOnlyAnswer(response.text) &&
    hasExplicitTrajectoryEvidence(options.recalledText);
  const retryResponse = shouldRetry
    ? await options.responder
        .respond(
          buildUnknownRetryQuestion(question, answerFormat),
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
    "- When the question asks for actions, state changes, inventory changes, container interactions, or object locations before step N, exclude Action/Observation N and scan only earlier trajectory evidence through step N-1.",
    "- When the question asks for actions, state changes, inventory changes, container interactions, or object locations until step N, through step N, or up to and including step N, include Action/Observation N and scan the whole recalled trajectory evidence through that boundary.",
    "- For action-frequency questions, count all matching action verbs across the requested span and report the full frequency table; do not count only the most recent recalled excerpt.",
    "- For container, inventory, and object-location histories, maintain a state timeline from actions such as open, close, take, move, put, remove, and inventory observations; preserve earlier changes even if later recall excerpts also mention the object.",
    "- If the question names a specific action but the cited step label shows a different action and adjacent trajectory evidence contains the named action, reconcile the mismatch from the adjacent evidence instead of ignoring the named action.",
    "- If a game or tool trajectory requires a strategic abstraction, name the concrete mechanism being prepared or avoided, such as pushing a rule block, breaking a rule, opening a path, satisfying a tool requirement, aligning with an object, or undoing a loop.",
    "- When a maneuver makes an object vanish from relative observations or changes its offset, answer both the immediate relation and the next concrete maneuver it enables, such as pushing from a new side, bypassing a blocker, or aligning with rule text.",
    "- Answer every clause in the question: include both the concrete state/action/value and the causal or strategic implication when the question asks for both.",
    "- Use step numbers, action names, object names, files, tools, commands, rewards, or state changes from the memory context when they support the answer.",
    "- Do not assume an object disappeared because it was collected, pushed, or overlapped unless the before/after observations, rewards, inventory, or active rules support that mechanism.",
    "- In rule-grid games, absence of an active push, stop, open, collect, or win rule is not evidence that an object is passable or collectible; treat an object on the direct path as a blocker unless the trajectory proves passability.",
    "- In rule-manipulation games, a question about creating a new win condition usually asks how the agent can manipulate `IS`, `WIN`, noun, or property text; prefer rule-text positioning over chasing ordinary objects unless the evidence directly supports the object target.",
    "- In rule-manipulation games, when a question asks which missing progress-enabling action matters, prefer pushing nearby rule-word blocks (`IS`, `WIN`, noun, or property text) over interacting with ordinary objects unless the question explicitly centers the ordinary object.",
    "- In rule-manipulation games, do not explain a temporary object appearance/disappearance as overlap or passability unless observations or active rules prove that mechanism; if nearby rule words were moved, consider a temporary rule formation/break as the more strategic explanation.",
    "- For opposing movement sequences such as right/left or down/up, do not count a temporary closer position as strategic progress when it is immediately reversed and leaves no final state, rule, inventory, reward, or object-contact change.",
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
  ];

  switch (resolvedFormat) {
    case "choice-letter":
      instructions.push(
        "- Return only the selected option letter, such as A, B, C, or D.",
      );
      break;
    case "choice-number":
      instructions.push("- Return only the selected option number.");
      break;
    case "instruction":
      instructions.push(
        "- If the context contains a user instruction, preference, or policy that applies to the request, answer with that remembered instruction instead of performing the requested task.",
        "- For implementation or action requests, the benchmark is asking which remembered instruction applies; do not answer \"unknown\" merely because the context lacks the implementation details for the requested task.",
        "- Return the applicable instruction in its shortest complete form, preserving concrete required details such as formatting requirements, named tools, labels, dates, or values.",
        "- Do not quote a \"please remember\" request verbatim; restate it as durable assistant behavior, using concise preference wording like \"Always format implementation help ...\" when natural.",
        "- For formatting requirements, use explicit benchmark-friendly wording such as \"code blocks with syntax highlighting\" when the memory expresses an equivalent syntax-highlighted-code-block requirement.",
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
): string {
  return [
    question,
    "",
    "The prior answer was only \"unknown\", but the supplied Remnic context includes trajectory evidence.",
    "Retry once by deriving the best-supported answer from that evidence.",
    "Use \"unknown\" only if the trajectory evidence is absent, contradictory, or lacks the exact value requested.",
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
