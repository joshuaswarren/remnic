import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("persistExtraction serializes per-storage temporal index updates", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
    "utf-8",
  );
  assert.match(
    source,
    /for \(const entry of persistedIdsByStorage\.values\(\)\) \{\s*await this\.deps\.updateTemporalTagIndexes\(entry\.storage,\s*entry\.ids\);\s*\}/m,
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
