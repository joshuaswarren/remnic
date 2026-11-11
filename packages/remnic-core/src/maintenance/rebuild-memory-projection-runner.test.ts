import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PROJECTION_REBUILD_RUNNER_FLAG } from "./rebuild-memory-projection-runner.js";

const RUNNER = fileURLToPath(new URL("./rebuild-memory-projection-runner.ts", import.meta.url));

type RunnerMessage =
  | { ok: true; currentRows: number; timelineRows: number; entityMentionRows: number }
  | { ok: false; error: string };

async function runRunner(args: string[]): Promise<{
  code: number | null;
  messages: RunnerMessage[];
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", RUNNER, PROJECTION_REBUILD_RUNNER_FLAG, ...args],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env },
    },
  );
  const messages: RunnerMessage[] = [];
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("message", (message) => {
    // SAFETY: the runner posts only RunnerMessage values over IPC; the assertions below check each field.
    messages.push(message as RunnerMessage);
  });
  const { promise: exitPromise, resolve, reject } = Promise.withResolvers<number | null>();
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve(exitCode));
  const code = await exitPromise;
  return { code, messages, stderr };
}

test("PROJECTION_REBUILD_RUNNER_FLAG is the documented argv marker", () => {
  assert.equal(PROJECTION_REBUILD_RUNNER_FLAG, "--remnic-projection-rebuild-runner");
});

test("runner rejects missing argv with an IPC failure message", async () => {
  const result = await runRunner([]);
  assert.equal(result.code, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]!.ok, false);
  if (result.messages[0]!.ok === false) {
    assert.match(result.messages[0]!.error, /requires memoryDir, defaultNamespace, and now/);
  }
});

test("runner rejects a non-timestamp now value", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-runner-bad-now-"));
  try {
    const result = await runRunner([root, "default", "not-a-date"]);
    assert.equal(result.code, 1);
    assert.equal(result.messages[0]!.ok, false);
    if (result.messages[0]!.ok === false) {
      assert.match(result.messages[0]!.error, /not a timestamp/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner rebuilds an empty memory dir and reports zero rows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-runner-ok-"));
  try {
    const result = await runRunner([root, "default", "2026-06-01T00:00:00.000Z"]);
    assert.equal(result.code, 0, result.stderr || JSON.stringify(result.messages));
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.messages[0], {
      ok: true,
      currentRows: 0,
      timelineRows: 0,
      entityMentionRows: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
