import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.js";
import { buildBriefing, parseBriefingWindow } from "../src/briefing.js";

const NOW = new Date("2026-04-11T12:00:00.000Z");

async function makeTempStorage(): Promise<{ dir: string; storage: StorageManager }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-briefing-llm-"));
  StorageManager.clearAllStaticCaches();
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  return { dir, storage };
}

test("buildBriefing omits follow-ups cleanly when no LLM is configured", async () => {
  const { dir, storage } = await makeTempStorage();
  try {
    const result = await buildBriefing({
      storage,
      window: parseBriefingWindow("yesterday", NOW)!,
      maxFollowups: 5,
      allowLlm: true,
      // Intentionally: no openaiApiKey, no followupGenerator.
      now: NOW,
    });

    assert.equal(result.sections.suggestedFollowups.length, 0);
    assert.equal(
      result.followupsUnavailableReason,
      'no LLM configured for follow-ups (set OPENAI_API_KEY, enable a local LLM, or use modelSource "gateway")',
    );
    assert.match(result.markdown, /## Suggested follow-ups/);
    assert.match(result.markdown, /_Unavailable: no LLM configured for follow-ups/);
    // Other sections still render.
    assert.match(result.markdown, /## Active threads/);
    assert.match(result.markdown, /## Recent entities/);
    assert.match(result.markdown, /## Open commitments/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBriefing omits follow-ups when allowLlm is explicitly false", async () => {
  const { dir, storage } = await makeTempStorage();
  try {
    const result = await buildBriefing({
      storage,
      window: parseBriefingWindow("yesterday", NOW)!,
      maxFollowups: 5,
      allowLlm: false,
      openaiApiKey: "sk-fake-should-not-be-used",
      now: NOW,
    });

    assert.equal(result.sections.suggestedFollowups.length, 0);
    assert.ok(result.followupsUnavailableReason);
    assert.match(
      result.followupsUnavailableReason!,
      /disabled by configuration/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBriefing treats maxFollowups=0 as 'section disabled'", async () => {
  const { dir, storage } = await makeTempStorage();
  try {
    const result = await buildBriefing({
      storage,
      window: parseBriefingWindow("yesterday", NOW)!,
      maxFollowups: 0,
      allowLlm: true,
      openaiApiKey: "sk-fake",
      now: NOW,
    });

    assert.equal(result.sections.suggestedFollowups.length, 0);
    assert.ok(result.followupsUnavailableReason);
    assert.match(
      result.followupsUnavailableReason!,
      /disabled by configuration/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBriefing swallows LLM errors and reports the reason", async () => {
  const { dir, storage } = await makeTempStorage();
  try {
    const result = await buildBriefing({
      storage,
      window: parseBriefingWindow("yesterday", NOW)!,
      maxFollowups: 5,
      allowLlm: true,
      // No openaiApiKey — but we override with a generator that throws.
      followupGenerator: async () => {
        throw new Error("boom");
      },
      now: NOW,
    });

    assert.equal(result.sections.suggestedFollowups.length, 0);
    assert.match(result.followupsUnavailableReason!, /boom/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
