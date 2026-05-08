import type { MemoryIntent, RecallPlanMode } from "./types.js";

const GOAL_PATTERNS: Array<{ re: RegExp; goal: string }> = [
  { re: /\b(debug(?:s|ged|ging)?|fix(?:es|ed|ing)?|error(?:s)?|incident(?:s)?|outage(?:s)?|failure(?:s)?)\b/i, goal: "stabilize" },
  { re: /\b(deploy(?:s|ed|ing)?|release(?:s|d|ing)?|ship(?:s|ped|ping)?|publish(?:es|ed|ing)?)\b/i, goal: "release" },
  { re: /\b(plan(?:s|ned|ning)?|roadmap(?:s)?|strateg(?:y|ies)|design(?:s|ed|ing)?)\b/i, goal: "plan" },
  { re: /\b(review(?:s|ed|ing)?|audit(?:s|ed|ing)?|security|hardening)\b/i, goal: "review" },
  { re: /\b(sales|deal|customer|client|prospect)\b/i, goal: "close_deal" },
];

const ACTION_PATTERNS: Array<{ re: RegExp; action: string }> = [
  { re: /\b(review(?:s|ed|ing)?|audit(?:s|ed|ing)?|inspect(?:s|ed|ing)?|check(?:s|ed|ing)?)\b/i, action: "review" },
  { re: /\b(plan(?:s|ned|ning)?|design(?:s|ed|ing)?|brainstorm(?:s|ed|ing)?|spec(?:s)?)\b/i, action: "plan" },
  { re: /\b(implement(?:s|ed|ing)?|build(?:s|ing)?|built|code(?:s|d|ing)?|patch(?:es|ed|ing)?|fix(?:es|ed|ing)?)\b/i, action: "execute" },
  { re: /\b(summariz(?:e|es|ed|ing)|recap(?:s|ped|ping)?|what happened|timeline)\b/i, action: "summarize" },
  { re: /\b(decid(?:e|es|ed|ing)|decision(?:s)?|cho(?:ose|oses|osing)|chose|chosen)\b/i, action: "decide" },
];

const ENTITY_PATTERNS: Array<{ re: RegExp; entityType: string }> = [
  { re: /\b(pr|pull request|branch|repo|github|ci|workflow)\b/i, entityType: "repo" },
  { re: /\b(discord|slack|channel|gateway|agent)\b/i, entityType: "ops" },
  { re: /\b(customer|client|deal|lead|account)\b/i, entityType: "client" },
  { re: /\b(model|llm|qmd|embedding|retrieval|memory)\b/i, entityType: "ai" },
  { re: /\b(doc|readme|docs|changelog)\b/i, entityType: "docs" },
];

/** User/agent is starting a hands-on task (issue #519 procedure recall gate). */
const TASK_INITIATION_RE =
  /\b(ship(?:ping|ped)?|deploy(?:ing|ed)?|release|publish|open(?:ing)?\s+(?:a\s+)?(?:pr|pull\s+request)|merge(?:ing)?\s+(?:the\s+)?(?:pr|pull\s+request)|run\s+(?:the\s+)?tests?|start(?:ing)?\s+(?:work|on|the)|kick\s+off|implement(?:ing|ed)?|let's\s+(?:ship|deploy|release|publish|open|run|merge|implement|fix|patch|build|start|do|get|put|wire|hook|land|roll)\b|going\s+to\s+(?:ship|deploy|release|open|run|merge)|need\s+to\s+(?:ship|deploy|run|open|merge|test)|fix(?:ing|ed)?\s+(?:(?:the|a)\s+)?(?:\w+\s+){0,4}(?:bug|build)\b|patch(?:ing|ed)?|build(?:ing)?\s+(?:and\s+)?(?:ship|deploy))\b/i;

const MEMORY_LOOKUP_RE =
  /^(?:what|when|where|who|which|why|how|did)\b/i;

function normalizeTextInput(input: unknown): string {
  return typeof input === "string" ? input : "";
}

export function inferIntentFromText(text: string): MemoryIntent {
  const safeText = normalizeTextInput(text);
  const goal = GOAL_PATTERNS.find((p) => p.re.test(safeText))?.goal ?? "unknown";
  const actionType = ACTION_PATTERNS.find((p) => p.re.test(safeText))?.action ?? "unknown";
  const entityTypes = Array.from(
    new Set(ENTITY_PATTERNS.filter((p) => p.re.test(safeText)).map((p) => p.entityType)),
  );
  const taskInitiation = !isMemoryLookupPrompt(safeText) && TASK_INITIATION_RE.test(safeText);

  return {
    goal,
    actionType,
    entityTypes,
    taskInitiation,
  };
}

export function isTaskInitiationIntent(intent: MemoryIntent): boolean {
  return intent.taskInitiation === true;
}

function isMemoryLookupPrompt(text: string): boolean {
  const trimmed = text.trim();
  return MEMORY_LOOKUP_RE.test(trimmed) ||
    /\b(?:previous|earlier|last week|last time|remember|recall|what did we decide)\b/i.test(trimmed);
}

export function intentCompatibilityScore(queryIntent: MemoryIntent, memoryIntent: MemoryIntent): number {
  const queryHasSignal =
    queryIntent.goal !== "unknown" ||
    queryIntent.actionType !== "unknown" ||
    queryIntent.entityTypes.length > 0;
  const memoryHasSignal =
    memoryIntent.goal !== "unknown" ||
    memoryIntent.actionType !== "unknown" ||
    memoryIntent.entityTypes.length > 0;
  if (!queryHasSignal || !memoryHasSignal) return 0;

  let score = 0;
  if (
    queryIntent.goal !== "unknown" &&
    memoryIntent.goal !== "unknown" &&
    queryIntent.goal === memoryIntent.goal
  ) {
    score += 0.5;
  }
  if (
    queryIntent.actionType !== "unknown" &&
    memoryIntent.actionType !== "unknown" &&
    queryIntent.actionType === memoryIntent.actionType
  ) {
    score += 0.3;
  }

  const overlap = queryIntent.entityTypes.filter((et) => memoryIntent.entityTypes.includes(et)).length;
  if (overlap > 0) {
    const denom = Math.max(queryIntent.entityTypes.length, memoryIntent.entityTypes.length, 1);
    score += 0.2 * (overlap / denom);
  }

  return Math.max(0, Math.min(1, score));
}

export function planRecallMode(prompt: string): RecallPlanMode {
  const p = normalizeTextInput(prompt).trim();
  let ackCandidate = p;
  while (ackCandidate.length > 0) {
    const ch = ackCandidate.charCodeAt(ackCandidate.length - 1);
    const isDigit = ch >= 48 && ch <= 57;
    const isUpper = ch >= 65 && ch <= 90;
    const isLower = ch >= 97 && ch <= 122;
    // Strip any trailing non-alphanumeric noise (punctuation/emojis/symbols).
    if (isDigit || isUpper || isLower) break;
    ackCandidate = ackCandidate.slice(0, -1);
  }
  ackCandidate = ackCandidate.trim();
  if (p.length === 0) return "no_recall";

  if (/\b(timeline|sequence|history|what happened|chain of events|root cause)\b/i.test(p)) {
    return "graph_mode";
  }

  // Reserve no_recall for low-information acknowledgements; avoid broad regressions.
  if (
    p.length <= 18 &&
    /^(ok|okay|kk|thanks|thx|got it|sounds good|yep|yes|nope|no|done|cool|works)$/i.test(ackCandidate)
  ) {
    return "no_recall";
  }

  // Full recall for prompts that are explicitly memory-seeking or analytical questions.
  if (
    /\b(previous|earlier|remember|last time|did we|what did we decide|context|summarize|summary|recap|key points|decision)\b/i.test(p) ||
    /\?$/.test(p) ||
    /^(what|why|how|when|where|who|which)\b/i.test(p.toLowerCase())
  ) {
    return "full";
  }

  // Minimal for short, non-question operational directives to keep latency/tokens down.
  if (
    p.length <= 100 &&
    /^(check|reload|restart|run|verify|show|status|sync|update|open|close|set|enable|disable|fix|patch)\b/i.test(p)
  ) {
    return "minimal";
  }

  return "full";
}

export function hasBroadGraphIntent(prompt: string): boolean {
  const p = normalizeTextInput(prompt).trim().toLowerCase();
  if (!p) return false;
  return /\b(what changed|how did we get here|why did this happen|what led to|cause chain|dependency chain|regression chain|failure chain)\b/i.test(
    p,
  );
}
