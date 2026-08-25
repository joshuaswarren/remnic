import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { registerCli } from "@remnic/core/cli";
import { StorageManager } from "@remnic/core/storage";
import { clearAuthTokenSecretCache } from "../packages/remnic-core/src/resolve-auth-token.js";
import type { OperatorToolkitOrchestrator } from "@remnic/core/operator-toolkit";

class MockCommand {
  readonly children = new Map<string, MockCommand>();
  actionHandler?: (...args: unknown[]) => Promise<void> | void;

  constructor(readonly name: string) {}

  command(name: string): MockCommand {
    const child = new MockCommand(name);
    this.children.set(name, child);
    return child;
  }

  description(): MockCommand {
    return this;
  }

  option(): MockCommand {
    return this;
  }

  requiredOption(): MockCommand {
    return this;
  }

  argument(): MockCommand {
    return this;
  }

  action(handler: (...args: unknown[]) => Promise<void> | void): MockCommand {
    this.actionHandler = handler;
    return this;
  }
}

function openclawConfigDocument(pluginConfig: Record<string, unknown>): string {
  return JSON.stringify({
    plugins: {
      entries: {
        "openclaw-engram": {
          config: pluginConfig,
        },
      },
    },
  }, null, 2);
}

async function makeFixture(
  overrides: Record<string, unknown> = {},
  registerOptions: Parameters<typeof registerCli>[2] = {},
): Promise<{
  configPath: string;
  orchestrator: OperatorToolkitOrchestrator;
  root: MockCommand;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "engram-operator-cli-"));
  const memoryDir = path.join(rootDir, "memory");
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const rawConfig = {
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    captureMode: "implicit",
    ...overrides,
  };
  const config = parseConfig(rawConfig);
  const configPath = path.join(rootDir, "openclaw.json");
  await writeFile(configPath, openclawConfigDocument(rawConfig), "utf-8");

  const orchestrator: OperatorToolkitOrchestrator = {
    config,
    storage: new StorageManager(memoryDir),
    qmd: {
      async probe() {
        return config.qmdEnabled;
      },
      isAvailable() {
        return config.qmdEnabled;
      },
      async ensureCollection() {
        return config.qmdEnabled ? "present" : "skipped";
      },
      debugStatus() {
        return config.qmdEnabled ? "available" : "disabled";
      },
    },
    async initialize() {},
    conversationIndexCoordinator: {
      async getHealth() {
        return {
          enabled: false,
          backend: "qmd" as const,
          status: "disabled" as const,
          chunkDocCount: 0,
          lastUpdateAt: null,
        };
      },
      async rebuild() {
        return {
          chunks: 0,
          skipped: true,
          reason: "disabled",
          embedded: false,
          rebuilt: false,
        };
      },
    },
  } as OperatorToolkitOrchestrator;

  const root = new MockCommand("root");
  registerCli(
    {
      registerCli(handler: (opts: { program: MockCommand }) => void): void {
        handler({ program: root });
      },
    },
    orchestrator as never,
    registerOptions,
  );

  return { configPath, orchestrator, root };
}

function getAction(root: MockCommand, segments: string[]): (...args: unknown[]) => Promise<void> | void {
  let current: MockCommand | undefined = root;
  for (const segment of segments) {
    current = current?.children.get(segment);
  }
  assert.equal(typeof current?.actionHandler, "function");
  return current!.actionHandler!;
}

async function captureAction(
  action: (...args: unknown[]) => Promise<void> | void,
  options: Record<string, unknown>,
): Promise<{ exitCode: number | undefined; output: string }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await action(options);
  } finally {
    console.log = originalLog;
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    return {
      exitCode,
      output: logs.join("\n"),
    };
  }
}

test("operator toolkit JSON commands emit parseable JSON without trailing OK", async () => {
  const fixture = await makeFixture({ evalHarnessEnabled: true, qmdEnabled: true });
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = fixture.configPath;

  const commands = [
    ["engram", "setup"],
    ["engram", "doctor"],
    ["engram", "config-review"],
    ["engram", "inventory"],
    ["engram", "benchmark", "recall"],
    ["engram", "repair"],
  ];

  try {
    for (const commandPath of commands) {
      const action = getAction(fixture.root, commandPath);
      const result = await captureAction(action, { json: true });
      assert.doesNotMatch(result.output, /\nOK$/);
      assert.doesNotThrow(() => JSON.parse(result.output));
      assert.equal(result.exitCode, undefined);
    }
  } finally {
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  }
});

test("access http-serve CLI resolves SecretRef authToken through injected host resolver", async () => {
  const authToken = {
    source: "exec",
    provider: "kc_openclaw_remnic_token",
    id: "http-serve-cli",
  };
  let resolverCalls = 0;
  clearAuthTokenSecretCache();

  const fixture = await makeFixture(
    {
      agentAccessHttp: {
        enabled: true,
        authToken,
      },
    },
    {
      loadResolveSecretRef: async () => {
        return async (ref) => {
          resolverCalls += 1;
          assert.deepEqual(ref, authToken);
          return " cli-secret-token\n";
        };
      },
    },
  );
  const serve = getAction(fixture.root, ["engram", "access", "http-serve"]);
  const stop = getAction(fixture.root, ["engram", "access", "http-stop"]);

  try {
    const result = await captureAction(serve, {
      host: "127.0.0.1",
      port: "0",
    });
    const status = JSON.parse(result.output.replace(/\nOK$/, "")) as {
      running: boolean;
      port: number;
    };

    assert.equal(result.exitCode, undefined);
    assert.equal(status.running, true);
    assert.equal(status.port > 0, true);
    assert.equal(resolverCalls, 1);
  } finally {
    await captureAction(stop, {});
    clearAuthTokenSecretCache();
  }
});

test("access http-serve CLI reports missing SecretRef resolver distinctly", async () => {
  clearAuthTokenSecretCache();
  const fixture = await makeFixture(
    {
      agentAccessHttp: {
        enabled: true,
        authToken: {
          source: "exec",
          provider: "kc_openclaw_remnic_token",
          id: "missing-resolver",
        },
      },
    },
    {
      loadResolveSecretRef: async () => null,
    },
  );
  const serve = getAction(fixture.root, ["engram", "access", "http-serve"]);

  try {
    await assert.rejects(
      () =>
        Promise.resolve(
          serve({
            host: "127.0.0.1",
            port: "0",
          }),
        ),
      /SecretRef resolver was not provided/,
    );
  } finally {
    clearAuthTokenSecretCache();
  }
});

test("setup CLI stays healthy when config discovery misses but runtime orchestrator is valid", async () => {
  const fixture = await makeFixture();
  const action = getAction(fixture.root, ["engram", "setup"]);
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = path.join(os.tmpdir(), "missing-openclaw-config.json");

  try {
    const result = await captureAction(action, { json: true });
    const report = JSON.parse(result.output) as { config: { parsed: boolean } };
    assert.equal(report.config.parsed, false);
    assert.equal(result.exitCode, undefined);
    assert.doesNotMatch(result.output, /\nOK$/);
  } finally {
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  }
});

test("doctor CLI warns instead of failing when config discovery misses but runtime orchestrator is valid", async () => {
  const fixture = await makeFixture({ qmdEnabled: true });
  const action = getAction(fixture.root, ["engram", "doctor"]);
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = path.join(os.tmpdir(), "missing-openclaw-config.json");

  try {
    const result = await captureAction(action, { json: true });
    const report = JSON.parse(result.output) as {
      ok: boolean;
      checks: Array<{ key: string; status: string }>;
    };
    assert.equal(report.ok, true);
    assert.equal(report.checks.some((check) => check.key === "config" && check.status === "warn"), true);
    assert.equal(result.exitCode, undefined);
  } finally {
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  }
});

test("config-review CLI fails when config discovery misses even if the runtime orchestrator is valid", async () => {
  const fixture = await makeFixture({ qmdEnabled: true });
  const action = getAction(fixture.root, ["engram", "config-review"]);
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = path.join(os.tmpdir(), "missing-openclaw-config.json");

  try {
    const result = await captureAction(action, { json: true });
    const report = JSON.parse(result.output) as {
      ok: boolean;
      config: { parsed: boolean };
    };
    assert.equal(report.config.parsed, false);
    assert.equal(report.ok, false);
    assert.equal(result.exitCode, 1);
  } finally {
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  }
});

test("config-review CLI exits non-zero when config problems are detected", async () => {
  const fixture = await makeFixture({
    qmdEnabled: false,
    qmdTierMigrationEnabled: true,
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });
  const action = getAction(fixture.root, ["engram", "config-review"]);
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = fixture.configPath;

  try {
    const result = await captureAction(action, { json: true });
    const report = JSON.parse(result.output) as {
      summary: { problem: number };
    };
    assert.equal(report.summary.problem > 0, true);
    assert.equal(result.exitCode, 1);
  } finally {
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  }
});

test("setup CLI previews managed explicit-capture instructions without writing MEMORY.md", async () => {
  const fixture = await makeFixture({ captureMode: "explicit" });
  const action = getAction(fixture.root, ["engram", "setup"]);
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = fixture.configPath;

  try {
    const result = await captureAction(action, {
      json: true,
      previewCaptureInstructions: true,
    });
    const report = JSON.parse(result.output) as {
      explicitCapture: {
        preview: string | null;
        memoryDocExists: boolean;
      };
    };
    assert.match(report.explicitCapture.preview ?? "", /BEGIN ENGRAM EXPLICIT CAPTURE INSTRUCTIONS/);
    assert.equal(report.explicitCapture.memoryDocExists, false);
    assert.equal(result.exitCode, undefined);
  } finally {
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  }
});

test("setup CLI removes managed explicit-capture instructions when requested", async () => {
  const fixture = await makeFixture({ captureMode: "explicit" });
  const action = getAction(fixture.root, ["engram", "setup"]);
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = fixture.configPath;

  try {
    const install = await captureAction(action, {
      json: true,
      installCaptureInstructions: true,
    });
    const installed = JSON.parse(install.output) as {
      explicitCapture: {
        memoryDocExists: boolean;
      };
    };
    assert.equal(installed.explicitCapture.memoryDocExists, true);

    const removed = await captureAction(action, {
      json: true,
      removeCaptureInstructions: true,
    });
    const report = JSON.parse(removed.output) as {
      explicitCapture: {
        memoryDocExists: boolean;
        memoryDocRemoved: boolean;
      };
    };
    assert.equal(report.explicitCapture.memoryDocRemoved, true);
    assert.equal(report.explicitCapture.memoryDocExists, false);
    assert.equal(removed.exitCode, undefined);
  } finally {
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  }
});
