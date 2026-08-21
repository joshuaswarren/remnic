import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  TailscaleHelper,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from "../src/network/tailscale.ts";

function createRunner(
  mapper: (
    command: string,
    args: string[],
    options?: { timeoutMs?: number },
  ) => TailscaleCommandResult,
): TailscaleCommandRunner {
  return async (command, args, options) => mapper(command, args, options);
}

test("tailscale status returns unavailable when binary check fails", async () => {
  const helper = new TailscaleHelper({
    runner: createRunner(() => ({ code: 1, stdout: "", stderr: "not found" })),
  });

  const status = await helper.status();
  assert.deepEqual(status, { available: false, running: false });
});

test("tailscale status parses running state from JSON", async () => {
  const helper = new TailscaleHelper({
    runner: createRunner((_, args) => {
      if (args[0] === "version") {
        return { code: 0, stdout: "1.80.0\n", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Version: "1.80.0",
          Self: {
            HostName: "engram-node",
            TailscaleIPs: ["100.90.10.20"],
          },
        }),
        stderr: "",
      };
    }),
  });

  const status = await helper.status();
  assert.equal(status.available, true);
  assert.equal(status.running, true);
  assert.equal(status.backendState, "Running");
  assert.equal(status.selfHostname, "engram-node");
  assert.equal(status.selfIp, "100.90.10.20");
});

test("tailscale status rejects invalid JSON output", async () => {
  const helper = new TailscaleHelper({
    runner: createRunner((_, args) => {
      if (args[0] === "version") {
        return { code: 0, stdout: "1.80.0", stderr: "" };
      }
      return { code: 0, stdout: "not-json", stderr: "" };
    }),
  });

  await assert.rejects(() => helper.status(), /invalid JSON/);
});

test("tailscale sync requires tailscale availability", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "engram-ts-sync-unavail-"));

  const helper = new TailscaleHelper({
    runner: createRunner(() => ({ code: 1, stdout: "", stderr: "not found" })),
  });

  await assert.rejects(
    () => helper.syncDirectory({ sourceDir, destination: "node:/dest" }),
    /not installed or not available/i,
  );
});

test("tailscale sync requires running daemon", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "engram-ts-sync-down-"));

  const helper = new TailscaleHelper({
    runner: createRunner((_, args) => {
      if (args[0] === "version") {
        return { code: 0, stdout: "1.80.0", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ BackendState: "Stopped" }),
        stderr: "",
      };
    }),
  });

  await assert.rejects(
    () => helper.syncDirectory({ sourceDir, destination: "node:/dest" }),
    /daemon is not running/i,
  );
});

test("tailscale sync executes rsync with expected args when running", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "engram-ts-sync-ok-"));
  const commands: Array<{ command: string; args: string[]; options?: { timeoutMs?: number } }> = [];

  const helper = new TailscaleHelper({
    runner: createRunner((command, args, options) => {
      commands.push({ command, args, options });
      if (command === "tailscale" && args[0] === "version") {
        return { code: 0, stdout: "1.80.0", stderr: "" };
      }
      if (command === "tailscale" && args[0] === "status") {
        return { code: 0, stdout: JSON.stringify({ BackendState: "Running" }), stderr: "" };
      }
      if (command === "rsync") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    }),
  });

  await helper.syncDirectory({
    sourceDir,
    destination: "engram-peer:/srv/engram",
    delete: true,
    dryRun: true,
    extraArgs: ["--numeric-ids"],
  });

  const rsyncCall = commands.find((entry) => entry.command === "rsync");
  assert.ok(rsyncCall);
  assert.deepEqual(rsyncCall.args.slice(0, 4), ["-az", "--delete", "--dry-run", "--numeric-ids"]);
  assert.equal(rsyncCall.args[4], `${sourceDir}/`);
  assert.equal(rsyncCall.args[5], "engram-peer:/srv/engram");
  assert.equal(rsyncCall.options, undefined);
});
