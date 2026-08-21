import assert from "node:assert/strict";
import test from "node:test";

import {
  corpusDominantLanguage,
  detectLanguageHint,
  planCrossScript,
} from "./cross-lingual-recall.js";

test("detectLanguageHint distinguishes Latin and Japanese", () => {
  assert.equal(detectLanguageHint("what did we decide about the deployment?"), "latn");
  assert.equal(detectLanguageHint("これはテストです"), "jpan");
  assert.equal(detectLanguageHint("デプロイは金曜に延期と決定"), "jpan");
});

test("legacy memories without a language hint do not vote", () => {
  assert.equal(corpusDominantLanguage([undefined, undefined, "jpan", "jpan", "latn"]), "jpan");
  assert.equal(corpusDominantLanguage([undefined, undefined]), undefined);
});

test("cross-script plan leans on vector and signals when embeddings are missing", () => {
  const withVector = planCrossScript({
    queryLanguage: "latn",
    corpusLanguage: "jpan",
    vectorTierAvailable: true,
  });
  assert.equal(withVector.crossScript, true);
  assert.equal(withVector.degradation, undefined);

  const withoutVector = planCrossScript({
    queryLanguage: "latn",
    corpusLanguage: "jpan",
    vectorTierAvailable: false,
  });
  assert.equal(withoutVector.crossScript, true);
  assert.equal(withoutVector.degradation?.code, "vector_tier_unavailable");
});

test("same-script query does not degrade", () => {
  const plan = planCrossScript({
    queryLanguage: "latn",
    corpusLanguage: "latn",
    vectorTierAvailable: false,
  });
  assert.equal(plan.crossScript, false);
  assert.equal(plan.degradation, undefined);
});
