import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = join(__dirname, "cli.ts");

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
});
