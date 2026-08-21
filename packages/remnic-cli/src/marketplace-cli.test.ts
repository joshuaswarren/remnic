import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(srcDir, "../../..");
const cliPath = path.join(srcDir, "index.ts");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

interface SpawnTextResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function toTextResult(result: ReturnType<typeof spawnSync>): SpawnTextResult {
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "",
    stderr: typeof result.stderr === "string" ? result.stderr : result.stderr?.toString("utf8") ?? "",
  };
}

before(() => {
  const result = toTextResult(
    spawnSync(process.execPath, [path.join(repoRoot, "scripts", "ensure-cli-bench-build-deps.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
  assert.equal(
    result.status,
    0,
    `failed to prepare CLI build dependencies\n${result.stdout}\n${result.stderr}`,
  );
});

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function runMarketplace(args: string[]): Promise<SpawnTextResult> {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-marketplace-cli-"));
  const cwd = path.join(home, "cwd");
  await mkdir(cwd);

  const result = spawnSync(process.execPath, [tsxCli, cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      REMNIC_HOME: home,
      OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
    },
  });

  await rm(home, { recursive: true, force: true });
  return toTextResult(result);
}

test("connectors marketplace generate rejects a bare --output flag", async () => {
  const result = await runMarketplace([
    "connectors",
    "marketplace",
    "generate",
    "--output",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /connectors marketplace generate: --output requires a value/);
  assert.doesNotMatch(result.stdout, /Generated marketplace\.json/);
});

test("connectors marketplace rejects a bare --config flag before using defaults", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-marketplace-cli-"));
  const outputDir = path.join(home, "out");
  try {
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        cliPath,
        "connectors",
        "marketplace",
        "generate",
        "--config",
        "--output",
        outputDir,
      ],
      {
        cwd: home,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          REMNIC_HOME: home,
        },
      },
    );

    const textResult = toTextResult(result);
    assert.notEqual(textResult.status, 0);
    assert.match(textResult.stderr, /connectors marketplace: --config requires a value/);
    assert.equal(await pathExists(path.join(outputDir, "marketplace.json")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("connectors marketplace generate rejects a duplicate bare --output flag", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-marketplace-cli-"));
  const outputDir = path.join(home, "out");
  try {
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        cliPath,
        "connectors",
        "marketplace",
        "generate",
        "--output",
        outputDir,
        "--output",
      ],
      {
        cwd: home,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          REMNIC_HOME: home,
        },
      },
    );

    const textResult = toTextResult(result);
    assert.notEqual(textResult.status, 0);
    assert.match(textResult.stderr, /connectors marketplace generate: --output requires a value/);
    assert.equal(await pathExists(path.join(outputDir, "marketplace.json")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
