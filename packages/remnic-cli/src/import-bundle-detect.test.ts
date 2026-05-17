import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUNDLE_SUPPORTED_IMPORTERS,
  detectBundleEntries,
  type BundleDetectOptions,
} from "./import-bundle-detect.js";
import { SUPPORTED_IMPORTERS } from "./optional-importer.js";

/**
 * Build a fake filesystem map that the detect helpers can query through
 * injected `readdirImpl` / `readFileImpl` / `isDirectoryImpl` hooks. Keys
 * ending in `/` are directories; every other path is a file whose contents
 * live in `files[path]` (or default to `{}`).
 */
function makeFs(
  files: Record<string, string>,
  dirs: string[],
  symlinks: string[] = [],
): BundleDetectOptions {
  const dirSet = new Set(dirs);
  const fileSet = new Set(Object.keys(files));
  const symlinkSet = new Set(symlinks);
  return {
    readdirImpl: (dir: string) => {
      const normalized = dir.endsWith("/") ? dir : dir + "/";
      const all = new Set<string>();
      for (const key of [...Object.keys(files), ...dirs, ...symlinks]) {
        if (key === dir) continue;
        if (key.startsWith(normalized)) {
          const rest = key.slice(normalized.length);
          if (rest.length === 0) continue;
          const head = rest.split("/")[0]!;
          if (head.length > 0) all.add(head);
        }
      }
      return [...all];
    },
    readFileImpl: (p: string) => files[p] ?? "{}",
    // Codex review on PR #610 — symlinks never report as directories OR
    // as regular files, so the walker refuses to follow them. This
    // matches defaultIsDirectory / defaultIsRegularFile in the
    // production module.
    isDirectoryImpl: (p: string) => dirSet.has(p) && !symlinkSet.has(p),
    isRegularFileImpl: (p: string) => fileSet.has(p) && !symlinkSet.has(p),
  };
}

describe("detectBundleEntries", () => {
  it("keeps bundle-supported importers intentionally narrower than optional importers", () => {
    assert.deepEqual([...BUNDLE_SUPPORTED_IMPORTERS], [
      "chatgpt",
      "claude",
      "gemini",
      "mem0",
    ]);
    for (const name of BUNDLE_SUPPORTED_IMPORTERS) {
      assert.ok(SUPPORTED_IMPORTERS.includes(name));
    }
    assert.equal(
      (BUNDLE_SUPPORTED_IMPORTERS as readonly string[]).includes("supermemory"),
      false,
    );
  });

  it("finds a ChatGPT saved-memories file at the bundle root", () => {
    const fs = makeFs(
      { "/bundle/memory.json": "{}" },
      ["/bundle"],
    );
    const entries = detectBundleEntries("/bundle", fs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.adapter, "chatgpt");
    assert.equal(entries[0]?.filePath, "/bundle/memory.json");
  });

  it("finds Claude projects.json and classifies correctly", () => {
    const fs = makeFs(
      { "/bundle/projects.json": "[]" },
      ["/bundle"],
    );
    const entries = detectBundleEntries("/bundle", fs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.adapter, "claude");
  });

  it("finds Gemini activity file and accepts both naming conventions", () => {
    const fs = makeFs(
      {
        "/bundle/Takeout/Gemini/My Activity.json": "[]",
      },
      ["/bundle", "/bundle/Takeout", "/bundle/Takeout/Gemini"],
    );
    const entries = detectBundleEntries("/bundle", fs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.adapter, "gemini");
    assert.equal(entries[0]?.filePath, "/bundle/Takeout/Gemini/My Activity.json");
  });

  it("disambiguates ChatGPT vs Claude conversations.json by content", () => {
    const fsChatgpt = makeFs(
      {
        "/bundle/conversations.json": JSON.stringify([
          { id: "c1", mapping: { "m-1": { id: "m-1" } } },
        ]),
      },
      ["/bundle"],
    );
    const chatgpt = detectBundleEntries("/bundle", fsChatgpt);
    assert.equal(chatgpt[0]?.adapter, "chatgpt");
    assert.equal(chatgpt[0]?.includeConversations, true);

    const fsClaude = makeFs(
      {
        "/bundle/conversations.json": JSON.stringify([
          { uuid: "c1", chat_messages: [] },
        ]),
      },
      ["/bundle"],
    );
    const claude = detectBundleEntries("/bundle", fsClaude);
    assert.equal(claude[0]?.adapter, "claude");
    assert.equal(claude[0]?.includeConversations, true);
  });

  it("produces a stable order across adapters and file paths", () => {
    const fs = makeFs(
      {
        "/bundle/My Activity.json": "[]",
        "/bundle/memory.json": "{}",
        "/bundle/projects.json": "[]",
        "/bundle/mem0.json": "{}",
      },
      ["/bundle"],
    );
    const entries = detectBundleEntries("/bundle", fs);
    assert.deepEqual(
      entries.map((e) => e.adapter),
      ["chatgpt", "claude", "gemini", "mem0"],
    );
  });

  it("returns an empty array when no known files are present", () => {
    const fs = makeFs(
      { "/bundle/random.txt": "" },
      ["/bundle"],
    );
    const entries = detectBundleEntries("/bundle", fs);
    assert.equal(entries.length, 0);
  });

  it("throws a user-facing error when the directory is unreadable", () => {
    const fs: BundleDetectOptions = {
      readdirImpl: () => {
        throw new Error("ENOENT");
      },
      readFileImpl: () => "",
      isDirectoryImpl: () => false,
    };
    assert.throws(
      () => detectBundleEntries("/missing", fs),
      /could not be read/,
    );
  });

  it("does not double-count identical file paths surfaced by the scan", () => {
    // Even if the scan returns the same path twice (symlink-style), the
    // entry list must not duplicate.
    const fs: BundleDetectOptions = {
      readdirImpl: () => ["memory.json"],
      readFileImpl: () => "{}",
      isDirectoryImpl: () => false,
      isRegularFileImpl: () => true,
    };
    const entries = detectBundleEntries("/bundle", fs);
    assert.equal(entries.length, 1);
  });

  // Codex review on PR #610 — a bundle containing a symlink named
  // memory.json / projects.json must NOT be followed, or the importer
  // could be tricked into reading arbitrary filesystem locations.
  // defaultIsRegularFile rejects symlinks; verify through the injected
  // BundleDetectOptions surface.
  it("rejects symlinked files even when their name matches a known shape", () => {
    const fs = makeFs(
      {
        "/bundle/real.json": "{}",
        "/bundle/memory.json": "{}",
      },
      ["/bundle"],
      ["/bundle/memory.json"], // mark memory.json as a symlink
    );
    const entries = detectBundleEntries("/bundle", fs);
    assert.equal(entries.length, 0);
  });

  it("rejects symlinked directories and does not recurse into them", () => {
    const fs = makeFs(
      { "/bundle/inner/memory.json": "{}" },
      ["/bundle", "/bundle/inner"],
      ["/bundle/inner"], // mark inner/ as a symlink
    );
    const entries = detectBundleEntries("/bundle", fs);
    assert.equal(entries.length, 0);
  });
});
