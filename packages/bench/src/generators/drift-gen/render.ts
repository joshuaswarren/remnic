/**
 * Dialogue rendering for drift-gen.
 *
 * Each fact becomes 1-3 natural turns inside its epoch's session. Phrasing is
 * drawn from pools of 20+ sentence frames per fact kind (fresh introduction
 * vs. update/supersession) so QMD lexical matching is not trivially
 * templated. The fact's value string always appears verbatim in at least one
 * turn — the validator relies on that containment invariant.
 */

import { pickOne, randomInt, type SeededRandom } from "../../seeded-random.js";
import { ATTRIBUTE_SPECS, type UserSchedule } from "./schedule.js";
import type { DriftSession, DriftSessionTurn, GoldFact } from "./types.js";

/** {clause} = attribute clause with subject, e.g. "Riley works at Norvig Dynamics". */
const FRESH_FRAMES: readonly string[] = Object.freeze([
  "By the way, {clause}.",
  "I wanted to mention that {clause}.",
  "Oh, before I forget: {clause}.",
  "Fun fact from this month: {clause}.",
  "Something new on my end: {clause}.",
  "Quick note for your records: {clause}.",
  "In case it ever comes up, {clause}.",
  "Here is a bit of news: {clause}.",
  "You might find this useful later: {clause}.",
  "For context, {clause}.",
  "Small life update: {clause}.",
  "I keep meaning to tell you that {clause}.",
  "Worth remembering: {clause}.",
  "Adding this to the pile: {clause}.",
  "It finally happened: {clause}.",
  "Not sure I mentioned it, but {clause}.",
  "One more thing from this week: {clause}.",
  "File this away somewhere: {clause}.",
  "A little background on that front: {clause}.",
  "Just so you have the full picture, {clause}.",
  "Today I learned that {clause}.",
  "The latest around here is that {clause}.",
]);

/** {clause} = new-state clause; {oldValue} = previous value string. */
const UPDATE_FRAMES: readonly string[] = Object.freeze([
  "Actually, an update: {clause} now, not {oldValue} anymore.",
  "Change of plans since we last talked: {clause}, moving on from {oldValue}.",
  "Correction to something I said before: {clause} these days, no longer {oldValue}.",
  "Heads up, things shifted: {clause}, which replaces {oldValue}.",
  "Scratch the old note about {oldValue}: {clause} now.",
  "That changed recently: {clause}, after a stretch with {oldValue}.",
  "New development: {clause}. The {oldValue} chapter is over.",
  "Since last month, {clause} — quite a switch from {oldValue}.",
  "Please update your notes: {clause}, superseding {oldValue}.",
  "Big change on that front: {clause} instead of {oldValue}.",
  "Turns out {clause} now; {oldValue} did not stick.",
  "As of this month, {clause}. Farewell to {oldValue}.",
  "I made the jump: {clause}, leaving {oldValue} behind.",
  "Things moved fast: {clause} now, after {oldValue}.",
  "Quick revision to the record: {clause}, formerly {oldValue}.",
  "Update from this side: {clause}. The {oldValue} era ended.",
  "It is official now: {clause}, replacing {oldValue}.",
  "Another shift to log: {clause}, whereas before it was {oldValue}.",
  "Latest news: {clause}, which is a change from {oldValue}.",
  "For accuracy going forward: {clause}, not {oldValue}.",
  "The situation evolved: {clause} as of now, previously {oldValue}.",
  "Mark this down: {clause}, taking over from {oldValue}.",
]);

const ACK_LINES: readonly string[] = Object.freeze([
  "Noted, thanks for the update.",
  "Got it, I will remember that.",
  "Thanks for letting me know.",
  "Understood, recorded.",
  "That is good to know.",
  "Appreciate the heads up.",
  "Noted — anything else changing?",
  "I have that down now.",
  "Thanks, updating my notes.",
  "Good to know, thanks for sharing.",
  "Recorded. How is everything else?",
  "Nice, thanks for the detail.",
]);

const ELABORATION_LINES: readonly string[] = Object.freeze([
  "It has been keeping things interesting, honestly.",
  "So far it feels like the right call.",
  "Still settling into it, but it is going well.",
  "Ask me again in a month how that is going.",
  "There is a longer story there for another day.",
  "It came together faster than expected.",
  "Everyone around here seems pleased about it.",
  "We will see how that holds up over time.",
  "It took a while, but it finally worked out.",
  "That one has been a long time coming.",
  "No regrets so far on that front.",
  "More details on that next time we talk.",
]);

const CORPUS_START_YEAR = 2021;
const CORPUS_START_MONTH = 3;

/** Fictional session date: epoch 1 = March 2021, one epoch per month. */
export function epochDate(epoch: number, dayOfMonth: number): string {
  const monthIndex = CORPUS_START_MONTH - 1 + (epoch - 1);
  const year = CORPUS_START_YEAR + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const mm = String(month).padStart(2, "0");
  const dd = String(dayOfMonth).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function renderClause(fact: GoldFact, persona: string): string {
  const spec = ATTRIBUTE_SPECS.find((s) => s.attribute === fact.attribute);
  if (!spec) throw new Error(`unknown drift-gen attribute: ${fact.attribute}`);
  return fact.subject === persona
    ? `I ${spec.firstPersonClause(fact.value)}`
    : `${fact.subject} ${spec.clause(fact.value)}`;
}

function renderFactTurns(
  rng: SeededRandom,
  fact: GoldFact,
  persona: string,
  supersedes: GoldFact | undefined,
): DriftSessionTurn[] {
  const clause = renderClause(fact, persona);
  const opening = supersedes
    ? pickOne(rng, UPDATE_FRAMES)
        .replaceAll("{clause}", clause)
        .replaceAll("{oldValue}", supersedes.value)
    : pickOne(rng, FRESH_FRAMES).replaceAll("{clause}", clause);
  const turns: DriftSessionTurn[] = [{ role: "user", content: opening }];
  const extra = randomInt(rng, 0, 2);
  if (extra >= 1) {
    turns.push({ role: "assistant", content: pickOne(rng, ACK_LINES) });
  }
  if (extra === 2) {
    turns.push({ role: "user", content: pickOne(rng, ELABORATION_LINES) });
  }
  return turns;
}

export function renderUserSessions(
  rng: SeededRandom,
  user: UserSchedule,
  epochs: number,
): DriftSession[] {
  const supersededBy = new Map<string, GoldFact>();
  for (const fact of user.facts) {
    if (fact.supersededBy !== null) {
      const successor = user.facts.find((f) => f.id === fact.supersededBy);
      if (successor) supersededBy.set(successor.id, fact);
    }
  }

  const sessions: DriftSession[] = [];
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const introduced = user.facts.filter((f) => f.introducedEpoch === epoch);
    const turns: DriftSessionTurn[] = [];
    for (const fact of introduced) {
      turns.push(...renderFactTurns(rng, fact, user.persona, supersededBy.get(fact.id)));
    }
    sessions.push({
      sessionId: `s-${user.userId}-e${epoch}`,
      userId: user.userId,
      epoch,
      date: epochDate(epoch, randomInt(rng, 2, 27)),
      turns,
    });
  }
  return sessions;
}
