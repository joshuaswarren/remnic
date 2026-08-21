import assert from "node:assert/strict";
import test from "node:test";
import { buildRecallQueryPolicy, classifyRecallPromptShape } from "../src/recall-query-policy.js";

const baseConfig = {
  cronRecallPolicyEnabled: true,
  cronRecallNormalizedQueryMaxChars: 320,
  cronRecallInstructionHeavyTokenCap: 24,
  cronConversationRecallMode: "auto" as const,
};

test("classifies instruction-heavy cron prompt shape", () => {
  const prompt = `
[cron:deckard-morning-briefing]
Goal: Generate a comprehensive morning briefing.
DATA GATHERING:
1. Read /Users/example/a.md
2. Read /Users/example/b.md
3. Extract section outputs
4. Parse ~/workspace/todo.md
5. Determine blockers and dependencies
6. Include only verified facts
OUTPUT FORMAT:
- Greeting
- Calendar
- Tasks
- Follow-ups
- Risks
- Priorities
GROUNDING RULES:
- Never invent details
- Omit sections with no data
- Skip stale items older than 7 days
- Return plain text only
FOLLOW-UP:
- Extract unresolved actions
- Include owners and due dates
Current time: Monday, February 23rd, 2026
`.trim();

  assert.equal(classifyRecallPromptShape(prompt), "instruction_heavy");
});

test("buildRecallQueryPolicy normalizes instruction-heavy cron prompts", () => {
  const prompt = `
[cron:deckard-morning-briefing] You are OpenClaw automation.
Goal: Generate briefing.
DATA GATHERING:
1. Read /Users/josh/really/long/path/to/file.md
2. Parse ~/workspace/notes/today.md
3. Include outputs
4. Read /Users/josh/operations/runbook.md
5. Determine unresolved incidents
6. Extract owners and deadlines
OUTPUT FORMAT:
- greeting
- tasks
- followups
- incidents
- blockers
GROUNDING RULES:
- Never invent details
- Skip empty sections
- Omit stale items
Return your summary as plain text.
`.trim();

  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:deckard-morning-briefing", baseConfig);

  assert.equal(result.promptShape, "instruction_heavy");
  assert.equal(result.skipConversationRecall, true);
  assert.equal(result.retrievalBudgetMode, "minimal");
  assert.ok(result.retrievalQuery.length > 0);
  assert.ok(result.retrievalQuery.length <= 320);
  assert.equal(result.retrievalQuery.includes("/Users/"), false);
  assert.equal(result.retrievalQuery.includes("~/"), false);
});

test("buildRecallQueryPolicy preserves multilingual terms in instruction-heavy cron prompts", () => {
  const prompt = `
[cron:global-support-briefing] You are OpenClaw automation.
Goal: Generate multilingual support recall.
DATA GATHERING:
1. Read /Users/josh/support/ru.md
2. Read /Users/josh/support/el.md
3. Read /Users/josh/support/ar.md
4. Read /Users/josh/support/zh.md
5. Extract Привет incident notes
6. Include Καλημέρα launch notes
7. Include שלום account notes
8. Include مرحبا escalation notes
9. Include 用户喜欢深色模式 preferences
OUTPUT FORMAT:
- greeting
- tasks
- followups
- incidents
- blockers
GROUNDING RULES:
- Never invent details
- Skip empty sections
- Omit stale items
Return your summary as plain text.
`.trim();

  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:global-support-briefing", baseConfig);

  assert.equal(result.promptShape, "instruction_heavy");
  assert.match(result.retrievalQuery, /привет/u);
  assert.match(result.retrievalQuery, /καλημέρα/u);
  assert.match(result.retrievalQuery, /שלום/u);
  assert.match(result.retrievalQuery, /مرحبا/u);
  assert.equal(result.retrievalQuery.includes("用"), true);
  assert.equal(result.retrievalQuery.includes("/Users/"), false);
});

test("buildRecallQueryPolicy preserves combining-mark terms in instruction-heavy cron prompts", () => {
  const prompt = `
[cron:global-support-briefing] You are OpenClaw automation.
Goal: Generate multilingual support recall.
DATA GATHERING:
1. Read /Users/josh/support/hi.md
2. Read /Users/josh/support/th.md
3. Read /Users/josh/support/ta.md
4. Include हिंदी escalation notes
5. Include สวัสดี support notes
6. Include தமிழ் account notes
7. Extract unresolved owners
8. Determine escalation blockers
9. Omit stale resolved cases
OUTPUT FORMAT:
- greeting
- tasks
- followups
- incidents
- blockers
- accounts
- renewals
- risks
GROUNDING RULES:
- Never invent details
- Skip empty sections
- Omit stale items
FOLLOW-UP:
- Extract unresolved actions
- Include owners and due dates
Current time: Monday, February 23rd, 2026
Return your summary as plain text.
`.trim();

  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:global-support-briefing", baseConfig);

  assert.equal(result.promptShape, "instruction_heavy");
  assert.match(result.retrievalQuery, /हिंदी/u);
  assert.match(result.retrievalQuery, /สวัสดี/u);
  assert.match(result.retrievalQuery, /தமிழ்/u);
});

test("buildRecallQueryPolicy preserves exact identifiers in instruction-heavy cron prompts", () => {
  const prompt = `
[cron:support-queue] You are OpenClaw automation.
Goal: Generate support recall.
DATA GATHERING:
1. Read /Users/josh/support/incidents.md
2. Parse ~/workspace/crm.md
3. Include INC-123 incident status
4. Include crm:deal_456 account notes
5. Include api_retry runbook notes
6. Extract unresolved owners
7. Determine escalation blockers
8. Include renewal risk notes
9. Omit stale resolved cases
OUTPUT FORMAT:
- greeting
- tasks
- followups
- incidents
- blockers
- accounts
- renewals
- risks
GROUNDING RULES:
- Never invent details
- Skip empty sections
- Omit stale items
FOLLOW-UP:
- Extract unresolved actions
- Include owners and due dates
Current time: Monday, February 23rd, 2026
Return your summary as plain text.
`.trim();

  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:support-queue", baseConfig);

  assert.equal(result.promptShape, "instruction_heavy");
  assert.match(result.retrievalQuery, /\binc-123\b/u);
  assert.match(result.retrievalQuery, /\bcrm:deal_456\b/u);
  assert.match(result.retrievalQuery, /\bapi_retry\b/u);
});

test("buildRecallQueryPolicy preserves adjacent exact identifiers in instruction-heavy cron prompts", () => {
  const prompt = `
[cron:support-queue] You are OpenClaw automation.
Goal: Generate support recall.
DATA GATHERING:
1. Read /Users/josh/support/incidents.md
2. Parse ~/workspace/crm.md
3. Include INC-123/INC-456 incident status
4. Include CRM-789,crm:deal_456 account notes
5. Extract unresolved owners
6. Determine escalation blockers
7. Include renewal risk notes
8. Omit stale resolved cases
OUTPUT FORMAT:
- greeting
- tasks
- followups
- incidents
- blockers
- accounts
- renewals
- risks
GROUNDING RULES:
- Never invent details
- Skip empty sections
- Omit stale items
FOLLOW-UP:
- Extract unresolved actions
- Include owners and due dates
Current time: Monday, February 23rd, 2026
Return your summary as plain text.
`.trim();

  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:support-queue", baseConfig);

  assert.equal(result.promptShape, "instruction_heavy");
  assert.match(result.retrievalQuery, /\binc-123\b/u);
  assert.match(result.retrievalQuery, /\binc-456\b/u);
  assert.match(result.retrievalQuery, /\bcrm-789\b/u);
  assert.match(result.retrievalQuery, /\bcrm:deal_456\b/u);
});

test("buildRecallQueryPolicy preserves later terms after expanded CJK cron terms", () => {
  const prompt = `
[cron:global-support-briefing] You are OpenClaw automation.
Goal: Generate multilingual support recall.
DATA GATHERING:
1. Read /Users/josh/support/zh.md
2. Read /Users/josh/support/ru.md
3. Include 用户喜欢深色模式并且需要同步客户账户升级阻塞事项
4. Include Привет incident notes
5. Include INC-123 escalation notes
6. Extract unresolved owners
7. Determine escalation blockers
8. Include renewal risk notes
9. Omit stale resolved cases
OUTPUT FORMAT:
- greeting
- tasks
- followups
- incidents
- blockers
- accounts
- renewals
- risks
GROUNDING RULES:
- Never invent details
- Skip empty sections
- Omit stale items
FOLLOW-UP:
- Extract unresolved actions
- Include owners and due dates
Current time: Monday, February 23rd, 2026
Return your summary as plain text.
`.trim();

  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:global-support-briefing", {
    ...baseConfig,
    cronRecallInstructionHeavyTokenCap: 24,
  });

  assert.equal(result.promptShape, "instruction_heavy");
  assert.match(result.retrievalQuery, /привет/u);
  assert.match(result.retrievalQuery, /\binc-123\b/u);
});

test("buildRecallQueryPolicy keeps standard non-cron prompts full", () => {
  const prompt = "Can you   remind me\nwhat we decided last week about API retries?  ";
  const result = buildRecallQueryPolicy(prompt, "agent:generalist:main", baseConfig);

  assert.equal(result.promptShape, "standard");
  assert.equal(result.skipConversationRecall, false);
  assert.equal(result.retrievalBudgetMode, "full");
  assert.equal(result.retrievalQuery, prompt);
});

test("buildRecallQueryPolicy keeps raw prompt when cron policy is disabled", () => {
  const prompt = "  Keep   this\nas-is for recall query. ";
  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:deckard-morning-briefing", {
    ...baseConfig,
    cronRecallPolicyEnabled: false,
  });

  assert.equal(result.promptShape, "standard");
  assert.equal(result.skipConversationRecall, false);
  assert.equal(result.retrievalBudgetMode, "full");
  assert.equal(result.retrievalQuery, prompt);
});

test("cron conversation mode override always keeps conversation recall", () => {
  const prompt = `
Goal: Generate report
DATA GATHERING:
1. Read /Users/example/report.md
2. Parse ~/workspace/briefing.md
3. Extract unresolved actions
OUTPUT FORMAT:
- Summary
- Tasks
- Risks
GROUNDING RULES:
- Never invent details
- Return plain text
`.trim();

  const result = buildRecallQueryPolicy(prompt, "agent:generalist:cron:job-123", {
    ...baseConfig,
    cronConversationRecallMode: "always",
  });

  assert.equal(result.skipConversationRecall, false);
});
