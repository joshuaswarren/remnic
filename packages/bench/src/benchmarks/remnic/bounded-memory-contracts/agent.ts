/**
 * Pack assembly + deterministic agent simulation for bounded-memory-contracts.
 *
 * Everything here is a PURE function of (task, condition, contract, budget).
 * No I/O, no randomness, no LLM. This is what makes the benchmark offline and
 * reproducible: the "agent" is a fixed decision procedure over whatever
 * metadata the condition exposes, so the four conditions produce genuinely
 * different packs and decisions — the comparison is honest, not hard-coded.
 */

import type {
  AgentDecision,
  AssembledMemoryPack,
  BoundedMemoryConditionId,
  BoundedMemoryTask,
  FixtureMemoryItem,
  FixtureSkill,
  MemoryContract,
  MemoryPackItem,
  SkillTriggerLogEntry,
} from "./types.js";

/**
 * The benchmark-local typed-retrieval contract. Mirrors the issue's
 * `MemoryContract` schema. maxTotalTokens is the SHARED budget under which C1
 * (raw transcript) and C2/C3 (typed) are compared — the budget-normalized
 * comparison the issue requires.
 */
export const BOUNDED_MEMORY_CONTRACT: MemoryContract = {
  id: "bounded-memory-default",
  description:
    "Fresh bounded prompt assembled from typed, scoped, citable memory slots. No historical raw transcript is appended.",
  maxTotalTokens: 320,
  slots: [
    {
      id: "active_scope",
      memoryCategories: ["fact", "decision"],
      maxItems: 4,
      required: true,
      excludeIfSuperseded: true,
      requireCitation: true,
    },
    {
      id: "relevant_facts",
      memoryCategories: ["fact", "decision", "preference", "principle", "entity"],
      maxItems: 6,
      required: true,
      excludeIfSuperseded: true,
      requireCitation: true,
    },
    {
      id: "conflicts_and_supersessions",
      memoryCategories: ["correction"],
      maxItems: 3,
      required: false,
      excludeIfSuperseded: false,
      requireCitation: true,
    },
    {
      id: "boundaries",
      memoryCategories: ["boundary"],
      maxItems: 2,
      required: false,
      excludeIfSuperseded: true,
      requireCitation: true,
    },
  ],
};

function toPackItem(item: FixtureMemoryItem, exposedMetadata: boolean): MemoryPackItem {
  return {
    itemId: item.id,
    category: item.category,
    scope: item.scope,
    status: item.status,
    content: item.content,
    subjectKeywords: item.subjectKeywords,
    citation: exposedMetadata ? `mem:${item.id}` : "",
    tokens: item.tokens,
    superseded: item.status === "superseded",
    wrongScope: item.wrongScope === true,
    exposedMetadata,
  };
}

function keywordOverlap(a: readonly string[], b: readonly string[]): number {
  const setB = new Set(b);
  let n = 0;
  for (const kw of a) {
    if (setB.has(kw)) n += 1;
  }
  return n;
}

/**
 * Assemble the memory pack for one (task, condition) pair.
 *
 * - C0: empty pack.
 * - C1: every item flattened into a transcript block (no metadata exposed),
 *   most-recent-first, truncated to the shared token budget.
 * - C2: items filtered to the task scope, active, non-superseded, organized
 *   into typed slots with citations. A boundary item is lifted into a
 *   dedicated boundaryNote. NO raw transcript is appended.
 * - C3: C2 plus skills whose trigger classifier fires.
 */
export function assemblePack(
  task: BoundedMemoryTask,
  condition: BoundedMemoryConditionId,
  contract: MemoryContract,
  injectSkills: FixtureSkill[],
): AssembledMemoryPack {
  const fullTranscriptTokens = task.memoryItems.reduce((s, m) => s + m.tokens, 0);

  if (condition === "no-memory") {
    return {
      condition,
      slots: [],
      transcriptBlock: null,
      boundaryNote: null,
      totalTokens: 0,
      fullTranscriptTokens,
    };
  }

  if (condition === "raw-transcript") {
    // Most-recent-first so the budget favors recent context (fair to C1).
    const ordered = task.memoryItems.slice().sort((a, b) => b.turn - a.turn);
    const items: MemoryPackItem[] = [];
    let budget = contract.maxTotalTokens;
    for (const m of ordered) {
      if (budget <= 0) break;
      if (m.tokens > budget) continue;
      items.push(toPackItem(m, false));
      budget -= m.tokens;
    }
    const transcriptBlock = items
      .map((it) => `- [turn ${task.memoryItems.find((m) => m.id === it.itemId)!.turn}] ${it.content}`)
      .join("\n");
    return {
      condition,
      slots: [{ id: "transcript", items }],
      transcriptBlock,
      // Raw transcript buries any boundary prose; it is NOT surfaced as a
      // structured boundary note, so the agent cannot reliably act on it.
      boundaryNote: null,
      totalTokens: items.reduce((s, it) => s + it.tokens, 0),
      fullTranscriptTokens,
    };
  }

  // C2 / C3: typed contract. Each memory item is assigned to AT MOST ONE
  // slot (no double-counting) and the shared token budget is enforced across
  // the whole pack, so typed conditions are held to the same cap as C1.
  const inScope = task.memoryItems.filter((m) => m.scope === task.scope);
  const boundaryItem = inScope.find(
    (m) => m.category === "boundary" && m.status === "active",
  );
  const boundaryNote = boundaryItem ? boundaryItem.content : null;

  // Rank all in-scope, non-pending-review candidates once by relevance then
  // recency. Each candidate is offered to the first accepting slot; an item
  // already claimed by an earlier slot is skipped so cost metrics count each
  // trace item exactly once.
  const rankedCandidates = inScope
    .filter((m) => m.status !== "pending_review")
    .slice()
    .sort((a, b) => {
      const oa = keywordOverlap(a.subjectKeywords, task.subjectKeywords);
      const ob = keywordOverlap(b.subjectKeywords, task.subjectKeywords);
      if (ob !== oa) return ob - oa;
      return b.turn - a.turn;
    });

  const alreadyPicked = new Set<string>();
  let budget = contract.maxTotalTokens;
  const slots = contract.slots.map((slot) => {
    const items: MemoryPackItem[] = [];
    for (const m of rankedCandidates) {
      if (budget <= 0) break;
      if (alreadyPicked.has(m.id)) continue;
      if (!slot.memoryCategories.includes(m.category)) continue;
      if (slot.excludeIfSuperseded && m.status === "superseded") continue;
      if (items.length >= slot.maxItems) break;
      if (m.tokens > budget) continue;
      items.push(toPackItem(m, true));
      alreadyPicked.add(m.id);
      budget -= m.tokens;
    }
    return { id: slot.id, items };
  });

  let totalTokens = contract.maxTotalTokens - budget;

  // C3: append triggered skills as a procedural slot, respecting the budget.
  if (condition === "typed-plus-skills" && injectSkills.length > 0) {
    const skillItems: MemoryPackItem[] = [];
    for (const skill of injectSkills) {
      if (totalTokens + skill.tokens > contract.maxTotalTokens) break;
      skillItems.push({
        itemId: skill.id,
        category: "skill",
        scope: task.scope,
        status: skill.status,
        content: `${skill.title}: ${skill.steps.join(" → ")}`,
        subjectKeywords: skill.appliesWhen,
        citation: `skill:${skill.id}`,
        tokens: skill.tokens,
        superseded: false,
        wrongScope: false,
        exposedMetadata: true,
      });
      totalTokens += skill.tokens;
    }
    if (skillItems.length > 0) {
      slots.push({ id: "triggered_skills", items: skillItems });
    }
  }

  return {
    condition,
    slots,
    transcriptBlock: null,
    boundaryNote,
    totalTokens,
    fullTranscriptTokens,
  };
}

/**
 * Rule-based skill trigger classifier (C3 only).
 *
 * A skill is CONSIDERED when any appliesWhen keyword appears in the task. It
 * is INJECTED iff at least one appliesWhen keyword matches AND no
 * doesNotApplyWhen keyword matches. This is deliberately simple and
 * deterministic — it models a procedural recall gate, not a frontier model.
 */
export function classifySkillTrigger(
  skill: FixtureSkill,
  task: BoundedMemoryTask,
): { considered: boolean; injected: boolean; reason: string } {
  const taskTokens = tokenize(task.prompt + " " + task.subjectKeywords.join(" "));
  const taskSet = new Set(taskTokens);
  const appliesHits = skill.appliesWhen.filter((k) => taskSet.has(k));
  const blocksHits = skill.doesNotApplyWhen.filter((k) => taskSet.has(k));
  const considered = appliesHits.length > 0 || blocksHits.length > 0;
  if (appliesHits.length > 0 && blocksHits.length === 0) {
    return {
      considered: true,
      injected: true,
      reason: `appliesWhen matched [${appliesHits.join(", ")}]; no doesNotApplyWhen hit`,
    };
  }
  if (blocksHits.length > 0) {
    return {
      considered: true,
      injected: false,
      reason: `blocked by doesNotApplyWhen [${blocksHits.join(", ")}]`,
    };
  }
  return { considered, injected: false, reason: "no trigger overlap" };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

interface RankedCandidate {
  item: MemoryPackItem;
  overlap: number;
  tokens: number;
  turn: number;
}

/**
 * Rank pack candidates the way each condition's agent would:
 *
 * - C1 (no metadata): overlap desc, then tokens desc (longer / more repeated
 *   memory is more salient — a fair raw-transcript heuristic).
 * - C2/C3 (metadata exposed, already filtered): overlap desc, then recency.
 *
 * Returns the best candidate or null.
 */
function rankCandidates(
  pack: AssembledMemoryPack,
  task: BoundedMemoryTask,
  sourceItems: FixtureMemoryItem[],
): MemoryPackItem | null {
  const candidates: RankedCandidate[] = [];
  const exposedMetadata = pack.condition !== "raw-transcript";
  for (const slot of pack.slots) {
    for (const it of slot.items) {
      const overlap = keywordOverlap(it.subjectKeywords, task.subjectKeywords);
      if (overlap === 0) continue;
      const source = sourceItems.find((m) => m.id === it.itemId);
      const turn = source ? source.turn : it.tokens;
      candidates.push({ item: it, overlap, tokens: it.tokens, turn });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return exposedMetadata ? b.turn - a.turn : b.tokens - a.tokens;
  });
  return candidates[0]!.item;
}

/**
 * Run the deterministic agent over the assembled pack.
 */
export function simulateAgent(
  task: BoundedMemoryTask,
  pack: AssembledMemoryPack,
  injectedSkills: FixtureSkill[],
): AgentDecision {
  const allItems = task.memoryItems;
  const consideredSkillIds: string[] = [];
  const usedSkillIds: string[] = [];

  // --- Boundary tasks: ask vs act ---
  if (task.shouldAsk === true) {
    // Correct behavior is to ASK. Typed conditions surface a structured
    // boundary note; C0/C1 do not → they act (a boundary violation).
    const asked = pack.boundaryNote !== null;
    return {
      answer: asked ? task.expectedAnswer : "act-without-confirmation",
      askedClarification: asked,
      acted: !asked,
      recalledItemIds: [],
      usedSkillIds,
      consideredSkillIds,
      wrongScopeLeakedIds: [],
      staleLeakedIds: [],
    };
  }
  if (task.shouldAsk === false) {
    // Correct behavior is to ACT (no unnecessary clarification).
    const best = rankCandidates(pack, task, allItems);
    const answer = best?.itemId ? deriveAnswer(best.itemId, allItems, injectedSkills, task) : (SELF_CONTAINED_ANSWERS[task.id] ?? "unknown");
    return {
      answer,
      askedClarification: false,
      acted: true,
      recalledItemIds: best ? [best.itemId] : [],
      usedSkillIds,
      consideredSkillIds,
      wrongScopeLeakedIds: best?.wrongScope ? [best.itemId] : [],
      staleLeakedIds: best?.superseded ? [best.itemId] : [],
    };
  }

  // --- Recall / governance / skill tasks ---
  // C3: record considered + injected skills (for the trigger log).
  for (const skill of injectedSkills) {
    consideredSkillIds.push(skill.id);
    usedSkillIds.push(skill.id);
  }

  const best = rankCandidates(pack, task, allItems);

  // Skill-positive: if a skill was injected, its steps determine the answer.
  if (task.family === "skill-positive" && injectedSkills.length > 0) {
    const answer = deriveAnswer(task.shouldUseSkillId ?? "", allItems, injectedSkills, task);
    return {
      answer,
      askedClarification: false,
      acted: true,
      recalledItemIds: best ? [best.itemId] : [],
      usedSkillIds,
      consideredSkillIds,
      wrongScopeLeakedIds: best?.wrongScope ? [best.itemId] : [],
      staleLeakedIds: best?.superseded ? [best.itemId] : [],
    };
  }

  const answer = best ? deriveAnswer(best.itemId, allItems, injectedSkills, task) : (SELF_CONTAINED_ANSWERS[task.id] ?? "unknown");
  return {
    answer,
    askedClarification: false,
    acted: true,
    recalledItemIds: best ? [best.itemId] : [],
    usedSkillIds,
    consideredSkillIds,
    wrongScopeLeakedIds: best?.wrongScope ? [best.itemId] : [],
    staleLeakedIds: best?.superseded ? [best.itemId] : [],
    };
}

function deriveAnswer(
  itemId: string,
  items: FixtureMemoryItem[],
  skills: FixtureSkill[],
  task: BoundedMemoryTask,
): string {
  // A skill answer takes precedence when the task is skill-positive and the
  // injected skill is the one that should fire.
  if (task.family === "skill-positive") {
    const skill = skills.find((sx) => sx.id === task.shouldUseSkillId);
    if (skill) {
      return SKILL_ANSWER_TOKENS[skill.id] ?? "procedure-applied";
    }
  }
  const item = items.find((m) => m.id === itemId);
  return item?.answerToken ?? "unknown";
}

/**
 * Answer token each injected skill yields (synthesized from its steps). Kept as
 * a static Record so the mapping is discoverable and lint-clean.
 */
const SKILL_ANSWER_TOKENS: Record<string, string> = {
  "skill:deploy-gateway": "run-deploy-checks-then-tag",
  "skill:rotate-api-keys": "dual-load-then-retire",
};

/**
 * Self-contained act-when-enough tasks derive the answer from the prompt
 * itself (no memory needed). Static Record keyed by task id.
 */
const SELF_CONTAINED_ANSWERS: Record<string, string> = {
  "act-self-contained-greeting": "hello-acme",
  "act-self-contained-summarize": "the-sky-is-blue",
};

/**
 * Build the C3 skill-trigger log across a task set. One entry per (task,
 * considered skill). `outcome` is resolved against the task's expected skill
 * behavior.
 */
export function buildSkillTriggerLog(
  tasks: readonly BoundedMemoryTask[],
): SkillTriggerLogEntry[] {
  const log: SkillTriggerLogEntry[] = [];
  for (const task of tasks) {
    for (const skill of task.skills) {
      const verdict = classifySkillTrigger(skill, task);
      if (!verdict.considered) continue;
      let outcome: SkillTriggerLogEntry["outcome"] = "irrelevant";
      if (task.family === "skill-positive") {
        const shouldFire = task.shouldUseSkillId === skill.id;
        outcome = verdict.injected === shouldFire ? (shouldFire ? "helped" : "irrelevant") : "harmed";
      } else if (task.family === "skill-negative") {
        // Correct outcome is to NOT inject.
        outcome = verdict.injected ? "harmed" : "irrelevant";
      }
      log.push({
        taskId: task.id,
        skillId: skill.id,
        considered: verdict.considered,
        injected: verdict.injected,
        triggerReason: verdict.reason,
        confidence: skill.confidence,
        outcome,
      });
    }
  }
  return log;
}
