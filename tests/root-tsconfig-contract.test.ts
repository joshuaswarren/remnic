import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("root tsconfig is typecheck-only when package path aliases point at source files", () => {
  const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as {
    compilerOptions?: {
      noEmit?: boolean;
      paths?: Record<string, string[]>;
    };
  };

  const paths = tsconfig.compilerOptions?.paths ?? {};
  const sourceAliases = Object.entries(paths).filter(([, targets]) =>
    targets.some((target) => target.includes("/src/") || target.endsWith("/src/index.ts")),
  );

  assert.notEqual(sourceAliases.length, 0, "expected root tsconfig to define source-backed package aliases");
  assert.equal(
    tsconfig.compilerOptions?.noEmit,
    true,
    "root tsconfig must stay typecheck-only so source-backed aliases are not emitted into release output",
  );
});
