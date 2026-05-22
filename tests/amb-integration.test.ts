import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
  const slowHelperPath = path.join(fakeRemnicRoot, "integrations", "amb", "slow-helper.mjs");
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
      "    async def _process_one_attempt(self, answer_result, q, dataset):",
      "        return QueryResult(",
      "            query_id=q.id,",
      "            query=q.query,",
      "            answer=answer_result.answer,",
      "            reasoning=answer_result.reasoning,",
      "            context=answer_result.context,",
      "            context_tokens=0,",
      "            retrieve_time_ms=answer_result.retrieve_time_ms,",
      "            gold_answers=q.gold_answers,",
      "            correct=True,",
      "            judge_reason='ok',",
      "            meta=q.meta,",
      "            raw_response=None,  # skip storing to conserve disk space",
      "            category_axes=dataset.get_result_categories(q.meta),",
      "        )",
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
      "from .tempo import TempoDataset",
      "",
      "REGISTRY: dict[str, type[Dataset]] = {",
      "    'tempo': TempoDataset,",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(datasetDir, "tempo.py"),
    [
      "from .base import Dataset",
      "",
      "class TempoDataset(Dataset):",
      "    published = True",
      "    description = 'Tempo fixture'",
      "    task_type = 'qa'",
      "    splits = ['1k']",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(datasetDir, "personamem.py"),
    [
      "from .base import Dataset",
      "",
      "class PersonaMemDataset(Dataset):",
      "    published = True",
      "    description = 'PersonaMem fixture'",
      "    task_type = 'qa'",
      "    splits = ['128k']",
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
      "class LLMConfig:",
      "    pass",
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
    path.join(llmDir, "new_llm.py"),
    [
      "from .base import LLM",
      "",
      "class NewLLM(LLM):",
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
      "from .new_llm import NewLLM",
      "",
      "REGISTRY: dict[str, type[LLM]] = {",
      '    "gemini": GeminiLLM,',
      '    "new-llm": NewLLM,',
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
      "from .llm.base import LLMConfig, Schema",
      "from .llm.gemini import GeminiLLM",
      "",
      "class Judge:",
      "    def __init__(self, llm: GeminiLLM | None = None):",
      "        self.llm = llm or GeminiLLM()",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(modesDir, "rag.py"),
    [
      "from ..llm.gemini import GeminiLLM",
      "",
      "class RAGMode:",
      "    def __init__(self, llm: GeminiLLM | None = None):",
      "        self.llm = llm or GeminiLLM()",
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
      "    provider = 'BM25'",
      "    name = 'bm25'",
      "    description = 'BM25 fixture'",
      "    kind = 'local'",
      "    link = 'https://example.com/bm25'",
      "    logo = ''",
      "    variant = 'default'",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(memoryDir, "new_provider.py"),
    [
      "from .base import MemoryProvider",
      "",
      "class NewMemoryProvider(MemoryProvider):",
      "    provider = 'NewMemory'",
      "    name = 'new-memory'",
      "    description = 'New upstream memory provider fixture.'",
      "    kind = 'local'",
      "    link = 'https://example.com/new-memory'",
      "    logo = ''",
      "    variant = 'default'",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(memoryDir, "__init__.py"),
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      "from .new_provider import NewMemoryProvider",
      "",
      "REGISTRY: dict[str, type[MemoryProvider]] = {",
      '    "bm25": BM25MemoryProvider,',
      '    "new-memory": NewMemoryProvider,',
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
    slowHelperPath,
    [
      "setTimeout(() => {}, 5000);",
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
      "prompt = sys.stdin.read()",
      "output = pathlib.Path(args[args.index('--output-last-message') + 1])",
      "if '# Tools' in prompt:",
      "    counter_path = pathlib.Path(os.environ['FAKE_CODEX_TOOL_COUNTER'])",
      "    count = int(counter_path.read_text()) if counter_path.exists() else 0",
      "    counter_path.write_text(str(count + 1))",
      "    if count == 0:",
      "        output.write_text(json.dumps({'action': 'tool', 'tool_name': 'lookup', 'tool_args': {'query': 'launch', 'limit': 2}, 'final_answer': ''}))",
      "    else:",
      "        output.write_text(json.dumps({'action': 'final', 'tool_name': '', 'tool_args': {}, 'final_answer': 'done'}))",
      "else:",
      "    assert 'Answer from context.' in prompt",
      "    output.write_text(json.dumps({'answer': 'May 20', 'reasoning': 'used memory'}))",
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
  assert.equal(
    patchedRegistry.match(/"new-memory": _LazyMemoryProvider\("\.new_provider", "NewMemoryProvider"\)/g)?.length,
    1,
  );
  assert.match(patchedRegistry, /lazy optional-provider imports/);
  assert.match(patchedRegistry, /_MEMORY_PROVIDER_METADATA/);
  assert.match(patchedRegistry, /if name\.startswith\("_"\):\n            raise AttributeError\(name\)/);
  const patchedDatasets = await readFile(path.join(datasetDir, "__init__.py"), "utf8");
  assert.match(patchedDatasets, /lazy optional-dataset imports/);
  assert.match(patchedDatasets, /if name\.startswith\("_"\):\n            raise AttributeError\(name\)/);
  assert.equal(
    patchedDatasets.match(/"personamem": _LazyDataset\("\.personamem", "PersonaMemDataset"\)/g)?.length,
    1,
  );
  assert.equal(
    patchedDatasets.match(/"tempo": _LazyDataset\("\.tempo", "TempoDataset"\)/g)?.length,
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
  assert.equal(
    patchedLlmRegistry.match(/"new-llm": _LazyLLM\("\.new_llm", "NewLLM"\)/g)?.length,
    1,
  );
  assert.match(patchedLlmRegistry, /lazy provider imports/);
  assert.match(patchedLlmRegistry, /if name\.startswith\("_"\):\n            raise AttributeError\(name\)/);
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
  assert.match(patchedRagMode, /get_answer_llm/);
  assert.doesNotMatch(patchedAgenticMode, /llm\.gemini|GeminiLLM\(\)/);
  assert.doesNotMatch(patchedJudge, /llm\.gemini|GeminiLLM/);
  assert.match(patchedJudge, /get_judge_llm/);
  assert.match(patchedJudge, /from \.llm\.base import LLM, LLMConfig, Schema/);
  assert.match(patchedModesInit, /getattr\(cls\.__init__, "__code__", None\)/);
  assert.match(patchedAgenticMode, /get_answer_llm/);
  assert.match(patchedAgenticMode, /RAGMode\(llm=self\._llm\)/);
  assert.doesNotMatch(patchedAgenticMode, /RAGMode\(llm=self\._llm, k=k\)/);
  assert.match(patchedRunner, /Remnic patch: save batch results incrementally/);
  assert.match(patchedRunner, /save_lock = asyncio\.Lock\(\)/);
  assert.match(patchedRunner, /async with save_lock/);
  assert.match(patchedRunner, /correct_count = sum\(1 for r in completed if r\.correct\)/);
  assert.match(patchedRunner, /accuracy=correct_count \/ len\(completed\)/);
  assert.doesNotMatch(patchedRunner, /accuracy=0\.0/);
  assert.match(patchedRunner, /Remnic patch: preserve AnswerResult raw_response/);
  assert.match(patchedRunner, /raw_response=getattr\(answer_result, "raw_response", None\)/);
  assert.doesNotMatch(patchedRunner, /raw_response=None,\s+# skip storing to conserve disk space/);
  assert.match(patchedRunner, /self\._save\(partial\)/);

  const smokeScript = [
    "from pathlib import Path",
    "import os",
    "from memory_bench.dataset import REGISTRY as DATASET_REGISTRY",
    "from memory_bench.memory import REGISTRY",
    "from memory_bench.llm import REGISTRY as LLM_REGISTRY",
    "from memory_bench.llm.base import Schema, ToolDef",
    "import memory_bench.llm.codex as codex_module",
    "from memory_bench.models import Document",
    "",
    "assert list(REGISTRY).count('remnic') == 1",
    "assert list(LLM_REGISTRY).count('codex') == 1",
    "assert LLM_REGISTRY['new-llm']().model_id == 'NewLLM'",
    "assert REGISTRY['bm25'].provider == 'BM25'",
    "assert REGISTRY['bm25'].name == 'bm25'",
    "assert REGISTRY['bm25'].description == 'BM25 memory provider.'",
    "assert REGISTRY['bm25'].kind == 'local'",
    "assert REGISTRY['bm25'].link == ''",
    "assert REGISTRY['bm25'].logo == ''",
    "assert REGISTRY['bm25'].variant == 'default'",
    "assert not hasattr(REGISTRY['remnic'], '_missing_private_attr')",
    "assert REGISTRY['new-memory'].provider == 'NewMemory'",
    "assert REGISTRY['new-memory'].name == 'new-memory'",
    "assert REGISTRY['mem0'].provider == 'Mem0'",
    "assert REGISTRY['mem0'].name == 'mem0'",
    "assert DATASET_REGISTRY['personamem'].published is True",
    "assert DATASET_REGISTRY['personamem'].description == 'PersonaMem fixture'",
    "assert DATASET_REGISTRY['personamem'].task_type == 'qa'",
    "assert DATASET_REGISTRY['personamem'].splits == ['128k']",
    "assert DATASET_REGISTRY['tempo'].published is True",
    "assert DATASET_REGISTRY['tempo'].description == 'Tempo fixture'",
    "assert DATASET_REGISTRY['tempo'].task_type == 'qa'",
    "assert DATASET_REGISTRY['tempo'].splits == ['1k']",
    "assert codex_module._TOOL_SCHEMA['required'] == ['action']",
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
    "old_codex_bin = os.environ.get('REMNIC_AMB_CODEX_BIN')",
    "os.environ['REMNIC_AMB_CODEX_BIN'] = '~/fake-codex'",
    "try:",
    "    assert LLM_REGISTRY['codex']()._codex_bin == str(Path.home() / 'fake-codex')",
    "finally:",
    "    if old_codex_bin is None:",
    "        os.environ.pop('REMNIC_AMB_CODEX_BIN', None)",
    "    else:",
    "        os.environ['REMNIC_AMB_CODEX_BIN'] = old_codex_bin",
    "old_codex_bin = os.environ.get('REMNIC_AMB_CODEX_BIN')",
    "os.environ['REMNIC_AMB_CODEX_BIN'] = 'bin/fake-codex'",
    "try:",
    "    assert LLM_REGISTRY['codex']()._codex_bin == str(Path.cwd() / 'bin' / 'fake-codex')",
    "finally:",
    "    if old_codex_bin is None:",
    "        os.environ.pop('REMNIC_AMB_CODEX_BIN', None)",
    "    else:",
    "        os.environ['REMNIC_AMB_CODEX_BIN'] = old_codex_bin",
    "seen = {}",
    "def lookup(query, limit=1):",
    "    seen['args'] = {'query': query, 'limit': limit}",
    "    return 'tool-output'",
    "tool_answer = llm.tool_loop(",
    "    'Use the lookup tool.',",
    "    [ToolDef(",
    "        name='lookup',",
    "        description='Look up memory.',",
    "        parameters={'type': 'object', 'properties': {'query': {'type': 'string'}, 'limit': {'type': 'integer'}}},",
    "        required=['query'],",
    "        fn=lookup,",
    "    )],",
    ")",
    "assert seen['args'] == {'query': 'launch', 'limit': 2}",
    "assert tool_answer == 'done'",
    "os.environ['REMNIC_AMB_CODEX_TIMEOUT_SECONDS'] = '\\u00b2'",
    "try:",
    "    LLM_REGISTRY['codex']()",
    "except ValueError as exc:",
    "    assert 'positive integer' in str(exc)",
    "else:",
    "    raise AssertionError('unicode digit timeout should be rejected')",
    "finally:",
    "    os.environ.pop('REMNIC_AMB_CODEX_TIMEOUT_SECONDS', None)",
    "old_node = os.environ.get('REMNIC_AMB_NODE')",
    "os.environ['REMNIC_AMB_NODE'] = 'bin/fake-node'",
    "try:",
    "    assert REGISTRY['remnic']()._node == str(Path.cwd() / 'bin' / 'fake-node')",
    "finally:",
    "    if old_node is None:",
    "        os.environ.pop('REMNIC_AMB_NODE', None)",
    "    else:",
    "        os.environ['REMNIC_AMB_NODE'] = old_node",
    "old_node = os.environ.get('REMNIC_AMB_NODE')",
    "os.environ['REMNIC_AMB_NODE'] = '~/fake-node'",
    "try:",
    "    assert REGISTRY['remnic']()._node == str(Path.home() / 'fake-node')",
    "finally:",
    "    if old_node is None:",
    "        os.environ.pop('REMNIC_AMB_NODE', None)",
    "    else:",
    "        os.environ['REMNIC_AMB_NODE'] = old_node",
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
    "old_helper = os.environ.get('REMNIC_AMB_HELPER')",
    "old_helper_timeout = os.environ.get('REMNIC_AMB_HELPER_TIMEOUT_SECONDS')",
    "os.environ['REMNIC_AMB_HELPER'] = os.environ['SLOW_HELPER']",
    "os.environ['REMNIC_AMB_HELPER_TIMEOUT_SECONDS'] = '1'",
    "try:",
    "    slow_provider = REGISTRY['remnic']()",
    "    slow_provider.prepare(Path('slow-store'), reset=True)",
    "    try:",
    "        slow_provider.retrieve('Will the helper timeout?', user_id='u1')",
    "    except RuntimeError as exc:",
    "        assert 'timed out after 1 seconds' in str(exc)",
    "    else:",
    "        raise AssertionError('helper timeout should fail')",
    "finally:",
    "    if old_helper is None:",
    "        os.environ.pop('REMNIC_AMB_HELPER', None)",
    "    else:",
    "        os.environ['REMNIC_AMB_HELPER'] = old_helper",
    "    if old_helper_timeout is None:",
    "        os.environ.pop('REMNIC_AMB_HELPER_TIMEOUT_SECONDS', None)",
    "    else:",
    "        os.environ['REMNIC_AMB_HELPER_TIMEOUT_SECONDS'] = old_helper_timeout",
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
      SLOW_HELPER: slowHelperPath,
      FAKE_CODEX_ARGS: fakeCodexArgsPath,
      FAKE_CODEX_TOOL_COUNTER: path.join(tmpDir, "fake-codex-tool-counter.txt"),
    },
  });

  assert.equal(result.stderr, "");
  const fakeCodexArgs = JSON.parse(await readFile(fakeCodexArgsPath, "utf8"));
  assert.ok(fakeCodexArgs.includes("--ephemeral"));
  assert.ok(fakeCodexArgs.includes("--ignore-rules"));

  const missingRepoEnv = {
    ...process.env,
    PYTHONPATH: path.join(ambRoot, "src"),
  };
  delete missingRepoEnv.REMNIC_REPO;
  delete missingRepoEnv.REMNIC_AMB_HELPER;
  const missingRepo = spawnSync("python3", [
    "-c",
    "from memory_bench.memory import REGISTRY\nREGISTRY['remnic']()",
  ], {
    cwd: ambRoot,
    encoding: "utf8",
    env: missingRepoEnv,
  });
  assert.notEqual(missingRepo.status, 0);
  assert.match(missingRepo.stderr, /Could not locate the Remnic checkout/);
  assert.match(missingRepo.stderr, /REMNIC_REPO/);
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

test("AMB runner rejects missing option values before consuming flags", async () => {
  const result = spawnSync("bash", [
    path.resolve("scripts", "bench", "run-amb-remnic.sh"),
    "--name",
    "--verify-sota",
  ], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--name requires a value/);
  assert.doesNotMatch(result.stderr, /--amb is required/);
});

test("AMB runner requires explicit SOTA coverage floor", async () => {
  const result = spawnSync("bash", [
    path.resolve("scripts", "bench", "run-amb-remnic.sh"),
    "--amb",
    "missing-amb-checkout",
    "--verify-sota",
  ], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--verify-sota requires --min-queries/);
  assert.doesNotMatch(result.stderr, /Agent Memory Benchmark checkout/);
});

test("AMB runner install-only does not require Codex CLI", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-install-only-"));
  const ambRoot = path.join(tmpDir, "amb");
  const binDir = path.join(tmpDir, "bin");
  const fakeRemnicRoot = path.join(tmpDir, "remnic");
  const fakeInstallPath = path.join(fakeRemnicRoot, "integrations", "amb", "install.py");
  const providersMarker = path.join(tmpDir, "providers.txt");
  const fakeUvPath = path.join(binDir, "uv");
  const fakeOmbPath = path.join(ambRoot, ".venv", "bin", "omb");

  await mkdir(path.join(ambRoot, "src", "memory_bench", "memory"), { recursive: true });
  await mkdir(path.dirname(fakeInstallPath), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.dirname(fakeOmbPath), { recursive: true });

  await writeFile(path.join(ambRoot, "pyproject.toml"), "[project]\nname = 'fake-amb'\n");
  await writeFile(
    fakeInstallPath,
    [
      "import argparse",
      "",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--amb', required=True)",
      "parser.parse_args()",
      "",
    ].join("\n"),
  );
  await writeFile(fakeUvPath, "#!/usr/bin/env sh\nexit 0\n");
  await writeFile(
    fakeOmbPath,
    [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"providers\" ]; then",
      "  printf providers > \"$PROVIDERS_MARKER\"",
      "  exit 0",
      "fi",
      "exit 99",
      "",
    ].join("\n"),
  );
  await chmod(fakeUvPath, 0o755);
  await chmod(fakeOmbPath, 0o755);

  const result = spawnSync("bash", [
    path.resolve("scripts", "bench", "run-amb-remnic.sh"),
    "--amb=~/amb",
    "--install-only",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PROVIDERS_MARKER: providersMarker,
      REMNIC_AMB_CODEX_BIN: path.join(tmpDir, "missing-codex"),
      REMNIC_REPO: fakeRemnicRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(providersMarker, "utf8"), "providers");
  assert.doesNotMatch(result.stderr, /Codex CLI is required/);
  assert.doesNotMatch(result.stderr, /@remnic\/core is not built/);
});

test("AMB runner verifies SOTA results from absolute output directories", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-absolute-output-"));
  const ambRoot = path.join(tmpDir, "amb");
  const binDir = path.join(tmpDir, "bin");
  const fakeRemnicRoot = path.join(tmpDir, "remnic");
  const fakeInstallPath = path.join(fakeRemnicRoot, "integrations", "amb", "install.py");
  const fakeVerifierPath = path.join(fakeRemnicRoot, "scripts", "bench", "verify-amb-sota.mjs");
  const fakeCodexPath = path.join(binDir, "codex");
  const fakeUvPath = path.join(binDir, "uv");
  const fakeOmbPath = path.join(ambRoot, ".venv", "bin", "omb");
  const absoluteOutputDir = path.join(tmpDir, "absolute-results");
  const verifierArgsPath = path.join(tmpDir, "verifier-args.json");

  await mkdir(path.join(ambRoot, "src", "memory_bench", "memory"), { recursive: true });
  await mkdir(path.dirname(fakeInstallPath), { recursive: true });
  await mkdir(path.dirname(fakeVerifierPath), { recursive: true });
  await mkdir(path.join(fakeRemnicRoot, "packages", "remnic-core", "dist"), {
    recursive: true,
  });
  await mkdir(path.dirname(fakeOmbPath), { recursive: true });
  await mkdir(binDir, { recursive: true });

  await writeFile(path.join(ambRoot, "pyproject.toml"), "[project]\nname = 'fake-amb'\n");
  await writeFile(path.join(fakeRemnicRoot, "packages", "remnic-core", "dist", "index.js"), "");
  await writeFile(
    fakeInstallPath,
    [
      "import argparse",
      "",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--amb', required=True)",
      "parser.parse_args()",
      "",
    ].join("\n"),
  );
  await writeFile(
    fakeVerifierPath,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.VERIFIER_ARGS_PATH, JSON.stringify(args));",
      "const resultPath = args[args.indexOf('--result') + 1];",
      "if (!existsSync(resultPath)) {",
      "  throw new Error(`missing result at ${resultPath}`);",
      "}",
      "if (!args.includes('--allow-remnic-amb-patches')) {",
      "  throw new Error('missing --allow-remnic-amb-patches');",
      "}",
      "const expectedCommit = args[args.indexOf('--amb-expected-commit') + 1];",
      "if (expectedCommit !== process.env.EXPECTED_AMB_COMMIT) {",
      "  throw new Error(`unexpected AMB commit ${expectedCommit}`);",
      "}",
      "process.stdout.write(JSON.stringify({ sota: true }) + '\\n');",
      "",
    ].join("\n"),
  );
  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 0\n");
  await writeFile(fakeUvPath, "#!/usr/bin/env sh\nexit 0\n");
  await writeFile(
    fakeOmbPath,
    [
      "#!/usr/bin/env python3",
      "import json, os, pathlib, sys",
      "args = sys.argv[1:]",
      "if args == ['providers']:",
      "    raise SystemExit(0)",
      "if args == ['run', '--help']:",
      "    print('--split')",
      "    raise SystemExit(0)",
      "if args and args[0] == 'run':",
      "    output_dir = pathlib.Path(args[args.index('--output-dir') + 1])",
      "    dataset = args[args.index('--dataset') + 1]",
      "    name = args[args.index('--name') + 1]",
      "    mode = args[args.index('--mode') + 1]",
      "    split = args[args.index('--split') + 1]",
      "    result_path = output_dir / dataset / name / mode / f'{split}.json'",
      "    result_path.parent.mkdir(parents=True, exist_ok=True)",
      "    result_path.write_text(json.dumps({",
      "        'dataset': dataset,",
      "        'split': split,",
      "        'memory_provider': 'remnic',",
      "        'run_name': name,",
      "        'mode': mode,",
      "        'total_queries': 100,",
      "        'correct': 100,",
      "        'accuracy': 1.0,",
      "    }))",
      "    raise SystemExit(0)",
      "raise AssertionError(sys.argv)",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);
  await chmod(fakeUvPath, 0o755);
  await chmod(fakeOmbPath, 0o755);
  runGit(ambRoot, ["init"]);
  runGit(ambRoot, ["add", "."]);
  runGit(ambRoot, [
    "-c",
    "user.email=remnic-tests@example.invalid",
    "-c",
    "user.name=Remnic Tests",
    "commit",
    "-m",
    "fixture",
  ]);
  const expectedAmbCommit = gitOutput(ambRoot, ["rev-parse", "HEAD"]);

  const result = spawnSync("bash", [
    path.resolve("scripts", "bench", "run-amb-remnic.sh"),
    "--amb",
    ambRoot,
    "--output-dir",
    absoluteOutputDir,
    "--verify-sota",
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      REMNIC_AMB_CODEX_BIN: fakeCodexPath,
      REMNIC_REPO: fakeRemnicRoot,
      VERIFIER_ARGS_PATH: verifierArgsPath,
      EXPECTED_AMB_COMMIT: expectedAmbCommit,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const verifierArgs = JSON.parse(await readFile(verifierArgsPath, "utf8"));
  assert.equal(
    verifierArgs[verifierArgs.indexOf("--result") + 1],
    path.join(absoluteOutputDir, "personamem", "remnic", "rag", "128k.json"),
  );
});

test("AMB runner forces Codex LLMs, strips Gemini Google keys, and passes AMB run args", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-runner-"));
  const ambRoot = path.join(tmpDir, "amb");
  const binDir = path.join(tmpDir, "bin");
  const memoryDir = path.join(ambRoot, "src", "memory_bench", "memory");
  const datasetDir = path.join(ambRoot, "src", "memory_bench", "dataset");
  const llmDir = path.join(ambRoot, "src", "memory_bench", "llm");
  const runnerPath = path.join(ambRoot, "src", "memory_bench", "runner.py");
  const fakeRemnicRoot = path.join(tmpDir, "remnic");
  const fakeInstallPath = path.join(fakeRemnicRoot, "integrations", "amb", "install.py");
  const observedEnvPath = path.join(tmpDir, "uv-env.json");
  const observedRunArgsPath = path.join(tmpDir, "run-args.json");
  const fakeHome = path.join(tmpDir, "home");
  const fakeCodexPath = path.join(fakeHome, "bin", "codex");
  const fakeUvPath = path.join(binDir, "uv");

  await mkdir(memoryDir, { recursive: true });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(llmDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.dirname(fakeCodexPath), { recursive: true });
  await mkdir(path.dirname(fakeInstallPath), { recursive: true });
  await mkdir(path.join(fakeRemnicRoot, "packages", "remnic-core", "dist"), {
    recursive: true,
  });
  await writeFile(path.join(ambRoot, "pyproject.toml"), "[project]\nname = 'fake-amb'\n");
  await writeFile(path.join(fakeRemnicRoot, "packages", "remnic-core", "dist", "index.js"), "");
  await writeFile(
    fakeInstallPath,
    [
      "import argparse",
      "",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--amb', required=True)",
      "parser.parse_args()",
      "",
    ].join("\n"),
  );
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
      "omb.write_text(\"\"\"#!/usr/bin/env python3\\nimport json, os, pathlib, sys\\nargs = sys.argv[1:]\\nif args == ['providers']:\\n    pathlib.Path(os.environ['OBSERVED_ENV_PATH']).write_text(json.dumps({\\n        'OMB_ANSWER_LLM': os.environ.get('OMB_ANSWER_LLM'),\\n        'OMB_JUDGE_LLM': os.environ.get('OMB_JUDGE_LLM'),\\n        'OMB_ANSWER_MODEL': os.environ.get('OMB_ANSWER_MODEL'),\\n        'OMB_JUDGE_MODEL': os.environ.get('OMB_JUDGE_MODEL'),\\n        'REMNIC_AMB_FORCE_CODEX_LLM': os.environ.get('REMNIC_AMB_FORCE_CODEX_LLM'),\\n        'REMNIC_AMB_CODEX_BIN': os.environ.get('REMNIC_AMB_CODEX_BIN'),\\n        'REMNIC_AMB_NODE': os.environ.get('REMNIC_AMB_NODE'),\\n        'REMNIC_REPO': os.environ.get('REMNIC_REPO'),\\n        'GEMINI_API_KEY': os.environ.get('GEMINI_API_KEY'),\\n        'GOOGLE_API_KEY': os.environ.get('GOOGLE_API_KEY'),\\n    }))\\n    raise SystemExit(0)\\nif args == ['run', '--help']:\\n    print('--split')\\n    raise SystemExit(0)\\nif args and args[0] == 'run':\\n    pathlib.Path(os.environ['OBSERVED_RUN_ARGS_PATH']).write_text(json.dumps(args))\\n    raise SystemExit(0)\\nraise AssertionError(sys.argv)\\n\"\"\")",
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
    cwd: fakeRemnicRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      REMNIC_AMB_CODEX_BIN: "~/bin/codex",
      REMNIC_AMB_NODE: "./relative-node/bin/node",
      REMNIC_REPO: ".",
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
  assert.equal(observed.REMNIC_AMB_NODE, path.join(realpathSync(fakeRemnicRoot), "relative-node", "bin", "node"));
  assert.equal(observed.REMNIC_REPO, realpathSync(fakeRemnicRoot));
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

test("AMB runner rejects passthrough arguments for SOTA verification", async () => {
  for (const flag of [
    "--help",
    "-h",
    "--show-raw",
    "--skip-answer",
    "--skip-ingestion",
    "--skip-retrieval",
    "--skip-ingested",
    "--only-failed",
    "--retrieve-only",
    "--oracle",
    "--query-id",
    "--category=travel",
    "-c",
    "-c=travel",
    "-ctravel",
    "-cprefs",
    "--dataset",
    "--dataset=tempo",
    "--doc-limit",
    "--memory",
    "--memory=bm25",
    "-m",
    "-m=bm25",
    "-mbm25",
    "--mode",
    "--mode=agent",
    "--name",
    "--name=other",
    "-n",
    "-n=other",
    "-nother",
    "--output-dir",
    "--output-dir=remnic-amb-smoke",
    "-o",
    "-o=remnic-amb-smoke",
    "-oremnic-amb-smoke",
    "--query-limit",
    "--query-limit=20",
    "-q",
    "-q=20",
    "-q20",
    "--split",
    "--split=32k",
    "-s",
    "-s=32k",
    "-s32k",
    "--domain",
    "--domain=32k",
    "--llm",
    "--llm=gemini",
    "--description",
    "--description=other",
    "-d",
    "-d=other",
    "-dother",
  ]) {
    const result = spawnSync("bash", [
      path.resolve("scripts", "bench", "run-amb-remnic.sh"),
      "--amb",
      "missing-amb-checkout",
      "--verify-sota",
      "--min-queries",
      "100",
      "--",
      flag,
    ], {
      encoding: "utf8",
    });

    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`--verify-sota cannot be combined with AMB passthrough argument: ${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    assert.doesNotMatch(result.stderr, /Agent Memory Benchmark checkout/);
  }
});

test("AMB runner rejects query-limited SOTA verification", async () => {
  const result = spawnSync("bash", [
    path.resolve("scripts", "bench", "run-amb-remnic.sh"),
    "--amb",
    "missing-amb-checkout",
    "--verify-sota",
    "--min-queries",
    "100",
    "--query-limit",
    "20",
  ], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /--verify-sota cannot be combined with --query-limit/,
  );
  assert.doesNotMatch(result.stderr, /Agent Memory Benchmark checkout/);
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
  assert.equal(result.raw_response.stats.totalMessages, 2);
  assert.equal(result.raw_response.returnedDocuments, 1);
  assert.equal(result.raw_response.memories.length, 1);
  assert.match(result.raw_response.memories[0].content, /May 20/);
  assert.equal(Object.hasOwn(result.raw_response, "context"), false);
  assert.equal(result.documents.length, 1);
  assert.match(result.documents[0].content, /Query timestamp: 2026-05-13T00:00:00\.000Z/);
  assert.match(result.documents[0].content, /Session scope: amb:u1/);
  assert.match(result.documents[0].content, /AMB system context/);
  assert.match(result.documents[0].content, /Current user persona: Name: Kanoa Manu/);
  assert.match(result.documents[0].content, /May 20/);
});

test("AMB helper returns no documents when recall has no evidence", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-helper-empty-"));
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  const retrieved = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_REPO: repoRoot,
    },
    input: JSON.stringify({
      command: "retrieve",
      storeDir,
      query: [
        "Which activity best matches the user's preference?",
        "",
        "(a) Board games",
        "(b) Charades",
        "(c) Trivia",
        "(d) Costume party",
      ].join("\n"),
      k: 3,
      userId: "u1",
      queryTimestamp: "2026-05-13T00:00:00Z",
    }),
  });

  assert.equal(retrieved.status, 0, retrieved.stderr);
  const result = JSON.parse(retrieved.stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(result.documents, []);
  assert.equal(result.raw_response.returnedDocuments, 0);
  assert.equal(result.raw_response.searchHits, 0);
  assert.deepEqual(result.raw_response.memories, []);
  assert.match(result.raw_response.retrievalContext, /Query timestamp: 2026-05-13T00:00:00\.000Z/);
});

test("AMB helper expands tilde in REMNIC_REPO", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async (t) => {
  assert.ok(helperNode);
  const homeRelativeRepo = path.relative(os.homedir(), repoRoot);
  if (homeRelativeRepo.startsWith("..") || path.isAbsolute(homeRelativeRepo)) {
    t.skip("repository is not under the home directory");
    return;
  }

  const storeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-helper-tilde-"));
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_REPO: path.join("~", homeRelativeRepo),
    },
    input: JSON.stringify({
      command: "retrieve",
      storeDir,
      query: "What has the user mentioned?",
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.documents, []);
});

test("AMB helper passes AMB timestamps to replay sourceValidAt", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-source-valid-at-"));
  const fakeRemnicRoot = path.join(tmpDir, "remnic");
  const fakeCorePath = path.join(fakeRemnicRoot, "packages", "remnic-core", "dist", "index.js");
  const replayTurnsPath = path.join(tmpDir, "replay-turns.json");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await mkdir(path.dirname(fakeCorePath), { recursive: true });
  await writeFile(path.join(fakeRemnicRoot, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    fakeCorePath,
    [
      "import { writeFileSync } from 'node:fs';",
      "export function parseConfig(config) { return config; }",
      "export function buildEvidencePack() { return ''; }",
      "export async function buildExplicitCueRecallSection() { return ''; }",
      "export function collectExplicitTurnReferences() { return []; }",
      "let observedTurns = [];",
      "export class Orchestrator {",
      "  constructor(config) {",
      "    this.config = config;",
      "    this.lcmEngine = { waitForObserveQueueIdle: async () => {}, close() {} };",
      "  }",
      "  async initialize() {}",
      "  async ingestReplayBatch(turns) {",
      "    observedTurns = observedTurns.concat(turns);",
      "    writeFileSync(process.env.REPLAY_TURNS_PATH, JSON.stringify(observedTurns));",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_REPO: fakeRemnicRoot,
      REPLAY_TURNS_PATH: replayTurnsPath,
    },
    input: JSON.stringify({
      command: "ingest",
      storeDir: path.join(tmpDir, "store"),
      documents: [
        {
          id: "structured",
          user_id: "u1",
          timestamp: "2025-01-01T00:00:00Z",
          messages: [
            {
              role: "user",
              content: "I used to prefer tea.",
              timestamp: "2025-01-02T03:04:05Z",
            },
            {
              role: "assistant",
              content: "Noted.",
            },
          ],
        },
        {
          id: "content-only",
          user_id: "u1",
          content: "Now I prefer coffee.",
          timestamp: "2025-02-03T00:00:00Z",
        },
      ],
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const turns = JSON.parse(await readFile(replayTurnsPath, "utf8"));
  assert.deepEqual(turns.map((turn: { sourceValidAt?: string }) => turn.sourceValidAt), [
    "2025-01-02T03:04:05.000Z",
    "2025-01-01T00:00:00.000Z",
    "2025-02-03T00:00:00.000Z",
  ]);
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
  const fakeCodexPath = path.join(tmpDir, "bin", "fake-codex");
  const fakeCodexArgsPath = path.join(tmpDir, "fake-codex-args.json");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await mkdir(path.dirname(fakeCodexPath), { recursive: true });
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
      HOME: tmpDir,
      REMNIC_REPO: repoRoot,
      REMNIC_AMB_CODEX_BIN: "bin/fake-codex",
      FAKE_CODEX_ARGS: fakeCodexArgsPath,
    },
    cwd: tmpDir,
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

test("AMB helper preserves explicit-cue evidence for direct-answer prompts", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-codex-explicit-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "bin", "fake-codex");
  const fakeCodexPromptPath = path.join(tmpDir, "fake-codex-prompt.txt");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    FAKE_CODEX_PROMPT: fakeCodexPromptPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await mkdir(path.dirname(fakeCodexPath), { recursive: true });
  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env python3",
      "import json, os, pathlib, sys",
      "prompt = sys.stdin.read()",
      "pathlib.Path(os.environ['FAKE_CODEX_PROMPT']).write_text(prompt)",
      "assert '## Explicit Cue Evidence' in prompt",
      "assert 'Remember the launch review is May 20.' in prompt",
      "output = pathlib.Path(sys.argv[sys.argv.index('--output-last-message') + 1])",
      "output.write_text(json.dumps({'answer': 'The launch review is May 20.'}))",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "explicit-turn",
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

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: "What did I say in turn 1 about the launch review?",
      userId: "u1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "The launch review is May 20.");
  assert.match(await readFile(fakeCodexPromptPath, "utf8"), /## Explicit Cue Evidence/);
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
    REMNIC_AMB_NATIVE_ONLY_DIRECT_ANSWER: "1",
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

test("AMB helper keeps MCQ-like retrieved memory evidence for native ranking", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-native-mcq-evidence-lines-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
    REMNIC_AMB_NATIVE_ONLY_DIRECT_ANSWER: "1",
  };

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const checklistEvidence = Array.from({ length: 12 }, () => [
    "My saved game-night checklist said:",
    "(a) Costume party felt like too much planning.",
    "(b) Social games like charades brought laughter, helped everyone bond, and made the fun-filled game night memorable.",
    "(c) Board games were less lively.",
    "(d) Trivia challenge felt too competitive.",
  ].join("\n")).join("\n\n");

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "game-night-checklist",
          content: checklistEvidence,
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
  assert.match(payload.context, /\(b\) Social games like charades/);
  assert.equal(payload.raw_response.answerModel, "remnic-native-mcq-evidence-ranker");
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
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env python3",
      "import json, pathlib, sys",
      "args = sys.argv[1:]",
      "prompt = sys.stdin.read()",
      "assert 'return only the option letter' in prompt",
      "assert '(a) Costume party' in prompt and '(b) Social games like charades' in prompt",
      "output = pathlib.Path(args[args.index('--output-last-message') + 1])",
      "output.write_text(json.dumps({'answer': 'Answer: (b)'}))",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "social-night",
          content: Array.from({ length: 12 }, () =>
            "Social games like charades brought laughter, helped everyone bond, and made the fun-filled game night memorable.",
          ).join(" "),
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
  assert.equal(payload.raw_response.answerModel, "codex:gpt-5.5:xhigh:fast");
});

test("AMB helper rejects explanatory MCQ direct answers without an option marker", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-codex-mcq-invalid-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");
  const env = {
    ...process.env,
    REMNIC_REPO: repoRoot,
    REMNIC_AMB_CODEX_BIN: fakeCodexPath,
    REMNIC_AMB_EXTRACTION_DEADLINE_MS: "300000",
  };

  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env python3",
      "import json, pathlib, sys",
      "args = sys.argv[1:]",
      "output = pathlib.Path(args[args.index('--output-last-message') + 1])",
      "output.write_text(json.dumps({'answer': 'Based on the memories, charades is best.'}))",
      "",
    ].join("\n"),
  );
  await chmod(fakeCodexPath, 0o755);

  const ingest = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      command: "ingest",
      storeDir,
      documents: [
        {
          id: "social-night",
          content: Array.from({ length: 12 }, () =>
            "Social games like charades brought laughter, helped everyone bond, and made the fun-filled game night memorable.",
          ).join(" "),
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
  assert.equal(payload.answer, "");
  assert.equal(payload.raw_response.answerModel, "codex:gpt-5.5:xhigh:fast");
  assert.match(payload.raw_response.answerError, /invalid multiple-choice answer/);
});

test("AMB helper records unsupported MCQ fallback errors despite adjacent memories", {
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
    REMNIC_AMB_CODEX_TIMEOUT_MS: "12abc",
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
  assert.equal(payload.answer, "");
  assert.match(payload.raw_response.answerError, /REMNIC_AMB_CODEX_TIMEOUT_MS must be a positive integer/);
});

test("AMB helper returns empty MCQ direct-answer before Codex when no evidence is retrieved", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-mcq-no-fallback-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
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
        "Which activity best matches the user's preference?",
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
  assert.equal(payload.answer, "");
  assert.equal(payload.context, "");
  assert.equal(payload.raw_response.answerModel, "remnic-no-evidence-mcq-guard");
  assert.match(payload.raw_response.answerError, /no retrieved memory evidence/i);
});

test("AMB helper fails native-only MCQ direct-answer without evidence support", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-native-only-no-evidence-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\necho should-not-call-codex >&2\nexit 23\n");
  await chmod(fakeCodexPath, 0o755);

  const result = spawnSync(helperNode, [helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_REPO: repoRoot,
      REMNIC_AMB_CODEX_BIN: fakeCodexPath,
      REMNIC_AMB_NATIVE_ONLY_DIRECT_ANSWER: "1",
    },
    input: JSON.stringify({
      command: "direct_answer",
      storeDir,
      query: [
        "Which activity best matches the user's preference?",
        "",
        "(a) Board games",
        "(b) Charades",
        "(c) Trivia",
        "(d) Costume party",
      ].join("\n"),
      userId: "u1",
    }),
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no evidence-backed multiple-choice answer/i);
  assert.doesNotMatch(result.stderr, /should-not-call-codex/);
});

test("AMB helper does not satisfy MCQ answer from query text alone", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-task-rule-no-memory-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
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
  assert.equal(payload.answer, "");
  assert.equal(payload.context, "");
  assert.equal(payload.raw_response.answerModel, "remnic-no-evidence-mcq-guard");
  assert.match(payload.raw_response.answerError, /no retrieved memory evidence/i);
});

test("AMB helper does not satisfy health-event MCQ from query text alone", {
  skip:
    existsSync(builtCoreEntry) && helperNode
      ? false
      : "built @remnic/core dist and a Node 22 runtime are required",
}, async () => {
  assert.ok(helperNode);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-health-event-no-memory-"));
  const storeDir = path.join(tmpDir, "store");
  const fakeCodexPath = path.join(tmpDir, "fake-codex");
  const helperPath = path.join(repoRoot, "integrations", "amb", "remnic-amb-provider.mjs");

  await writeFile(fakeCodexPath, "#!/usr/bin/env sh\nexit 23\n");
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
  assert.equal(payload.answer, "");
  assert.equal(payload.context, "");
  assert.equal(payload.raw_response.answerModel, "remnic-no-evidence-mcq-guard");
  assert.match(payload.raw_response.answerError, /no retrieved memory evidence/i);
});

test("AMB SOTA verifier compares Remnic result against external best", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-amb-sota-"));
  const externalPath = path.join(tmpDir, "external_results.json");
  const nullResultPath = path.join(tmpDir, "null-result.json");
  const losingPath = path.join(tmpDir, "losing-result.json");
  const spoofedProviderPath = path.join(tmpDir, "spoofed-provider-result.json");
  const missingLlmPath = path.join(tmpDir, "missing-llm-result.json");
  const nonCodexLlmPath = path.join(tmpDir, "non-codex-llm-result.json");
  const percentageAccuracyPath = path.join(tmpDir, "percentage-accuracy-result.json");
  const inconsistentAccuracyPath = path.join(tmpDir, "inconsistent-accuracy-result.json");
  const aggregateWinningPath = path.join(tmpDir, "aggregate-winning-result.json");
  const agentFailedPath = path.join(tmpDir, "agent-failed-result.json");
  const agentTopLevelFailedPath = path.join(tmpDir, "agent-top-level-failed-result.json");
  const agentWinningPath = path.join(tmpDir, "agent-winning-result.json");
  const artifactWinningPath = path.join(tmpDir, "artifact-winning-result.json");
  const artifactRejectedProvenancePath = path.join(tmpDir, "artifact-rejected-provenance-result.json");
  const overfilledPath = path.join(tmpDir, "overfilled-result.json");
  const winningPath = path.join(tmpDir, "winning-result.json");
  const oraclePath = path.join(tmpDir, "oracle-result.json");
  const agentManifestPath = path.join(tmpDir, "agent-winning-manifest.json");
  const artifactManifestPath = path.join(tmpDir, "artifact-winning-manifest.json");
  const manifestPath = path.join(tmpDir, "winning-manifest.json");
  const cleanAmbRepo = path.join(tmpDir, "clean-amb-repo");
  const dirtyAmbRepo = path.join(tmpDir, "dirty-amb-repo");
  const patchedAmbRepo = path.join(tmpDir, "patched-amb-repo");
  const scoringPatchedAmbRepo = path.join(tmpDir, "scoring-patched-amb-repo");
  const nonGitAmbRepo = path.join(tmpDir, "non-git-amb-repo");
  const patchedManifestPath = path.join(tmpDir, "patched-winning-manifest.json");
  const verifier = path.join(repoRoot, "scripts", "bench", "verify-amb-sota.mjs");

  await initCleanGitRepo(cleanAmbRepo);
  await initCleanGitRepo(dirtyAmbRepo);
  await initCleanGitRepo(patchedAmbRepo);
  await initCleanGitRepo(scoringPatchedAmbRepo);
  const dirtyAmbCommit = gitOutput(dirtyAmbRepo, ["rev-parse", "HEAD"]);
  const patchedAmbCommit = gitOutput(patchedAmbRepo, ["rev-parse", "HEAD"]);
  const scoringPatchedAmbCommit = gitOutput(scoringPatchedAmbRepo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(dirtyAmbRepo, "untracked.txt"), "dirty\n");
  await mkdir(path.join(patchedAmbRepo, "src", "memory_bench", "memory"), { recursive: true });
  await mkdir(path.join(patchedAmbRepo, "src", "memory_bench", "llm"), { recursive: true });
  await writeFile(path.join(patchedAmbRepo, "src", "memory_bench", "memory", "remnic.py"), "patched\n");
  await writeFile(path.join(patchedAmbRepo, "src", "memory_bench", "llm", "codex.py"), "patched\n");
  await mkdir(path.join(scoringPatchedAmbRepo, "src", "memory_bench"), { recursive: true });
  await writeFile(path.join(scoringPatchedAmbRepo, "src", "memory_bench", "judge.py"), "score inflation\n");
  await mkdir(nonGitAmbRepo, { recursive: true });

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
  await writeFile(nullResultPath, "null");
  await writeFile(
    losingPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      total_queries: 100,
      accuracy: 0.52,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
    }),
  );
  await writeFile(
    spoofedProviderPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "bm25",
      run_name: "remnic-smoke",
      total_queries: 100,
      accuracy: 1,
    }),
  );
  await writeFile(
    missingLlmPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      mode: "rag",
      total_queries: 100,
      accuracy: 1,
    }),
  );
  await writeFile(
    nonCodexLlmPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      total_queries: 100,
      accuracy: 1,
      answer_llm: "openai:gpt-4o",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
    }),
  );
  await writeFile(
    percentageAccuracyPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      total_queries: 100,
      accuracy: 60.8,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
    }),
  );
  await writeFile(
    inconsistentAccuracyPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      total_queries: 100,
      correct: 52,
      accuracy: 0.521,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
    }),
  );
  await writeFile(
    aggregateWinningPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic-aggregate-only",
      mode: "rag",
      total_queries: 100,
      correct: 53,
      accuracy: 0.53,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
    }),
  );
  await writeFile(
    agentWinningPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic-agent",
      mode: "agent",
      total_queries: 2,
      correct: 2,
      accuracy: 1,
      judge_llm: "codex:gpt-5.5:xhigh:fast",
      results: [
        { raw_response: { answerModel: "codex:gpt-5.5:xhigh:fast" } },
        { raw_response: { answerModel: "codex:gpt-5.5:xhigh:fast" } },
      ],
    }),
  );
  await writeFile(
    agentFailedPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic-agent-failed",
      mode: "agent",
      total_queries: 2,
      correct: 2,
      accuracy: 1,
      judge_llm: "codex:gpt-5.5:xhigh:fast",
      results: [
        {
          raw_response: {
            answerModel: "codex:gpt-5.5:xhigh:fast",
            answerError: "Codex CLI direct_answer failed: timed out after 300000ms",
          },
        },
        {
          raw_response: {
            answerModel: "codex:gpt-5.5:xhigh:fast",
            answerError: null,
          },
        },
      ],
    }),
  );
  await writeFile(
    agentTopLevelFailedPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic-agent-top-level-failed",
      mode: "agent",
      total_queries: 2,
      correct: 2,
      accuracy: 1,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
      results: [
        {
          raw_response: {
            answerModel: "codex:gpt-5.5:xhigh:fast",
            answerError: "Codex CLI direct_answer failed: invalid multiple-choice answer",
          },
        },
        {
          raw_response: {
            answerModel: "codex:gpt-5.5:xhigh:fast",
            answerError: null,
          },
        },
      ],
    }),
  );
  await writeFile(
    artifactWinningPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memoryProvider: "remnic",
      runName: "remnic-agent-artifact",
      mode: "agent",
      totalQueries: 2,
      correct: 2,
      ingestedDocs: 7,
      accuracy: 1,
      results: [
        { correct: true },
        { correct: true },
      ],
      llm: {
        answerLlm: "codex:gpt-5.5:xhigh:fast",
        judgeLlm: "codex:gpt-5.5:xhigh:fast",
      },
    }),
  );
  await writeFile(
    artifactRejectedProvenancePath,
    JSON.stringify({
      schemaVersion: 1,
      dataset: "personamem",
      split: "128k",
      memoryProvider: "remnic",
      runName: "remnic-agent-rejected-provenance",
      mode: "agent",
      totalQueries: 2,
      correct: 2,
      accuracy: 1,
      provenanceVerified: false,
      llm: {
        answerLlm: "codex:gpt-5.5:xhigh:fast",
        judgeLlm: "codex:gpt-5.5:xhigh:fast",
      },
      verification: {
        status: "rejected_dirty_provenance",
        reason: "Original verification rejected dirty provenance.",
      },
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
      accuracy: 0.53,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
      results: Array.from({ length: 100 }, (_, index) => ({
        query_id: `q${index + 1}`,
        correct: index < 53,
      })),
    }),
  );
  await writeFile(
    overfilledPath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      mode: "rag",
      total_queries: 101,
      correct: 54,
      accuracy: 0.535,
      answer_llm: "codex:gpt-5.5:xhigh:fast",
      judge_llm: "codex:gpt-5.5:xhigh:fast",
    }),
  );
  await writeFile(
    oraclePath,
    JSON.stringify({
      dataset: "personamem",
      split: "128k",
      memory_provider: "remnic",
      run_name: "remnic",
      oracle: true,
      total_queries: 100,
      correct: 100,
      accuracy: 1,
    }),
  );

  const noFloor = spawnSync(process.execPath, [
    verifier,
    "--result",
    winningPath,
    "--external-results",
    externalPath,
  ], {
    encoding: "utf8",
  });
  assert.equal(noFloor.status, 2);
  assert.match(noFloor.stderr, /--min-queries is required/);

  const nullResult = spawnSync(process.execPath, [
    verifier,
    "--result",
    nullResultPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(nullResult.status, 2);
  assert.match(nullResult.stderr, /AMB result must be a JSON object/);

  const spoofedProvider = spawnSync(process.execPath, [
    verifier,
    "--result",
    spoofedProviderPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(spoofedProvider.status, 2);
  assert.match(spoofedProvider.stderr, /result\.memory_provider must be "remnic"/);
  assert.equal(spoofedProvider.stdout, "");

  const missingLlm = spawnSync(process.execPath, [
    verifier,
    "--result",
    missingLlmPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(missingLlm.status, 2);
  assert.match(missingLlm.stderr, /result\.answer_llm must be "codex:gpt-5\.5:xhigh:fast"/);
  assert.equal(missingLlm.stdout, "");

  const nonCodexLlm = spawnSync(process.execPath, [
    verifier,
    "--result",
    nonCodexLlmPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(nonCodexLlm.status, 2);
  assert.match(nonCodexLlm.stderr, /result\.answer_llm must be "codex:gpt-5\.5:xhigh:fast"/);
  assert.equal(nonCodexLlm.stdout, "");

  const percentageAccuracy = spawnSync(process.execPath, [
    verifier,
    "--result",
    percentageAccuracyPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(percentageAccuracy.status, 2);
  assert.match(percentageAccuracy.stderr, /result\.accuracy must be a fraction between 0 and 1/);
  assert.equal(percentageAccuracy.stdout, "");

  const inconsistentAccuracy = spawnSync(process.execPath, [
    verifier,
    "--result",
    inconsistentAccuracyPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(inconsistentAccuracy.status, 2);
  assert.match(inconsistentAccuracy.stderr, /result\.accuracy is inconsistent with result\.correct \/ result\.total_queries/);
  assert.equal(inconsistentAccuracy.stdout, "");

  const aggregateWinning = spawnSync(process.execPath, [
    verifier,
    "--result",
    aggregateWinningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(aggregateWinning.status, 2);
  assert.match(aggregateWinning.stderr, /result\.results must contain exactly result\.total_queries entries/);
  assert.equal(aggregateWinning.stdout, "");

  const agentFailed = spawnSync(process.execPath, [
    verifier,
    "--result",
    agentFailedPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "2",
    "--amb-dir",
    cleanAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(agentFailed.status, 2);
  assert.match(agentFailed.stderr, /agent-mode result\.raw_response\.answerError must be empty/);
  assert.equal(agentFailed.stdout, "");

  const agentTopLevelFailed = spawnSync(process.execPath, [
    verifier,
    "--result",
    agentTopLevelFailedPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "2",
    "--amb-dir",
    cleanAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(agentTopLevelFailed.status, 2);
  assert.match(agentTopLevelFailed.stderr, /agent-mode result\.raw_response\.answerError must be empty/);
  assert.equal(agentTopLevelFailed.stdout, "");

  const agentWinning = spawnSync(process.execPath, [
    verifier,
    "--result",
    agentWinningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "2",
    "--manifest-out",
    agentManifestPath,
    "--amb-dir",
    cleanAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(agentWinning.status, 0, agentWinning.stderr);
  const agentVerdict = JSON.parse(agentWinning.stdout);
  assert.equal(agentVerdict.sota, true);
  assert.equal(agentVerdict.answerLlm, "codex:gpt-5.5:xhigh:fast");
  assert.equal(agentVerdict.judgeLlm, "codex:gpt-5.5:xhigh:fast");
  const agentManifest = JSON.parse(await readFile(agentManifestPath, "utf8"));
  assert.equal(agentManifest.run.answerLlm, "codex:gpt-5.5:xhigh:fast");
  assert.equal(agentManifest.run.judgeLlm, "codex:gpt-5.5:xhigh:fast");
  assert.equal(agentManifest.remnic.repo, "<remnic-repo>");
  assert.equal(agentManifest.amb.repo, "<agent-memory-benchmark-checkout>");
  assert.equal(agentManifest.amb.dirty, false);

  const artifactWinning = spawnSync(process.execPath, [
    verifier,
    "--result",
    artifactWinningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "2",
    "--manifest-out",
    artifactManifestPath,
    "--amb-dir",
    cleanAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(artifactWinning.status, 0, artifactWinning.stderr);
  const artifactVerdict = JSON.parse(artifactWinning.stdout);
  assert.equal(artifactVerdict.sota, true);
  assert.equal(artifactVerdict.answerLlm, "codex:gpt-5.5:xhigh:fast");
  assert.equal(artifactVerdict.judgeLlm, "codex:gpt-5.5:xhigh:fast");
  const artifactManifest = JSON.parse(await readFile(artifactManifestPath, "utf8"));
  assert.equal(artifactManifest.run.memoryProvider, "remnic");
  assert.equal(artifactManifest.run.runName, "remnic-agent-artifact");
  assert.equal(artifactManifest.run.totalQueries, 2);
  assert.equal(artifactManifest.run.ingestedDocs, 7);

  const artifactRejectedProvenance = spawnSync(process.execPath, [
    verifier,
    "--result",
    artifactRejectedProvenancePath,
    "--external-results",
    externalPath,
    "--min-queries",
    "2",
    "--amb-dir",
    cleanAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(artifactRejectedProvenance.status, 2);
  assert.match(artifactRejectedProvenance.stderr, /result\.provenanceVerified must not be false/);
  assert.equal(artifactRejectedProvenance.stdout, "");

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

  const oracle = spawnSync(process.execPath, [
    verifier,
    "--result",
    oraclePath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
  ], {
    encoding: "utf8",
  });
  assert.equal(oracle.status, 2);
  assert.match(oracle.stderr, /oracle-aided AMB runs cannot be verified for SOTA/);
  assert.equal(oracle.stdout, "");

  const overfilled = spawnSync(process.execPath, [
    verifier,
    "--result",
    overfilledPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
    "--amb-dir",
    cleanAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(overfilled.status, 1);
  assert.match(overfilled.stderr, /result has 101 queries, expected exactly --min-queries 100/);
  assert.equal(overfilled.stdout, "");

  const missingAmbProvenance = spawnSync(process.execPath, [
    verifier,
    "--result",
    winningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
    "--amb-dir",
    nonGitAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(missingAmbProvenance.status, 2);
  assert.match(missingAmbProvenance.stderr, /AMB checkout provenance is missing a git commit/);
  assert.equal(missingAmbProvenance.stdout, "");

  const dirtyAmbProvenance = spawnSync(process.execPath, [
    verifier,
    "--result",
    winningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
    "--amb-dir",
    dirtyAmbRepo,
  ], {
    encoding: "utf8",
  });
  assert.equal(dirtyAmbProvenance.status, 2);
  assert.match(dirtyAmbProvenance.stderr, /AMB checkout provenance is dirty or unavailable/);
  assert.equal(dirtyAmbProvenance.stdout, "");

  const dirtyAllowedAmbProvenance = spawnSync(process.execPath, [
    verifier,
    "--result",
    winningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
    "--amb-dir",
    dirtyAmbRepo,
    "--allow-remnic-amb-patches",
    "--amb-expected-commit",
    dirtyAmbCommit,
  ], {
    encoding: "utf8",
  });
  assert.equal(dirtyAllowedAmbProvenance.status, 2);
  assert.match(dirtyAllowedAmbProvenance.stderr, /unexpected changes: untracked\.txt/);
  assert.equal(dirtyAllowedAmbProvenance.stdout, "");

  const patchedAmbProvenance = spawnSync(process.execPath, [
    verifier,
    "--result",
    winningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
    "--manifest-out",
    patchedManifestPath,
    "--amb-dir",
    patchedAmbRepo,
    "--allow-remnic-amb-patches",
    "--amb-expected-commit",
    patchedAmbCommit,
  ], {
    encoding: "utf8",
  });
  assert.equal(patchedAmbProvenance.status, 0, patchedAmbProvenance.stderr);
  const patchedManifest = JSON.parse(await readFile(patchedManifestPath, "utf8"));
  assert.equal(patchedManifest.amb.dirty, true);
  assert.equal(patchedManifest.amb.expectedCommit, patchedAmbCommit);
  assert.equal(patchedManifest.amb.acceptedDirtyReason, "remnic_amb_installer_patches");

  const scoringPatchedAmbProvenance = spawnSync(process.execPath, [
    verifier,
    "--result",
    winningPath,
    "--external-results",
    externalPath,
    "--min-queries",
    "100",
    "--amb-dir",
    scoringPatchedAmbRepo,
    "--allow-remnic-amb-patches",
    "--amb-expected-commit",
    scoringPatchedAmbCommit,
  ], {
    encoding: "utf8",
  });
  assert.equal(scoringPatchedAmbProvenance.status, 2);
  assert.match(scoringPatchedAmbProvenance.stderr, /unexpected changes: src\/memory_bench\/judge\.py/);
  assert.equal(scoringPatchedAmbProvenance.stdout, "");

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
    cleanAmbRepo,
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
  assert.equal(manifest.remnic.repo, "<remnic-repo>");
  assert.equal(manifest.remnic.dirty, false);
  assert.equal(manifest.amb.repo, "<agent-memory-benchmark-checkout>");
  assert.equal(manifest.amb.dirty, false);
  const serializedManifest = JSON.stringify(manifest);
  assert.doesNotMatch(serializedManifest, new RegExp(cleanAmbRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serializedManifest, new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serializedManifest, /\/Users\//);
  assert.doesNotMatch(serializedManifest, /\/opt\/homebrew/);
});

async function initCleanGitRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  runGit(repoDir, ["init"]);
  runGit(repoDir, [
    "-c",
    "user.email=remnic-tests@example.invalid",
    "-c",
    "user.name=Remnic Tests",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
}

function runGit(repoDir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function gitOutput(repoDir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

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
