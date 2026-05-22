import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelRegistry } from "./model-registry.js";

test("calculateContextSizes keeps output budget inside a small valid override", () => {
  const dir = mkdtempSync(join(tmpdir(), "remnic-model-registry-"));
  try {
    const registry = new ModelRegistry(dir);
    const sizes = registry.calculateContextSizes("local-model", 1024);

    assert.equal(sizes.maxOutputTokens, 256);
    assert.match(sizes.description, /1,024 context \(user override\)/);
    assert.ok(sizes.maxInputChars > 0);
    assert.ok(sizes.maxOutputTokens < 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calculateContextSizes ignores invalid or tiny override values before budgeting", () => {
  const dir = mkdtempSync(join(tmpdir(), "remnic-model-registry-"));
  try {
    const registry = new ModelRegistry(dir);
    for (const override of [0, 128, 256, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sizes = registry.calculateContextSizes("local-model", override);

      assert.match(sizes.description, /32,768 context \(default\)/);
      assert.ok(sizes.maxInputChars > 0);
      assert.ok(sizes.maxOutputTokens < 32768);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
