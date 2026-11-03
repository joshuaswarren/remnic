import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("persistExtraction serializes per-storage temporal index updates", () => {
  // The loop lives in the shared batch-end finalization (#3231), which both the success path and the partial-failure paths call.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist-promotion.ts"),
    "utf-8",
  );
  assert.match(
    source,
    /for \(const entry of options\.persistedIdsByStorage\.values\(\)\) \{\s*await options\.updateTemporalTagIndexes\(entry\.storage,\s*entry\.ids\);\s*\}/m,
    "per-storage temporal index updates should run serially to avoid concurrent index file races",
  );
});

test("persistExtraction derives intent from routed category", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
    "utf-8",
  );
  assert.match(
    source,
    /inferIntentFromText\([\s\S]*writeCategory[\s\S]*fact\.tags\.join\(" "\)[\s\S]*fact\.content[\s\S]*\)/m,
    "intent inference should use routed category so downstream intent metadata matches write target",
  );
});
