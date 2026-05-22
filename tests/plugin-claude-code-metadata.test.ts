import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Claude Code plugin manifest version matches package version", async () => {
  const packageJson = JSON.parse(
    await readFile("packages/plugin-claude-code/package.json", "utf8"),
  ) as { version?: unknown };
  const pluginJson = JSON.parse(
    await readFile("packages/plugin-claude-code/.claude-plugin/plugin.json", "utf8"),
  ) as { version?: unknown };

  assert.equal(pluginJson.version, packageJson.version);
});
