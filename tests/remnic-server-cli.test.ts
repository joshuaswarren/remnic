import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Orchestrator } from "@remnic/core";
import { cliMain, startServer } from "../packages/remnic-server/src/index.js";
import { runServerBin } from "../packages/remnic-server/bin/server-bin.js";

function restoreEnv(t: TestContext, keys: string[]): void {
  const snapshot = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate a free TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

test("remnic-server CLI rejects documented value options without values", async () => {
  for (const option of ["--config", "--host", "--port", "--auth-token"]) {
    await assert.rejects(
      () => cliMain([option]),
      new RegExp(`Missing value for ${option}`),
      `${option} should require a following value`,
    );

    await assert.rejects(
      () => cliMain([option, "--help"]),
      new RegExp(`Missing value for ${option}`),
      `${option} should not consume the next option as its value`,
    );
  }
});

test("remnic-server CLI rejects empty inline values", async () => {
  await assert.rejects(
    () => cliMain(["--auth-token="]),
    /Missing value for --auth-token/,
  );
});

test("remnic-server CLI accepts inline values that look like options", async () => {
  await assert.rejects(
    () => cliMain(["--auth-token=--some-secret", "--port", "0"]),
    /Invalid --port: expected an integer port from 1 to 65535/,
  );
});

test("remnic-server CLI rejects invalid port values before startup", async () => {
  for (const port of ["0", "65536", "3.7", "abc"]) {
    await assert.rejects(
      () => cliMain(["--port", port]),
      /Invalid --port: expected an integer port from 1 to 65535/,
      `port ${port} should be rejected`,
    );
  }
});

test("remnic-server CLI rejects unknown long options", async () => {
  await assert.rejects(
    () => cliMain(["--auth-tokn", "secret"]),
    /Unknown option --auth-tokn/,
  );
});

test("remnic-server bin wrapper delegates help-mixed value flags to CLI validation", async () => {
  let stderr = "";
  let exitCode: number | undefined;
  let receivedArgv: string[] | undefined;

  await assert.rejects(
    () =>
      runServerBin("remnic-server", {
        argv: ["--auth-token", "--help"],
        loadCliMain: async () => ({
          cliMain: async (argv: string[]) => {
            receivedArgv = argv;
            throw new Error("Missing value for --auth-token");
          },
        }),
        stderr: (value: string) => {
          stderr += value;
        },
        exit: (code: number) => {
          exitCode = code;
          throw new Error(`exit ${code}`);
        },
      }),
    /exit 1/,
  );

  assert.deepEqual(receivedArgv, ["--auth-token", "--help"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing value for --auth-token/);
});

test("startServer rejects invalid direct option ports before initializing", async (t) => {
  restoreEnv(t, ["REMNIC_PORT", "ENGRAM_PORT"]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;

  await assert.rejects(
    () =>
      startServer({
        port: 0,
      }),
    /Invalid options\.port: expected an integer port from 1 to 65535/,
  );
});

test("startServer lets direct option port override invalid environment ports", async (t) => {
  restoreEnv(t, [
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);
  process.env.REMNIC_PORT = "abc";
  delete process.env.ENGRAM_PORT;
  delete process.env.ENGRAM_MEMORY_DIR;
  process.env.REMNIC_AUTH_TOKEN = "test-token";
  delete process.env.ENGRAM_AUTH_TOKEN;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-env-port-"));
  process.env.REMNIC_MEMORY_DIR = tempDir;
  const configPath = path.join(tempDir, "remnic.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: { memoryDir: tempDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop" },
    }),
    "utf8",
  );
  const port = await getFreePort();
  const result = await startServer({
    configPath,
    port,
  });

  try {
    assert.equal(result.port, port);
  } finally {
    result.cancelStartupSync();
    result.abortDeferredInit();
    await result.httpServer.stop();
  }
});

test("startServer rejects invalid environment ports before initializing", async (t) => {
  restoreEnv(t, ["REMNIC_PORT", "ENGRAM_PORT"]);
  process.env.REMNIC_PORT = "abc";
  delete process.env.ENGRAM_PORT;

  await assert.rejects(
    () => startServer(),
    /Invalid REMNIC_PORT\/ENGRAM_PORT: expected an integer port from 1 to 65535/,
  );
});

test("startServer expands tilde in explicit config paths", async (t) => {
  restoreEnv(t, [
    "HOME",
    "REMNIC_CONFIG_PATH",
    "ENGRAM_CONFIG_PATH",
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);

  const tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-server-home-"));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-memory-"));
  const configDir = path.join(tempHome, ".config", "remnic");
  const configPath = path.join(configDir, "config.json");
  const port = await getFreePort();

  process.env.HOME = tempHome;
  delete process.env.REMNIC_CONFIG_PATH;
  delete process.env.ENGRAM_CONFIG_PATH;
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: { memoryDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop" },
      server: { port, authToken: "test-token" },
    }),
    "utf8",
  );

  const result = await startServer({ configPath: "~/.config/remnic/config.json" });

  try {
    assert.equal(result.port, port);
    assert.equal(result.config.memoryDir, memoryDir);
  } finally {
    result.cancelStartupSync();
    result.abortDeferredInit();
    await result.httpServer.stop();
  }
});

test("startServer rejects missing explicit config paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-missing-config-"));

  await assert.rejects(
    () => startServer({ configPath: path.join(tempDir, "missing-config.json") }),
    /Config file from --config not found:/,
  );
});

test("startServer rejects missing explicit env config paths", async (t) => {
  restoreEnv(t, ["REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH"]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-missing-env-config-"));
  process.env.REMNIC_CONFIG_PATH = path.join(tempDir, "missing-config.json");
  delete process.env.ENGRAM_CONFIG_PATH;

  await assert.rejects(
    () => startServer(),
    /Config file from REMNIC_CONFIG_PATH\/ENGRAM_CONFIG_PATH not found:/,
  );
});

test("startServer skips non-file auto-discovered config candidates", async (t) => {
  restoreEnv(t, [
    "REMNIC_CONFIG_PATH",
    "ENGRAM_CONFIG_PATH",
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);

  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-autodiscovery-"));
  const memoryDir = path.join(tempDir, "memory");
  const port = await getFreePort();

  delete process.env.REMNIC_CONFIG_PATH;
  delete process.env.ENGRAM_CONFIG_PATH;
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  await mkdir(path.join(tempDir, "remnic.config.json"), { recursive: true });
  await writeFile(
    path.join(tempDir, "engram.config.json"),
    JSON.stringify({
      remnic: { memoryDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop" },
      server: { port, authToken: "test-token" },
    }),
    "utf8",
  );

  process.chdir(tempDir);
  const result = await startServer();

  try {
    assert.equal(result.port, port);
    assert.equal(result.config.memoryDir, memoryDir);
  } finally {
    result.cancelStartupSync();
    result.abortDeferredInit();
    await result.httpServer.stop();
  }
});

test("startServer rejects invalid config file ports before initializing", async (t) => {
  restoreEnv(t, ["REMNIC_PORT", "ENGRAM_PORT"]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-config-port-"));
  const configPath = path.join(tempDir, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ server: { port: "abc" } }), "utf8");

  await assert.rejects(
    () => startServer({ configPath }),
    /Invalid server\.port: expected an integer port from 1 to 65535/,
  );
});

test("admin config PATCH writes config atomically with owner-only permissions", async (t) => {
  restoreEnv(t, [
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-admin-config-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const memoryDir = path.join(tempDir, "memory");
  const configPath = path.join(tempDir, "remnic.config.json");
  const port = await getFreePort();
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        memoryDir,
        openaiApiKey: false,
        qmdEnabled: false,
        qmdDaemonEnabled: false,
        searchBackend: "noop",
      },
      server: { authToken: "test-token", adminConsoleEnabled: true },
    }),
    "utf8",
  );
  await chmod(configPath, 0o644);

  const result = await startServer({ configPath, port });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/admin/config`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ localLlmEnabled: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { config?: { restartRequired?: boolean } };
    assert.equal(body.config?.restartRequired, true);

    const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
      remnic?: { localLlmEnabled?: boolean };
    };
    assert.equal(persisted.remnic?.localLlmEnabled, true);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const leftovers = (await readdir(tempDir)).filter((entry) => entry.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await result.stop();
  }
});

test("admin config PATCH preserves flat remnic config files that also have server settings", async (t) => {
  restoreEnv(t, [
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-admin-flat-config-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const memoryDir = path.join(tempDir, "memory");
  const configPath = path.join(tempDir, "remnic.config.json");
  const port = await getFreePort();
  await writeFile(
    configPath,
    JSON.stringify({
      memoryDir,
      openaiApiKey: false,
      qmdEnabled: false,
      qmdDaemonEnabled: false,
      searchBackend: "noop",
      server: { authToken: "test-token", adminConsoleEnabled: true },
    }),
    "utf8",
  );

  const result = await startServer({ configPath, port });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/admin/config`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ localLlmEnabled: true }),
    });
    assert.equal(response.status, 200);

    const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
      remnic?: unknown;
      memoryDir?: string;
      openaiApiKey?: unknown;
      qmdEnabled?: boolean;
      qmdDaemonEnabled?: boolean;
      searchBackend?: string;
      localLlmEnabled?: boolean;
    };
    assert.equal(persisted.remnic, undefined);
    assert.equal(persisted.memoryDir, memoryDir);
    assert.equal(persisted.openaiApiKey, false);
    assert.equal(persisted.qmdEnabled, false);
    assert.equal(persisted.qmdDaemonEnabled, false);
    assert.equal(persisted.searchBackend, "noop");
    assert.equal(persisted.localLlmEnabled, true);
  } finally {
    await result.stop();
  }
});

test("admin config PATCH is unavailable unless admin console is enabled", async (t) => {
  restoreEnv(t, [
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-admin-disabled-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const memoryDir = path.join(tempDir, "memory");
  const configPath = path.join(tempDir, "remnic.config.json");
  const port = await getFreePort();
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        memoryDir,
        openaiApiKey: false,
        qmdEnabled: false,
        qmdDaemonEnabled: false,
        searchBackend: "noop",
      },
      server: { authToken: "test-token" },
    }),
    "utf8",
  );

  const result = await startServer({ configPath, port });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/admin/config`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ localLlmEnabled: true }),
    });
    assert.equal(response.status, 404);

    const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
      remnic?: { localLlmEnabled?: boolean };
    };
    assert.equal(persisted.remnic?.localLlmEnabled, undefined);
  } finally {
    await result.stop();
  }
});

test("admin dashboard discovers Ollama models from OLLAMA_HOST when localLlmUrl is defaulted", async (t) => {
  restoreEnv(t, [
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
    "OLLAMA_HOST",
  ]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  process.env.OLLAMA_HOST = "http://ollama:11434";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://ollama:11434/api/tags") {
      return new Response(JSON.stringify({ models: [{ name: "llama3.2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-ollama-env-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const memoryDir = path.join(tempDir, "memory");
  const configPath = path.join(tempDir, "remnic.config.json");
  const port = await getFreePort();
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        memoryDir,
        openaiApiKey: false,
        localLlmEnabled: true,
        qmdEnabled: false,
        qmdDaemonEnabled: false,
        searchBackend: "noop",
      },
      server: { authToken: "test-token", adminConsoleEnabled: true },
    }),
    "utf8",
  );

  const result = await startServer({ configPath, port });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/admin/dashboard`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      providers?: Array<{ id?: string; detected?: boolean; enabled?: boolean }>;
      models?: Array<{ id?: string; provider?: string; source?: string; endpoint?: string }>;
    };
    assert.equal(body.providers?.find((provider) => provider.id === "ollama")?.detected, true);
    assert.equal(body.providers?.find((provider) => provider.id === "ollama")?.enabled, true);
    assert.ok(body.models?.some((model) => (
      model.provider === "ollama" &&
      model.id === "llama3.2" &&
      model.source === "ollama" &&
      model.endpoint === "http://ollama:11434"
    )));
  } finally {
    await result.stop();
  }
});

test("startServer destroys the orchestrator when HTTP bind fails after initialization", async (t) => {
  restoreEnv(t, [
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-bind-fail-"));
  const memoryDir = path.join(tempDir, "memory");
  const configPath = path.join(tempDir, "remnic.config.json");
  const port = await getFreePort();
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: { memoryDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop" },
      server: { authToken: "test-token" },
    }),
    "utf8",
  );

  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => {
      blocker.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      blocker.close((err) => (err ? reject(err) : resolve()));
    });
  });

  const originalDestroy = Orchestrator.prototype.destroy;
  let destroyCalls = 0;
  (Orchestrator.prototype as unknown as { destroy: typeof originalDestroy }).destroy = async function (
    this: Orchestrator,
  ): Promise<void> {
    destroyCalls += 1;
    return originalDestroy.call(this);
  };
  t.after(() => {
    (Orchestrator.prototype as unknown as { destroy: typeof originalDestroy }).destroy = originalDestroy;
  });

  await assert.rejects(
    () => startServer({ configPath, port }),
    /EADDRINUSE|address already in use/i,
  );
  assert.equal(destroyCalls, 1);
});

/**
 * The daemon calls `initLogger()` at the top of `startServer`, before the
 * config file has been read, so `debug: true` was accepted and then silently
 * ignored (issue #2209) — the one flag an operator reaches for when the daemon
 * is misbehaving. These assert the flag reaches the logger either way.
 */
async function startServerWithDebug(
  t: TestContext,
  debug: boolean,
): Promise<{ debugLines: string[] }> {
  restoreEnv(t, ["REMNIC_PORT", "ENGRAM_PORT", "REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR", "REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN"]);
  for (const key of ["REMNIC_PORT", "ENGRAM_PORT", "REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR"]) delete process.env[key];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-debug-flag-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: { memoryDir: tempDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop", debug },
    }),
    "utf8",
  );

  // Resolve the port BEFORE patching console: a rejection here would otherwise
  // leave the global patched for every later test in the file.
  const port = await getFreePort();
  const debugLines: string[] = [];
  const originalDebug = console.debug;
  console.debug = (...args: unknown[]) => {
    debugLines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await startServer({ configPath, port });
    result.cancelStartupSync();
    result.abortDeferredInit();
    await result.httpServer.stop();
  } finally {
    console.debug = originalDebug;
  }
  return { debugLines };
}

test("startServer honors debug:true from the config file", async (t) => {
  const { debugLines } = await startServerWithDebug(t, true);
  assert.ok(
    debugLines.some((line) => line.includes("debug logging enabled from config")),
    `expected a debug line, got ${debugLines.length} line(s)`,
  );
});

test("startServer emits no debug output when debug:false", async (t) => {
  const { debugLines } = await startServerWithDebug(t, false);
  // Assert the whole channel is silent, not just that our marker is absent:
  // filtering for one message would pass while every other debug line leaked.
  assert.deepEqual(debugLines, []);
});
