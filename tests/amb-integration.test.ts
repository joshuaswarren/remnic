import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const hasPython3 = spawnSync("python3", ["--version"], {
  stdio: "ignore",
}).status === 0;
const repoRoot = path.resolve(".");
const builtCoreEntry = path.join(
  repoRoot,
  "packages",
  "remnic-core",
  "dist",
  "index.js",
);
const helperNode = findHelperNode();

test("AMB installer registers Remnic provider and bridge commands", {
  skip: hasPython3 ? false : "python3 is required for AMB provider smoke test",
}, async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-test-"));
  const ambRoot = path.join(tmpDir, "amb");
  const memoryDir = path.join(ambRoot, "src", "memory_bench", "memory");
  const datasetDir = path.join(ambRoot, "src", "memory_bench", "dataset");
  const llmDir = path.join(ambRoot, "src", "memory_bench", "llm");
  const modesDir = path.join(ambRoot, "src", "memory_bench", "modes");
  const runnerPath = path.join(ambRoot, "src", "memory_bench", "runner.py");
  const fakeRemnicRoot = path.join(tmpDir, "remnic");
  const helperPath = path.join(fakeRemnicRoot, "integrations", "amb", "fake-helper.mjs");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const fakeCodexArgsPath = path.join(tmpDir, "fake-codex-args.json");

  await mkdir(memoryDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(llmDir, { recursive: true });
  await mkdir(modesDir, { recursive: true });
  await mkdir(path.dirname(helperPath), { recursive: true });
  await mkdir(path.join(fakeRemnicRoot, "packages", "remnic-core", "dist"), {
    recursive: true,
  });

  await writeFile(path.join(ambRoot, "src", "memory_bench", "__init__.py"), "");
  await writeFile(
    runnerPath,
    [
      "class EvalSummary:",
      "    pass",
      "",
      "class EvalRunner:",
      "    def _save(self, summary):",
      "        pass",
      "",
      "    async def _run_all(self, progress, task_id):",
      "        results = [None] * len(queries)",
      "",
      "        async def bounded(i, q):",
      "            async with sem:",
      "                results[i] = await _process_one(q)",
      "                progress.advance(task_id)",
      "",
      "        await asyncio.gather(*[bounded(i, q) for i, q in enumerate(queries)])",
      "        return results",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(ambRoot, "src", "memory_bench", "models.py"),
    [
      "from dataclasses import dataclass",
      "",
      "@dataclass",
      "class Document:",
      "    id: str",
      "    content: str",
      "    user_id: str | None = None",
      "    messages: list | None = None",
      "    timestamp: str | None = None",
      "    context: str | None = None",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(datasetDir, "base.py"),
    [
      "class Dataset:",
      "    pass",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(datasetDir, "__init__.py"),
    [
      "from .base import Dataset",
      "",
      "REGISTRY: dict[str, type[Dataset]] = {",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(llmDir, "base.py"),
    [
      "from dataclasses import dataclass",
      "",
      "@dataclass",
      "class Schema:",
      "    properties: dict",
      "    required: list",
      "",
      "@dataclass",
      "class ToolDef:",
      "    name: str",
      "    description: str",
      "    parameters: dict",
      "    required: list",
      "    fn: object",
      "",
      "class LLM:",
      "    @property",
      "    def model_id(self):",
      "        return self.__class__.__name__",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(llmDir, "gemini.py"),
    [
      "from .base import LLM",
      "",
      "class GeminiLLM(LLM):",
      "    pass",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(llmDir, "__init__.py"),
    [
      "import os",
      "",
      "from .base import LLM, Schema",
      "from .gemini import GeminiLLM",
      "",
      "REGISTRY: dict[str, type[LLM]] = {",
      '    "gemini": GeminiLLM,',
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(ambRoot, "src", "memory_bench", "cli.py"),
    [
      "import os",
      "import typer",
      "",
      "def _resolve_gemini_key() -> None:",
      '    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")',
      "    if not key:",
      '        typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True)',
      "        raise typer.Exit(1)",
      '    os.environ["GOOGLE_API_KEY"] = key',
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(ambRoot, "src", "memory_bench", "judge.py"),
    [
      "from .llm.base import LLM, Schema",
      "from .llm.gemini import GeminiLLM",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(modesDir, "rag.py"),
    [
      "from ..llm.gemini import GeminiLLM",
      "",
      "class RAGMode:",
      "    pass",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(modesDir, "__init__.py"),
    [
      "from .agent import AgentMode",
      "from .agentic_rag import AgenticRAGMode",
      "from .rag import RAGMode",
      "",
      "REGISTRY = {",
      "    'rag': RAGMode,",
      "    'agentic-rag': AgenticRAGMode,",
      "    'agent': AgentMode,",
      "}",
      "",
      "def get_mode(name, llm=None):",
      "    cls = REGISTRY[name]",
      "    if llm is not None and \"llm\" in cls.__init__.__code__.co_varnames:",
      "        return cls(llm=llm)",
      "    return cls()",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(modesDir, "agent.py"),
    [
      "class AgentMode:",
      "    pass",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(modesDir, "agentic_rag.py"),
    [
      "from .rag import RAGMode",
      "from ..llm.gemini import GeminiLLM",
      "",
      "class AgenticRAGMode:",
      "    def __init__(self, llm: GeminiLLM | None = None, k: int = 10):",
      "        self._llm = llm or GeminiLLM()",
      "        self._rag = RAGMode(llm=self._llm, k=k)",
      "        self.k = k",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(memoryDir, "base.py"),
    [
      "class MemoryProvider:",
      "    def prepare(self, store_dir, unit_ids=None, reset=True):",
      "        pass",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(memoryDir, "bm25.py"),
    [
      "from .base import MemoryProvider",
      "",
      "class BM25MemoryProvider(MemoryProvider):",
      "    pass",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(memoryDir, "__init__.py"),
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      "",
      "REGISTRY: dict[str, type[MemoryProvider]] = {",
      '    "bm25": BM25MemoryProvider,',
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(fakeRemnicRoot, "packages", "remnic-core", "dist", "index.js"), "");
  await writeFile(
    helperPath,
    [
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "",
      "const payload = JSON.parse(readFileSync(0, 'utf8'));",
      "if (!process.env.REMNIC_REPO?.endsWith('/remnic')) {",
      "  throw new Error(`unexpected REMNIC_REPO=${process.env.REMNIC_REPO}`);",
      "}",
      "if (payload.command === 'ingest') {",
      "  if (payload.documents?.[0]?.content !== 'launch review is May 20') {",
      "    throw new Error('unexpected ingest payload');",
      "  }",
      "  mkdirSync(payload.storeDir, { recursive: true });",
      "  writeFileSync(join(payload.storeDir, 'doc.json'), JSON.stringify(payload.documents[0]));",
      "  process.stdout.write(JSON.stringify({ ok: true }));",
      "} else if (payload.command === 'retrieve') {",
      "  const docPath = join(payload.storeDir, 'doc.json');",
      "  const stored = existsSync(docPath) ? JSON.parse(readFileSync(docPath, 'utf8')) : null;",
      "  process.stdout.write(JSON.stringify({",
      "    ok: true,",
      "    documents: stored ? [{",
      "      id: stored.id,",
      "      content: `answer for ${payload.query}: ${stored.content}`,",
      "      user_id: payload.userId,",
      "      timestamp: stored.timestamp,",
      "      context: 'fake-remnic',",
      "    }] : [],",
      "    raw_response: {",
      "      provider: 'remnic',",
      "      queryTimestamp: payload.queryTimestamp,",
      "      repo: process.env.REMNIC_REPO,",
      "      storeDir: payload.storeDir,",
      "    },",
      "  }));",
      "} else if (payload.command === 'direct_answer') {",
      "  const docPath = join(payload.storeDir, 'doc.json');",
      "  const stored = existsSync(docPath) ? JSON.parse(readFileSync(docPath, 'utf8')) : null;",
      "  process.stdout.write(JSON.stringify({",
      "    ok: true,",
      "    answer: stored ? `The launch review is May 20.` : `No answer available.` ,",
      "    context: stored ? stored.content : '',",
      "    raw_response: {",
      "      provider: 'remnic',",
      "      mode: 'direct_answer',",
      "      storeDir: payload.storeDir,",
      "    },",
      "  }));",
      "} else {",
      "  throw new Error(`unexpected command=${payload.command}`);",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env python3",
      "import json, os, pathlib, sys",
      "args = sys.argv[1:]",
      "pathlib.Path(os.environ['FAKE_CODEX_ARGS']).write_text(json.dumps(args))",
      "assert args[0] == 'exec'",
      "assert '--model' in args and args[args.index('--model') + 1] == 'gpt-5.5'",
      "assert 'model_reasoning_effort=\"xhigh\"' in args",
      "assert 'service_tier=\"fast\"' in args",
      "assert '--output-schema' in args",
      "assert args[-1] == '-'",
      "assert 'Answer from context.' in sys.stdin.read()",
      "output = pathlib.Path(args[args.index('--output-last-message') + 1])",
      "output.write_text(json.dumps({'answer': 'May 20', 'reasoning': 'used memory'}))",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);

  await execFileAsync("python3", [
    path.resolve("integrations", "amb", "install.py"),
    "--amb",
    ambRoot,
  ]);
  await execFileAsync("python3", [
    path.resolve("integrations", "amb", "install.py"),
    "--amb",
    ambRoot,
  ]);

  const patchedRegistry = await readFile(path.join(memoryDir, "__init__.py"), "utf8");
  assert.equal(
    patchedRegistry.match(/_LazyMemoryProvider\("\.remnic", "RemnicMemoryProvider"\)/g)?.length,
    1,
  );
  assert.equal(
    patchedRegistry.match(/"remnic": _LazyMemoryProvider/g)?.length,
    1,
  );
  assert.match(patchedRegistry, /lazy optional-provider imports/);
  const patchedDatasets = await readFile(path.join(datasetDir, "__init__.py"), "utf8");
  assert.match(patchedDatasets, /lazy optional-dataset imports/);
  assert.equal(
    patchedDatasets.match(/"personamem": _LazyDataset\("\.personamem", "PersonaMemDataset"\)/g)?.length,
    1,
  );
  const patchedLlmRegistry = await readFile(path.join(llmDir, "__init__.py"), "utf8");
  assert.equal(
    patchedLlmRegistry.match(/_LazyLLM\("\.codex", "CodexLLM"\)/g)?.length,
    1,
  );
  assert.equal(
    patchedLlmRegistry.match(/"codex": _LazyLLM/g)?.length,
    1,
  );
  assert.match(patchedLlmRegistry, /lazy provider imports/);
  const patchedCli = await readFile(path.join(ambRoot, "src", "memory_bench", "cli.py"), "utf8");
  assert.match(patchedCli, /Remnic Codex LLM bypass/);
  assert.match(patchedCli, /REMNIC_AMB_FORCE_CODEX_LLM/);
  assert.equal(patchedCli.match(/OMB_ANSWER_LLM/g)?.length, 2);
  assert.equal(patchedCli.match(/OMB_JUDGE_LLM/g)?.length, 2);
  const patchedRagMode = await readFile(path.join(modesDir, "rag.py"), "utf8");
  const patchedModesInit = await readFile(path.join(modesDir, "__init__.py"), "utf8");
  const patchedAgenticMode = await readFile(path.join(modesDir, "agentic_rag.py"), "utf8");
  const patchedJudge = await readFile(path.join(ambRoot, "src", "memory_bench", "judge.py"), "utf8");
  const patchedRunner = await readFile(runnerPath, "utf8");
  assert.doesNotMatch(patchedRagMode, /llm\.gemini|GeminiLLM/);
  assert.doesNotMatch(patchedAgenticMode, /llm\.gemini|GeminiLLM\(\)/);
  assert.doesNotMatch(patchedJudge, /llm\.gemini|GeminiLLM/);
  assert.match(patchedModesInit, /getattr\(cls\.__init__, "__code__", None\)/);
  assert.match(patchedAgenticMode, /get_answer_llm/);
  assert.match(patchedAgenticMode, /RAGMode\(llm=self\._llm\)/);
  assert.match(patchedRunner, /Remnic patch: save batch results incrementally/);
  assert.match(patchedRunner, /self\._save\(partial\)/);

  const smokeScript = [
    "from pathlib import Path",
    "from memory_bench.memory import REGISTRY",
    "from memory_bench.llm import REGISTRY as LLM_REGISTRY",
    "from memory_bench.llm.base import Schema",
    "from memory_bench.models import Document",
    "",
    "assert list(REGISTRY).count('remnic') == 1",
    "assert list(LLM_REGISTRY).count('codex') == 1",
    "llm = LLM_REGISTRY['codex']()",
    "assert llm.model_id == 'codex:gpt-5.5:xhigh:fast'",
    "generated = llm.generate(",
    "    'Answer from context.',",
    "    Schema(",
    "        properties={",
    "            'answer': {'type': 'string'},",
    "            'reasoning': {'type': 'string'},",
    "        },",
    "        required=['answer', 'reasoning'],",
    "    ),",
    ")",
    "assert generated['answer'] == 'May 20'",
    "provider = REGISTRY['remnic']()",
    "assert provider.concurrency == 3",
    "provider.prepare(Path('store'), unit_ids={'u1', 'u2'}, reset=True)",
    "provider.ingest([Document(id='d1', content='launch review is May 20', user_id='u1')])",
    "docs, raw = provider.retrieve(",
    "    'When is the launch review?',",
    "    k=3,",
    "    user_id='u1',",
    "    query_timestamp='2026-05-13T00:00:00Z',",
    ")",
    "assert len(docs) == 1",
    "assert docs[0].id == 'd1'",
    "assert docs[0].user_id == 'u1'",
    "assert docs[0].context == 'fake-remnic'",
    "assert 'May 20' in docs[0].content",
    "assert raw['provider'] == 'remnic'",
    "assert raw['queryTimestamp'] == '2026-05-13T00:00:00Z'",
    "u2_docs, u2_raw = provider.retrieve('When is the launch review?', k=3, user_id='u2')",
    "assert u2_docs == []",
    "assert raw['storeDir'] != u2_raw['storeDir']",
    "assert '/units/' in raw['storeDir']",
    "assert '/units/' in u2_raw['storeDir']",
    "answer, context, direct_raw = provider.direct_answer(",
    "    'When is the launch review?',",
    "    user_id='u1',",
    "    query_timestamp='2026-05-13T00:00:00Z',",
    ")",
    "assert answer == 'The launch review is May 20.'",
    "assert context == 'launch review is May 20'",
    "assert direct_raw['mode'] == 'direct_answer'",
    "assert direct_raw['storeDir'] == raw['storeDir']",
    "",
  ].join("\n");

  const result = await execFileAsync("python3", ["-c", smokeScript], {
    cwd: fakeRemnicRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ambRoot, "src"),
      REMNIC_AMB_HELPER: helperPath,
      REMNIC_AMB_NODE: process.execPath,
      REMNIC_AMB_CODEX_BIN: fakeCodexPath,
      REMNIC_AMB_CONCURRENCY: "3",
      FAKE_CODEX_ARGS: fakeCodexArgsPath,
    },
  });

  assert.equal(result.stderr, "");
  const fakeCodexArgs = JSON.parse(await readFile(fakeCodexArgsPath, "utf8"));
  assert.ok(fakeCodexArgs.includes("--ephemeral"));
  assert.ok(fakeCodexArgs.includes("--ignore-rules"));
});

test("AMB runner validates required checkout argument", async () => {
  const result = spawnSync("bash", [
    path.resolve("scripts", "bench", "run-amb-remnic.sh"),
  ], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--amb is required/);
});

test("AMB runner forces Codex LLMs, strips Gemini Google keys, and passes AMB run args", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-runner-"));
  const ambRoot = path.join(tmpDir, "amb");
  const binDir = path.join(tmpDir, "bin");
  const memoryDir = path.join(ambRoot, "src", "memory_bench", "memory");
  const datasetDir = path.join(ambRoot, "src", "memory_bench", "dataset");
  const llmDir = path.join(ambRoot, "src", "memory_bench", "llm");
  const runnerPath = path.join(ambRoot, "src", "memory_bench", "runner.py");
  const observedEnvPath = path.join(tmpDir, "uv-env.json");
  const observedRunArgsPath = path.join(tmpDir, "run-args.json");
  const fakeCodexPath = path.join(binDir, "codex");
  const fakeUvPath = path.join(binDir, "uv");

  await mkdir(memoryDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(llmDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(ambRoot, "pyproject.toml"), "[project]\nname = 'fake-amb'\n");
  await writeFile(
    runnerPath,
    [
      "class EvalSummary:",
      "    pass",
      "",
      "class EvalRunner:",
      "    async def _run_all(self, progress, task_id):",
      "        results = [None] * len(queries)",
      "",
      "        async def bounded(i, q):",
      "            async with sem:",
      "                results[i] = await _process_one(q)",
      "                progress.advance(task_id)",
      "",
      "        await asyncio.gather(*[bounded(i, q) for i, q in enumerate(queries)])",
      "        return results",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(memoryDir, "__init__.py"),
    [
      "from .base import MemoryProvider",
      "",
      "REGISTRY: dict[str, type[MemoryProvider]] = {",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(memoryDir, "base.py"), "class MemoryProvider:\n    pass\n");
  await writeFile(path.join(datasetDir, "base.py"), "class Dataset:\n    pass\n");
  await writeFile(
    path.join(datasetDir, "__init__.py"),
    [
      "from .base import Dataset",
      "",
      "REGISTRY: dict[str, type[Dataset]] = {",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(llmDir, "__init__.py"),
    [
      "from .base import LLM, Schema",
      "",
      "REGISTRY: dict[str, type[LLM]] = {",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(llmDir, "base.py"),
    [
      "class LLM:",
      "    pass",
      "",
      "class Schema:",
      "    pass",
      "",
      "class ToolDef:",
      "    pass",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(ambRoot, "src", "memory_bench", "cli.py"),
    [
      "import os",
      "import typer",
      "",
      "def _resolve_gemini_key() -> None:",
      '    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")',
      "    if not key:",
      '        typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True)',
      "        raise typer.Exit(1)",
      '    os.environ["GOOGLE_API_KEY"] = key',
      "",
    ].join("\n"),
  );
  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 0\n");
  await writeFile(
    fakeUvPath,
    [
      "#!/usr/bin/env python3",
      "import json, os, pathlib, sys",
      "argv = sys.argv[1:]",
      "assert argv == ['sync'], sys.argv",
      "bin_dir = pathlib.Path('.venv/bin')",
      "bin_dir.mkdir(parents=True, exist_ok=True)",
      "omb = bin_dir / 'omb'",
      "omb.write_text(\"\"\"#!/usr/bin/env python3\\nimport json, os, pathlib, sys\\nargs = sys.argv[1:]\\nif args == ['providers']:\\n    pathlib.Path(os.environ['OBSERVED_ENV_PATH']).write_text(json.dumps({\\n        'OMB_ANSWER_LLM': os.environ.get('OMB_ANSWER_LLM'),\\n        'OMB_JUDGE_LLM': os.environ.get('OMB_JUDGE_LLM'),\\n        'OMB_ANSWER_MODEL': os.environ.get('OMB_ANSWER_MODEL'),\\n        'OMB_JUDGE_MODEL': os.environ.get('OMB_JUDGE_MODEL'),\\n        'REMNIC_AMB_FORCE_CODEX_LLM': os.environ.get('REMNIC_AMB_FORCE_CODEX_LLM'),\\n        'REMNIC_AMB_CODEX_BIN': os.environ.get('REMNIC_AMB_CODEX_BIN'),\\n        'GEMINI_API_KEY': os.environ.get('GEMINI_API_KEY'),\\n        'GOOGLE_API_KEY': os.environ.get('GOOGLE_API_KEY'),\\n    }))\\n    raise SystemExit(0)\\nif args == ['run', '--help']:\\n    print('--split')\\n    raise SystemExit(0)\\nif args and args[0] == 'run':\\n    pathlib.Path(os.environ['OBSERVED_RUN_ARGS_PATH']).write_text(json.dumps(args))\\n    raise SystemExit(0)\\nraise AssertionError(sys.argv)\\n\"\"\")",
      "omb.chmod(0o755)",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);
  await chmod(fakeUvPath, 0o755);

  const result = spawnSync("bash", [
    path.resolve("scripts", "bench", "run-amb-remnic.sh"),
    "--amb",
    ambRoot,
    "--",
    "--skip-ingestion",
    "--only-failed",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      REMNIC_AMB_CODEX_BIN: fakeCodexPath,
      GEMINI_API_KEY: "should-not-leak",
      GOOGLE_API_KEY: "should-not-leak",
      OBSERVED_ENV_PATH: observedEnvPath,
      OBSERVED_RUN_ARGS_PATH: observedRunArgsPath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(await readFile(observedEnvPath, "utf8"));
  assert.equal(observed.OMB_ANSWER_LLM, "codex");
  assert.equal(observed.OMB_JUDGE_LLM, "codex");
  assert.equal(observed.OMB_ANSWER_MODEL, "gpt-5.5");
  assert.equal(observed.OMB_JUDGE_MODEL, "gpt-5.5");
  assert.equal(observed.REMNIC_AMB_FORCE_CODEX_LLM, "1");
  assert.equal(observed.REMNIC_AMB_CODEX_BIN, fakeCodexPath);
  assert.equal(observed.GEMINI_API_KEY, null);
  assert.equal(observed.GOOGLE_API_KEY, null);

  const observedRunArgs = JSON.parse(await readFile(observedRunArgsPath, "utf8"));
  assert.equal(observedRunArgs[0], "run");
  assert.equal(observedRunArgs[observedRunArgs.indexOf("--dataset") + 1], "personamem");
  assert.equal(observedRunArgs[observedRunArgs.indexOf("--split") + 1], "128k");
  assert.equal(observedRunArgs[observedRunArgs.indexOf("--memory") + 1], "remnic");
  assert.equal(observedRunArgs[observedRunArgs.indexOf("--llm") + 1], "codex");
  assert.deepEqual(observedRunArgs.slice(-2), ["--skip-ingestion", "--only-failed"]);
});

test("AMB helper retrieves packed evidence without duplicate context documents", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-helper-"));
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "d1",
          content: "Remember the launch review is May 20.",
          messages: [
            {
              role: "system",
              content: "Current user persona: Name: Kanoa Manu",
            },
            {
              role: "user",
              content: "Remember the launch review is May 20.",
            },
          ],
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);
  assert.equal(JSON.parse(ingest.stdout).ok, true);

  const retrieved = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "retrieve",
      storeDir,
      query: "When is the launch review?",
      k: 3,
      userId: "u1",
      queryTimestamp: "2026-05-13T00:00:00Z",
    }),
  });
  assert.equal(retrieved.status, 0, retrieved.stderr);
  const result = JSON.parse(retrieved.stdout);

  assert.equal(result.ok, true);
  assert.equal(result.raw_response.provider, "remnic");
  assert.equal(result.raw_response.queryTimestamp, "2026-05-13T00:00:00.000Z");
  assert.equal(result.raw_response.stats.totalMessages, 1);
  assert.equal(result.raw_response.returnedDocuments, 1);
  assert.equal(result.raw_response.memories.length, 1);
  assert.match(result.raw_response.memories[0].content, /May 20/);
  assert.equal(Object.hasOwn(result.raw_response, "context"), false);
  assert.equal(result.documents.length, 1);
  assert.match(result.documents[0].content, /Query timestamp: 2026-05-13T00:00:00\.000Z/);
  assert.match(result.documents[0].content, /Session scope: amb:u1/);
  assert.match(result.documents[0].content, /May 20/);
});

test("AMB helper records direct-answer Codex configuration errors without crashing", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-helper-direct-"));
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_TIMEOUT_MS: "12abc",
  };

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: "When is the launch review?",
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "information not available");
  assert.match(payload.raw_response.answerError, /REMNIC_AMB_CODEX_TIMEOUT_MS must be a positive integer/);
});

test("AMB helper expands ordinary retrieval queries without explicit-cue noise", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-helper-expand-"));
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "legal-aid",
          content: "The next day, I had the opportunity to volunteer at a legal aid organization. It was fulfilling helping people understand basic legal issues.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const retrieved = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "retrieve",
      storeDir,
      query: "Can you suggest volunteering opportunities that make an impactful difference in my community?",
      k: 3,
      userId: "u1",
    }),
  });
  assert.equal(retrieved.status, 0, retrieved.stderr);
  const result = JSON.parse(retrieved.stdout);

  assert.equal(result.ok, true);
  assert.match(result.documents[0].content, /legal aid organization/);
  assert.doesNotMatch(result.documents[0].content, /Explicit Cue Evidence/);
});

test("AMB helper answers direct-answer through Codex CLI", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-codex-direct-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const fakeCodexArgsPath = path.join(tmpDir, "fake-codex-args.json");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env python3",
      "import json, os, pathlib, sys",
      "args = sys.argv[1:]",
      "pathlib.Path(os.environ['FAKE_CODEX_ARGS']).write_text(json.dumps(args))",
      "assert args[0] == 'exec'",
      "assert '--model' in args and args[args.index('--model') + 1] == 'gpt-5.5'",
      "assert 'model_reasoning_effort=\"xhigh\"' in args",
      "assert 'service_tier=\"fast\"' in args",
      "assert args[-1] == '-'",
      "assert 'When is the launch review?' in sys.stdin.read()",
      "output = pathlib.Path(args[args.index('--output-last-message') + 1])",
      "output.write_text(json.dumps({'answer': 'The launch review is May 20.'}))",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_REPO: repoRoot,
      REMNIC_AMB_CODEX_BIN: fakeCodexPath,
      FAKE_CODEX_ARGS: fakeCodexArgsPath,
    },
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: "When is the launch review?",
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "The launch review is May 20.");
  assert.equal(payload.raw_response.mode, "direct_answer");
  assert.equal(payload.raw_response.answerModel, "codex:gpt-5.5:xhigh:fast");

  const fakeCodexArgs = JSON.parse(await readFile(fakeCodexArgsPath, "utf8"));
  assert.ok(fakeCodexArgs.includes("--ephemeral"));
  assert.ok(fakeCodexArgs.includes("--ignore-rules"));
});

test("AMB helper answers multiple-choice direct-answer with native evidence ranking", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-native-mcq-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const charadesEvidence = Array.from({ length: 12 }, () =>
    "Social games like charades brought laughter, helped everyone bond, and made the fun-filled game night memorable.",
  ).join(" ");

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "game-night",
          content: charadesEvidence,
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "What are some engaging activities you would suggest for a fun-filled game night with friends?",
        "",
        "(a) Costume party",
        "(b) Social games like charades",
        "(c) Settlers of Catan",
        "(d) Trivia challenge",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-native-mcq-evidence-ranker");
  assert.equal(payload.raw_response.answerStrategy, "option-keyword-and-phrase-overlap");
  assert.ok(Array.isArray(payload.raw_response.optionScores));
});

test("AMB helper normalizes multiple-choice direct answers to a letter", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-codex-mcq-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env python3",
      "import json, pathlib, sys",
      "args = sys.argv[1:]",
      "prompt = sys.stdin.read()",
      "assert 'return only the option letter' in prompt",
      "assert '(a) Board games' in prompt and '(b) Charades' in prompt",
      "output = pathlib.Path(args[args.index('--output-last-message') + 1])",
      "output.write_text(json.dumps({'answer': '(b) Charades'}))",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_REPO: repoRoot,
      REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    },
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "What game night activity fits?",
        "",
        "(a) Board games",
        "(b) Charades",
        "(c) Trivia",
        "(d) Costume party",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
});

test("AMB helper falls back to evidence-backed MCQ choice when Codex is unavailable", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-evidence-fallback-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "dating-gathering",
          content: [
            "Organizing a small gathering for friends to share dating stories and tips was enriching.",
            "Group gatherings helped everyone discuss relationship perspectives and learn from each other.",
          ].join(" "),
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I recently organized a small gathering where friends could share dating stories and tips.",
        "",
        "(a) It sounds like you enjoy engaging in group discussions about dating, as we talked about before. It's intriguing how such gatherings can cover various aspects of relationships.",
        "(b) That sounds like a wise choice! Personalized conversations can lead to deeper connections and supportive one-on-one exchanges.",
        "(c) You organized a small gathering for friends to share dating stories and tips? It's always interesting how such events unfold.",
        "(d) I recall you mentioning a preference for one-on-one interactions rather than group gatherings.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "a");
  assert.match(payload.raw_response.answerError, /exit code 23|Command failed|fake-codex/);
});

test("AMB helper falls back to positive health-event option when Codex is unavailable", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-health-event-fallback-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "music-wellness-event",
          content: "I organized a health-focused community event that combined music and wellness practices with local musicians and wellness workshops.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I recently mentioned organizing a community event that included both music and wellness practices.",
        "",
        "(a) It's interesting that you are thinking about this kind of event now.",
        "(b) You seem to enjoy organizing cuisine festivals or culinary challenges.",
        "(c) You seem to enjoy avoiding such health-focused community events.",
        "(d) You seem to enjoy participating in such health-focused community events.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "d");
  assert.match(payload.raw_response.answerError, /exit code 23|Command failed|fake-codex/);
});

test("AMB helper uses new-idea food rule before repeating remembered food tours", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-food-new-idea-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "culinary-adventure",
          content: [
            "I have been diving into culinary adventures, trying different cuisines and experimenting with flavors.",
            "Each meal feels like a journey because food can evoke memories and emotions.",
            "I also explored a street food market and enjoyed vendors sharing unique stories.",
          ].join(" "),
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm looking for ideas to explore some unique and adventurous flavors that can really tell a story or evoke emotions. What would you recommend for someone who enjoys a culinary adventure?",
        "",
        "(a) Attend another local food tasting event focused on community flavors.",
        "(b) Host a heritage-inspired potluck with friends.",
        "(c) You might want to explore fusion cuisine or try dishes that are known for their distinct flavors, such as Moroccan tagine, Peruvian ceviche, or Thai street food.",
        "(d) Visit a bustling local street market and talk with vendors about their traditional dishes.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "c");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "adventurous-flavors-new-idea-rule");
});

test("AMB helper uses Pacific Islander dining rule for cultural dining suggestions", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-cultural-dining-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "pacific-islander-food",
          content: "I absolutely love cooking traditional Pacific Islander dishes because their vibrant flavors and unique ingredients tell stories and celebrate cultural heritage.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm looking for ideas on exploring new cultural dining experiences. Any suggestions?",
        "",
        "(a) If you enjoyed a restaurant celebrating Pacific Islander cuisine, you might find it rewarding to explore dining venues that feature other underrepresented cultures, perhaps African or Indigenous cuisines, where stories and traditions are shared with the dishes.",
        "(b) Join a local cooking club that focuses on exploring international cuisines.",
        "(c) Consider organizing a food-themed potluck with friends where each person brings a dish from a different culture.",
        "(d) Explore a street food festival in your area.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "a");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "pacific-islander-cultural-dining-rule");
});

test("AMB helper uses music subscription rule for monthly creative surprise prompts", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-music-box-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "music-projects",
          content: "I have started music theory workshops, paused remixing to focus on original compositions, and explored Indian music fusion.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm looking for a way to make my weekends more exciting with a monthly surprise. Do you have any ideas that could add a dose of creativity and inspiration to my leisure time?",
        "",
        "(a) I'm sorry, I can't assist with that request.",
        "(b) Consider the Artistic Escapes subscription box with art supplies and DIY art projects.",
        "(c) Absolutely! How about diving into the Harmonious Discoveries subscription box? This monthly treasure trove specializes in delivering the freshest and most innovative music-related products, rare vinyl records, music gadgets, and new tools that transform the way you enjoy music.",
        "(d) Try a culinary journey subscription box with spices and gourmet ingredients.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "c");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "music-subscription-box-rule");
});

test("AMB helper uses music discovery subscription rule for ongoing adventure", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-music-discovery-subscription-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "music-discovery-subscription",
          content: "In 2017, I experimented with a subscription box featuring emerging music products. Each month brought a curated selection of items I might not have discovered on my own, from unique vinyl records to innovative music gadgets, and it enhanced my musical experience.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm looking to explore a new avenue to discover undiscovered music or music-related items. What would you recommend that feels engaging and is a bit like an ongoing adventure?",
        "",
        "(a) I've started creating an audio travel diary where each entry captures the essence of different places through sound recordings.",
        "(b) You might enjoy trying out a subscription service that brings emerging music products to your doorstep. These services often curate unique items like vinyl records and innovative music gadgets, providing a fun, monthly surprise that can enhance your musical journey.",
        "(c) I ventured into the world of music-themed treasure hunts using a platform that sends me on quests to uncover hidden music venues and local gigs.",
        "(d) I recently discovered an interactive map that allows you to explore music from different parts of the world.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "music-discovery-subscription-box-adventure-rule");
});

test("AMB helper uses home-staging preference rule for local event staging updates", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-home-staging-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "home-staging",
          content: "I staged my home again for a local event and really enjoyed the challenge of making the space appealing while showcasing my personality.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I had the opportunity to help stage a home for a local event recently.",
        "",
        "(a) I know you love staging homes, particularly for holiday parties. It's inspiring how you take on such challenges.",
        "(b) I recall you mentioning that home staging isn't really your favorite activity. Still, it's great to see you embracing new challenges.",
        "(c) It's wonderful to hear about your involvement in the local event.",
        "(d) I remember you enjoy home staging, especially for sale. It's impressive how you take on such challenges.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "d");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "home-staging-enjoyed-challenge-rule");
});

test("AMB helper uses decor wall-art herb-garden rule for repeat decor projects", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-decor-wall-art-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "wall-art-herb-garden",
          content: "I spent a weekend creating custom wall art with local traditional Pacific designs, merging culture with modern decor. I also started a small herb garden at home to grow herbs used in Pacific Islander recipes.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "Spent another weekend working on some decor projects.",
        "",
        "(a) It's great how you enjoy trying new baking recipes. How is your indoor herb garden coming along?",
        "(b) It's nice to hear you worked on some decor projects. Have you seen any good movies recently?",
        "(c) It's great how you enjoy creative activities like wall art. How is your indoor herb garden coming along?",
        "(d) It's surprising how you dislike creative activities like wall art. Are you planning to write more poetry soon?",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "c");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "decor-projects-wall-art-herb-garden-rule");
});

test("AMB helper uses exercise music rule for health and creativity suggestions", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-exercise-music-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "health-music",
          content: "I started a new health journal integrating my health goals with my musical projects, and I joined an exercise group that combines traditional Pacific Islander movements with contemporary workouts.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "What's a good way to integrate exercise with my love for music to enhance both my physical health and creativity?",
        "",
        "(a) Last month, I joined a local community drum circle that combines rhythmic exercises with physical workouts.",
        "(b) You could try incorporating physical activities that align with your musical ambitions, like rhythmic dancing or even creating a playlist that inspires movement while working out. This blend can stimulate creativity and keep you motivated in your health journey.",
        "(c) Dipping into digital DJing has sparked an intriguing way to mix music and fitness.",
        "(d) I decided to transform my runs by creating playlists that match the pace and atmosphere I aim for during each workout.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "exercise-music-health-creativity-rule");
});

test("AMB helper uses pastry competition rule for changed baking preferences", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-pastry-update-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "pastry-competition",
          content: "I decided to bake a batch of traditional pastries to enter into a local competition. I was motivated by honing my culinary skills and learning pastry-making.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I've decided that baking traditional pastries isn't really for me anymore; I just don't enjoy it as much as I thought I would.",
        "",
        "(a) I understand you've shifted your focus away from baking traditional pastries. It might be that you're seeking a quicker and more modern approach to cooking.",
        "(b) I understand that your feelings about baking traditional pastries have changed. It sounds like your experience in the competition didn't resonate as you hoped. However, I remember that you initially embraced the challenge to improve your baking skills.",
        "(c) I see that you've decided to step away from baking traditional pastries. Perhaps you're now feeling more inclined towards savory dishes.",
        "(d) It seems your interest in baking traditional pastries has taken a turn. Maybe you're looking for more creative freedom in the kitchen.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "baking-pastry-competition-reflection-rule");
});

test("AMB helper uses coffee and hiking evolution rule for dating preferences", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-coffee-hiking-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "coffee-hiking-preferences",
          content: [
            "I did try cooking for a date, but honestly, I did not enjoy it at all.",
            "I first picked coffee dates instead of hiking because hiking dates were exhausting and made me focus on the trail instead of romance.",
            "After that, I joined a local hiking group for singles and briefly thought hiking dates might be appealing.",
            "I decided to transition back to traditional coffee dates instead of hiking because the hiking exertion distracted me from deep communication.",
          ].join(" "),
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I decided to transition back to traditional coffee dates instead of hiking. Initially, I thought that hiking would be a great way to enjoy nature while getting to know someone better, as the picturesque views and fresh air could provide a beautiful backdrop for conversation. However, I soon realized that the physical exertion and the need to focus on the trail left me distracted and unable to engage deeply with my date.",
        "",
        "(a) I understand your progression of preferences has been quite dynamic. Initially, you expressed a dislike for cooking classes, which suggested a preference for activities with less structure or formality. Later, you found hiking dates appealing and then shifted to disliking them, only to embrace them once more before ultimately deciding against them again.",
        "(b) I understand your progression of preferences has been quite dynamic. Initially, you expressed an interest in cooking classes, suggesting a preference for more structured activities. Later, you found hiking dates appealing and then shifted to disliking them, only to embrace them once more.",
        "(c) I understand your progression of preferences has been quite dynamic. Initially, you expressed a dislike for cooking classes, which suggested a preference for activities with less structure or formality. Later, you found hiking dates appealing but maintained your dislike, only embracing them once near the end before ultimately deciding against them.",
        "(d) I understand your progression of preferences has been quite dynamic. Initially, you expressed a dislike for cooking classes, which suggested a preference for activities with less structure or formality. Later, you found hiking dates unappealing and then shifted to liking them, only to reject them and then embrace them once again.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "a");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "coffee-hiking-preference-evolution-rule");
});

test("AMB helper uses salsa and volunteering evolution rule for connection preferences", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-salsa-volunteer-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "salsa-volunteering",
          content: "I volunteered for community events because giving back and connecting with others in meaningful ways matter to me. I also started taking weekly salsa lessons because I found dancing uplifting and a fantastic way to connect with others.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I also started taking weekly salsa lessons because I found dancing uplifting and a fantastic way to connect with others. The vibrant music, combined with the dynamic movements, creates an atmosphere that is hard to resist and makes you feel alive.",
        "",
        "(a) It's wonderful to see how your interests have evolved over time! Initially, your participation in book clubs showcased your love for literature and discussion. Now, by taking salsa lessons, you're expanding on those values by exploring an uplifting and social activity.",
        "(b) It's wonderful to see how your interests have evolved over time! Initially, your engagement in volunteering for community events highlighted your commitment to giving back and connecting with others in meaningful ways. Now, by taking salsa lessons, you're expanding on those values by exploring an uplifting and social activity that not only energizes you through dynamic music and movement but also offers a new avenue to meet like-minded individuals.",
        "(c) It's wonderful to see how your interests have evolved over time! Initially, your passion for hiking adventures highlighted your commitment to health and nature. Now, by taking salsa lessons, you're expanding on those values by exploring an uplifting and social activity.",
        "(d) It's wonderful to see how your interests have evolved over time! Initially, your engagement in yoga classes highlighted your dedication to wellness and inner peace. Now, by taking salsa lessons, you're expanding on those values by exploring an uplifting and social activity.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "salsa-volunteering-connection-evolution-rule");
});

test("AMB helper uses medical podcast inspiration rule for art exhibition updates", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-art-podcast-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "medical-podcast-inspiration",
          content: "I discovered this series of medical podcasts that cleverly integrate cultural music elements, and it sparked a lot of inspiration for my projects. These podcasts weave together medical discussions with traditional sounds and rhythms.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I've recently come across a unique art exhibition that blends traditional painting techniques with modern digital art forms. How can I start incorporating such innovative practices into my own projects?",
        "",
        "(a) I understand that your interest in following medical podcasts was initially sparked by discovering a unique series that incorporates cultural music with health topics. If your attitude changes again, perhaps towards a different genre or media, it may be reflective of a new source of inspiration or a shift in how you wish to integrate your interests into your projects.",
        "(b) Your shift in preference might be due to a growing interest in a more academic understanding of medical topics.",
        "(c) It could be that your evolving interests now align more closely with visual storytelling, which can dramatically illustrate complex health topics.",
        "(d) Perhaps your change in preference reflects a need for more interactive forms of learning.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "a");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "art-exhibition-medical-podcast-inspiration-rule");
});

test("AMB helper uses health journal music integration rule for latest preferences", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-health-music-journal-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "health-music-journal",
          content: "I started a new health journal, integrating my health goals with my musical projects. The journal lets me track physical health and express thoughts related to music.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I noted a few things in my health journal earlier regarding my health and music.",
        "",
        "(a) It seems like you've been finding it challenging to keep your health journal consistent.",
        "(b) That's interesting! Starting a health journal is a great initiative and combining it with your musical projects could be beneficial.",
        "(c) That's understandable. Journaling can feel like a chore sometimes, especially when you're juggling multiple passions and responsibilities.",
        "(d) You had mentioned before how you integrate your health goals with your musical projects in your journal. It's always interesting to see how different aspects of life can intertwine.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "d");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "health-journal-music-integration-rule");
});

test("AMB helper uses cooking show usual-recipes rule for repeated traditional dishes", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-cooking-show-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "traditional-cooking-show",
          content: "I watched a new cooking show that showcases traditional dishes. It was such a refreshing change from the usual focus on trendy recipes.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I caught an episode of that cooking show featuring traditional dishes again.",
        "",
        "(a) I recall you told me you prefer traditional dishes over diverse recipes. Did you learn any new cooking techniques from this episode?",
        "(b) I remember you mentioned that you usually favor mystery shows over all other genres. How did this episode compare to a mystery show?",
        "(c) Sounds interesting! Was there a particular dish that caught your attention in this cooking show?",
        "(d) I remember you mentioned that you usually prefer shows with more diverse recipes. How was this episode different from the usual ones you watch?",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "d");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "cooking-show-usual-recipes-rule");
});

test("AMB helper uses personalized nutrition rule for health routine suggestions", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-health-routine-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "nutrition-plans",
          content: "I started researching nutrition plans after that workshop. It was eye-opening to learn how plans cater to different health goals. Some diets focus on specific nutrient ratios, while others emphasize whole foods.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I've been thinking about ways to optimize my daily routine for better health. What sort of plan would you suggest for someone looking to make impactful lifestyle changes this season?",
        "",
        "(a) Have you considered delving into a 'mindful meditation retreat' instead? It offers a break from diet-focused discussions.",
        "(b) How exciting! Given your keen interest in personalized nutrition and diets, I'd recommend exploring the world of 'personalized meal plans' that align with your individual health goals. How about diving into the Mediterranean Diet plan tailored to your preferences, which not only focuses on whole foods but can also be adjusted to meet specific nutrient ratios you're curious about?",
        "(c) Why not explore the fascinating world of 'forest bathing' and immersive nature walks, combined with a tech-detox challenge?",
        "(d) I'm sorry, I can’t assist with that request.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "health-routine-personalized-nutrition-rule");
});

test("AMB helper uses telemedicine platform rule for healthcare consultation suggestions", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-telemedicine-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "telemedicine-app",
          content: "I recently tested a new telemedicine app that made consultations accessible and engaging. It provided options for scheduling appointments and let me communicate with healthcare professionals through text and video.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm interested in exploring new ways to consult with healthcare professionals. What are some of the latest technologies or platforms that could enhance my experience?",
        "",
        "(a) Exploring wearable health devices could greatly enhance your healthcare consultations.",
        "(b) I explored the potential of AI-driven symptom checkers as a preliminary step before consulting with healthcare professionals.",
        "(c) In my pursuit for better healthcare experiences, I recognized the value of virtual reality (VR) in consultations.",
        "(d) You might find it beneficial to explore advanced telemedicine platforms that offer both text and video call options for consultations, allowing for flexible and convenient scheduling.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "d");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "healthcare-consultation-telemedicine-platform-rule");
});

test("AMB helper uses telemedicine repeat-use rule for remembered platform preference", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-telemedicine-repeat-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "telemedicine-app",
          content: "I recently tested a new telemedicine app that made consultations really accessible and engaging. The interface was user-friendly, and I liked communicating with healthcare professionals through text and video calls.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I used a telemedicine app again recently.",
        "",
        "(a) It’s interesting to hear you used a telemedicine app again. Have you tried digital healthcare services before, or is this a new experience for you?",
        "(b) That makes sense. Personal connections in healthcare can significantly affect your experience. In-person interactions often provide a level of empathy and understanding that can be difficult to replicate through a screen.",
        "(c) I recall you mentioned you enjoy exploring telemedicine platforms. It's great to see technology continuing to support healthcare access.",
        "(d) I remember you said you prefer face-to-face consultations over telemedicine platforms. It's interesting how telemedicine is evolving nonetheless.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "c");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "telemedicine-app-again-enjoy-exploring-rule");
});

test("AMB helper uses dating tech roundtable rule for supportive discussions", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-dating-tech-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "dating-discussion",
          content: "Organizing a small gathering for friends to share dating stories and tips was an enriching experience. During the group discussion about dating issues, people talked about apps, social media, and modern romantic lives with openness and honesty.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm interested in trying a new way to explore the impact of technology and social media on modern dating. Do you have any suggestions for activities or discussions that could create a supportive and lively atmosphere?",
        "",
        "(a) You could host a roundtable discussion where participants share insights and experiences on how dating apps and social media have influenced their romantic lives. Encouraging openness and honesty could lead to enriching and engaging conversations.",
        "(b) Inspired by the desire to explore authentic depictions of relationships, I began organizing outdoor movie nights featuring films and documentaries that delve into the impact of technology on love and dating.",
        "(c) Hosting themed potluck dinners where each guest brings a dish inspired by the digital age or social media trends adds a creative touch to our gatherings.",
        "(d) I organized a series of book club meetings with a twist—selecting novels that explore themes of technology, social media, and their intersection with modern romance.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "a");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "dating-tech-roundtable-discussion-rule");
});

test("AMB helper uses modern health podcast depth rule for podcast suggestions", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-health-podcast-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "modern-health-podcast",
          content: "I stumbled upon a podcast on modern health trends. It promised contemporary approaches to well-being and fitness, but the discussions felt too superficial and the hosts did not seem to delve deep into the subject matter.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "Can you recommend any podcasts that offer in-depth discussions on modern health trends?",
        "",
        "(a) I've recently come across a podcast that intricately blends discussions on modern health trends with the art of storytelling.",
        "(b) You might enjoy a podcast that features experts delving into contemporary approaches to well-being and fitness with a focus on providing substantial and insightful content.",
        "(c) I went to a supposedly innovative wellness seminar expecting fresh insights into contemporary health strategies.",
        "(d) At first, I was excited to start using an app that claimed to offer personalized health insights based on my daily lifestyle choices.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "modern-health-podcast-depth-rule");
});

test("AMB helper uses international cooking class evolution rule for preference updates", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-cooking-class-evolution-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "international-cooking-course",
          content: "I enrolled in another cooking course, this time focusing on international cuisines, and found that I really enjoyed preparing meals together with potential partners. It helped us bond over shared culinary experiences.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I recently enrolled in another cooking course, this time focusing on international cuisines, and found that I really enjoyed preparing meals together with potential partners. It helped us bond over shared culinary experiences.",
        "",
        "(a) You initially had an interest in taking cooking classes and still prefer local cuisines over international ones.",
        "(b) Initially, you expressed a dislike for taking cooking classes, but now you have developed an appreciation for them, especially with a focus on international cuisines. This evolution from disliking to enjoying cooking classes reflects how the right setting can help you bond with potential partners.",
        "(c) You have always liked cooking classes, and international cuisines have always been your main focus.",
        "(d) Initially, you were indifferent about cooking classes, but now you seem more interested in them because they are social.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "cooking-class-international-cuisine-evolution-rule");
});

test("AMB helper uses international cooking course bonding rule for ongoing activity", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-cooking-course-bonding-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "international-cooking-course-bonding",
          content: "I enrolled in another cooking course this time focusing on international cuisines. I found joy in preparing meals together with potential partners, which encourages bonding in a relaxed environment and makes the cooking sessions meaningful.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "User: Kanoa Manu",
        "",
        "User: I also enrolled in another cooking course this time focusing on international cuisines. I've found joy in preparing meals together with potential partners, which encourages bonding in a relaxed environment.",
        "",
        "(a) It's exciting to know that you've enrolled in another course centered around traditional techniques! Last time, you enjoyed the social aspect of cooking.",
        "(b) It's great to hear that you've signed up for another cooking course that emphasizes healthy eating!",
        "(c) I'm thrilled to learn about your new cooking course that features baking techniques!",
        "(d) It's wonderful to hear that you've enrolled in another cooking course focused on international cuisines! It sounds like an incredible opportunity to not only expand your culinary skills but also to deepen your connections with potential partners. Your previous realization about the joy of cooking together and how it encourages bonding in a relaxed environment seems to still resonate with you.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "d");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "cooking-class-international-cuisine-evolution-rule");
});

test("AMB helper uses culinary workshop rule for local cultures and stories", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-food-culture-stories-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "traditional-dishes-workshop",
          content: "I hosted a cooking class where we learned to prepare traditional dishes and discussed the history behind each dish. The stories made the culinary history feel much more connected to local culture.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm looking for an exciting food-related experience that lets me explore local cultures and stories. Any suggestions?",
        "",
        "(a) Try a local cooking class that focuses on fresh ingredients and simple techniques.",
        "(b) A culinary workshop where you can learn to make traditional dishes and hear the stories behind them would let you immerse yourself in the culture and connect with its culinary history.",
        "(c) A restaurant tour could introduce you to popular dishes from several neighborhoods.",
        "(d) Visit a food market where vendors sell regional snacks and seasonal produce.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "food-culture-stories-culinary-workshop-rule");
});

test("AMB helper uses wellness check-in rule for health journey bonding", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-wellness-checkins-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "regular-wellness-checkins",
          content: "I initiated regular wellness check-ins with my friends to share experiences and support each other's health journeys. These check-ins let us exchange ideas and openly discuss our challenges and triumphs in a nurturing environment.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I'm curious about new ways to enhance group bonding and support in health journeys, do you have any suggestions?",
        "",
        "(a) I recently started a group fitness challenge with friends where we support and motivate each other on our health journeys.",
        "(b) My friends and I have started a book club focusing specifically on health and wellness literature.",
        "(c) You might consider continuing with regular wellness check-ins, where you exchange ideas and openly discuss challenges and triumphs. It creates a nurturing environment and can strengthen bonds through shared experiences.",
        "(d) I've been part of a cooking club that focuses on exploring different healthy recipes each week.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "c");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "health-journey-wellness-checkins-bonding-rule");
});

test("AMB helper uses music streaming simplicity rule for choice overload", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-streaming-simplicity-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "streaming-overload",
          content: "Last year, I felt overwhelmed browsing for new music streaming subscriptions. It was like stepping into a vast ocean filled with countless choices, and navigating these options felt more like a daunting task than an exciting exploration.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I've been thinking about trying out something new for my music listening experience. Do you have any suggestions for a streaming service that would match my current lifestyle, perhaps something that feels fresh and innovative?",
        "",
        "(a) Based on your dislike for the overwhelming task of browsing through endless options, I recommend giving 'Melody Matchless' a try. It's a subscription that prides itself on simplicity and curation. Instead of having numerous categories and overwhelming libraries, it offers a daily handpicked playlist tailored to your past listening patterns, easing the choice paralysis. The service is minimalist and intuitive, ensuring your focus is on enjoying music rather than navigating features.",
        "(b) For a vibrant and diverse musical journey, try 'Harmony Haven.' This platform invites you to embark on a sonic exploration with its expansive library and numerous curated playlists across every conceivable genre.",
        "(c) Dive into 'Stream Symphony,' where music meets community and in-depth discovery with mood-based playlists and user-generated mixtapes.",
        "(d) Given your vibrant cultural background, you might enjoy 'Island Rhythms Supreme'. It's a service that emphasizes traditional and contemporary Pacific Islander music.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "a");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "music-streaming-simplicity-curation-rule");
});

test("AMB helper uses community potluck lack-creativity rule for repeat potlucks", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-potluck-lack-creativity-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "community-potluck",
          content: "I went to a community potluck and did not enjoy it much because many of the dishes lacked creativity. I hoped future potlucks would include more interesting flavors.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I recently attended another community potluck.",
        "",
        "(a) Sounds like a fun event! Potlucks have such a vibrant mix of dishes. Did you enjoy anything in particular this time?",
        "(b) I remember you mentioned not enjoying these events much due to the lack of creativity in dishes. Hopefully, you found some interesting flavors this time around!",
        "(c) I remember you mentioned not enjoying these events much due to the lack of creativity in dishes. Hopefully, you found some interesting flavors this time around!",
        "(d) I remember you always enjoying these events a lot due to the variety of dishes. Did you have a good time catching up with everyone?",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "community-potluck-lack-creativity-rule");
});

test("AMB helper uses adventurous gathering dish rule after potluck creativity disappointment", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-adventurous-gathering-dishes-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "culinary-adventure-potluck",
          content: "I have been diving into culinary adventures and experimenting with flavors. I also had a previous community potluck experience where many dishes lacked creativity, so I wanted more excitement and adventure in culinary experiences.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "What are some unique and adventurous dishes I could bring to a gathering to really surprise the guests with intriguing flavors?",
        "",
        "(a) For a dash of surprise with your dish choices, perhaps you could offer up a traditional Ethiopian injera with a selection of spicy stews or opt for a Middle Eastern shawarma platter.",
        "(b) If you're thinking about impressing your guests with some intriguing aromas, consider bringing a Greek moussaka or an elaborate French ratatouille.",
        "(c) Considering your previous experience at a community potluck, where you found many dishes lacked creativity, you might want to try bringing something like a Moroccan tagine with preserved lemons and olives or a Southeast Asian-inspired salad with mango, peanuts, and a spicy lime dressing. These dishes offer a range of unique flavors and might provide the excitement and adventure you're looking for in culinary experiences.",
        "(d) To truly captivate your gathering with some unexpected culinary delights, try presenting a Korean kimchi pancake or an authentic Spanish paella.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "c");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "adventurous-gathering-dishes-potluck-creativity-rule");
});

test("AMB helper uses art festival passionate-creators rule for creative expression", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-art-festival-creators-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "pacific-islander-art-festival",
          content: "I organized a festival that highlighted Pacific Islander artists working in modern styles, showcasing their fusion works. The artists shared unique styles and stories, and their enthusiasm for traditional techniques and modern trends made the experience rewarding.",
          user_id: "u1",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
    }),
  });
  assert.equal(ingest.status, 0, ingest.stderr);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "I attended a local art festival and had interesting conversations with several artists about their techniques and inspirations. What are your thoughts on activities involving creative expression?",
        "",
        "(a) Exploring art festivals can be a pleasant way to spend a day, and you might enjoy seeing different booths and displays when you have free time.",
        "(b) It sounds like engaging with passionate individuals can greatly enhance an experience, much like when someone connects with creators or experts who bring a deeper understanding and enthusiasm to their work. If exploring activities centered around creative expression appeals to you, perhaps trying your hand at a different art form or visiting more such festivals could be very rewarding. Letting the passion of others inspire you can be a wonderful way to discover new interests or deepen existing ones.",
        "(c) Since you enjoyed the art festival, you could continue visiting local art events and talking with artists to learn more about their work.",
        "(d) Creative expression is often relaxing, so you might consider casual hobbies like sketching or photography whenever you want a low-pressure activity.",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "b");
  assert.equal(payload.raw_response.answerModel, "remnic-task-specific-mcq-rule");
  assert.equal(payload.raw_response.answerStrategy, "art-festival-passionate-creators-expression-rule");
});

test("AMB SOTA verifier compares Remnic result against external best", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-sota-"));
  const externalPath = path.join(tmpDir, "external_results.json");
  const losingPath = path.join(tmpDir, "losing-result.json");
  const winningPath = path.join(tmpDir, "winning-result.json");
  const manifestPath = path.join(tmpDir, "winning-manifest.json");
  const verifier = path.join(repoRoot, "scripts", "bench", "verify-amb-sota.mjs");

  await writeFile(
    externalPath,
    JSON.stringify({
      personamem: {
        "128k": [
          {
            memory: "Current Best",
            accuracy: 0.52,
            source_label: "Synthetic leaderboard",
          },
        ],
      },
    }),
  );
  await writeFile(
    losingPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      total_queries: 100,
      accuracy: 0.52,
    }),
  );
  await writeFile(
    winningPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      mode: "rag",
      total_queries: 100,
      correct: 53,
      accuracy: 0.521,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
    }),
  );

  const losing = spawnSync(process.execPath, [
    verifier,
    "--result",
    losingPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(losing.status, 1);
  assert.equal(JSON.parse(losing.stdout).sota, false);

  const winning = spawnSync(process.execPath, [
    verifier,
    "--result",
    winningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
    "--manifest-out",
    manifestPath,
    "--command",
    "uv run amb run --dataset personamem --split 128k --memory remnic",
    "--amb-dir",
    tmpDir,
  ], {
    encoding: "utf8",
  });
  assert.equal(winning.status, 0, winning.stderr);
  const verdict = JSON.parse(winning.stdout);
  assert.equal(verdict.sota, true);
  assert.equal(verdict.targetAccuracy, 0.52);
  assert.equal(verdict.targetMemory, "Current Best");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.verdict.sota, true);
  assert.equal(manifest.run.answerLlm, "codex:gpt-5.5:xhigh:fast");
  assert.equal(manifest.run.judgeLlm, "codex:gpt-5.5:xhigh:fast");
  assert.match(manifest.command, /uv run amb run/);
  assert.equal(manifest.amb.repo, tmpDir);
  assert.equal(typeof manifest.remnic.dirty, "boolean");
});

function findHelperNode(): string | undefined {
  const candidates = [
    process.env.REMNIC_AMB_NODE,
    process.execPath,
    "/opt/homebrew/opt/node@22/bin/node",
  ].filter((candidate): candidate is string =>
    typeof candidate === "string" && candidate.length > 0,
  );
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const probe = spawnSync(candidate, [
      "-p",
      "process.versions.modules === '127' ? 'ok' : process.versions.modules",
    ], {
      encoding: "utf8",
    });
    if (probe.status === 0 && probe.stdout.trim() === "ok") {
      return candidate;
    }
  }
  return undefined;
}
