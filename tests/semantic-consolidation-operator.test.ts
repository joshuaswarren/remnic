/**
 * Tests for operator-aware consolidation prompt + parse (issue #561 PR 3).
 *
 * Covers:
 *   - `chooseConsolidationOperator` heuristic (cluster size → operator).
 *   - `buildOperatorAwareConsolidationPrompt` shape and operator vocab.
 *   - `parseOperatorAwareConsolidationResponse` accepts strict JSON,
 *     fenced code blocks, and prose-prefixed JSON — and falls back to the
 *     heuristic for malformed / unknown / plain-text responses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperatorAwareConsolidationPrompt,
  parseOperatorAwareConsolidationResponse,
  chooseConsolidationOperator,
  type ConsolidationCluster,
} from "../src/semantic-consolidation.ts";
import type { MemoryFile } from "../src/types.ts";

function makeMemory(id: string, content: string, created = "2026-04-19T00:00:00Z"): MemoryFile {
  return {
    path: `/memory/facts/${id}.md`,
    frontmatter: {
      id,
      category: "fact" as any,
      created,
      updated: created,
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied" as any,
      tags: [],
    },
    content,
  };
}

function makeCluster(n: number): ConsolidationCluster {
  return {
    category: "fact",
    memories: Array.from({ length: n }, (_, i) =>
      makeMemory(`fact-${i + 1}`, `Source content #${i + 1}`),
    ),
    overlapScore: 0.8,
  };
}

// ─── chooseConsolidationOperator ─────────────────────────────────────────────

test("chooseConsolidationOperator returns update for single-memory clusters", () => {
  assert.equal(chooseConsolidationOperator(makeCluster(1)), "update");
});

test("chooseConsolidationOperator returns merge for multi-memory clusters", () => {
  assert.equal(chooseConsolidationOperator(makeCluster(2)), "merge");
  assert.equal(chooseConsolidationOperator(makeCluster(5)), "merge");
});

// ─── buildOperatorAwareConsolidationPrompt ───────────────────────────────────

test("buildOperatorAwareConsolidationPrompt names all three operators", () => {
  const prompt = buildOperatorAwareConsolidationPrompt(makeCluster(3));
  assert.ok(prompt.includes('"merge"'));
  assert.ok(prompt.includes('"update"'));
  assert.ok(prompt.includes('"split"'));
});

test("buildOperatorAwareConsolidationPrompt asks for JSON-only output", () => {
  const prompt = buildOperatorAwareConsolidationPrompt(makeCluster(2));
  assert.ok(prompt.includes('"operator"'));
  assert.ok(prompt.includes('"output"'));
  assert.ok(prompt.toLowerCase().includes("json"));
});

test("buildOperatorAwareConsolidationPrompt example uses a concrete operator, not the pipe placeholder", () => {
  // PR #632 round-4 review (codex P2): the example JSON in the user
  // prompt previously contained the literal `"operator": "merge" |
  // "update" | "split"` placeholder, which some models would echo back
  // verbatim.  The example must show a concrete value like "merge".
  const prompt = buildOperatorAwareConsolidationPrompt(makeCluster(2));
  // The schema example block must include `"operator": "merge"` (a
  // concrete assignment).
  assert.match(prompt, /"operator":\s*"merge"/u);
  // Any mention of the pipe placeholder must be in a negative
  // instruction (i.e. context that tells the model NOT to use it).
  const pipeIdx = prompt.indexOf("merge|update|split");
  if (pipeIdx >= 0) {
    const context = prompt.slice(Math.max(0, pipeIdx - 100), pipeIdx);
    assert.match(
      context,
      /never|not|forbidden|do not/iu,
      "any pipe-placeholder mention must be framed negatively",
    );
  }
});

test("parseOperatorAwareConsolidationResponse tolerates JSON example blocks prepended by the model", () => {
  // Regression for PR #632 round-4 review (codex P1): previously the
  // parser sliced from first `{` to last `}`, which breaks when the
  // model includes an earlier brace block.  Switched to balanced-brace
  // scanning, so earlier blocks are skipped and the actual payload
  // parses correctly.
  const cluster = makeCluster(3);
  const prefixed = [
    "Here's what I'll emit:",
    '```',
    '{"note": "this is a per-operator example"}',
    '```',
    "Actual answer:",
    '{"operator":"merge","output":"actual canonical body"}',
  ].join("\n");
  const res = parseOperatorAwareConsolidationResponse(prefixed, cluster);
  assert.equal(res.operator, "merge");
  assert.equal(res.output, "actual canonical body");
});

test("parseOperatorAwareConsolidationResponse falls back when LLM returns the pipe-delimited placeholder", () => {
  // Regression for PR #632 review feedback (codex P2): if a model
  // follows the system prompt literally and emits the
  // `"merge|update|split"` placeholder string as the operator value,
  // the parser must fall back to the heuristic rather than accept the
  // malformed value.  The orchestrator now emits a system prompt that
  // explicitly forbids the placeholder, but defense-in-depth demands
  // the parser still reject it.
  const cluster = makeCluster(3);
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"merge|update|split","output":"placeholder body"}',
    cluster,
  );
  assert.equal(res.operator, "merge"); // heuristic for multi-memory cluster
  assert.equal(res.output, "placeholder body");
});

test("buildOperatorAwareConsolidationPrompt embeds every source memory", () => {
  const cluster = makeCluster(3);
  const prompt = buildOperatorAwareConsolidationPrompt(cluster);
  for (const m of cluster.memories) {
    assert.ok(prompt.includes(m.frontmatter.id));
    assert.ok(prompt.includes(m.content));
  }
});

// ─── parseOperatorAwareConsolidationResponse ─────────────────────────────────

test("parseOperatorAwareConsolidationResponse accepts strict JSON", () => {
  const cluster = makeCluster(3);
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"merge","output":"canonical body"}',
    cluster,
  );
  assert.equal(res.operator, "merge");
  assert.equal(res.output, "canonical body");
});

test("parseOperatorAwareConsolidationResponse accepts update and split operators", () => {
  const cluster = makeCluster(2);
  for (const op of ["update", "split"] as const) {
    const res = parseOperatorAwareConsolidationResponse(
      `{"operator":"${op}","output":"body-${op}"}`,
      cluster,
    );
    assert.equal(res.operator, op);
    assert.equal(res.output, `body-${op}`);
  }
});

test("parseOperatorAwareConsolidationResponse tolerates fenced code blocks", () => {
  const cluster = makeCluster(2);
  const fenced = [
    "```json",
    '{"operator":"merge","output":"fenced body"}',
    "```",
  ].join("\n");
  const res = parseOperatorAwareConsolidationResponse(fenced, cluster);
  assert.equal(res.operator, "merge");
  assert.equal(res.output, "fenced body");
});

test("parseOperatorAwareConsolidationResponse tolerates prose-prefixed JSON", () => {
  const cluster = makeCluster(2);
  const withProse =
    'Here is the consolidation result:\n\n{"operator":"update","output":"updated body"}\n';
  const res = parseOperatorAwareConsolidationResponse(withProse, cluster);
  assert.equal(res.operator, "update");
  assert.equal(res.output, "updated body");
});

test("parseOperatorAwareConsolidationResponse falls back to heuristic on plain text", () => {
  const cluster = makeCluster(3);
  const plain = "Joshua prefers TypeScript for backend work.";
  const res = parseOperatorAwareConsolidationResponse(plain, cluster);
  // Multi-memory cluster → heuristic returns "merge".
  assert.equal(res.operator, "merge");
  assert.equal(res.output, plain);
});

test("parseOperatorAwareConsolidationResponse falls back to heuristic for unknown operator", () => {
  const cluster = makeCluster(1);
  // Single-memory cluster → heuristic returns "update".
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"annihilate","output":"body"}',
    cluster,
  );
  assert.equal(res.operator, "update");
  assert.equal(res.output, "body");
});

test("parseOperatorAwareConsolidationResponse falls back on malformed JSON", () => {
  const cluster = makeCluster(4);
  const broken = '{"operator":"merge","output":"body"'; // missing closing brace
  const res = parseOperatorAwareConsolidationResponse(broken, cluster);
  // Heuristic fallback: multi-memory → merge; output is the raw trimmed text.
  assert.equal(res.operator, "merge");
  assert.equal(res.output, broken.trim());
});

test("parseOperatorAwareConsolidationResponse falls back when output field is empty", () => {
  const cluster = makeCluster(2);
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"merge","output":""}',
    cluster,
  );
  assert.equal(res.operator, "merge");
  // Empty output field → use raw trimmed response instead of dropping the
  // cluster.  Callers still write something rather than losing data.
  assert.equal(res.output, '{"operator":"merge","output":""}');
});

test("parseOperatorAwareConsolidationResponse never throws on weird inputs", () => {
  const cluster = makeCluster(2);
  const inputs = ["", "   ", "{}", "null", "[]", "not json at all"];
  for (const input of inputs) {
    const res = parseOperatorAwareConsolidationResponse(input, cluster);
    assert.ok(res.operator === "merge" || res.operator === "update" || res.operator === "split");
    assert.equal(typeof res.output, "string");
  }
});

test("parseOperatorAwareConsolidationResponse handles mixed-case operator values", () => {
  const cluster = makeCluster(2);
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"MERGE","output":"upper case"}',
    cluster,
  );
  assert.equal(res.operator, "merge");
  assert.equal(res.output, "upper case");
});

// ─── Config coercion (regression for PR #632 review feedback) ────────────────
// codex P1 / cursor Medium: `operatorAwareConsolidationEnabled` must
// coerce string-valued falsey config inputs (e.g.
// `--config operatorAwareConsolidationEnabled=false`) so the documented
// rollback escape hatch actually works when the CLI passes string
// values.

test("operatorAwareConsolidationEnabled coerces string 'false' to disabled", async () => {
  const { parseConfig } = await import("../src/config.ts");
  const parsed = parseConfig({ operatorAwareConsolidationEnabled: "false" } as any);
  assert.equal(parsed.operatorAwareConsolidationEnabled, false);
});

test("operatorAwareConsolidationEnabled defaults to false when unset", async () => {
  // Least-privileged default per PR #632 review (cursor): the operator-
  // aware prompt is opt-in so installs using older models don't hit
  // the JSON-format prompt by default.  When disabled, `derived_via`
  // still populates via the cluster-shape heuristic.
  const { parseConfig } = await import("../src/config.ts");
  const parsed = parseConfig({});
  assert.equal(parsed.operatorAwareConsolidationEnabled, false);
});

test("operatorAwareConsolidationEnabled honors boolean false", async () => {
  const { parseConfig } = await import("../src/config.ts");
  const parsed = parseConfig({ operatorAwareConsolidationEnabled: false });
  assert.equal(parsed.operatorAwareConsolidationEnabled, false);
});

// ─── PR #730 Cursor Bugbot: LLM cannot inject `pattern-reinforcement` ────────

test("parseOperatorAwareConsolidationResponse rejects LLM-emitted pattern-reinforcement operator", () => {
  // Pattern-reinforcement joined `ConsolidationOperator` in #687 PR 2/4
  // for the maintenance job, but the consolidation LLM must NEVER be
  // able to write it onto `derived_via`.  The narrow-gate parser must
  // fall back to the cluster-shape heuristic when the LLM hallucinates
  // that operator.
  const cluster = makeCluster(2);
  const res = parseOperatorAwareConsolidationResponse(
    JSON.stringify({ operator: "pattern-reinforcement", output: "canonical" }),
    cluster,
  );
  // Cluster of 2 → heuristic returns "merge".  Crucially NOT
  // "pattern-reinforcement".
  assert.equal(res.operator, "merge");
  assert.notEqual(res.operator, "pattern-reinforcement");
});

test("isSemanticConsolidationLlmOperator excludes pattern-reinforcement", async () => {
  const { isSemanticConsolidationLlmOperator } = await import(
    "../src/consolidation-operator.ts"
  );
  assert.equal(isSemanticConsolidationLlmOperator("split"), true);
  assert.equal(isSemanticConsolidationLlmOperator("merge"), true);
  assert.equal(isSemanticConsolidationLlmOperator("update"), true);
  // Reserved for the maintenance job — the LLM must not be able to
  // emit it through this gate.
  assert.equal(isSemanticConsolidationLlmOperator("pattern-reinforcement"), false);
  assert.equal(isSemanticConsolidationLlmOperator("garbage"), false);
});
