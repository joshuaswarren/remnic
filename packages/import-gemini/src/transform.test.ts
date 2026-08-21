import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseGeminiExport } from "./parser.js";
import { transformGeminiExport } from "./transform.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("transformGeminiExport", () => {
  it("emits one memory per non-trivial Gemini prompt and drops short ones", () => {
    const parsed = parseGeminiExport(loadFixture("my-activity.json"), {
      filePath: "/tmp/takeout.json",
    });
    const memories = transformGeminiExport(parsed);
    // 3 prompts pass the default min length (10 chars); `ok` is dropped.
    assert.equal(memories.length, 3);
    for (const m of memories) {
      assert.equal(m.sourceLabel, "gemini");
      assert.equal(m.importedFromPath, "/tmp/takeout.json");
      assert.equal(m.metadata?.kind, "prompt");
    }
  });

  it("preserves the activity URL and model tag in metadata when present", () => {
    const parsed = parseGeminiExport(loadFixture("my-activity.json"));
    const memories = transformGeminiExport(parsed);
    const withModel = memories.find((m) => m.metadata?.modelTag);
    assert.ok(withModel);
    assert.equal(withModel.metadata?.modelTag, "Model: Gemini 2.5 Pro");
    const withUrl = memories.find((m) => m.metadata?.activityUrl);
    assert.ok(withUrl);
    assert.match(
      String(withUrl.metadata?.activityUrl ?? ""),
      /gemini\.google\.com/,
    );
  });

  it("honors maxMemories as a hard cap", () => {
    const parsed = parseGeminiExport(loadFixture("my-activity.json"));
    const memories = transformGeminiExport(parsed, { maxMemories: 1 });
    assert.equal(memories.length, 1);
  });

  it("respects a custom minPromptLength", () => {
    const parsed = parseGeminiExport(
      JSON.stringify([
        { header: "Gemini Apps", text: "short", time: "2026-01-01T00:00:00Z" },
        { header: "Gemini Apps", text: "longer prompt here", time: "2026-01-02T00:00:00Z" },
      ]),
    );
    const defaultOut = transformGeminiExport(parsed);
    assert.equal(defaultOut.length, 1);
    const strictOut = transformGeminiExport(parsed, { minPromptLength: 100 });
    assert.equal(strictOut.length, 0);
    const permissiveOut = transformGeminiExport(parsed, { minPromptLength: 1 });
    assert.equal(permissiveOut.length, 2);
  });
});
