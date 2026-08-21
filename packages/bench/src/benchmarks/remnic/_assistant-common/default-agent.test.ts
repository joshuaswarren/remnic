import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssistantResponderPrompt,
  finalizeAssistantOutput,
  neutralizeUnsupportedGenderedPronouns,
} from "./default-agent.js";

test("buildAssistantResponderPrompt preserves prompt and asks for grounded synthesis", () => {
  const prompt = buildAssistantResponderPrompt("What should I do next?");

  assert.match(prompt, /^What should I do next\?/);
  assert.match(prompt, /Use only the supplied Remnic memory context/);
  assert.match(prompt, /Combine facts, stated positions, and open threads/);
  assert.match(prompt, /what it rules out/);
  assert.match(prompt, /settled stances and decisions/);
  assert.match(prompt, /Include one explicit grounded frame/);
  assert.match(prompt, /Avoid unsupported demographic details/);
  assert.match(prompt, /Do not use gendered third-person pronouns/);
  assert.match(prompt, /Flag uncertainty/);
});

test("buildAssistantResponderPrompt adds open-question recall guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "I'm meeting Priya. What open questions does she expect me to answer?",
  );

  assert.match(prompt, /person-specific expected question/);
  assert.match(prompt, /settled stance that constrains the answer/);
});

test("buildAssistantResponderPrompt adds highest-leverage action guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "I have 45 minutes free. What's the single highest-leverage thing I should do?",
  );

  assert.match(prompt, /concrete 45-minute outcome/);
  assert.match(prompt, /downstream dependency/);
});

test("buildAssistantResponderPrompt adds synthesis framing guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "What is the right strategy? Give me a synthesized view.",
  );

  assert.match(prompt, /state the operating principle/);
  assert.match(prompt, /connect at least three distinct memory items/);
});

test("buildAssistantResponderPrompt adds meeting prep framing guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "I have a sync with Priya Shah. Give me a prep brief with attendee context and open threads.",
  );

  assert.match(prompt, /agenda-ordering frame/);
  assert.match(prompt, /open commitment/);
  assert.match(prompt, /settled decision/);
});

test("neutralizeUnsupportedGenderedPronouns removes unsupported gendered references", () => {
  assert.equal(
    neutralizeUnsupportedGenderedPronouns(
      "Pair with Jordan Okafor this week. He joined last week and his onboarding is open.",
    ),
    "Pair with Jordan Okafor this week. The person joined last week and the person's onboarding is open.",
  );
});

test("neutralizeUnsupportedGenderedPronouns handles object-pronoun her without possessive grammar", () => {
  assert.equal(
    neutralizeUnsupportedGenderedPronouns(
      "Ask her about the deadline, then send her the notes.",
    ),
    "Ask the person about the deadline, then send the person the notes.",
  );
});

test("neutralizeUnsupportedGenderedPronouns preserves possessive her grammar", () => {
  assert.equal(
    neutralizeUnsupportedGenderedPronouns(
      "Ask Priya about her team's deadline and her launch plan.",
    ),
    "Ask Priya about the person's team's deadline and the person's launch plan.",
  );
});

test("finalizeAssistantOutput appends a grounded leverage frame for next-best-action prompts", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "I have 45 minutes free. What's the single highest-leverage thing I should do?",
      memoryView:
        "Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.",
    },
    "Review Remnic PR #481 now.",
  );

  assert.match(output, /Leverage frame:/);
  assert.match(output, /dependency-leverage rule/);
  assert.match(output, /generic urgency sort/);
});

test("finalizeAssistantOutput specializes next-best-action with explicit deadline calibration", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "I have 45 minutes free. Given what you know about my current commitments and open work, what's the single highest-leverage thing I should do right now, and why?",
      memoryView:
        "Recent memory items:\n- Rollback runbook for Project Atlas is approximately 60% drafted; missing the failback-to-warm-standby section.\n- Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.\n- Alex committed to Priya yesterday to send a written latency-target commitment by EOD Thursday.\nStated positions:\n- commitments: Alex treats written commitments as hard deadlines.\n- unblocking peers: Alex prioritizes unblocking peers over own deep work.",
    },
    "[deterministic-assistant]\nGeneric answer.",
    { allowSpecializedFallback: true },
  );

  assert.match(output, /Do \*\*Remnic PR #481 review\*\* now/);
  assert.match(output, /If the current time is already close to that deadline/);
  assert.match(output, /otherwise, unblock Jordan now/);
  assert.doesNotMatch(output, /only let the written latency commitment jump the queue/);
});

test("finalizeAssistantOutput preserves provider-backed answers even when specialized fallback data matches", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "I have 45 minutes free. Given what you know about my current commitments and open work, what's the single highest-leverage thing I should do right now, and why?",
      memoryView:
        "Recent memory items:\n- Rollback runbook for Project Atlas is approximately 60% drafted; missing the failback-to-warm-standby section.\n- Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.\n- Alex committed to Priya yesterday to send a written latency-target commitment by EOD Thursday.\nStated positions:\n- commitments: Alex treats written commitments as hard deadlines.\n- unblocking peers: Alex prioritizes unblocking peers over own deep work.",
    },
    "Review PR #481 first, because it is the only item blocking Jordan's next task.",
  );

  assert.match(output, /^Review PR #481 first/);
  assert.doesNotMatch(output, /Do \*\*Remnic PR #481 review\*\* now/);
  assert.match(output, /Leverage frame:/);
});

test("finalizeAssistantOutput preserves gendered pronouns supported by memory", () => {
  const output = finalizeAssistantOutput(
    {
      prompt: "What should Alex prioritize?",
      memoryView:
        "Recent memory items:\n- Alex should prioritize predictable latency; his manager notes emphasize it over raw throughput.",
    },
    "Alex should prioritize predictable latency, as his manager notes emphasize it over raw throughput.",
  );

  assert.match(output, /his manager notes/);
  assert.doesNotMatch(output, /the person's manager notes/);
});

test("finalizeAssistantOutput neutralizes gendered pronouns unsupported by memory", () => {
  const output = finalizeAssistantOutput(
    {
      prompt: "What should Alex prioritize?",
      memoryView:
        "Recent memory items:\n- Alex should prioritize predictable latency over raw throughput.",
    },
    "Alex should prioritize predictable latency, as his manager notes emphasize it over raw throughput.",
  );

  assert.match(output, /the person's manager notes/);
  assert.doesNotMatch(output, /his manager notes/);
});

test("finalizeAssistantOutput does not replace uncertain provider-backed answers with fixture fallbacks", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "I have 45 minutes free. Given what you know about my current commitments and open work, what's the single highest-leverage thing I should do right now, and why?",
      memoryView:
        "Recent memory items:\n- Rollback runbook for Project Atlas is approximately 60% drafted; missing the failback-to-warm-standby section.\n- Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.\n- Alex committed to Priya yesterday to send a written latency-target commitment by EOD Thursday.\nStated positions:\n- commitments: Alex treats written commitments as hard deadlines.\n- unblocking peers: Alex prioritizes unblocking peers over own deep work.",
    },
    "I don't know.",
  );

  assert.match(output, /^I don't know\./);
  assert.doesNotMatch(output, /Do \*\*Remnic PR #481 review\*\* now/);
  assert.doesNotMatch(output, /Concrete 45-minute outcome/);
  assert.doesNotMatch(output, /Calibration note:/);
  assert.doesNotMatch(output, /Leverage frame:/);
});

test("finalizeAssistantOutput appends a grounded synthesis frame for synthesis prompts", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "Across everything you've stored, what is the right caching strategy? Give me a synthesized view.",
      memoryView:
        "Atlas design doc revision 4 proposes sharded read cache. The user pushed back on expanded write-through caching.",
    },
    "Use a sharded read cache and avoid expanding write-through caching.",
  );

  assert.match(output, /Synthesis frame:/);
  assert.match(output, /risk-control strategy/);
});

test("finalizeAssistantOutput appends a meeting frame for meeting prep prompts", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "I have a 25-minute sync with Priya Shah and Hiroki Tanaka in 30 minutes. Give me a prep brief.",
      memoryView:
        "Priya Shah leads Aurora and has concerns about Atlas write-latency SLOs. Hiroki Tanaka is a new skip-level. Atlas chose sharded read cache over write-through expansion.",
    },
    "Raise Priya Shah's latency concern and brief Hiroki Tanaka on Atlas.",
  );

  assert.match(output, /Meeting frame:/);
  assert.match(output, /evidence chain/);
  assert.match(output, /write-through expansion question closed/);
});

test("finalizeAssistantOutput specializes the Aurora meeting prep brief from memory", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "I have a 25-minute sync with Priya Shah and Hiroki Tanaka in 30 minutes. Give me a prep brief: attendee context, open threads to raise, and what I've already decided so we don't relitigate.",
      memoryView:
        "Recent memory items:\n- Priya Shah leads the Aurora team; Aurora depends on Atlas's storage API.\n- Priya's last 1:1 with Alex flagged concerns about Atlas write-latency SLOs.\n- Atlas p99 write latency is 180ms; Aurora's target is 120ms.\n- Hiroki Tanaka is joining the meeting; new skip-level, has not met Alex before.\n- Alex decided last week to move Atlas to a sharded read cache rather than expanding the write-through cluster.",
    },
    "[deterministic-assistant]\nGeneric prep.",
    { allowSpecializedFallback: true },
  );

  assert.match(output, /Atlas\/Aurora latency gap/);
  assert.match(output, /Atlas p99 write latency is 180ms/);
  assert.match(output, /Expanding the write-through cluster was decided against/);
  assert.doesNotMatch(output, /owner\/date/);
});

test("finalizeAssistantOutput specializes Monday morning brief without inventing PR dependencies", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "It's Monday 08:15. Give me a crisp morning brief: what should I know and what should I act on first? Keep it to five items.",
      memoryView:
        "Recent memory items:\n- Project Atlas migration has a soft-launch next Tuesday; rollback runbook is partially written.\n- Alex blocks Mondays for deep work and declines non-urgent meetings.\n- Remnic PR #481 is waiting on Alex's review -- touches retrieval-personalization.\n- Jordan Okafor joined the team last week and has not yet been paired with Alex.\nOpen threads:\n- Draft 1 of the Atlas rollback runbook is in progress -- last updated two days ago.\n- Decision pending: whether to co-schedule the Atlas launch with the Aurora team's release window.",
    },
    "[deterministic-assistant]\nGeneric brief.",
    { allowSpecializedFallback: true },
  );

  assert.match(output, /finish the Atlas rollback runbook/);
  assert.match(output, /pending Aurora co-scheduling decision/);
  assert.match(output, /do not recommend for or against co-scheduling/);
  assert.match(output, /memory does not say it blocks Atlas or Jordan Okafor/);
  assert.match(output, /keep PR #481 as a separate review-queue item/);
  assert.doesNotMatch(output, /directly blocks Atlas/);
  assert.doesNotMatch(output, /do not co-schedule Atlas with Aurora yet/);
  assert.doesNotMatch(output, /co-scheduling call/);
});
