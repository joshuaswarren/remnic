import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as canonicalCliFallback from "../cli-fallback.js";
import * as canonicalThreadKey from "../thread-key.js";
import * as aliasCliFallback from "./codex-cli-fallback.js";
import * as aliasThreadKey from "./codex-thread-key.js";

const pkgJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

test("codex-cli-fallback alias re-exports the same value symbols as cli-fallback", () => {
  // export * forwards live bindings by reference, so the function objects and
  // the test-hooks namespace are identical (===) across both subpaths.
  assert.equal(
    aliasCliFallback.callCodexCliFallback,
    canonicalCliFallback.callCodexCliFallback,
  );
  assert.equal(
    aliasCliFallback.setCodexCliFallbackRunnerForProcess,
    canonicalCliFallback.setCodexCliFallbackRunnerForProcess,
  );
  assert.equal(
    aliasCliFallback.__codexCliFallbackTestHooks,
    canonicalCliFallback.__codexCliFallbackTestHooks,
  );
});

test("codex-thread-key alias re-exports the same symbol as thread-key", () => {
  assert.equal(
    aliasThreadKey.CODEX_THREAD_KEY_PREFIX,
    canonicalThreadKey.CODEX_THREAD_KEY_PREFIX,
  );
  assert.equal(aliasThreadKey.CODEX_THREAD_KEY_PREFIX, "codex-thread:");
});

test("every named runtime export of cli-fallback is forwarded by the alias", () => {
  for (const key of Object.keys(canonicalCliFallback)) {
    assert.equal(
      key in aliasCliFallback,
      true,
      `alias missing forwarded export: ${key}`,
    );
  }
});

test("importing the old subpath resolves to the same symbol as the new subpath", async () => {
  // @remnic/core self-references its own exports map. Under --conditions=
  // remnic-source (set by preflight/test NODE_OPTIONS) the subpaths resolve to
  // src/. Both specifiers land on the same module record, so the exported
  // function is the same object reference.
  const [byNew, byOld] = await Promise.all([
    import("@remnic/core/cli-fallback"),
    import("@remnic/core/codex-cli-fallback"),
  ]);
  assert.equal(byOld.callCodexCliFallback, byNew.callCodexCliFallback);

  const [newKey, oldKey] = await Promise.all([
    import("@remnic/core/thread-key"),
    import("@remnic/core/codex-thread-key"),
  ]);
  assert.equal(oldKey.CODEX_THREAD_KEY_PREFIX, newKey.CODEX_THREAD_KEY_PREFIX);
});

test("the deprecated subpaths are registered with a removal timeline in the exports map", () => {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    exports: Record<string, { deprecated?: string; import?: string }>;
  };
  const aliasEntries = [
    "./codex-cli-fallback",
    "./codex-cli-fallback.js",
    "./codex-thread-key",
    "./codex-thread-key.js",
  ];
  for (const subpath of aliasEntries) {
    const entry = pkg.exports[subpath];
    assert.ok(entry, `missing exports entry for ${subpath}`);
    assert.ok(
      entry.deprecated,
      `exports entry for ${subpath} missing a deprecated field`,
    );
    assert.match(
      entry.deprecated,
      /v?10\.0\.0|remov/i,
      `deprecated field for ${subpath} should state a removal timeline`,
    );
    assert.ok(
      entry.import?.includes("/compat/"),
      `exports entry for ${subpath} should target the compat re-export module`,
    );
  }
});
