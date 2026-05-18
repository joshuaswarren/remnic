import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = join(__dirname, "cli.ts");

function mergeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
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

function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [tsxCli, cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
    env: mergeEnv(envOverrides),
  });
}

function runCliWithConfig(config: unknown) {
  const tempDir = mkdtempSync(join(tmpdir(), "remnic-weclone-cli-"));
  const configPath = join(tempDir, "weclone.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  try {
    return runCli(["--config", configPath]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeInvalidConfig(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      proxyPort: 8100,
      remnicDaemonUrl: "http://127.0.0.1:4318",
    }),
    { mode: 0o600 },
  );
}

function listenOnEphemeralPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolveServer, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
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

describe("remnic-weclone-proxy CLI", () => {
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
    const configPath = join(remnicHome, "connectors", "weclone.json");
    writeInvalidConfig(configPath);

    try {
      const result = runCli([], {
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

  it("expands tilde in explicit --config paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "remnic-weclone-cli-"));
    const home = join(tempDir, "home");
    const configPath = join(home, ".remnic", "connectors", "weclone.json");
    writeInvalidConfig(configPath);

    try {
      const result = runCli(["--config", "~/.remnic/connectors/weclone.json"], {
        HOME: home,
        USERPROFILE: home,
        REMNIC_HOME: undefined,
        ENGRAM_HOME: undefined,
      });

      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid config at /);
      assert.ok(result.stderr.includes(configPath), result.stderr);
      assert.match(result.stderr, /wecloneApiUrl/);
      assert.doesNotMatch(result.stderr, /Config not found/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
