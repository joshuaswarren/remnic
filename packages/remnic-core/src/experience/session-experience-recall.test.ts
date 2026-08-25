/**
 * Session-end experience recall injection (issue #2979 layer 2).
 *
 * Promoted experience memories compete in the existing procedure-recall
 * slot and share `recallMaxProcedures`. pending_review never injects.
 * Gate off: extraction still makes zero storage calls; recall does not
 * inspect experience attributes (no Experience preview prefix).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import type { BufferTurn, PluginConfig } from "../types.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import { StorageManager } from "../storage.js";
import { buildProcedureRecallSection } from "../procedural/procedure-recall.js";
import { buildProcedureMarkdownBody } from "../procedural/procedure-types.js";
import { runSessionExperienceExtraction } from "./session-experience.js";
import {
  isSessionExperienceMemory,
  renderSessionExperiencePreview,
  scoreSessionExperienceForPrompt,
} from "./session-experience-recall.js";

function turn(role: "user" | "assistant", content: string): BufferTurn {
  return { role, content, timestamp: "2026-01-15T10:00:00.000Z" };
}

function successSession(): BufferTurn[] {
  return [
    turn("user", "Fix the failing integration test in the payments module. The test times out after 30 seconds."),
    turn("assistant", "I will inspect the payments test file and reproduce the timeout locally first."),
    turn("assistant", "The timeout came from an unawaited database call in the test setup. I added the missing await."),
    turn("assistant", "Verified: the payments integration test passes now and the full suite is green."),
  ];
}

const TASK_PROMPT = "Let's fix the failing integration test in the payments module";

function recallConfig(memoryDir: string, experienceEnabled: boolean, recallMaxProcedures = 2): PluginConfig {
  return parseConfig({
    memoryDir,
    workspaceDir: path.join(memoryDir, "ws"),
    openaiApiKey: "test-key",
    procedural: { enabled: true, recallMaxProcedures },
    sessionExperience: { enabled: experienceEnabled },
  });
}

function recordingStorage() {
  const calls: { readAllMemories: number; writeSealedMemory: SealedMemoryEnvelope[] } = {
    readAllMemories: 0,
    writeSealedMemory: [],
  };
  const storage = {
    async readAllMemories() {
      calls.readAllMemories += 1;
      return [];
    },
    async writeSealedMemory(envelope: SealedMemoryEnvelope) {
      calls.writeSealedMemory.push(envelope);
      return { id: "should-not-write" };
    },
  };
  return { storage, calls };
}

test("gate off: session-end extraction still performs zero storage calls after recall wiring", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-recall-off-"));
  try {
    const config = parseConfig({ memoryDir });
    assert.equal(config.sessionExperience.enabled, false);
    const { storage, calls } = recordingStorage();
    const result = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-recall-off",
      config,
      storage,
    });
    assert.deepEqual(result, { written: false, skippedReason: "session_experience_disabled" });
    assert.equal(calls.readAllMemories, 0);
    assert.equal(calls.writeSealedMemory.length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pending_review experience is not injected into procedure-recall", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-recall-pending-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const config = recallConfig(memoryDir, true);
    const written = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-recall-pending",
      config,
      storage,
    });
    assert.equal(written.written, true);
    const memories = await storage.readAllMemories();
    assert.equal(memories[0]?.frontmatter.status, "pending_review");
    const section = await buildProcedureRecallSection(storage, TASK_PROMPT, config);
    assert.equal(section, null, "pending_review must not occupy a procedure-recall slot");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("promoted experience injects through procedure-recall with an Experience preview", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-recall-on-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const config = recallConfig(memoryDir, true);
    const written = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-recall-on",
      config,
      storage,
    });
    assert.equal(written.written, true);
    assert.ok(written.memoryId);
    const promoted = await storage.updateMemoryFrontmatter(written.memoryId, { status: "active" });
    assert.equal(promoted, true);
    const section = await buildProcedureRecallSection(storage, TASK_PROMPT, config);
    assert.ok(section);
    assert.match(section, /## Relevant procedures/);
    assert.match(section, new RegExp(written.memoryId));
    assert.match(section, /Experience\. Situation:/);
    assert.match(section, /payments/i);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("experience and procedure share recallMaxProcedures; situation match wins cap 1", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-recall-budget-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const config = recallConfig(memoryDir, true, 1);
    const written = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-recall-budget",
      config,
      storage,
    });
    assert.equal(written.written, true);
    await storage.updateMemoryFrontmatter(written.memoryId, { status: "active" });
    const body = buildProcedureMarkdownBody([
      { order: 1, intent: "Run deploy checks for production gateway" },
      { order: 2, intent: "Push the release tag" },
    ]);
    const other = await storage.writeMemory(
      "procedure",
      `When you deploy the gateway\n\n${body}`,
      { source: "test", tags: ["deploy", "gateway"] },
    );
    const section = await buildProcedureRecallSection(storage, TASK_PROMPT, config);
    assert.ok(section);
    assert.match(section, new RegExp(written.memoryId));
    assert.doesNotMatch(section, new RegExp(other.id));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("gate off: promoted experience may inject as a procedure but without Experience preview", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-recall-generic-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const enabled = recallConfig(memoryDir, true);
    const written = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-recall-generic",
      config: enabled,
      storage,
    });
    assert.equal(written.written, true);
    await storage.updateMemoryFrontmatter(written.memoryId, { status: "active" });
    const off = recallConfig(memoryDir, false);
    const section = await buildProcedureRecallSection(storage, TASK_PROMPT, off);
    if (section !== null) {
      assert.match(section, new RegExp(written.memoryId));
      assert.doesNotMatch(section, /Experience\. Situation:/);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("helpers: non-experience memories score/render as null; episodes label Situation", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-recall-helpers-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const other = await storage.writeMemory("procedure", "When you deploy the gateway, run the smoke suite.", {
      source: "test",
    });
    const otherFile = (await storage.readAllMemories()).find((m) => m.frontmatter.id === other.id);
    assert.ok(otherFile);
    assert.equal(isSessionExperienceMemory(otherFile), false);
    assert.equal(scoreSessionExperienceForPrompt(otherFile, TASK_PROMPT), null);
    assert.equal(renderSessionExperiencePreview(otherFile), null);

    const config = recallConfig(memoryDir, true);
    const written = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-recall-helpers",
      config,
      storage,
    });
    assert.equal(written.written, true);
    const episode = (await storage.readAllMemories()).find((m) => m.frontmatter.id === written.memoryId);
    assert.ok(episode);
    assert.equal(isSessionExperienceMemory(episode), true);
    const score = scoreSessionExperienceForPrompt(episode, TASK_PROMPT);
    assert.ok(score !== null && score > 0.04);
    assert.match(renderSessionExperiencePreview(episode) ?? "", /Experience\. Situation:.*payments/i);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
