import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  isolateDemoRemnicConfig,
  modelRequestTimeoutMs,
  readCleanCommitSha,
  runCleanupSteps,
  runWithReservedOutput,
  waitForResult,
} from "./live-demo-runtime.mjs";

const execFileAsync = promisify(execFile);

test("the demo preserves model routes but isolates namespace policy", () => {
  const config = isolateDemoRemnicConfig(
    {
      modelSource: "gateway",
      gatewayAgentId: "configured-agent",
      namespacesEnabled: true,
      defaultNamespace: "private",
      sharedNamespace: "team",
      namespacePolicies: [
        { name: "private", readPrincipals: ["configured-owner"], writePrincipals: ["configured-owner"] },
      ],
    },
    "/tmp/fresh-memory"
  );

  assert.equal(config.modelSource, "gateway");
  assert.equal(config.gatewayAgentId, "configured-agent");
  assert.equal(config.memoryDir, "/tmp/fresh-memory");
  assert.equal(config.namespacesEnabled, false);
  assert.equal(config.defaultNamespace, "default");
  assert.equal(config.sharedNamespace, "shared");
  assert.deepEqual(config.namespacePolicies, []);
});

test("model HTTP timeouts cover every configured route budget", () => {
  assert.equal(modelRequestTimeoutMs(["gateway"], 180_000), 45_000);
  assert.equal(modelRequestTimeoutMs(["local"], 600_000), 615_000);
  assert.equal(modelRequestTimeoutMs(["local", "direct", "gateway"], 600_000), 675_000);
});

test("runWithReservedOutput reserves and retains a new receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-output-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "new-output");

  await runWithReservedOutput(outputDir, async (reservation) => {
    await reservation.writeReceipt("receipt\n");
    await reservation.retainReceipt();
  });

  assert.equal(await readFile(path.join(outputDir, "receipt.json"), "utf8"), "receipt\n");
});

test("runWithReservedOutput cleans only its failed reservation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-cleanup-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "keep.txt"), "keep\n");

  await assert.rejects(
    runWithReservedOutput(root, async () => {
      throw new Error("model failed");
    }),
    /model failed/
  );

  assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "keep\n");
  await assert.rejects(access(path.join(root, "receipt.json")), { code: "ENOENT" });
});

test("runWithReservedOutput removes a requested receipt when later cleanup fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-late-cleanup-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    runWithReservedOutput(root, async (reservation) => {
      await reservation.writeReceipt("receipt\n");
      await reservation.retainReceipt();
      throw new Error("server stop failed");
    }),
    /server stop failed/
  );

  await assert.rejects(access(path.join(root, "receipt.json")), { code: "ENOENT" });
});

test("runWithReservedOutput removes nested directories created for a failed run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-new-output-cleanup-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "new", "nested", "output");

  await assert.rejects(
    runWithReservedOutput(outputDir, async () => {
      throw new Error("model failed");
    }),
    /model failed/
  );

  await assert.rejects(access(path.join(root, "new")), { code: "ENOENT" });
});

test("an invalid output destination prevents every model invocation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-invalid-output-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fileParent = path.join(root, "not-a-directory");
  await writeFile(fileParent, "file\n");
  let modelInvocations = 0;

  await assert.rejects(
    runWithReservedOutput(path.join(fileParent, "output"), async () => {
      modelInvocations += 1;
    })
  );

  assert.equal(modelInvocations, 0);
});

test("an existing receipt prevents every model invocation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-existing-receipt-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "receipt.json"), "existing\n");
  let modelInvocations = 0;

  await assert.rejects(
    runWithReservedOutput(root, async () => {
      modelInvocations += 1;
    }),
    /already contains receipt.json/
  );

  assert.equal(modelInvocations, 0);
});

test("waitForResult polls until an asynchronous result is durable", async () => {
  let clock = 0;
  let reads = 0;
  const result = await waitForResult(
    async () => {
      reads += 1;
      if (reads < 3) throw new Error("not durable yet");
      return "ready";
    },
    {
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    }
  );

  assert.equal(result, "ready");
  assert.equal(reads, 3);
});

test("waitForResult returns the last error after its bounded deadline", async () => {
  let clock = 0;
  let reads = 0;
  await assert.rejects(
    waitForResult(
      async () => {
        reads += 1;
        throw new Error(`not ready ${reads}`);
      },
      {
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: () => clock,
        delay: async (milliseconds) => {
          clock += milliseconds;
        },
      }
    ),
    /not ready 3/
  );
});

test("runCleanupSteps completes every cleanup and returns the first error", async () => {
  const completed = [];
  const firstError = new Error("server stop failed");
  const result = await runCleanupSteps([
    async () => {
      completed.push("server");
      throw firstError;
    },
    async () => {
      completed.push("environment");
    },
    async () => {
      completed.push("temp");
      throw new Error("temp cleanup failed");
    },
    async () => {
      completed.push("receipt");
    },
  ]);

  assert.equal(result, firstError);
  assert.deepEqual(completed, ["server", "environment", "temp", "receipt"]);
});

test("readCleanCommitSha permits an untracked config but rejects tracked changes", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-git-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  const runGit = (args, options) => execFileAsync("git", args, options);
  await runGit(["init", "--quiet"], { cwd: repoRoot });
  await runGit(["config", "user.name", "Remnic test"], { cwd: repoRoot });
  await runGit(["config", "user.email", "test@example.invalid"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "tracked.txt"), "clean\n");
  await runGit(["add", "tracked.txt"], { cwd: repoRoot });
  await runGit(["commit", "--quiet", "-m", "test fixture"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "remnic.config.json"), "{}\n");

  assert.match(await readCleanCommitSha(repoRoot, runGit), /^[a-f0-9]{40}$/);

  await writeFile(path.join(repoRoot, "tracked.txt"), "changed\n");
  await assert.rejects(readCleanCommitSha(repoRoot, runGit), /Commit all tracked changes/);
});
