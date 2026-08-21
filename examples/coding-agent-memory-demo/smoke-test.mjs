import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoDir, "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function assertIncludes(output, expected) {
  if (!output.includes(expected)) {
    throw new Error(`expected output to include ${JSON.stringify(expected)}`);
  }
}

function assertNotIncludes(output, unexpected) {
  if (output.includes(unexpected)) {
    throw new Error(`expected output not to include ${JSON.stringify(unexpected)}`);
  }
}

async function removeDirWithRetry(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function assertPathMissing(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`expected path not to exist: ${filePath}`);
}

async function walkMarkdownFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function runDemoArgs(args, envOverrides = {}) {
  return spawnSync(process.execPath, [tsxCli, "examples/coding-agent-memory-demo/demo.mts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...envOverrides,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--conditions=remnic-source`,
    },
  });
}

function runDemo(memoryDir, envOverrides = {}) {
  return runDemoArgs(["--memory-dir", memoryDir], envOverrides);
}

async function main() {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-coding-agent-memory-demo-"));
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-coding-agent-memory-demo-home-"));
  try {
    const result = runDemo(memoryDir);

    if (result.status !== 0) {
      throw new Error(`demo exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    const output = result.stdout;
    assertIncludes(output, "Remnic coding-agent memory demo");
    assertIncludes(output, "engine: real @remnic/core Orchestrator + EngramAccessService");
    assertIncludes(output, "apiKeys: none (OpenAI disabled, QMD disabled)");
    assertIncludes(output, "codex-cli / session-a stores real Remnic memories via memoryStore()");
    assertIncludes(output, "switch to claude-code / session-b and recall through recallXray(includeRecall=true)");
    assertIncludes(output, "active namespace: project-checkout-service");
    assertIncludes(output, "recalled 2 real Remnic memories");
    assertIncludes(output, "content: Decision: checkout-service payment retry policy lives in");
    assertIncludes(output, "content: Preference: for checkout-service, include the retry-policy file path");
    assertIncludes(output, "why: scope=namespace:project-checkout-service; servedBy=recent-scan");
    assertIncludes(output, "unrelated namespace: project-marketing-site");
    assertIncludes(output, "marketing memory surfaced: no");
    assertIncludes(output, "result: PASS");
    assertNotIncludes(output, "content: Decision: marketing-site hero copy");

    const markdownFiles = await walkMarkdownFiles(memoryDir);
    const persisted = (await Promise.all(markdownFiles.map((filePath) => readFile(filePath, "utf8")))).join("\n");
    assertIncludes(persisted, "source: explicit");
    assertIncludes(persisted, "agent-memory-demo");
    assertIncludes(persisted, "idempotency keys with a maximum of 3 attempts");

    const tildeResult = runDemoArgs(["--", "--memory-dir", "~/remnic-demo-memory"], { HOME: tempHome });
    if (tildeResult.status !== 0) {
      throw new Error(
        `tilde demo exited ${tildeResult.status}\nstdout:\n${tildeResult.stdout}\nstderr:\n${tildeResult.stderr}`
      );
    }

    const tildeMemoryDir = path.join(tempHome, "remnic-demo-memory");
    const tildeMarkdownFiles = await walkMarkdownFiles(tildeMemoryDir);
    const tildePersisted = (await Promise.all(tildeMarkdownFiles.map((filePath) => readFile(filePath, "utf8")))).join(
      "\n"
    );
    assertIncludes(tildePersisted, "idempotency keys with a maximum of 3 attempts");

    const invalidFlagDir = "--remnic-demo-invalid-memory-dir";
    const invalidFlagPath = path.join(repoRoot, invalidFlagDir);
    await removeDirWithRetry(invalidFlagPath);
    const invalidFlagResult = runDemoArgs(["--memory-dir", invalidFlagDir]);
    if (invalidFlagResult.status === 0) {
      throw new Error(`invalid flag-like memory-dir succeeded\nstdout:\n${invalidFlagResult.stdout}`);
    }
    assertIncludes(invalidFlagResult.stderr, "--memory-dir requires a path value");
    await assertPathMissing(invalidFlagPath);

    const homeSentinel = path.join(tempHome, "sentinel");
    await writeFile(homeSentinel, "keep\n", "utf8");
    const unsafeResetResult = runDemoArgs(["--memory-dir", "~", "--reset"], { HOME: tempHome });
    if (unsafeResetResult.status === 0) {
      throw new Error(`unsafe home reset succeeded\nstdout:\n${unsafeResetResult.stdout}`);
    }
    assertIncludes(unsafeResetResult.stderr, "refusing to reset protected memory directory");
    await access(homeSentinel);

    console.log("PASS coding-agent-memory-demo smoke test");
  } finally {
    await removeDirWithRetry(memoryDir);
    await removeDirWithRetry(tempHome);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
