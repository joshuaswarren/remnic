import assert from "node:assert/strict";
import test from "node:test";

import { buildAnalysisPrompt } from "./analysis-prompt.js";

test("empty observations render (empty)", () => {
  const first = buildAnalysisPrompt({ observations: [] });
  const second = buildAnalysisPrompt({ observations: [] });
  assert.match(first, /\(empty\)/);
  assert.equal(first, second);
  assert.doesNotMatch(first, /\[\s*\{/);
});

test("observations sort by id, not input order", () => {
  const prompt = buildAnalysisPrompt({
    observations: [
      { id: 3, capturedAtUtc: "2026-08-17T12:00:00.000Z" },
      { id: 1, capturedAtUtc: "2026-08-17T10:00:00.000Z" },
      { id: 2, capturedAtUtc: "2026-08-17T11:00:00.000Z" },
    ],
  });
  const first = prompt.indexOf('"id":1');
  const second = prompt.indexOf('"id":2');
  const third = prompt.indexOf('"id":3');
  assert.ok(first >= 0 && second > first && third > second);
  assert.match(prompt, /2026-08-17T10:00:00.000Z/);
  assert.match(prompt, /2026-08-17T11:00:00.000Z/);
  assert.match(prompt, /2026-08-17T12:00:00.000Z/);
});

test("free-text body and extra fields do not leak", () => {
  const prompt = buildAnalysisPrompt({
    observations: [
      {
        id: 9,
        capturedAtUtc: "2026-08-17T09:00:00.000Z",
        body: "SECRET-BODY",
        text: "SECRET-TEXT",
        windowTitle: "SECRET-TITLE",
        app: "SECRET-APP",
      } as { id: number; capturedAtUtc: string },
    ],
  });
  assert.equal(prompt.includes("SECRET-BODY"), false);
  assert.equal(prompt.includes("SECRET-TEXT"), false);
  assert.equal(prompt.includes("SECRET-TITLE"), false);
  assert.equal(prompt.includes("SECRET-APP"), false);
  assert.match(prompt, /"id":9/);
  assert.match(prompt, /2026-08-17T09:00:00.000Z/);
});
