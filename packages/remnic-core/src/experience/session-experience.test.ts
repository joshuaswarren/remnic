/**
 * Session-end agent-experience extraction (issue #2979).
 *
 * Deterministic Situation/Approach/Reflection episode extraction from a
 * completed session transcript, plus the privacy/trust gate: with
 * `sessionExperience.enabled` off the run performs ZERO storage calls
 * (not even reads), and when on it writes at most one agent-subject,
 * `pending_review` procedure memory per session key.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import type { BufferTurn, MemoryFile, PluginConfig } from "../types.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import { StorageManager } from "../index.js";
import {
  SESSION_EXPERIENCE_CONFIG_DEFAULTS,
  parseSessionExperienceConfig,
} from "./session-experience-config.js";
import {
  extractExperienceEpisode,
  runSessionExperienceExtraction,
} from "./session-experience.js";

function turn(role: "user" | "assistant", content: string): BufferTurn {
  return { role, content, timestamp: "2026-01-15T10:00:00.000Z" };
}

/** A representative successful coding session transcript. */
function successSession(): BufferTurn[] {
  return [
    turn("user", "Fix the failing integration test in the payments module. The test times out after 30 seconds."),
    turn("assistant", "I will inspect the payments test file and reproduce the timeout locally first."),
    turn("assistant", "The timeout came from an unawaited database call in the test setup. I added the missing await."),
    turn("assistant", "Verified: the payments integration test passes now and the full suite is green."),
  ];
}

/** A representative failed session transcript (refusal/failure is signal). */
function failureSession(): BufferTurn[] {
  return [
    turn("user", "Migrate the billing export job to the new queue library before the release cut."),
    turn("assistant", "I will port the export job onto the new queue client and run the smoke suite."),
    turn("assistant", "The migration failed: the new queue library cannot serialize the billing payload format."),
  ];
}

/** Minimal structural stand-in for StorageManager; records every call. */
function recordingStorage(existing: MemoryFile[] = []) {
  const calls: { readAllMemories: number; writeSealedMemory: SealedMemoryEnvelope[] } = {
    readAllMemories: 0,
    writeSealedMemory: [],
  };
  const storage = {
    async readAllMemories() {
      calls.readAllMemories += 1;
      return existing;
    },
    async writeSealedMemory(envelope: SealedMemoryEnvelope) {
      calls.writeSealedMemory.push(envelope);
      return { id: "written-once" };
    },
  };
  return { storage, calls };
}

function enabledConfig(memoryDir: string): PluginConfig {
  return parseConfig({ memoryDir, sessionExperience: { enabled: true } });
}

test("extractExperienceEpisode derives the situation/approach/reflection classes from a session transcript", () => {
  const episode = extractExperienceEpisode(successSession());
  assert.ok(episode, "a representative session must yield an episode");
  assert.match(episode.situation, /Fix the failing integration test/);
  assert.match(episode.situation, /payments/i);
  assert.match(episode.approach, /inspect the payments test file/);
  assert.equal(episode.outcomeKind, "success");
  assert.match(episode.reflection, /succeed|pass/i);
  // Deterministic: identical transcript, identical episode.
  assert.deepEqual(extractExperienceEpisode(successSession()), episode);
});

test("extractExperienceEpisode records failure as signal, not a skip", () => {
  const episode = extractExperienceEpisode(failureSession());
  assert.ok(episode);
  assert.equal(episode.outcomeKind, "failure");
  assert.match(episode.reflection, /fail/i);
  assert.match(episode.reflection, /cannot serialize the billing payload/);
});

test("extractExperienceEpisode returns null without a task or without agent work", () => {
  assert.equal(extractExperienceEpisode([]), null);
  assert.equal(extractExperienceEpisode([turn("assistant", "Working on it. Verified the fix.")]), null);
  assert.equal(extractExperienceEpisode([turn("user", "Please fix the flaky payments test soon.")]), null);
});

test("gate off performs zero storage calls — nothing is read, nothing is written", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-off-"));
  try {
    const config = parseConfig({ memoryDir });
    assert.equal(config.sessionExperience.enabled, false);
    const { storage, calls } = recordingStorage();
    const result = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-off",
      config,
      storage,
    });
    assert.deepEqual(result, { written: false, skippedReason: "session_experience_disabled" });
    assert.equal(calls.readAllMemories, 0, "gate off must not even read storage");
    assert.equal(calls.writeSealedMemory.length, 0, "gate off must not compose or write anything");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("gate on writes exactly one pending_review agent-subject procedure memory per session", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-on-"));
  try {
    const { storage, calls } = recordingStorage();
    const result = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-on",
      config: enabledConfig(memoryDir),
      storage,
    });
    assert.equal(result.written, true);
    assert.equal(calls.writeSealedMemory.length, 1, "at most one experience per session");
    const envelope = calls.writeSealedMemory[0];
    assert.equal(envelope.category, "procedure");
    assert.equal(envelope.subject, "agent");
    assert.equal(envelope.source, "session-experience");
    assert.ok(envelope.structuredAttributes?.experience_session_hash, "dedupe hash must be stamped");
    assert.equal(envelope.structuredAttributes?.experience_outcome, "success");
    assert.match(envelope.content, /Situation: Fix the failing integration test/);
    assert.match(envelope.content, /Approach: /);
    assert.match(envelope.content, /Reflection: /);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a repeated session_end for the same session key dedupes to zero new writes", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-dup-"));
  try {
    const realStorage = new StorageManager(memoryDir);
    await realStorage.ensureDirectories();
    try {
      const first = await runSessionExperienceExtraction({
        turns: successSession(),
        sessionKey: "session-dedupe",
        config: enabledConfig(memoryDir),
        storage: realStorage,
      });
      assert.equal(first.written, true);
      const second = await runSessionExperienceExtraction({
        turns: successSession(),
        sessionKey: "session-dedupe",
        config: enabledConfig(memoryDir),
        storage: realStorage,
      });
      assert.deepEqual(second, { written: false, skippedReason: "duplicate_session" });
      const experiences = (await realStorage.readAllMemories()).filter(
        (m) => m.frontmatter.structuredAttributes?.experience_session_hash !== undefined,
      );
      assert.equal(experiences.length, 1, "replay must not duplicate the episode");
      assert.equal(experiences[0]?.frontmatter.status, "pending_review", "trust-mode review by default");
      assert.equal(experiences[0]?.frontmatter.subject, "agent");
      assert.equal(experiences[0]?.frontmatter.category, "procedure");
    } finally {
      // StorageManager holds no explicit dispose; the temp dir removal below
      // is the cleanup.
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("deadline and abort are honored before any write", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-dl-"));
  try {
    const { storage, calls } = recordingStorage();
    const deadline = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-deadline",
      config: enabledConfig(memoryDir),
      storage,
      deadlineMs: Date.now() - 1,
    });
    assert.deepEqual(deadline, { written: false, skippedReason: "deadline_elapsed" });
    const controller = new AbortController();
    controller.abort();
    const aborted = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-abort",
      config: enabledConfig(memoryDir),
      storage,
      abortSignal: controller.signal,
    });
    assert.deepEqual(aborted, { written: false, skippedReason: "aborted" });
    assert.equal(calls.writeSealedMemory.length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("sessionExperience config: default off, opt-in parse, unknown keys fail closed, conservative pins off", () => {
  assert.deepEqual(SESSION_EXPERIENCE_CONFIG_DEFAULTS, { enabled: false });
  assert.deepEqual(parseSessionExperienceConfig(undefined), { enabled: false });
  assert.deepEqual(parseSessionExperienceConfig({}), { enabled: false });
  assert.deepEqual(parseSessionExperienceConfig({ enabled: true }), { enabled: true });
  assert.throws(() => parseSessionExperienceConfig("yes"), /sessionExperience must be an object/);
  assert.throws(
    () => parseSessionExperienceConfig({ enabled: true, maxEpisodes: 2 }),
    /unknown key "maxEpisodes"/,
  );
  const memoryDir = "/tmp/remnic-sx-preset";
  assert.equal(parseConfig({ memoryDir }).sessionExperience.enabled, false);
  assert.equal(
    parseConfig({ memoryDir, memoryOsPreset: "conservative" }).sessionExperience.enabled,
    false,
    "the conservative preset pins session-end experience extraction off",
  );
  assert.equal(
    parseConfig({ memoryDir, memoryOsPreset: "balanced", sessionExperience: { enabled: true } })
      .sessionExperience.enabled,
    true,
  );
});
