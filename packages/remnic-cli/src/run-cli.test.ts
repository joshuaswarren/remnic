/**
 * Harness tests for `runCli` — the in-process CLI entry point (#1532 Phase A).
 *
 * These tests do NOT exercise the dispatcher's command behaviour (that is
 * `cli-command-surface.test.ts`). They verify the wrapper itself:
 *   - stdout / stderr are captured (whether written via `process.stdout`,
 *     `console.log`, `console.error`, etc.)
 *   - `process.exit(N)` is captured as `exitCode: N` without terminating
 *     the test process
 *   - uncaught throws become `exitCode: 1` + a `Fatal:` line on stderr
 *     (mirroring the binary's auto-runner `.catch`)
 *   - cwd / env overrides take effect for the duration of the run and are
 *     restored afterwards, even when the dispatcher fails
 *   - the exit code defaults to 0 when the dispatcher returns normally
 *
 * Together these give the surface tests a deterministic harness whose
 * behaviour matches the real `remnic` binary as closely as an in-process
 * run allows.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { formatConsoleArgs, runCli } from "./run-cli.js";

// Isolate HOME for the entire file so the dispatcher's migrateFromEngram()
// (which runs for every non-migrate command) is a no-op against an empty
// temp directory rather than the developer's real ~/.engram or ~/.remnic.
let tempHome = "";
let originalHome: string | undefined;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-test-home-"));
  process.env.HOME = tempHome;
});

after(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

test("runCli captures stdout written via console.log", async () => {
  // `remnic status` against an empty temp HOME reports the server is
  // stopped (no PID file) — a deterministic, no-network check.
  const result = await runCli(["status"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Remnic server:/);
  assert.equal(result.stderr, "");
});

test("runCli captures stdout written via process.stdout.write directly", async () => {
  // The default usage path (no command / unknown command) writes through
  // console.log, which routes through process.stdout.write — verify
  // capture works for that path too.
  const result = await runCli([]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /remnic — Remnic memory CLI/);
});

test("runCli captures exitCode 1 from process.exit(1) without terminating the process", async () => {
  // `remnic daemon <invalid>` writes the usage line and calls process.exit(1).
  const result = await runCli(["daemon", "bogus-action"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Usage: remnic daemon/);
});

test("runCli captures exitCode from a subcommand that exits with explicit code", async () => {
  // `remnic tree generate --max-per-category notanumber` exits 1 with an
  // explicit numeric argument; this exercises the typeof-code === 'number'
  // branch of the intercepted process.exit.
  const result = await runCli(["tree", "generate", "--max-per-category", "notanumber"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Invalid --max-per-category: notanumber/);
});

test("runCli captures uncaught throws as exitCode 1 + Fatal line on stderr", async () => {
  // `remnic xray` with no query throws synchronously inside cmdXray via
  // parseXrayCliOptions. The dispatcher does not catch it, so it unwinds
  // to runCli — mirroring the binary's auto-runner .catch handler.
  const result = await runCli(["xray"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Fatal:/);
});

test("runCli honours the cwd override and restores it afterwards", async () => {
  const cwdBefore = process.cwd();
  const isolated = await mkdtemp(path.join(os.tmpdir(), "remnic-cwd-"));
  try {
    const result = await runCli(["init"], { cwd: isolated });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Created .*remnic\.config\.json/);
    const created = path.join(isolated, "remnic.config.json");
    assert.equal(fs.existsSync(created), true, "init wrote into the overridden cwd");
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
  // finally in runCli restored process.cwd — verify from the host side too.
  assert.equal(process.cwd(), cwdBefore);
});

test("runCli honours env overrides and restores prior values afterwards", async () => {
  const previousValue = process.env.REMNIC_TEST_ENV_VAR;
  process.env.REMNIC_TEST_ENV_VAR = "original";
  try {
    // Use a command that doesn't read this var — we only need to verify
    // set/restore semantics. The var is set during the run and restored
    // to "original" afterwards.
    await runCli(["status"], {
      env: { REMNIC_TEST_ENV_VAR: "overridden" },
    });
    assert.equal(process.env.REMNIC_TEST_ENV_VAR, "original", "env override was restored to its pre-run value");
  } finally {
    if (previousValue === undefined) {
      delete process.env.REMNIC_TEST_ENV_VAR;
    } else {
      process.env.REMNIC_TEST_ENV_VAR = previousValue;
    }
  }
});

test("runCli deletes env keys mapped to undefined and restores them afterwards", async () => {
  // Pre-existing key gets deleted during the run, restored afterwards.
  const previousValue = process.env.REMNIC_TEST_DELETE_VAR;
  process.env.REMNIC_TEST_DELETE_VAR = "set";
  try {
    await runCli(["status"], {
      env: { REMNIC_TEST_DELETE_VAR: undefined },
    });
    assert.equal(process.env.REMNIC_TEST_DELETE_VAR, "set", "deleted env key was restored after the run");
  } finally {
    if (previousValue === undefined) {
      delete process.env.REMNIC_TEST_DELETE_VAR;
    } else {
      process.env.REMNIC_TEST_DELETE_VAR = previousValue;
    }
  }
});

test("runCli restores process.stdout / process.stderr / console even on a throw", async () => {
  const originalStdoutWrite = process.stdout.write;
  const originalConsoleLog = console.log;
  await runCli(["xray", "--format", "bogus-format-value"]);
  // If finally didn't restore, subsequent writes would be lost to the
  // captured buffer. Verify the bindings are the same identity.
  assert.equal(process.stdout.write, originalStdoutWrite);
  assert.equal(console.log, originalConsoleLog);
});

test("runCli routes custom stdout/stderr sinks instead of the default buffer", async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const result = await runCli(["daemon", "bogus-action"], {
    stdout: { write: (chunk) => void stdoutChunks.push(chunk) },
    stderr: { write: (chunk) => void stderrChunks.push(chunk) },
  });
  assert.equal(result.exitCode, 1);
  // The captured buffers stay empty because the custom sink was used.
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(stdoutChunks.join("").includes("Usage: remnic daemon"));
  assert.equal(stderrChunks.length, 0);
});

test("runCli rejects non-array argv with a TypeError", async () => {
  await assert.rejects(() => runCli(undefined as unknown as string[]), /argv must be an array/);
});

test("runCli's swapped process.stdout / process.stderr are accepted by child_process stdio", async () => {
  // Regression for the #1613 review thread on run-cli.ts:194. Commands
  // that pass process.stdout / process.stderr into child_process stdio
  // (e.g. `bench datasets download --json` redirects the dataset script's
  // stdout to parent stderr via ["inherit", process.stderr, "inherit"])
  // must not fail with "The argument 'stdio' is invalid" when invoked
  // through runCli. Node's child_process only honours a stream-typed
  // stdio entry when it carries a numeric .fd; the fakes runCli installs
  // must therefore expose .fd (1 / 2) so they're accepted as stdio
  // targets, routing the child's output to the real underlying fd.
  //
  // We probe from inside a custom stdout sink: runCli has already swapped
  // process.stdout AND process.stderr to the fakes by the time the
  // dispatcher writes its first line, so the spawns inside the sink see
  // the fakes. Using process.execPath keeps the probe hermetic (no shell,
  // no network, no external script).
  const childProcess = await import("node:child_process");
  const errors: string[] = [];
  let probeRan = false;
  const probeStdout = {
    write: (chunk: string) => {
      if (!probeRan) {
        probeRan = true;
        // Mirror the exact stdio shape `bench datasets download --json`
        // uses: ["inherit", <parent stream>, "inherit"]. Probe both
        // process.stderr (the production path) and process.stdout (for
        // symmetry — any future command passing stdout hits the same
        // validation).
        for (const stream of [process.stderr, process.stdout]) {
          try {
            childProcess.execFileSync(process.execPath, ["-e", "process.exit(0)"], {
              stdio: ["inherit", stream, "inherit"],
            });
          } catch (err) {
            errors.push((err as Error).message.split("\n")[0]);
          }
        }
      }
      return true;
    },
  };
  // `daemon bogus-action` prints a usage line to stdout via console.log,
  // which routes through runCli's swapped console.log -> stdout sink,
  // triggering our probe on the first write.
  await runCli(["daemon", "bogus-action"], { stdout: probeStdout });
  assert.equal(probeRan, true, "probe never ran — daemon bogus-action wrote no stdout");
  assert.deepEqual(errors, [], `child spawn under runCli failed: ${JSON.stringify(errors)}`);
});

test("runCli captures @remnic/core logger output (CONSOLE_LOGGER late-binds console.*)", async () => {
  // Regression for the #1613 review thread on logger pre-binding
  // (PRRT_kwDORJXyws6OXb9H): @remnic/core's default CONSOLE_LOGGER
  // backend must late-bind console.* so that runCli's console swap
  // routes log.info/warn/error through the capture buffer. With the old
  // pre-bound form (console.warn.bind(console)), a command that called
  // initLogger() pinned the logger to the original console methods
  // before runCli could swap them, so log.warn / log.info output
  // escaped RunCliResult and polluted the test runner's real stderr.
  const { log, initLogger } = await import("@remnic/core");
  // initLogger() with no args pins _backend to CONSOLE_LOGGER. Under
  // late-binding this resolves console.* at call time (picking up the
  // swap); under the old pre-bound form it captured the originals.
  initLogger();
  const stderrChunks: string[] = [];
  const result = await runCli(["daemon", "bogus-action"], {
    stdout: {
      write: (chunk: string) => {
        // Emit a core-logger line from INSIDE the run — runCli has
        // already swapped console.warn by the time the dispatcher
        // writes its first stdout line, so late-binding routes log.warn
        // through the swapped console.warn -> stderr sink. Under
        // pre-binding the warn would escape to the real process.stderr.
        log.warn("regression-probe: captured-via-late-bind");
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => { stderrChunks.push(chunk); return true; },
    },
  });
  const captured = stderrChunks.join("");
  assert.ok(
    captured.includes("regression-probe: captured-via-late-bind"),
    "core logger output escaped runCli's capture — CONSOLE_LOGGER must late-bind console.* (no .bind(console) in logger.ts)",
  );
});

test("runCli rejects concurrent calls (process-global swap hazard)", async () => {
  // Regression for the #1613 review thread on concurrent invocation
  // (PRRT_kwDORJXyws6OXfNf): runCli swaps process-wide globals
  // (process.stdout/stderr/exit/argv, console.*, cwd, env). Two
  // concurrent calls would snapshot each other's fakes and restore in
  // the wrong order. The re-entry guard makes that a loud failure.
  //
  // Start a runCli call — it sets activeRun = true and suspends at
  // `await main(argv)`. Node's single-threaded event loop guarantees
  // the second synchronous entry sees activeRun still true.
  const first = runCli(["status"]);
  await assert.rejects(
    () => runCli(["status"]),
    /another runCli call is in progress/,
  );
  // Let the first finish and clear the guard.
  await first;
  // After the first completes, a new call must succeed — the guard was
  // cleared in finally.
  const result = await runCli(["status"]);
  assert.equal(result.exitCode, 0);
});

test("formatConsoleArgs substitutes printf-style specifiers via util.format", () => {
  // Regression for the #1613 review thread on formatConsoleArgs
  // (PRRT_kwDORJXyws6OXhGV): the old custom formatter joined args with
  // spaces without substituting printf-style specifiers, so a core log
  // line like log.info("found %d items in %s", 3, "scope") was captured
  // as "found %d items in %s 3 scope" instead of "found 3 items in
  // scope". Using util.format (the exact function console.* uses
  // internally) makes captured output byte-identical to the binary's
  // console output.
    // %d / %s substitution
  assert.equal(
    formatConsoleArgs(["found %d items in %s", 3, "scope"]),
    "found 3 items in scope\n",
  );
  // %j (JSON) substitution
  assert.equal(
    formatConsoleArgs(["config: %j", { verbose: true }]),
    'config: {"verbose":true}\n',
  );
  // No specifiers — plain join with newline (matches console.log)
  assert.equal(
    formatConsoleArgs(["hello", "world"]),
    "hello world\n",
  );
});
