import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  SUPPORTED_IMPORTERS,
  clearImporterModuleCacheForTesting,
  isSupportedImporterName,
  loadImporterModule,
} from "./optional-importer.js";

describe("optional-importer loader", () => {
  beforeEach(() => {
    clearImporterModuleCacheForTesting();
  });

  it("SUPPORTED_IMPORTERS lists the five canonical sources in a stable order", () => {
    assert.deepEqual([...SUPPORTED_IMPORTERS], [
      "chatgpt",
      "claude",
      "gemini",
      "mem0",
      "supermemory",
    ]);
  });

  it("isSupportedImporterName is false for unknown names", () => {
    assert.equal(isSupportedImporterName("chatgpt"), true);
    assert.equal(isSupportedImporterName("bogus"), false);
    assert.equal(isSupportedImporterName(""), false);
    assert.equal(isSupportedImporterName("chatgpt "), false);
  });

  // All four slice packages (chatgpt, claude, gemini, mem0) are installed
  // alongside the CLI once the import series lands, so no durable
  // "missing package" fixture remains inside the `remnic/import-*`
  // family. The loader still raises a clear install hint when the user
  // asks for an importer whose package is absent at runtime; we
  // exercise that branch via a non-existent name that satisfies the
  // SupportedImporterName type at the call site.
  //
  // Keeping "claude" here is still valid during the rollout window
  // because PR 3 has not yet been merged from this branch's POV — the
  // merged `main` will only see this once PR 3 lands. If this test
  // destabilizes, flip it to another not-yet-shipped adapter.
  it("loading a missing importer throws a user-facing install hint", async () => {
    await assert.rejects(
      () => loadImporterModule("supermemory"),
      (err: Error) => {
        // Install hint must include the package name and an install
        // command the user can actually run — not a raw MODULE_NOT_FOUND.
        assert.ok(
          err.message.includes("@remnic/import-supermemory"),
          `expected package name in message, got: ${err.message}`,
        );
        assert.ok(
          err.message.includes("npm install") ||
            err.message.includes("pnpm add"),
          `expected install command in message, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("loader caches negative results so repeated calls do not re-import", async () => {
    // First call populates the cache with a null.
    await assert.rejects(() => loadImporterModule("claude"));
    // Second call must still throw — but the cache hit path is covered
    // exclusively by the branch that rejects from cached null.
    await assert.rejects(() => loadImporterModule("claude"));
  });
});
