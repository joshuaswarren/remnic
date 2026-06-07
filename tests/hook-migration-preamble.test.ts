import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Codex plugin's hooks moved to a single unified Node.js runner
// (issue #1440). Its migration preamble is `ensureMigrated()` in
// `packages/plugin-codex/hooks/bin/remnic-codex-hook.cjs`, asserted by the
// runner's own integration tests. The bash scripts here remain for the
// Claude Code plugin only.
const hookFiles = [
  "packages/plugin-claude-code/hooks/bin/session-start.sh",
  "packages/plugin-claude-code/hooks/bin/user-prompt-recall.sh",
  "packages/plugin-claude-code/hooks/bin/post-tool-observe.sh",
];

for (const hookFile of hookFiles) {
  test(`${hookFile} runs the rename migration preamble`, async () => {
    const content = await readFile(hookFile, "utf8");
    assert.match(content, /ensure_migrated\(\)/);
    assert.match(content, /\.migrated-from-engram/);
    assert.match(content, /remnic migrate/);
  });
}
