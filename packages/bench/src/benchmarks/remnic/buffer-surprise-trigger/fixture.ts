/**
 * Fixture for the `buffer-surprise-trigger` benchmark (issue #563 PR 4).
 *
 * Each case represents a short synthetic conversation with 2–3 annotated
 * topic shifts. A "topic shift" is the turn where the conversation moves
 * to a semantically distant subject — that is the turn we expect the
 * D-MEM surprise gate to flush on when it's working.
 *
 * Conversations are intentionally short (12–15 turns) and written in
 * plain English so the deterministic hash embedder used by the runner
 * produces meaningful cosine similarities across topic boundaries
 * without requiring a real embedding model. The runner does NOT call any
 * LLM, network, or QMD instance — everything is in-memory and
 * reproducible by seed.
 *
 * Each `topicShiftTurnIndices` is 0-indexed into the `turns` array. The
 * first turn (index 0) is never a topic shift by construction — there is
 * no prior context to shift away from.
 */

export interface BufferSurpriseTriggerCase {
  id: string;
  /**
   * Ordered turns in the conversation. Only the text matters — the
   * runner handles role assignment deterministically.
   */
  turns: string[];
  /** 0-indexed turn positions that introduce a new topic. */
  topicShiftTurnIndices: number[];
}

export const BUFFER_SURPRISE_TRIGGER_FIXTURE: BufferSurpriseTriggerCase[] = [
  {
    id: "cooking-to-astronomy",
    turns: [
      "I'm making pasta carbonara tonight with pancetta and pecorino.",
      "Should I use guanciale instead of pancetta for authenticity?",
      "What ratio of eggs to cheese gives the best creamy texture?",
      "I usually whisk yolks and whole eggs separately before combining.",
      "A splash of pasta water at the end helps emulsify everything.",
      // Topic shift 1: cooking → astronomy
      "Completely different question — can you explain why Jupiter has such strong magnetic fields?",
      "Does the liquid metallic hydrogen in its interior act like a dynamo?",
      "Are Jupiter's auroras visible from Earth-based telescopes?",
      "I saw a Hubble image of the polar auroras last year.",
      // Topic shift 2: astronomy → tax policy
      "Switching gears: what's the current US federal long-term capital gains rate?",
      "How does the holding-period rule interact with wash sales?",
      "Are there any exemptions for primary residence gains?",
    ],
    topicShiftTurnIndices: [5, 9],
  },
  {
    id: "debugging-to-travel",
    turns: [
      "My Node.js process is hanging on shutdown and I can't figure out why.",
      "I've checked for open handles with `wtfnode` and it shows a pending timer.",
      "The timer is from a library I don't own — any ideas?",
      "I tried process.exit(0) but it cuts off pending writes.",
      "Maybe I should use unref() on the timer.",
      "That worked — unref lets the event loop exit cleanly.",
      // Topic shift: engineering → travel planning
      "On a different note — I'm planning a trip to Kyoto next spring.",
      "Which neighborhoods should I stay in for temple access?",
      "Is it better to rent bicycles or use the bus and subway?",
      "What's the weather like during cherry blossom season?",
      "Should I book ryokan accommodations in advance?",
    ],
    topicShiftTurnIndices: [6],
  },
  {
    id: "cue-free-cooking-to-astronomy",
    turns: [
      "I'm refining a mushroom risotto recipe with arborio rice and vegetable stock.",
      "The pan absorbs liquid slowly when I add one ladle at a time.",
      "Toasted rice grains help the final texture stay creamy without turning mushy.",
      "Finishing with parmesan and butter gives the sauce a glossy texture.",
      // Topic shift: cooking -> astronomy, intentionally without a lexical pivot cue.
      "Jupiter's magnetosphere traps charged particles across a vast radiation belt.",
      "Rapid planetary rotation and metallic hydrogen can power a strong dynamo.",
      "The polar auroras brighten when solar wind particles interact with the field.",
      "Spacecraft have measured intense radiation around the inner moons.",
    ],
    topicShiftTurnIndices: [4],
  },
  {
    id: "music-to-gardening-to-finance",
    turns: [
      "I've been learning the blues scale on guitar this week.",
      "The minor pentatonic with a flat 5 gives it that distinctive sound.",
      "Which B.B. King album should I study for phrasing?",
      // Topic shift 1: music → gardening
      "Switching topics — my tomato plants have yellow leaves on the bottom.",
      "Is that nitrogen deficiency or just normal old-leaf drop?",
      "Should I side-dress with compost or use a liquid fertilizer?",
      "My soil pH tested at 6.8 last month, which seems okay.",
      // Topic shift 2: gardening → finance
      "On another note, I wanted to ask about Treasury I-bonds.",
      "How does the inflation adjustment compound over time?",
      "What's the annual purchase limit per person?",
      "Are they a better deal than TIPS right now?",
    ],
    topicShiftTurnIndices: [3, 7],
  },
  {
    id: "no-shifts-baseline",
    turns: [
      "I've been rewriting our authentication flow in Go.",
      "The old session cookie had no rotation, which bothered me.",
      "I'm using PASETO tokens with 15-minute lifetimes.",
      "Refresh tokens go in an HttpOnly cookie with SameSite strict.",
      "The refresh path rotates the token and invalidates the old one.",
      "Device fingerprinting helps us detect stolen refresh tokens.",
      "We log rotation events for audit and anomaly detection.",
      "The load balancer strips all cookies before cache hits.",
    ],
    topicShiftTurnIndices: [],
  },
  {
    id: "three-shifts",
    turns: [
      "I'm designing a rate limiter for our public API.",
      "Token bucket vs leaky bucket — which fits bursty traffic better?",
      "I was leaning toward a sliding-window counter with Redis.",
      // Shift 1: engineering → cooking
      "Unrelated — thinking about making sourdough this weekend.",
      "My starter has been in the fridge for two weeks, is it still alive?",
      "Should I refresh it twice before baking?",
      // Shift 2: cooking → history
      "Separately — when did the Byzantine Empire actually fall?",
      "Was it 1453 when Constantinople fell to the Ottomans?",
      "What happened to the remnants in the Morea after that?",
      // Shift 3: history → photography
      "One more thing — I just bought a used Fujifilm X-T4.",
      "Which lens should I start with for street photography?",
      "Do you recommend the 23mm f/2 or the 35mm f/1.4?",
    ],
    topicShiftTurnIndices: [3, 6, 9],
  },
];

/** A small smoke subset for `--mode quick` runs. */
export const BUFFER_SURPRISE_TRIGGER_SMOKE_FIXTURE =
  BUFFER_SURPRISE_TRIGGER_FIXTURE.slice(0, 2);
