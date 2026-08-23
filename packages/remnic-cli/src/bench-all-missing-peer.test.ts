import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// PR #2835 review follow-up: `remnic bench run --all` without the optional
// @remnic/bench peer used to expand to an empty selection and exit with the
// misleading "no runnable benchmarks are available for --all" catalogue
// message — before the per-benchmark loop could emit its install hint. The
// CLI must detect the missing package before expanding --all and print the
// same actionable install hint a named benchmark gets, with a nonzero exit.
//
// The children run the real CLI dispatch (src/index.ts via tsx). A module
// resolve hook makes exactly the bare specifier "@remnic/bench"
// unresolvable, reproducing what a published install without the optional
// peer sees; every other resolution (tsx, workspace packages) delegates
// through the normal chain. HOME points at a throwaway directory so the
// named-run case cannot write bench-status files into a real home.
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const cliEntry = join(repoRoot, "packages", "remnic-cli", "src", "index.ts");

const HOOK_REGISTER_SOURCE = `import { register } from "node:module";
register(new URL("./force-missing-bench-hook.mjs", import.meta.url));
`;

const HOOK_SOURCE = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@remnic/bench") {
    const err = new Error(
      \`Cannot find package '@remnic/bench' imported from \${context.parentURL ?? "unknown"}\`,
    );
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  }
  return nextResolve(specifier, context);
}
`;

interface MissingBenchPeerFixture {
  homeDir: string;
  importArgs: string[];
}

async function writeMissingBenchPeerFixture(
  root: string,
): Promise<MissingBenchPeerFixture> {
  const homeDir = join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const registerEntry = join(root, "force-missing-bench-register.mjs");
  await writeFile(registerEntry, HOOK_REGISTER_SOURCE, "utf8");
  await writeFile(
    join(root, "force-missing-bench-hook.mjs"),
    HOOK_SOURCE,
    "utf8",
  );
  return { homeDir, importArgs: ["--import", pathToFileURL(registerEntry).href] };
}

function runCliWithMissingBenchPeer(
  importArgs: string[],
  homeDir: string,
  cliArgs: string[],
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--conditions=remnic-source",
      "--import",
      "tsx",
      ...importArgs,
      cliEntry,
      ...cliArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_CLI_BIN: "1",
        HOME: homeDir,
      },
    },
  );
}

test("bench run --all without @remnic/bench exits nonzero with the install hint", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "remnic-all-missing-peer-"));
  try {
    const { homeDir, importArgs } = await writeMissingBenchPeerFixture(tempRoot);

    const result = runCliWithMissingBenchPeer(importArgs, homeDir, [
      "bench",
      "run",
      "--all",
    ]);

    assert.notEqual(
      result.status,
      0,
      `bench run --all must exit nonzero without @remnic/bench: ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /bench run --all requires @remnic\/bench/,
      `expected the actionable install hint, got: ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /install @remnic\/bench/,
      `hint must tell the user how to install the runtime, got: ${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stderr,
      /no runnable benchmarks/,
      `must not print the misleading catalogue message, got: ${result.stderr}`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bench run <name> without @remnic/bench keeps its per-benchmark install hint", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "remnic-named-missing-peer-"));
  try {
    const { homeDir, importArgs } = await writeMissingBenchPeerFixture(tempRoot);

    const result = runCliWithMissingBenchPeer(importArgs, homeDir, [
      "bench",
      "run",
      "locomo",
    ]);

    assert.notEqual(
      result.status,
      0,
      `bench run locomo must exit nonzero without @remnic/bench: ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /Benchmark "locomo" requires @remnic\/bench\. Build the workspace packages \(or install @remnic\/bench\) and retry\./,
      `named run must keep the per-benchmark install hint, got: ${result.stderr}`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
