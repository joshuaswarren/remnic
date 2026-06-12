import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  applyCorrections,
  compileCorrectionRule,
  compileCorrectionRules,
  loadCorrectionsFile,
  saveCorrectionsFile,
} from "./corrections.js";

function compiled(rules: Parameters<typeof compileCorrectionRules>[0]) {
  return compileCorrectionRules(rules, "test");
}

test("literal rules match on word boundaries, case-insensitive by default", () => {
  const rules = compiled([{ match: "remnick", replace: "Remnic" }]);
  assert.equal(
    applyCorrections("Remnick and REMNICK but not remnickson", rules, "limitless").text,
    "Remnic and Remnic but not remnickson",
  );
});

test("literal rules escape regex metacharacters", () => {
  const rules = compiled([{ match: "node.js (v22)", replace: "Node 22" }]);
  const result = applyCorrections("we run node.js (v22) here", rules, "limitless");
  assert.equal(result.text, "we run Node 22 here");
  assert.equal(result.applied, 1);
  // The dot must not act as a wildcard.
  assert.equal(
    applyCorrections("nodeXjs (v22)", rules, "limitless").applied,
    0,
  );
});

test("dollar signs in replacements stay literal", () => {
  const rules = compiled([{ match: "five bucks", replace: "$5 ($$ saved)" }]);
  assert.equal(
    applyCorrections("that cost five bucks", rules, "limitless").text,
    "that cost $5 ($$ saved)",
  );
});

test("regex rules work and case sensitivity is honored", () => {
  const rules = compiled([
    { match: "colou?r", replace: "color", regex: true, caseInsensitive: false },
  ]);
  const result = applyCorrections("colour Colour", rules, "limitless");
  assert.equal(result.text, "color Colour");
});

test("rules scoped to sources skip other sources", () => {
  const rules = compiled([
    { match: "panda", replace: "Pendant", sources: ["limitless"] },
  ]);
  assert.equal(applyCorrections("my panda", rules, "limitless").applied, 1);
  assert.equal(applyCorrections("my panda", rules, "bee").applied, 0);
});

test("invalid rules are rejected loudly at compile time", () => {
  assert.throws(() => compileCorrectionRule({ match: "", replace: "x" }, "r"), /non-empty/);
  assert.throws(
    () => compileCorrectionRule({ match: "(", replace: "x", regex: true }, "r"),
    /not a valid regular expression/,
  );
  assert.throws(
    () => compileCorrectionRule({ match: "a*", replace: "x", regex: true }, "r"),
    /matches the empty string/,
  );
});

test("corrections file round-trips, validates, and tolerates absence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-corrections-"));
  try {
    assert.deepEqual(await loadCorrectionsFile(dir), []);
    const rules = [
      { match: "remnick", replace: "Remnic" },
      { match: "acme corp", replace: "ACME Corp", sources: ["bee"] },
    ];
    await saveCorrectionsFile(dir, rules);
    assert.deepEqual(await loadCorrectionsFile(dir), rules);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt corrections file throws instead of silently dropping rules", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-corrections-"));
  try {
    const { promises: fsPromises } = await import("node:fs");
    const filePath = path.join(dir, "state", "wearables", "corrections.json");
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, "{not json", "utf-8");
    await assert.rejects(loadCorrectionsFile(dir), /not valid JSON/);
    await fsPromises.writeFile(filePath, JSON.stringify({ rules: "nope" }), "utf-8");
    await assert.rejects(loadCorrectionsFile(dir), /unexpected shape/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving an invalid rule set is rejected before touching the file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-corrections-"));
  try {
    await saveCorrectionsFile(dir, [{ match: "good", replace: "fine" }]);
    await assert.rejects(
      saveCorrectionsFile(dir, [{ match: "(", replace: "x", regex: true }]),
      /not a valid regular expression/,
    );
    // The previously-saved rules are still intact.
    assert.equal((await loadCorrectionsFile(dir)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
