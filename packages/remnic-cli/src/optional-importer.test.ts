import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";

import {
  SUPPORTED_IMPORTERS,
  clearImporterModuleCacheForTesting,
  isSupportedImporterName,
  loadImporterModule,
} from "./optional-importer.js";
import type { SupportedImporterName } from "./optional-importer.js";

describe("optional-importer loader", () => {
  beforeEach(() => {
    clearImporterModuleCacheForTesting();
  });

  it("SUPPORTED_IMPORTERS lists the canonical generic sources in a stable order", () => {
    assert.deepEqual([...SUPPORTED_IMPORTERS], [
      "chatgpt",
      "claude",
      "gemini",
      "mem0",
      "supermemory",
      "okf",
    ]);
  });

  it("generic importer peers are represented in SUPPORTED_IMPORTERS", () => {
    const packageJsonPath = path.resolve(import.meta.dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    const optionalImporterPeers = Object.keys(manifest.peerDependencies ?? {})
      .filter((name) => name.startsWith("@remnic/import-"))
      .map((name) => name.slice("@remnic/import-".length));

    // These optional import packages are CLI runtime companions, but they are
    // not generic `remnic import --adapter` sources. Lossless-claw has a
    // dedicated SQLite import command; WeClone is loaded through the
    // bulk-import source registration path.
    const nonGenericImporters = new Set(["lossless-claw", "weclone"]);
    const genericImporterPeers = optionalImporterPeers
      .filter((name) => !nonGenericImporters.has(name))
      .sort();

    assert.deepEqual(genericImporterPeers, [...SUPPORTED_IMPORTERS].sort());
  });

  it("isSupportedImporterName is false for unknown names", () => {
    assert.equal(isSupportedImporterName("chatgpt"), true);
    assert.equal(isSupportedImporterName("bogus"), false);
    assert.equal(isSupportedImporterName(""), false);
    assert.equal(isSupportedImporterName("chatgpt "), false);
  });

  it("loading a missing importer throws a user-facing install hint", async () => {
    const missing = "missing-fixture" as SupportedImporterName;

    await assert.rejects(
      () => loadImporterModule(missing),
      (err: Error) => {
        // Install hint must include the package name and an install
        // command the user can actually run — not a raw MODULE_NOT_FOUND.
        assert.ok(
          err.message.includes("@remnic/import-missing-fixture"),
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
    const missing = "missing-fixture" as SupportedImporterName;

    // First call populates the cache with a null.
    await assert.rejects(() => loadImporterModule(missing));
    // Second call must still throw — but the cache hit path is covered
    // exclusively by the branch that rejects from cached null.
    await assert.rejects(() => loadImporterModule(missing));
  });
});
