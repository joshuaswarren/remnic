// Regression tests for issue #2478: the runtime bridge must resolve
// @remnic/coding-graph through the shared loader
// (optional-coding-graph.ts) -- ONE import, ONE cache, ONE contract
// check -- and the miss path must surface the canonical install hint,
// never a raw ERR_MODULE_NOT_FOUND.
//
// Both tests drive the REAL dynamic-import machinery in a child process
// with a registered resolve hook (the established technique from
// packages/remnic-cli/src/openclaw-managed-upgrade.test.ts):
//
//   1. pass-through hook that COUNTS resolutions of the specifier --
//      the shared loader caches success, so a probe + a store open must
//      resolve "@remnic/coding-graph" exactly once. A parallel loader
//      in codegraph-runtime.ts resolves it a second time and fails.
//   2. throwing hook that simulates the absent package -- the store
//      open must reject with the tagged CodegraphRuntimeError whose
//      message is the canonical install hint (buildCodingGraphInstallHint).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const optionalLoaderSource = path.join(
  repoRoot,
  "packages",
  "remnic-core",
  "src",
  "coding",
  "optional-coding-graph.ts",
);
const runtimeSource = path.join(
  repoRoot,
  "packages",
  "remnic-core",
  "src",
  "coding",
  "codegraph-runtime.ts",
);

interface DriverReport {
  opened?: boolean;
  threw?: boolean;
  name?: string;
  code?: unknown;
  message?: string;
}

function makeScratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCountingResolveHook(root: string): { hookPath: string; logPath: string } {
  const logPath = path.join(root, "resolves.log");
  const hookPath = path.join(root, "count-resolves.mjs");
  fs.writeFileSync(
    hookPath,
    `import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@remnic/coding-graph") {
    if (process.env.CODEGRAPH_RESOLVE_LOG) {
      appendFileSync(process.env.CODEGRAPH_RESOLVE_LOG, specifier + "\\n");
    }
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      if (err && err.code === "ERR_MODULE_NOT_FOUND" && process.env.CODEGRAPH_SOURCE_FALLBACK) {
        // Worktree/base install where the optional peer is not linked:
        // map the specifier to the workspace source so the import
        // SUCCEEDS and the shared loader's success cache is observable.
        return { url: pathToFileURL(process.env.CODEGRAPH_SOURCE_FALLBACK).href, shortCircuit: true };
      }
      throw err;
    }
  }
  return nextResolve(specifier, context);
}
`,
    "utf8",
  );
  return { hookPath, logPath };
}

function writeMissingPackageResolveHook(root: string): string {
  const hookPath = path.join(root, "missing-coding-graph.mjs");
  fs.writeFileSync(
    hookPath,
    `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@remnic/coding-graph") {
    const error = new Error("Cannot find package '@remnic/coding-graph' imported from test");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return nextResolve(specifier, context);
}
`,
    "utf8",
  );
  return hookPath;
}

function writeStoreOpenDriver(root: string): string {
  const driverPath = path.join(root, "store-open.mts");
  fs.writeFileSync(
    driverPath,
    `import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , runtimePath, optionalLoaderPath, scratch] = process.argv;
// Prime the shared loader exactly like the real surfaces do (the
// runtime-availability probe runs before any store open).
const optional = await import(pathToFileURL(optionalLoaderPath).href);
await optional.isCodingGraphInstalled();
const runtime = await import(pathToFileURL(runtimePath).href);
const memoryDir = path.join(scratch, "memory");
mkdirSync(path.join(memoryDir, "codegraph", "loader-principal"), { recursive: true });
const config = {
  codingKnowledge: { enabled: true, codegraphTools: true, codegraphDbDir: "" },
};
const request = {
  config,
  memoryDir,
  principal: "loader-principal",
  projectId: "loader-test",
};
try {
  const store = await runtime.getCodegraphStore(request);
  const schemaVersion = store.schemaVersion();
  await store.close();
  console.log(JSON.stringify({ opened: true, schemaVersion }));
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.log(
    JSON.stringify({ threw: true, name: e.name, code: e.code, message: e.message }),
  );
}
`,
    "utf8",
  );
  return driverPath;
}


function runChild(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, scriptPath, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function lastJsonLine(stdout: string): DriverReport {
  const lines = stdout.trim().split(/\n/).filter(Boolean);
  let line: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) {
      line = lines[i];
      break;
    }
  }
  assert.ok(line, `expected a JSON line in child stdout, got: ${stdout}`);
  return JSON.parse(line) as DriverReport;
}

test("codegraph-runtime resolves @remnic/coding-graph exactly once (shared loader, no parallel import)", async () => {
  // The counting hook maps the specifier to the workspace source when the
  // optional peer is not linked, so the import SUCCEEDS in every install
  // state. The shared loader then caches the success: a probe + a store
  // open must resolve the specifier exactly once. A parallel loader in
  // codegraph-runtime.ts imports the package again and fails this count.
  const root = makeScratch("remnic-2478-single-load-");
  try {
    const { hookPath, logPath } = writeCountingResolveHook(root);
    const driver = writeStoreOpenDriver(root);
    const result = runChild(driver, [runtimeSource, optionalLoaderSource, root], {
      CODEGRAPH_RESOLVE_LOG: logPath,
      CODEGRAPH_SOURCE_FALLBACK: path.join(repoRoot, "packages", "coding-graph", "src", "index.ts"),
      NODE_OPTIONS: `--experimental-loader=${pathToFileURL(hookPath).href} --conditions=remnic-source`,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = lastJsonLine(result.stdout);
    assert.equal(report.opened, true, `store must open against the loaded module: ${JSON.stringify(report)}`);
    const resolves = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split(/\n/).filter(Boolean)
      : [];
    assert.equal(
      resolves.length,
      1,
      `the shared loader must resolve "@remnic/coding-graph" exactly once; saw ${resolves.length} resolutions -- a second resolve means codegraph-runtime still imports the package in parallel`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("codegraph-runtime miss path throws the canonical install hint, not raw MODULE_NOT_FOUND", async () => {
  // The throwing resolve hook simulates the absent package even on a dev
  // workspace where it is installed, so this runs everywhere.
  const root = makeScratch("remnic-2478-miss-");
  try {
    const hookPath = writeMissingPackageResolveHook(root);
    const driver = writeStoreOpenDriver(root);
    const result = runChild(driver, [runtimeSource, optionalLoaderSource, root], {
      NODE_OPTIONS: `--experimental-loader=${pathToFileURL(hookPath).href} --conditions=remnic-source`,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = lastJsonLine(result.stdout);
    assert.equal(report.threw, true, `store open must fail when the package is absent: ${JSON.stringify(report)}`);
    assert.equal(report.code, "package_missing");
    assert.match(report.message ?? "", /npm install @remnic\/coding-graph/);
    assert.doesNotMatch(report.message ?? "", /ERR_MODULE_NOT_FOUND|Cannot find module/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
