import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Codex plugin's hooks moved to a single cross-platform Node.js runner
// (issue #1440) — `packages/plugin-codex/hooks/bin/remnic-codex-hook.cjs`.
// Behavior is exercised end-to-end in
// `packages/plugin-codex/hooks/bin/remnic-codex-hook.test.cjs`. The bash
// scripts below remain authoritative for the Claude Code plugin.
const hookFiles = [
  "packages/plugin-claude-code/hooks/bin/session-start.sh",
];

for (const hookFile of hookFiles) {
  test(`${hookFile} retries legacy token store when remnic token parsing fails`, async () => {
    const content = await readFile(hookFile, "utf8");
    assert.match(content, /TOKEN_FILES=\("\$\{HOME\}\/\.remnic\/tokens\.json" "\$\{HOME\}\/\.engram\/tokens\.json"\)/);
    assert.match(content, /for TOKEN_FILE in "\$\{TOKEN_FILES\[@\]\}"; do/);
    assert.match(content, /readFileSync\(process\.argv\[1\],'utf8'\)/);
    assert.match(content, /2>\/dev\/null \|\| echo ""\)/);
    assert.match(content, /\[ -n "\$REMNIC_TOKEN" \] && break/);
  });
}
