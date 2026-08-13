import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  DEMO_ENVIRONMENT_KEYS,
  isolateDemoRemnicConfig,
  isolateEnvironmentVariables,
  modelRequestTimeoutMs,
  prepareDemoRuntime,
  readCleanCommitSha,
  runCleanupSteps,
  runWithReservedOutput,
  waitForResult,
} from "./live-demo-runtime.mjs";

const execFileAsync = promisify(execFile);

test("the demo preserves model routes but isolates filesystem and namespace settings", () => {
  const config = isolateDemoRemnicConfig(
    {
      modelSource: "gateway",
      gatewayAgentId: "configured-agent",
      taskModelChain: { primary: "provider/model" },
      localLlmHomeDir: "/models/home",
      namespacesEnabled: true,
      defaultNamespace: "private",
      sharedNamespace: "team",
      workspaceDir: "/operator/workspace",
      profilingEnabled: true,
      profilingStorageDir: "/operator/profiling",
      causalTrajectoryStoreDir: "/operator/trajectories",
      sharedContextDir: "/operator/shared-context",
      namespacePolicies: [
        { name: "private", readPrincipals: ["configured-owner"], writePrincipals: ["configured-owner"] },
      ],
    },
    "/tmp/fresh-memory"
  );

  assert.equal(config.modelSource, "gateway");
  assert.equal(config.gatewayAgentId, "configured-agent");
  assert.deepEqual(config.taskModelChain, { primary: "provider/model" });
  assert.equal(config.localLlmHomeDir, "/models/home");
  assert.equal(config.memoryDir, "/tmp/fresh-memory");
  assert.equal(config.workspaceDir, "/tmp/fresh-memory/workspace");
  assert.equal(config.namespacesEnabled, false);
  assert.equal(config.defaultNamespace, "default");
  assert.equal(config.sharedNamespace, "shared");
  assert.deepEqual(config.namespacePolicies, []);
  assert.equal(Object.hasOwn(config, "profilingEnabled"), false);
  assert.equal(Object.hasOwn(config, "profilingStorageDir"), false);
  assert.equal(Object.hasOwn(config, "causalTrajectoryStoreDir"), false);
  assert.equal(Object.hasOwn(config, "sharedContextDir"), false);
});

test("the demo disables direct OpenAI when the selected route omits a direct credential", () => {
  const gateway = isolateDemoRemnicConfig({ modelSource: "gateway" }, "/tmp/fresh-memory");
  const local = isolateDemoRemnicConfig({ localLlmEnabled: true }, "/tmp/fresh-memory");

  assert.equal(gateway.openaiApiKey, false);
  assert.equal(local.openaiApiKey, false);
});

test("the demo resolves only credentials selected by the reusable config", () => {
  const seen = [];
  const config = isolateDemoRemnicConfig(
    {
      openaiApiKey: "${COMPATIBLE_API_KEY}",
      openaiBaseUrl: "${COMPATIBLE_BASE_URL}",
      localLlmApiKey: "${LOCAL_MODEL_KEY}",
    },
    "/tmp/fresh-memory",
    (value) => {
      seen.push(value);
      return `resolved:${value}`;
    }
  );

  assert.deepEqual(seen, ["${COMPATIBLE_API_KEY}", "${COMPATIBLE_BASE_URL}", "${LOCAL_MODEL_KEY}"]);
  assert.equal(config.openaiApiKey, "resolved:${COMPATIBLE_API_KEY}");
  assert.equal(config.openaiBaseUrl, "resolved:${COMPATIBLE_BASE_URL}");
  assert.equal(config.localLlmApiKey, "resolved:${LOCAL_MODEL_KEY}");
});

test("model HTTP timeouts cover every configured route budget", () => {
  assert.equal(modelRequestTimeoutMs(["gateway"], 180_000), 45_000);
  assert.equal(modelRequestTimeoutMs(["local"], 600_000), 615_000);
  assert.equal(modelRequestTimeoutMs(["local", "direct", "gateway"], 600_000), 675_000);
});

test("the demo clears inherited server limits and restores them", () => {
  const inheritedName = "REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS";
  const absentName = "ENGRAM_WRITE_RATE_LIMIT_WINDOW_MS";
  const priorInherited = process.env[inheritedName];
  const priorAbsent = process.env[absentName];
  process.env[inheritedName] = "1";
  Reflect.deleteProperty(process.env, absentName);

  try {
    const restore = isolateEnvironmentVariables([inheritedName, absentName]);
    assert.equal(process.env[inheritedName], undefined);
    assert.equal(process.env[absentName], undefined);
    process.env[inheritedName] = "60";
    process.env[absentName] = "60000";
    restore();
    assert.equal(process.env[inheritedName], "1");
    assert.equal(process.env[absentName], undefined);
  } finally {
    if (priorInherited === undefined) Reflect.deleteProperty(process.env, inheritedName);
    else process.env[inheritedName] = priorInherited;
    if (priorAbsent === undefined) Reflect.deleteProperty(process.env, absentName);
    else process.env[absentName] = priorAbsent;
  }
});

test("the demo isolates ambient direct-model credentials from selected routes", () => {
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("OPENAI_API_KEY"));
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("OPENAI_BASE_URL"));
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS"));
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("ENGRAM_WRITE_RATE_LIMIT_WINDOW_MS"));
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("REMNIC_ADMIN_CONSOLE_ENABLED"));
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("ENGRAM_ADMIN_CONSOLE_ENABLED"));
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("REMNIC_READY_OVERRIDE"));
  assert.ok(DEMO_ENVIRONMENT_KEYS.includes("REMNIC_OAUTH_ENABLED"));
  assert.equal(new Set(DEMO_ENVIRONMENT_KEYS).size, DEMO_ENVIRONMENT_KEYS.length);
});

test("the demo resolves selected direct-model placeholders before environment isolation", () => {
  const names = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.OPENAI_API_KEY = "selected-key";
  process.env.OPENAI_BASE_URL = "https://compatible.example.invalid/v1";
  let restoreEnvironment;

  try {
    const runtime = prepareDemoRuntime(
      {
        openaiApiKey: "${OPENAI_API_KEY}",
        openaiBaseUrl: "${OPENAI_BASE_URL}",
      },
      "/tmp/fresh-memory",
      (value) => value.replace(/\$\{([^}]+)\}/g, (_match, name) => process.env[name] ?? "")
    );
    restoreEnvironment = runtime.restoreEnvironment;

    assert.equal(runtime.remnicConfig.openaiApiKey, "selected-key");
    assert.equal(runtime.remnicConfig.openaiBaseUrl, "https://compatible.example.invalid/v1");
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.OPENAI_BASE_URL, undefined);

    restoreEnvironment();
    restoreEnvironment = undefined;
    assert.equal(process.env.OPENAI_API_KEY, "selected-key");
    assert.equal(process.env.OPENAI_BASE_URL, "https://compatible.example.invalid/v1");
  } finally {
    restoreEnvironment?.();
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
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

test("runWithReservedOutput aborts work and releases its receipt after a signal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-signal-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const signals = new EventEmitter();
  const started = Promise.withResolvers();

  const running = runWithReservedOutput(
    outputDir,
    async (_reservation, signal) => {
      started.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    signals
  );
  await started.promise;
  signals.emit("SIGTERM");

  await assert.rejects(running, /stopped by SIGTERM/);
  await assert.rejects(access(path.join(outputDir, "receipt.json")), { code: "ENOENT" });
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
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
