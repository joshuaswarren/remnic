import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("root tsconfig is typecheck-only and does not request emit artifacts", () => {
  const tsconfigPath = path.resolve(import.meta.dirname, "..", "tsconfig.json");
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8")) as {
    compilerOptions?: Record<string, unknown>;
  };
  const compilerOptions = tsconfig.compilerOptions ?? {};

  assert.equal(compilerOptions.noEmit, true);
  for (const option of ["outDir", "declaration", "declarationMap", "sourceMap"]) {
    assert.equal(
      Object.hasOwn(compilerOptions, option),
      false,
      `${option} must live in an emitting build config, not the root noEmit tsconfig`,
    );
  }
});
