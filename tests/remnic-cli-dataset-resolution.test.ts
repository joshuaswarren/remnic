import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const scriptPath = path.join(process.cwd(), "evals", "scripts", "download-datasets.sh");

function resolveCommand(command: string): string {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `Expected ${command} to be available for test setup.`);
  return result.stdout.trim();
}

function findPythonInterpreter(): string | undefined {
  for (const candidate of ["python", "python3"]) {
    const result = spawnSync(candidate, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("PersonaMem downloaded markers require both benchmark csv and mirrored chat histories", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-personamem-status-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  await mkdir(benchmarkDir, { recursive: true });
  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    [
      "persona_id,chat_history_32k_link,user_query,correct_answer",
      "persona-1,data/chat_history_32k/persona-1.json,What tea do I order?,Earl Grey tea",
      "persona-2,data/chat_history_32k/persona-2.json,What coffee do I avoid?,Dark roast coffee",
    ].join("\n"),
    "utf8",
  );

  const cliEntry = pathToFileURL(
    path.join(process.cwd(), "packages/remnic-cli/src/index.ts"),
  ).href;
  const cliModule = await import(`${cliEntry}?personamem-status=${Date.now()}`);
  const hooks = cliModule.__benchDatasetTestHooks as {
    isDatasetDownloaded: (datasetPath: string, benchmarkId: string) => boolean;
  };

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "personamem"), false);

  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({ chat_history: [] }),
    "utf8",
  );

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "personamem"), false);

  await writeFile(
    path.join(chatHistoryDir, "persona-2.json"),
    JSON.stringify({ chat_history: [] }),
    "utf8",
  );

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "personamem"), true);
});

test("runner-managed dry-run validation uses MemoryArena loader rules", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-memoryarena-dry-run-"));
  const datasetDir = path.join(tmpDir, "memory-arena");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memory-arena-webshop-products.jsonl"),
    [
      JSON.stringify({ asin: "B000TEST00", title: "Sidecar-only product" }),
      JSON.stringify({ asin: "B000DECOY0", title: "Sidecar decoy product" }),
    ].join("\n"),
    "utf8",
  );

  const cliEntry = pathToFileURL(
    path.join(process.cwd(), "packages/remnic-cli/src/index.ts"),
  ).href;
  const cliModule = await import(`${cliEntry}?memoryarena-dry-run=${Date.now()}`);
  const hooks = cliModule.__benchDatasetTestHooks as {
    validateRunnerManagedPublishedDryRunDatasetForTest: (
      benchmarkId: string,
      mode: "quick" | "full",
      datasetDir: string | undefined,
      limit?: number,
    ) => Promise<void>;
  };

  await assert.rejects(
    hooks.validateRunnerManagedPublishedDryRunDatasetForTest(
      "memory-arena",
      "full",
      datasetDir,
      1,
    ),
    /no \.jsonl domain files were found/,
  );

  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["Which item should be selected?"],
      answers: [{ attributes: ["Sidecar-only product"] }],
    })}\n`,
    "utf8",
  );

  await hooks.validateRunnerManagedPublishedDryRunDatasetForTest(
    "memory-arena",
    "full",
    datasetDir,
    1,
  );
});

test("runner-managed dry-run validates MemoryAgentBench ReDial mappings", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-mab-redial-dry-run-"));
  const datasetDir = path.join(tmpDir, "memoryagentbench");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "The user asked for cyberpunk action movies.",
        questions: ["User: I want a cyberpunk action movie. Recommender:"],
        answers: [["1"]],
        metadata: {
          source: "recsys_redial",
          qa_pair_ids: ["redial-missing-map"],
          question_types: ["recommendation"],
        },
      },
    ]),
    "utf8",
  );

  const cliEntry = pathToFileURL(
    path.join(process.cwd(), "packages/remnic-cli/src/index.ts"),
  ).href;
  const cliModule = await import(`${cliEntry}?memoryagentbench-dry-run=${Date.now()}`);
  const hooks = cliModule.__benchDatasetTestHooks as {
    validateRunnerManagedPublishedDryRunDatasetForTest: (
      benchmarkId: string,
      mode: "quick" | "full",
      datasetDir: string | undefined,
      limit?: number,
    ) => Promise<void>;
  };

  await assert.rejects(
    hooks.validateRunnerManagedPublishedDryRunDatasetForTest(
      "memoryagentbench",
      "full",
      datasetDir,
      1,
    ),
    /ReDial samples require a valid ReDial entity mapping/,
  );
});

test("MemoryAgentBench downloaded markers require ReDial mappings for split files", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-mab-split-redial-status-"));
  const datasetDir = path.join(tmpDir, "memoryagentbench");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "Test_Time_Learning.json"),
    JSON.stringify([
      {
        context: "The user asked for cyberpunk action movies.",
        questions: ["User: I want a cyberpunk action movie. Recommender:"],
        answers: [["1"]],
        metadata: {
          source: "recsys_redial",
          qa_pair_ids: ["redial-missing-map"],
          question_types: ["recommendation"],
        },
      },
    ]),
    "utf8",
  );

  const cliEntry = pathToFileURL(
    path.join(process.cwd(), "packages/remnic-cli/src/index.ts"),
  ).href;
  const cliModule = await import(`${cliEntry}?memoryagentbench-split-status=${Date.now()}`);
  const hooks = cliModule.__benchDatasetTestHooks as {
    isDatasetDownloaded: (datasetPath: string, benchmarkId: string) => boolean;
  };

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "memoryagentbench"), false);

  await writeFile(
    path.join(datasetDir, "entity2id.json"),
    JSON.stringify({ 1: "Blade Runner (1982)" }),
    "utf8",
  );

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "memoryagentbench"), true);
});

test("PersonaMem downloader accepts python3 when python is unavailable", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-personamem-download-"));
  const datasetsDir = path.join(tmpDir, "datasets");
  const datasetDir = path.join(datasetsDir, "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(path.join(benchmarkDir, "benchmark.csv"), "placeholder\n", "utf8");

  const stubBinDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-stub-python-"));
  const pythonStubPath = path.join(stubBinDir, "python3");
  await writeFile(pythonStubPath, "#!/bin/bash\nexit 0\n", "utf8");
  await chmod(pythonStubPath, 0o755);

  const gitPath = resolveCommand("git");
  const curlPath = resolveCommand("curl");
  const dirnamePath = resolveCommand("dirname");
  const touchPath = resolveCommand("touch");
  for (const [name, target] of [
    ["git", gitPath],
    ["curl", curlPath],
    ["dirname", dirnamePath],
    ["touch", touchPath],
  ]) {
    const wrapperPath = path.join(stubBinDir, name);
    await writeFile(wrapperPath, `#!/bin/bash\nexec "${target}" "$@"\n`, "utf8");
    await chmod(wrapperPath, 0o755);
  }

  const result = spawnSync("bash", [scriptPath, "--benchmark", "personamem"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATASETS_DIR: datasetsDir,
      PATH: `${stubBinDir}${path.delimiter}/bin`,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[personamem\] Downloading from Hugging Face/);
  assert.doesNotMatch(result.stdout, /\[personamem\] Already downloaded/);
});

test("PersonaMem downloader prefers python3 over a broken python shim", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-personamem-prefer-python3-"));
  const datasetsDir = path.join(tmpDir, "datasets");
  const datasetDir = path.join(datasetsDir, "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const stubBinDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-stub-prefer-python3-"));
  const markerPath = path.join(tmpDir, "python-invocations.log");

  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(path.join(benchmarkDir, "benchmark.csv"), "placeholder\n", "utf8");

  for (const [name, script] of [
    [
      "python",
      `#!/bin/bash\necho python >> "${markerPath}"\nexit 42\n`,
    ],
    [
      "python3",
      `#!/bin/bash\necho python3 >> "${markerPath}"\nexit 0\n`,
    ],
  ]) {
    const stubPath = path.join(stubBinDir, name);
    await writeFile(stubPath, script, "utf8");
    await chmod(stubPath, 0o755);
  }

  const gitPath = resolveCommand("git");
  const curlPath = resolveCommand("curl");
  const dirnamePath = resolveCommand("dirname");
  const touchPath = resolveCommand("touch");
  for (const [name, target] of [
    ["git", gitPath],
    ["curl", curlPath],
    ["dirname", dirnamePath],
    ["touch", touchPath],
  ]) {
    const wrapperPath = path.join(stubBinDir, name);
    await writeFile(wrapperPath, `#!/bin/bash\nexec "${target}" "$@"\n`, "utf8");
    await chmod(wrapperPath, 0o755);
  }

  const result = spawnSync("bash", [scriptPath, "--benchmark", "personamem"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATASETS_DIR: datasetsDir,
      PATH: `${stubBinDir}${path.delimiter}/bin`,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[personamem\] Downloading from Hugging Face/);

  const markerContents = await readFile(markerPath, "utf8");
  assert.match(markerContents, /^python3(?:\npython3)?\n?$/);
});

test("PersonaMem downloader falls back to python when python3 lacks required modules", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-personamem-python-fallback-"));
  const datasetsDir = path.join(tmpDir, "datasets");
  const datasetDir = path.join(datasetsDir, "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const stubBinDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-stub-python-fallback-"));
  const markerPath = path.join(tmpDir, "python-invocations.log");

  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(path.join(benchmarkDir, "benchmark.csv"), "placeholder\n", "utf8");

  for (const [name, script] of [
    [
      "python3",
      `#!/bin/bash\necho python3 >> "${markerPath}"\nexit 1\n`,
    ],
    [
      "python",
      `#!/bin/bash\necho python >> "${markerPath}"\nexit 0\n`,
    ],
  ]) {
    const stubPath = path.join(stubBinDir, name);
    await writeFile(stubPath, script, "utf8");
    await chmod(stubPath, 0o755);
  }

  const gitPath = resolveCommand("git");
  const curlPath = resolveCommand("curl");
  const dirnamePath = resolveCommand("dirname");
  const touchPath = resolveCommand("touch");
  for (const [name, target] of [
    ["git", gitPath],
    ["curl", curlPath],
    ["dirname", dirnamePath],
    ["touch", touchPath],
  ]) {
    const wrapperPath = path.join(stubBinDir, name);
    await writeFile(wrapperPath, `#!/bin/bash\nexec "${target}" "$@"\n`, "utf8");
    await chmod(wrapperPath, 0o755);
  }

  const result = spawnSync("bash", [scriptPath, "--benchmark", "personamem"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATASETS_DIR: datasetsDir,
      PATH: `${stubBinDir}${path.delimiter}/bin`,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const markerContents = await readFile(markerPath, "utf8");
  assert.match(markerContents, /^python3\npython\npython\n?$/);
});

test("PersonaMem downloader rejects chat history links that escape the dataset root", async (t) => {
  if (!findPythonInterpreter()) {
    t.skip("python or python3 is required for the embedded downloader regression test");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-personamem-escape-"));
  const datasetsDir = path.join(tmpDir, "datasets");
  const fixtureRoot = path.join(tmpDir, "hf", "source", "repo");
  const benchmarkDir = path.join(fixtureRoot, "benchmark", "text");
  const pythonModuleDir = path.join(tmpDir, "python-modules");
  const escapedSourcePath = path.join(tmpDir, "hf", "escape.json");
  const escapedDestinationPath = path.join(tmpDir, "escape.json");

  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(path.dirname(escapedSourcePath), { recursive: true });
  await mkdir(pythonModuleDir, { recursive: true });

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    [
      "persona_id,chat_history_32k_link,user_query,correct_answer",
      "persona-1,../../escape.json,What tea do I order?,Earl Grey tea",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    escapedSourcePath,
    JSON.stringify({ chat_history: [{ role: "user", content: "outside" }] }),
    "utf8",
  );
  await writeFile(
    path.join(pythonModuleDir, "huggingface_hub.py"),
    [
      "import os",
      "from pathlib import Path",
      "",
      "def hf_hub_download(*, repo_id, repo_type, filename, token=None):",
      '    fixture_root = Path(os.environ["PERSONAMEM_FIXTURE_ROOT"])',
      "    return str((fixture_root / filename).resolve())",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = spawnSync("bash", [scriptPath, "--benchmark", "personamem"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATASETS_DIR: datasetsDir,
      PERSONAMEM_FIXTURE_ROOT: fixtureRoot,
      PYTHONPATH: `${pythonModuleDir}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /must stay within dataset root/);
  assert.equal(await pathExists(escapedDestinationPath), false);
});
