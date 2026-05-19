import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, runCli, sanitizeAccessCliErrorMessage } from "./access-cli.js";
import { PLUGIN_ID } from "./plugin-id.js";

async function rejectsUsage(argv: string[]): Promise<void> {
  await assert.rejects(
    async () => {
      await main(argv);
    },
    /invalid access-cli arguments/,
  );
}

async function captureRunCliFailure(argv: string[]): Promise<string> {
  let output = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExit = process.exit;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: string | number | null | undefined): never => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;

  try {
    await assert.rejects(
      async () => {
        await runCli(argv);
      },
      /process\.exit:1/,
    );
    return output;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }
}

async function withPatchedEnv<T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    original[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeOpenClawConfig(configPath: string, config: Record<string, unknown>): void {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        entries: {
          [PLUGIN_ID]: { config },
        },
      },
    }),
  );
}

test("access-cli rejects malformed dry-run values before store can run", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--dry-run=true",
  ]);

  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--dry-run",
    "true",
  ]);
});

test("access-cli rejects unknown options before runtime initialization", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--typo",
    "value",
  ]);
});

test("access-cli rejects value options with missing values", async () => {
  await rejectsUsage(["browse", "--limit"]);
  await rejectsUsage(["browse", "--principal"]);
  await rejectsUsage(["store", "--content", "hello", "--category"]);
  await rejectsUsage(["store", "--content", "hello", "--category", ""]);
});

test("access-cli rejects partial numeric values", async () => {
  await rejectsUsage(["browse", "--limit", "10abc"]);
  await rejectsUsage(["browse", "--offset", "1.5"]);
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--confidence",
    "0.5x",
  ]);
});

test("access-cli rejects invalid browse sort and pagination before runtime initialization", async () => {
  await rejectsUsage(["browse", "--sort", "udpated_desc"]);
  await rejectsUsage(["browse", "--limit", "0"]);
  await rejectsUsage(["browse", "--limit", "-1"]);
  await rejectsUsage(["browse", "--offset", "-1"]);
});

test("access-cli browse sort error lists accepted values", async () => {
  const output = await captureRunCliFailure(["browse", "--sort", "udpated_desc"]);

  assert.match(output, /invalid value for --sort/);
  assert.match(output, /Accepted: updated_desc, updated_asc, created_desc, created_asc\./);
});

test("access-cli browse pagination bound errors list accepted ranges", async () => {
  const limitOutput = await captureRunCliFailure(["browse", "--limit", "0"]);
  const offsetOutput = await captureRunCliFailure(["browse", "--offset", "-1"]);
  const principalOutput = await captureRunCliFailure(["browse", "--principal"]);

  assert.match(limitOutput, /invalid value for --limit/);
  assert.match(limitOutput, /Accepted: integer >= 1\./);
  assert.match(offsetOutput, /invalid value for --offset/);
  assert.match(offsetOutput, /Accepted: integer >= 0\./);
  assert.match(principalOutput, /missing required option: --principal/);
});

test("access-cli rejects confidence outside the documented range", async () => {
  await rejectsUsage([
    "store",
    "--content",
    "hello",
    "--category",
    "fact",
    "--confidence",
    "1.1",
  ]);
});

test("access-cli prefers active OpenClaw config path over legacy config path", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "access-cli-config-"));
  const activeConfigPath = path.join(tempRoot, "active-openclaw.json");
  const legacyConfigPath = path.join(tempRoot, "legacy-openclaw.json");
  const memoryDir = path.join(tempRoot, "memory");
  const previousOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousOpenClawEngramConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  let output = "";
  const originalStdoutWrite = process.stdout.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await writeFile(
      activeConfigPath,
      JSON.stringify({
        plugins: {
          entries: {
            "openclaw-remnic": {
              config: {
                memoryDir,
              },
            },
          },
        },
      }),
    );
    await writeFile(legacyConfigPath, "{not valid json");

    process.env.OPENCLAW_CONFIG_PATH = activeConfigPath;
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH = legacyConfigPath;

    await main([
      "store",
      "--content",
      "hello",
      "--category",
      "fact",
      "--dry-run",
    ]);

    assert.match(output, /"operation": "memory_store"/);
    assert.match(output, /"dryRun": true/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    if (previousOpenClawConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousOpenClawConfigPath;
    }
    if (previousOpenClawEngramConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousOpenClawEngramConfigPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("access-cli browse uses OPENCLAW_CONFIG_PATH before legacy config path", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-access-cli-"));
  try {
    const primaryConfigPath = path.join(tempDir, "primary.json");
    const legacyConfigPath = path.join(tempDir, "legacy.json");
    writeOpenClawConfig(primaryConfigPath, {
      memoryDir: path.join(tempDir, "primary-memory"),
      namespacesEnabled: true,
      defaultNamespace: "default",
      namespacePolicies: [
        { name: "team", readPrincipals: ["reader"], writePrincipals: ["writer"] },
      ],
      agentAccessHttp: { principal: "reader" },
    });
    writeOpenClawConfig(legacyConfigPath, {
      memoryDir: path.join(tempDir, "legacy-memory"),
      namespacesEnabled: true,
      defaultNamespace: "default",
      namespacePolicies: [
        { name: "team", readPrincipals: ["legacy-reader"], writePrincipals: ["writer"] },
      ],
    });

    await withPatchedEnv(
      {
        OPENCLAW_CONFIG_PATH: primaryConfigPath,
        OPENCLAW_ENGRAM_CONFIG_PATH: legacyConfigPath,
      },
      async () => {
        await main(["browse", "--namespace", "team", "--limit", "1"]);
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("access-cli browse accepts an explicit principal for namespace reads", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-access-cli-"));
  try {
    const configPath = path.join(tempDir, "openclaw.json");
    writeOpenClawConfig(configPath, {
      memoryDir: path.join(tempDir, "memory"),
      namespacesEnabled: true,
      defaultNamespace: "default",
      namespacePolicies: [
        { name: "team", readPrincipals: ["reader"], writePrincipals: ["writer"] },
      ],
    });

    await withPatchedEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_ENGRAM_CONFIG_PATH: undefined,
      },
      async () => {
        await main(["browse", "--namespace", "team", "--principal", "reader", "--limit", "1"]);
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("access-cli runtime failures do not log sensitive message content", async () => {
  const output = await captureRunCliFailure([
    "store",
    "--content-file",
    "/path/that/does/not/exist",
    "--category",
    "fact",
  ]);

  assert.match(output, /access-cli failed/);
  assert.doesNotMatch(output, /does\/not\/exist/);
  assert.doesNotMatch(output, /ENOENT/);
});

test("access-cli redacts configured API keys from runtime failures", () => {
  assert.equal(
    sanitizeAccessCliErrorMessage("openaiApiKey: sk-test localLlmApiKey='local-secret' path=/tmp/file"),
    "openaiApiKey: [redacted] localLlmApiKey=[redacted] path=/tmp/file",
  );
});

test("access-cli accepts inline string values that begin with dashes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-access-cli-"));
  try {
    const configPath = path.join(tempDir, "openclaw.json");
    writeOpenClawConfig(configPath, {
      memoryDir: path.join(tempDir, "memory"),
      defaultNamespace: "default",
    });

    await withPatchedEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_ENGRAM_CONFIG_PATH: undefined,
      },
      async () => {
        await main(["browse", "--query=--literal", "--limit", "1"]);
        await main(["store", "--content=--note", "--category", "fact", "--dry-run"]);
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("access-cli rejects adjacent option-looking values", async () => {
  const output = await captureRunCliFailure([
    "store",
    "--content",
    "--dry-run",
    "--category",
    "fact",
  ]);

  assert.match(output, /missing required option: --content/);
});
