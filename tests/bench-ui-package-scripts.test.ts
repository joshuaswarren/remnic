import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bench-ui build runs type checking before Vite", async () => {
  const packageJson = JSON.parse(
    await readFile(
      new URL("../packages/bench-ui/package.json", import.meta.url),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };

  const buildScript = packageJson.scripts?.build ?? "";
  const checkIndex = buildScript.indexOf("check-types");
  const viteIndex = buildScript.indexOf("vite build");

  assert.notEqual(checkIndex, -1);
  assert.notEqual(viteIndex, -1);
  assert.ok(checkIndex < viteIndex);
});

test("bench-ui test script discovers root and nested tests without globstar", async () => {
  const packageJson = JSON.parse(
    await readFile(
      new URL("../packages/bench-ui/package.json", import.meta.url),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };

  const testScript = packageJson.scripts?.test ?? "";
  assert.match(testScript, /--conditions=remnic-source/);
  assert.doesNotMatch(testScript, /\*\*/);
  assert.match(testScript, /\bfind\b/);
  assert.match(testScript, /\bxargs\b/);
  assert.match(testScript, /\*\.test\.ts/);
  assert.match(testScript, /\*\.test\.tsx/);
});
