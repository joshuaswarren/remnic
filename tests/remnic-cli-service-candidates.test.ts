import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("cli service candidate helper falls through to legacy service labels after a failure", async () => {
  const { firstSuccessfulCandidate } = await import(
    path.join(ROOT, "packages/remnic-cli/src/service-candidates.ts")
  );
  const calls: string[] = [];
  const result = firstSuccessfulCandidate(["remnic.service", "engram.service"], (candidate) => {
    calls.push(candidate);
    if (candidate === "remnic.service") {
      throw new Error("canonical service missing");
    }
  });
  assert.equal(result, "engram.service");
  assert.deepEqual(calls, ["remnic.service", "engram.service"]);
});

test("daemon service candidates include legacy ai.remnic.server launchd service", async () => {
  const {
    LAUNCHD_LABEL_CANDIDATES,
    launchdPlistPaths,
  } = await import(path.join(ROOT, "packages/remnic-cli/src/daemon-service-candidates.ts"));
  const homeDir = path.join(os.tmpdir(), "remnic-service-candidates-home");

  assert.deepEqual(
    LAUNCHD_LABEL_CANDIDATES,
    ["ai.remnic.daemon", "ai.remnic.server", "ai.engram.daemon"],
  );
  assert.ok(
    launchdPlistPaths(homeDir).includes(
      path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.server.plist"),
    ),
  );
});

test("daemon server binary resolution falls back to remnic-server on PATH before TypeScript source", async () => {
  const {
    resolveServerBinPath,
  } = await import(path.join(ROOT, "packages/remnic-cli/src/daemon-service-candidates.ts"));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-bin-"));
  const packageDir = path.join(tempDir, "packages", "remnic-cli", "dist");
  const binDir = path.join(tempDir, "bin");
  const globalServer = path.join(tempDir, "lib", "node_modules", "@remnic", "server", "dist", "bin", "remnic-server.js");
  const pathServer = path.join(binDir, "remnic-server");

  fs.mkdirSync(path.dirname(globalServer), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
  await writeFile(globalServer, "#!/usr/bin/env node\n", "utf8");
  await chmod(globalServer, 0o755);
  await symlink(globalServer, pathServer);

  const resolved = resolveServerBinPath(packageDir, binDir);
  assert.equal(resolved, fs.realpathSync(globalServer));
});

test("daemon server binary resolution unwraps shell shims to runnable JavaScript", async () => {
  const {
    resolveServerBinPath,
  } = await import(path.join(ROOT, "packages/remnic-cli/src/daemon-service-candidates.ts"));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-shim-"));
  const packageDir = path.join(tempDir, "packages", "remnic-cli", "dist");
  const binDir = path.join(tempDir, "bin");
  const globalServer = path.join(tempDir, "lib", "node_modules", "@remnic", "server", "dist", "bin", "remnic-server.js");
  const pathServer = path.join(binDir, "remnic-server");

  fs.mkdirSync(path.dirname(globalServer), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
  await writeFile(globalServer, "#!/usr/bin/env node\nimport '../index.js';\n", "utf8");
  await chmod(globalServer, 0o755);
  await writeFile(
    pathServer,
    [
      "#!/bin/sh",
      "export REMNIC_SERVER_ENV=test",
      "basedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")",
      "exec node \"$basedir/../lib/node_modules/@remnic/server/dist/bin/remnic-server.js\" \"$@\"",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(pathServer, 0o755);

  const resolved = resolveServerBinPath(packageDir, binDir);
  assert.equal(resolved, fs.realpathSync(globalServer));
});
