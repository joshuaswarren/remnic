import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { formatOperatorError, main, parseArgs, runCli } from "./diagnose-locomo-retrieval-trace-delta.js";

test("expands tilde paths for both inputs and the private output", () => {
  assert.deepEqual(parseArgs(["~/baseline.json", "~/real.json", "--out", "~/delta.json"]), {
    baselinePath: path.join(homedir(), "baseline.json"),
    realPath: path.join(homedir(), "real.json"),
    out: path.join(homedir(), "delta.json"),
  });
});

test("does not expand unsupported named-user prefixes", () => {
  assert.deepEqual(parseArgs(["~someone/baseline.json", "real.json"]), {
    baselinePath: "~someone/baseline.json",
    realPath: "real.json",
  });
});

test("does not expose raw filesystem paths in operator errors", async () => {
  const sentinel = "/private/benchmark/secret-baseline.json";
  await assert.rejects(main([sentinel, "/private/benchmark/secret-real.json"]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /\/private\/benchmark/u);
    assert.match(error.message, /Unable to read (?:baseline|real) retrieval trace JSON: Error \(ENOENT\)/u);
    return true;
  });
  assert.equal(formatOperatorError(new Error(`failed at ${sentinel}`)), "Error");

  let stderr = "";
  const exitCode = await runCli([sentinel, "/private/benchmark/secret-real.json"], {
    write(chunk) {
      stderr += chunk;
    },
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /Unable to read (?:baseline|real) retrieval trace JSON: Error \(ENOENT\)/u);
  assert.doesNotMatch(stderr, /\/private\/benchmark/u);

  stderr = "";
  const invalidArgExitCode = await runCli(["baseline.json", "real.json", "/private/benchmark/secret-output.json"], {
    write(chunk) {
      stderr += chunk;
    },
  });
  assert.equal(invalidArgExitCode, 1);
  assert.equal(stderr, "Invalid command-line arguments.\n");
  assert.doesNotMatch(stderr, /\/private\/benchmark/u);
});

test("reports trusted top-level JSON type errors without exposing paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remnic-trace-delta-"));
  const baselinePath = path.join(directory, "private-baseline.json");
  const realPath = path.join(directory, "private-real.json");
  try {
    await writeFile(realPath, "{}\n", { mode: 0o600 });
    for (const invalidJson of ["null\n", "[]\n"]) {
      await writeFile(baselinePath, invalidJson, { mode: 0o600 });
      let stderr = "";
      const exitCode = await runCli([baselinePath, realPath], {
        write(chunk) {
          stderr += chunk;
        },
      });
      assert.equal(exitCode, 1);
      assert.equal(stderr, "baseline retrieval trace JSON must contain an object.\n");
      assert.doesNotMatch(stderr, /private-baseline|remnic-trace-delta/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
