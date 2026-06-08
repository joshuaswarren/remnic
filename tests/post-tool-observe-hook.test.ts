import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Codex plugin's PostToolUse hook moved to a unified Node.js runner
// (issue #1440 — packages/plugin-codex/hooks/bin/remnic-codex-hook.cjs).
// State/cursor/lock hardening is exercised end-to-end by
// `packages/plugin-codex/hooks/bin/remnic-codex-hook.test.cjs`.
const hookFiles = [
  "packages/plugin-claude-code/hooks/bin/post-tool-observe.sh",
];

for (const hookFile of hookFiles) {
  test(`${hookFile} stores cursor and lock files in private state`, async () => {
    const content = await readFile(hookFile, "utf8");

    assert.match(content, /STATE_HOME="\$\{XDG_STATE_HOME:-\$\{HOME\}\/\.local\/state\}"/);
    assert.match(content, /STATE_DIR="\$\{STATE_HOME\}\/remnic\/hooks"/);
    assert.match(content, /CURSOR_FILE="\$\{STATE_DIR\}\/remnic-cursor-\$\{SESSION_ID\}"/);
    assert.match(content, /LOCK_DIR="\$\{STATE_DIR\}\/remnic-lock-\$\{SESSION_ID\}\.d"/);
    assert.match(content, /LEGACY_CURSOR_FILE="\$\{STATE_DIR\}\/engram-cursor-\$\{SESSION_ID\}"/);
    assert.match(content, /LEGACY_LOCK_DIR="\$\{STATE_DIR\}\/engram-lock-\$\{SESSION_ID\}\.d"/);
    assert.match(content, /CURSOR_FILE="\$LEGACY_CURSOR_FILE"/);
    assert.match(content, /LOCK_DIR="\$LEGACY_LOCK_DIR"/);
    assert.match(content, /validate_cursor_file\(\)/);
    assert.match(content, /write_cursor_file\(\)/);
    assert.match(content, /migrate_tmp_cursor_file\(\)/);
    assert.doesNotMatch(content, /> "\$CURSOR_FILE"/);
    assert.doesNotMatch(content, /CURSOR_FILE="\/tmp/);
    assert.doesNotMatch(content, /LOCK_DIR="\/tmp/);
  });

  test(`${hookFile} retries legacy engram tokens when remnic token parsing fails`, async () => {
    const content = await readFile(hookFile, "utf8");

    assert.match(content, /for TOKEN_FILE in "\$\{HOME\}\/\.remnic\/tokens\.json" "\$\{HOME\}\/\.engram\/tokens\.json"; do/);
    assert.match(content, /\[ ! -f "\$TOKEN_FILE" \] && continue/);
    assert.match(content, /JSON\.parse\(fs\.readFileSync\(tokenFile, 'utf8'\)\)/);
    assert.match(content, /\[ -n "\$REMNIC_TOKEN" \] && break/);
  });
}
