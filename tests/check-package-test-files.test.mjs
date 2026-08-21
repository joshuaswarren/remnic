import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findMissingTestFiles } from "../scripts/check-package-test-files.mjs";

test("reports a test script file that does not exist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-files-"));
  mkdirSync(path.join(root, "packages", "import-weclone", "src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages", "import-weclone", "package.json"),
    JSON.stringify({
      scripts: {
        test: "tsx --test src/parser.test.ts src/threader.test.ts",
      },
    }),
  );
  writeFileSync(path.join(root, "packages", "import-weclone", "src", "parser.test.ts"), "");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {} }));
  const missing = findMissingTestFiles(root);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /threader\.test\.ts/);
});

test("ignores glob tokens and present files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-files-ok-"));
  mkdirSync(path.join(root, "packages", "pkg", "src"), { recursive: true });
  writeFileSync(path.join(root, "packages", "pkg", "src", "ok.test.ts"), "");
  writeFileSync(
    path.join(root, "packages", "pkg", "package.json"),
    JSON.stringify({
      scripts: { test: "tsx --test src/ok.test.ts src/**/*.test.ts" },
    }),
  );
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {} }));
  assert.deepEqual(findMissingTestFiles(root), []);
});
