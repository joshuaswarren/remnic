import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVIDENCE_CLASSES,
  applyEvidenceClassRules,
  classifyEvidenceClasses,
  deriveFactEvidenceClass,
  deriveTurnEvidenceClass,
  echoQuoteKey,
  evidenceTurnInput,
  type EvidenceClass,
  type EvidenceClassTurnInput,
} from "./extraction-evidence-class.js";

function turn(overrides: Partial<EvidenceClassTurnInput> & Pick<EvidenceClassTurnInput, "content">): EvidenceClassTurnInput {
  return { role: "assistant", ...overrides };
}

// ---------------------------------------------------------------------------
// Deterministic turn-class derivation — table-driven across all classes
// ---------------------------------------------------------------------------

const DERIVATION_TABLE: ReadonlyArray<{
  label: string;
  input: Partial<EvidenceClassTurnInput>;
  expected: EvidenceClass;
}> = [
  { label: "user role", input: { role: "user" }, expected: "user" },
  { label: "user role despite stray tool flags", input: { role: "user", toolResult: true, toolCall: true }, expected: "user" },
  { label: "assistant with tool result", input: { role: "assistant", toolResult: true }, expected: "tool" },
  { label: "assistant with tool result outranks tool call", input: { role: "assistant", toolResult: true, toolCall: true }, expected: "tool" },
  { label: "assistant with tool call only", input: { role: "assistant", toolCall: true }, expected: "action" },
  { label: "assistant prose", input: { role: "assistant" }, expected: "agent" },
  { label: "explicit false flags", input: { role: "assistant", toolResult: false, toolCall: false }, expected: "agent" },
];

test("deriveTurnEvidenceClass: table-driven classes", () => {
  for (const row of DERIVATION_TABLE) {
    const input = turn({ content: "x", ...row.input });
    assert.equal(
      deriveTurnEvidenceClass(input),
      row.expected,
      `${row.label}: expected ${row.expected}`,
    );
  }
});

test("deriveTurnEvidenceClass: same input always yields the same class (determinism regression)", () => {
  for (const row of DERIVATION_TABLE) {
    const input = turn({ content: "x", ...row.input });
    const first = deriveTurnEvidenceClass(input);
    for (let i = 0; i < 50; i++) {
      assert.equal(deriveTurnEvidenceClass(input), first, `${row.label}: call ${i} diverged`);
    }
    // A structurally identical clone must not change the class either.
    const clone = turn({ content: "x", ...row.input });
    assert.equal(deriveTurnEvidenceClass(clone), first, `${row.label}: clone diverged`);
  }
});

test("deriveTurnEvidenceClass: unrelated fields never change the class", () => {
  const base = turn({ content: "deploy finished", role: "user" });
  const first = deriveTurnEvidenceClass(base);
  const noisy: EvidenceClassTurnInput = {
    ...base,
    content: "completely different content of a different length",
  };
  assert.equal(deriveTurnEvidenceClass(noisy), first);
});

// ---------------------------------------------------------------------------
// Buffer-turn adapter — tool part flags map mechanically
// ---------------------------------------------------------------------------

test("evidenceTurnInput: tool_result part flags the turn as machine output", () => {
  const input = evidenceTurnInput({
    role: "assistant",
    content: "exit 0, 3 files changed",
    parts: [{ kind: "tool_result" }, { kind: "text" }],
  });
  assert.equal(input.toolResult, true);
  assert.equal(input.toolCall, undefined);
  assert.equal(deriveTurnEvidenceClass(input), "tool");
});

test("evidenceTurnInput: tool_call part flags an invocation", () => {
  const input = evidenceTurnInput({
    role: "assistant",
    content: "running the test suite",
    parts: [{ kind: "tool_call" }],
  });
  assert.equal(input.toolCall, true);
  assert.equal(deriveTurnEvidenceClass(input), "action");
});

test("evidenceTurnInput: plain parts derive agent prose", () => {
  const input = evidenceTurnInput({
    role: "assistant",
    content: "I think this looks fine",
    parts: [{ kind: "text" }],
  });
  assert.equal(deriveTurnEvidenceClass(input), "agent");
});

test("evidenceTurnInput: user role passes through", () => {
  const input = evidenceTurnInput({ role: "user", content: "ship it Friday" });
  assert.deepEqual(input, { role: "user", content: "ship it Friday" });
  assert.equal(deriveTurnEvidenceClass(input), "user");
});

// ---------------------------------------------------------------------------
// Fact-level span classification — reuses the provenance matcher
// ---------------------------------------------------------------------------

const USER_TURN = turn({ role: "user", content: "we renewed the license for 40 seats" });
const TOOL_TURN = turn({ role: "assistant", toolResult: true, content: "invoice total: 40 seats, $12,800 per year" });
const AGENT_TURN = turn({ role: "assistant", content: "the team seems happy with the current vendor" });

test("classifyEvidenceClasses: quote located in a user turn classifies user", () => {
  const classes = classifyEvidenceClasses({
    quote: "renewed the license",
    turns: [USER_TURN, TOOL_TURN, AGENT_TURN],
  });
  assert.deepEqual(classes, ["user"]);
});

test("classifyEvidenceClasses: quote in tool output classifies tool", () => {
  const classes = classifyEvidenceClasses({
    quote: "$12,800 per year",
    turns: [USER_TURN, TOOL_TURN, AGENT_TURN],
  });
  assert.deepEqual(classes, ["tool"]);
});

test("classifyEvidenceClasses: quote echoed in user and agent turns returns canonical order", () => {
  const shared = turn({ role: "user", content: "the cache TTL is 300 seconds" });
  const echo = turn({ role: "assistant", content: "as noted, the cache TTL is 300 seconds" });
  const classes = classifyEvidenceClasses({ quote: "the cache TTL is 300 seconds", turns: [echo, shared] });
  assert.deepEqual(classes, ["user", "agent"], "input order must not leak into output order");
});

test("classifyEvidenceClasses: leading prompt role label is stripped before matching", () => {
  const classes = classifyEvidenceClasses({
    quote: "[user] we renewed the license",
    turns: [USER_TURN],
  });
  assert.deepEqual(classes, ["user"]);
});

test("classifyEvidenceClasses: whitespace and case differences still locate (shared matcher)", () => {
  const classes = classifyEvidenceClasses({
    quote: "Invoice  Total:  40 SEATS",
    turns: [TOOL_TURN],
  });
  assert.deepEqual(classes, ["tool"]);
});

test("classifyEvidenceClasses: no quote and unlocatable quote both yield no classes", () => {
  assert.deepEqual(classifyEvidenceClasses({ quote: "", turns: [USER_TURN] }), []);
  assert.deepEqual(classifyEvidenceClasses({ quote: undefined, turns: [USER_TURN] }), []);
  assert.deepEqual(classifyEvidenceClasses({ quote: "never said this", turns: [USER_TURN] }), []);
});

test("classifyEvidenceClasses: determinism regression over repeated and reordered calls", () => {
  const input = { quote: "the cache TTL is 300 seconds", turns: [USER_TURN, TOOL_TURN, AGENT_TURN] };
  const first = classifyEvidenceClasses(input);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(classifyEvidenceClasses(input), first, `call ${i} diverged`);
  }
  const reordered = { quote: input.quote, turns: [...input.turns].reverse() };
  assert.deepEqual(classifyEvidenceClasses(reordered), first, "turn order must not change the class set");
});

// ---------------------------------------------------------------------------
// Fact-level single class — strongest present license wins
// ---------------------------------------------------------------------------

test("deriveFactEvidenceClass: strongest class present wins in fixed order", () => {
  assert.equal(deriveFactEvidenceClass(["user", "agent"]), "user");
  assert.equal(deriveFactEvidenceClass(["tool", "agent"]), "tool");
  assert.equal(deriveFactEvidenceClass(["action", "agent"]), "action");
  assert.equal(deriveFactEvidenceClass(["agent"]), "agent");
});

test("deriveFactEvidenceClass: no located span means agent-asserted", () => {
  assert.equal(deriveFactEvidenceClass([]), "agent");
});

test("deriveFactEvidenceClass: every class round-trips through the canonical order", () => {
  const all = EVIDENCE_CLASSES.slice();
  for (const cls of all) {
    assert.equal(deriveFactEvidenceClass([cls, "agent"]), cls);
  }
});

// ---------------------------------------------------------------------------
// Deterministic post-extraction rules — each case a smuggling attempt
// ---------------------------------------------------------------------------

test("rule: agent-asserted user decision never passes (assertion loop)", () => {
  // The agent asserts the human decided something; the only surviving span is
  // agent prose. This is the self-reinforcing loop the rules must break.
  const findings = applyEvidenceClassRules({
    content: "The user decided to migrate the database to Postgres",
    category: "decision",
    evidenceClasses: ["agent"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "user_attribution_without_user_span");
  assert.equal(findings[0]!.action, "refuse");
});

test("rule: user decision backed by a user span passes the attribution gate", () => {
  const findings = applyEvidenceClassRules({
    content: "The user decided to migrate the database to Postgres",
    category: "decision",
    evidenceClasses: ["user"],
  });
  assert.deepEqual(findings, []);
});

test("rule: agent-own decision honestly attributed is not refused", () => {
  const findings = applyEvidenceClassRules({
    content: "The agent chose the conservative retry policy",
    category: "decision",
    subject: "agent",
    evidenceClasses: ["agent"],
  });
  assert.deepEqual(findings, []);
});

test("rule: preference and commitment are decision-like too", () => {
  for (const category of ["preference", "commitment"]) {
    const findings = applyEvidenceClassRules({ content: "wants weekly digests", category, evidenceClasses: ["agent"] });
    assert.equal(findings[0]?.rule, "user_attribution_without_user_span", category);
  }
  const factCategory = applyEvidenceClassRules({ content: "wants weekly digests", category: "fact", evidenceClasses: ["agent"] });
  assert.deepEqual(factCategory, [], "plain facts are not user attributions");
});

test("rule: number without tool or action evidence is demoted", () => {
  const findings = applyEvidenceClassRules({
    content: "The cluster holds 5000 documents",
    category: "fact",
    evidenceClasses: ["agent"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "numeric_without_tool_evidence");
  assert.equal(findings[0]!.action, "demote");
});

test("rule: number with tool evidence passes", () => {
  assert.deepEqual(
    applyEvidenceClassRules({ content: "The cluster holds 5000 documents", category: "fact", evidenceClasses: ["tool"] }),
    [],
  );
});

test("rule: number with action evidence passes", () => {
  assert.deepEqual(
    applyEvidenceClassRules({ content: "The cluster holds 5000 documents", category: "fact", evidenceClasses: ["action"] }),
    [],
  );
});

test("rule: number in a user-spanned fact still demotes — the human is not a licit number source", () => {
  const findings = applyEvidenceClassRules({
    content: "We bought 40 seats",
    category: "fact",
    evidenceClasses: ["user"],
  });
  assert.equal(findings[0]?.rule, "numeric_without_tool_evidence");
});

test("rule: no evidence classes at all demotes numeric content", () => {
  const findings = applyEvidenceClassRules({ content: "cost is 5000", category: "fact", evidenceClasses: [] });
  assert.equal(findings[0]?.rule, "numeric_without_tool_evidence");
});

test("rule: echo of existing store content is refused", () => {
  const existing = new Set([echoQuoteKey("the cache TTL is 300 seconds")]);
  const findings = applyEvidenceClassRules({
    content: "The cache TTL is 300 seconds",
    category: "fact",
    evidenceClasses: ["tool"],
    quoteKeys: [echoQuoteKey("the cache TTL is 300 seconds")],
    existingQuoteKeys: existing,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "echo_of_existing_content");
  assert.equal(findings[0]!.action, "refuse");
});

test("rule: one fresh quote survives echo suppression", () => {
  const existing = new Set([echoQuoteKey("old quote")]);
  const findings = applyEvidenceClassRules({
    content: "something new",
    category: "fact",
    evidenceClasses: ["tool"],
    quoteKeys: [echoQuoteKey("old quote"), echoQuoteKey("a brand new observation")],
    existingQuoteKeys: existing,
  });
  assert.deepEqual(findings, []);
});

test("rule: no quote keys or no index means echo rule stays silent", () => {
  assert.deepEqual(
    applyEvidenceClassRules({ content: "x", category: "fact", evidenceClasses: ["tool"] }),
    [],
  );
  assert.deepEqual(
    applyEvidenceClassRules({
      content: "x", category: "fact", evidenceClasses: ["tool"], quoteKeys: [echoQuoteKey("q")],
    }),
    [],
  );
});

test("rule: combined smuggling — agent-asserted decision carrying a number", () => {
  const findings = applyEvidenceClassRules({
    content: "The user approved a budget of 9000 for the migration",
    category: "decision",
    evidenceClasses: ["agent"],
  });
  assert.deepEqual(
    findings.map((f) => f.rule),
    ["numeric_without_tool_evidence", "user_attribution_without_user_span"],
  );
});

test("rule: same input always yields the same findings (determinism regression)", () => {
  const input = {
    content: "The user approved a budget of 9000 for the migration",
    category: "decision" as const,
    evidenceClasses: ["agent"] as const,
    quoteKeys: [echoQuoteKey("q1")] as const,
    existingQuoteKeys: new Set([echoQuoteKey("q1")]),
  };
  const first = applyEvidenceClassRules(input);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(applyEvidenceClassRules(input), first, `call ${i} diverged`);
  }
  // Findings order is canonical (rule id order), not input-order dependent.
  assert.deepEqual(first.map((f) => f.rule), [
    "numeric_without_tool_evidence",
    "user_attribution_without_user_span",
    "echo_of_existing_content",
  ]);
});

test("echoQuoteKey is case- and whitespace-insensitive and stable", () => {
  assert.equal(echoQuoteKey("The  Cache TTL"), echoQuoteKey("the cache ttl"));
  assert.equal(echoQuoteKey("x"), echoQuoteKey("x"));
  assert.equal(echoQuoteKey("  spaced  out  "), "spaced out");
});
