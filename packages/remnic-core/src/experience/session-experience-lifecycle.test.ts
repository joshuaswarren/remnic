/**
 * Session-end experience extraction through the real flush lifecycle
 * (issue #2979): `flushSession(reason: "session_end")` drains the buffer
 * and then derives at most one agent-experience episode; `before_reset`
 * must not write one; gate off must write nothing anywhere.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Orchestrator } from "../orchestrator.js";
import {
  cleanupDir,
  makeHarmonicLifecycleConfig,
  markdownFilesUnder,
  mkTempMemoryDir,
  singleFactResult,
  stubExtraction,
} from "../testing/orchestrator-lite.js";

async function sessionEndMemories(memoryDir: string): Promise<string[]> {
  const matches: string[] = [];
  for (const file of await markdownFilesUnder(`${memoryDir}/procedures`)) {
    if ((await readFile(file, "utf8")).includes("Reflection: ")) matches.push(file);
  }
  return matches;
}

async function withOrchestrator(
  label: string,
  overrides: Record<string, unknown>,
  run: (orchestrator: Orchestrator, memoryDir: string) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkTempMemoryDir(label);
  let orchestrator: Orchestrator | undefined;
  try {
    orchestrator = new Orchestrator(makeHarmonicLifecycleConfig(memoryDir, overrides));
    stubExtraction(orchestrator, (turns) => singleFactResult("The harmonic probe fact persists."));
    await run(orchestrator, memoryDir);
  } finally {
    await orchestrator?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
}

const SESSION = "session-end-experience";

const SUCCESS_TURNS: Array<[role: "user" | "assistant", content: string]> = [
  ["user", "Fix the flaky payments integration test that times out after thirty seconds."],
  ["assistant", "I will reproduce the timeout and inspect the payments test setup."],
  ["assistant", "Added the missing await to the setup call. Verified: the payments test passes now."],
];

test("session_end flush writes exactly one pending_review agent-experience episode", async () => {
  await withOrchestrator(
    "sx-e2e-on",
    { sessionExperience: { enabled: true } },
    async (orchestrator, memoryDir) => {
      for (const [role, content] of SUCCESS_TURNS) {
        await orchestrator.processTurn(role, content, SESSION);
      }
      await orchestrator.flushSession(SESSION, { reason: "session_end" });
      const experiences = await sessionEndMemories(memoryDir);
      assert.equal(experiences.length, 1, "one session = at most one experience episode");
      const body = await readFile(experiences[0], "utf8");
      assert.match(body, /Situation: Fix the flaky payments integration test/);
      assert.match(body, /Approach: /);
      assert.match(body, /Reflection: /);
      assert.match(body, /status: pending_review/);
      assert.match(body, /subject: agent/);
      assert.match(body, /category: procedure/);
      assert.match(body, /experience_session_hash/);
      // A second session_end drain sees an empty buffer and must not duplicate.
      await orchestrator.flushSession(SESSION, { reason: "session_end" });
      assert.equal((await sessionEndMemories(memoryDir)).length, 1, "replay must not duplicate");
    },
  );
});

test("a failed session_end records the failure reflection", async () => {
  await withOrchestrator(
    "sx-e2e-fail",
    { sessionExperience: { enabled: true } },
    async (orchestrator, memoryDir) => {
      await orchestrator.processTurn(
        "user",
        "Migrate the billing export job to the new queue library before the release cut.",
        SESSION,
      );
      await orchestrator.processTurn(
        "assistant",
        "The migration failed: the new queue library cannot serialize the billing payload format.",
        SESSION,
      );
      await orchestrator.flushSession(SESSION, { reason: "session_end" });
      const experiences = await sessionEndMemories(memoryDir);
      assert.equal(experiences.length, 1);
      const body = await readFile(experiences[0], "utf8");
      assert.match(body, /experience_outcome: failure|experience_outcome=failure/);
      assert.match(body, /fail/i);
    },
  );
});

test("gate off (default): a session_end flush writes no experience anywhere", async () => {
  await withOrchestrator("sx-e2e-off", {}, async (orchestrator, memoryDir) => {
    for (const [role, content] of SUCCESS_TURNS) {
      await orchestrator.processTurn(role, content, SESSION);
    }
    await orchestrator.flushSession(SESSION, { reason: "session_end" });
    assert.equal((await sessionEndMemories(memoryDir)).length, 0, "gate off must write nothing");
    for (const file of await markdownFilesUnder(memoryDir)) {
      const body = await readFile(file, "utf8");
      assert.doesNotMatch(
        body,
        /Reflection: /,
        `no experience body may appear anywhere while gated off (saw ${file})`,
      );
    }
  });
});

test("before_reset drains the buffer but writes no experience episode", async () => {
  await withOrchestrator(
    "sx-e2e-reset",
    { sessionExperience: { enabled: true } },
    async (orchestrator, memoryDir) => {
      for (const [role, content] of SUCCESS_TURNS) {
        await orchestrator.processTurn(role, content, SESSION);
      }
      await orchestrator.flushSession(SESSION, { reason: "before_reset" });
      assert.equal(
        (await sessionEndMemories(memoryDir)).length,
        0,
        "experiences are session_end-only in v1",
      );
    },
  );
});
