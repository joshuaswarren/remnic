import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGracefulShutdownHandler } from "./shutdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = join(__dirname, "cli.ts");
const builtCliPath = join(__dirname, "..", "dist", "cli.js");

function buildConnectorCli(): void {
  const result = spawnSync("pnpm", ["--filter", "@remnic/connector-weclone", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function buildCliEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function runCliWithArgs(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCli, cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: buildCliEnv(env),
    timeout: 5_000,
  });
}

function runCliWithConfig(config: unknown) {
  const tempDir = mkdtempSync(join(tmpdir(), "remnic-weclone-cli-"));
  const configPath = join(tempDir, "weclone.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  try {
    return spawnSync(process.execPath, [tsxCli, cliPath, "--config", configPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runBuiltCliWithConfig(config: unknown) {
  const tempDir = mkdtempSync(join(tmpdir(), "remnic-weclone-built-cli-"));
  const configPath = join(tempDir, "weclone.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  try {
    return spawnSync(process.execPath, [builtCliPath, "--config", configPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCliWithoutConfig(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsxCli, cliPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: buildCliEnv(env),
    timeout: 5_000,
  });
}

function listenOnEphemeralPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolveServer, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolveServer({ server, port: address.port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolveClose();
    });
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("remnic-weclone-proxy CLI", () => {
  it("exercises the built package bin artifact", () => {
    buildConnectorCli();

    const result = runBuiltCliWithConfig({
      proxyPort: 8100,
      remnicDaemonUrl: "http://127.0.0.1:4318",
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid config at .*weclone\.json:/);
    assert.match(result.stderr, /wecloneApiUrl/);
  });

  it("prints a controlled error for semantically invalid config", () => {
    const result = runCliWithConfig({
      proxyPort: 8100,
      remnicDaemonUrl: "http://127.0.0.1:4318",
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid config at .*weclone\.json:/);
    assert.match(result.stderr, /wecloneApiUrl/);
    assert.doesNotMatch(result.stderr, /at parseConfig/);
  });

  it("falls back to ENGRAM_HOME when REMNIC_HOME is empty", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "remnic-weclone-env-"));
    const remnicHome = join(tempDir, "legacy-home");
    const configDir = join(remnicHome, "connectors");
    const configPath = join(configDir, "weclone.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        proxyPort: 8100,
        remnicDaemonUrl: "http://127.0.0.1:4318",
      }),
      { mode: 0o600 },
    );

    try {
      const result = runCliWithoutConfig({
        REMNIC_HOME: "",
        ENGRAM_HOME: remnicHome,
        HOME: join(tempDir, "home"),
      });

      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`Invalid config at ${configPath}:`));
      assert.match(result.stderr, /wecloneApiUrl/);
      assert.doesNotMatch(result.stderr, /Config not found/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("expands tilde in --config paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "remnic-weclone-tilde-config-"));
    const home = join(tempDir, "home");
    const configDir = join(home, ".remnic", "connectors");
    const configPath = join(configDir, "weclone.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        proxyPort: 8100,
        remnicDaemonUrl: "http://127.0.0.1:4318",
      }),
      { mode: 0o600 },
    );

    try {
      const result = runCliWithArgs(["--config", "~/.remnic/connectors/weclone.json"], {
        HOME: home,
        REMNIC_HOME: undefined,
        ENGRAM_HOME: undefined,
      });

      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`Invalid config at ${configPath}:`));
      assert.match(result.stderr, /wecloneApiUrl/);
      assert.doesNotMatch(result.stderr, /Config not found/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects --config when the next token is another option", () => {
    const result = runCliWithArgs(["--config", "--unknown"]);

    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error: --config requires a path argument/);
    assert.doesNotMatch(result.stderr, /Config not found/);
  });

  it("expands tilde in REMNIC_HOME default config paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "remnic-weclone-tilde-home-"));
    const home = join(tempDir, "home");
    const configDir = join(home, "remnic-home", "connectors");
    const configPath = join(configDir, "weclone.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        proxyPort: 8100,
        remnicDaemonUrl: "http://127.0.0.1:4318",
      }),
      { mode: 0o600 },
    );

    try {
      const result = runCliWithoutConfig({
        HOME: home,
        REMNIC_HOME: "~/remnic-home",
        ENGRAM_HOME: undefined,
      });

      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`Invalid config at ${configPath}:`));
      assert.match(result.stderr, /wecloneApiUrl/);
      assert.doesNotMatch(result.stderr, /Config not found/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prints a controlled error when proxy startup fails", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      const result = runCliWithConfig({
        wecloneApiUrl: "http://127.0.0.1:8000/v1",
        proxyPort: port,
        remnicDaemonUrl: "http://127.0.0.1:4318",
      });

      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Failed to start WeClone proxy:/);
      assert.match(result.stderr, /EADDRINUSE|address already in use/i);
    } finally {
      await closeServer(server);
    }
  });

  it("awaits proxy stop before exiting and ignores duplicate shutdown signals", async () => {
    const stopGate = deferred();
    const exitGate = deferred<number>();
    const exitCodes: number[] = [];
    let stopCalls = 0;

    const handler = createGracefulShutdownHandler(
      {
        async stop() {
          stopCalls += 1;
          await stopGate.promise;
        },
      },
      {
        exit(code) {
          exitCodes.push(code);
          exitGate.resolve(code);
        },
        logError() {},
      },
    );

    handler();
    handler();

    assert.equal(stopCalls, 1);
    assert.deepEqual(exitCodes, []);

    stopGate.resolve();
    assert.equal(await exitGate.promise, 0);
    assert.deepEqual(exitCodes, [0]);
  });

  it("reports a failed proxy stop and exits nonzero", async () => {
    const exitGate = deferred<number>();
    const logged: string[] = [];
    const handler = createGracefulShutdownHandler(
      {
        async stop() {
          throw new Error("flush failed");
        },
      },
      {
        exit(code) {
          exitGate.resolve(code);
        },
        logError(message) {
          logged.push(message);
        },
      },
    );

    handler();

    assert.equal(await exitGate.promise, 1);
    assert.match(logged.join("\n"), /Failed to stop WeClone proxy: flush failed/);
  });
});
