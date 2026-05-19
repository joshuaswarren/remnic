import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  patchAmbCli,
  patchAmbLlmRegistry,
  patchAmbMemoryRegistry,
} from "./install-remnic-provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createAmbFixture() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-amb-check-test-"));
  await mkdir(path.join(tempDir, "src", "memory_bench", "memory"), { recursive: true });
  await mkdir(path.join(tempDir, "src", "memory_bench", "llm"), { recursive: true });
  await mkdir(path.join(tempDir, "src", "memory_bench", "modes"), { recursive: true });
  await writeFile(path.join(tempDir, "pyproject.toml"), "[project]\nname = \"agent-memory-benchmark\"\n");
  await writeFile(
    path.join(tempDir, "src", "memory_bench", "memory", "__init__.py"),
    "from .base import MemoryProvider\nfrom .bm25 import BM25MemoryProvider\nREGISTRY = {\"bm25\": BM25MemoryProvider}\n",
  );
  await writeFile(
    path.join(tempDir, "src", "memory_bench", "llm", "__init__.py"),
    "import os\nfrom .base import LLM, Schema\nfrom .gemini import GeminiLLM\nREGISTRY = {\"gemini\": GeminiLLM}\n",
  );
  await writeFile(
    path.join(tempDir, "src", "memory_bench", "modes", "__init__.py"),
    "from .rag import RAGMode\nREGISTRY = {\"rag\": RAGMode}\n",
  );
  await writeFile(
    path.join(tempDir, "src", "memory_bench", "cli.py"),
    [
      "import os",
      "import typer",
      "def _resolve_gemini_key() -> None:",
      "    key = os.environ.get(\"GEMINI_API_KEY\") or os.environ.get(\"GOOGLE_API_KEY\")",
      "    if not key:",
      "        typer.echo(\"Error\", err=True)",
      "        raise typer.Exit(1)",
      "    os.environ[\"GOOGLE_API_KEY\"] = key",
      "def run(llm: str):",
      "    _resolve_gemini_key()",
      "    ds = get_dataset(dataset)",
      "",
    ].join("\n"),
  );
  return tempDir;
}

function runAmbPreflight(ambDir, env) {
  return spawnSync(
    process.execPath,
    [path.join(__dirname, "check-remnic-run.mjs"), ambDir],
    {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
      },
    },
  );
}

function commandExists(command) {
  return spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
    encoding: "utf8",
  }).status === 0;
}

const codexCliAvailable = commandExists(
  process.env.OMB_CODEX_EXECUTABLE ||
    process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE ||
    "codex",
);
const uvAvailable = commandExists("uv");
const requireCodexCli = {
  skip: codexCliAvailable && uvAvailable ? false : "codex CLI and uv are required",
};

test("installRemnicProvider exposes provider files before registry patches", () => {
  const source = readFileSync(
    path.join(__dirname, "install-remnic-provider.mjs"),
    "utf8",
  );
  const providerRename = source.indexOf("await rename(providerTemp, providerTarget)");
  const registryWrite = source.indexOf("await writeFile(registryPath, patchedRegistry)");
  const codexLlmRename = source.indexOf(
    "await rename(codexLlmTemp, codexLlmTarget)",
  );
  const llmRegistryWrite = source.indexOf(
    "await writeFile(llmRegistryPath, patchedLlmRegistry)",
  );

  assert.notEqual(providerRename, -1);
  assert.notEqual(registryWrite, -1);
  assert.ok(providerRename < registryWrite);
  assert.notEqual(codexLlmRename, -1);
  assert.notEqual(llmRegistryWrite, -1);
  assert.ok(codexLlmRename < llmRegistryWrite);
});

test("patchAmbMemoryRegistry handles compact single-line registries", () => {
  const compactRegistry =
    "from .base import MemoryProvider; from .bm25 import BM25MemoryProvider; from .hindsight import HindsightMemoryProvider; REGISTRY: dict[str, type[MemoryProvider]] = {\"bm25\": BM25MemoryProvider, \"hindsight\": HindsightMemoryProvider}; def get_memory_provider(name: str) -> MemoryProvider: raise ValueError(f\"Unknown memory provider: '{name}'. Available: {list(REGISTRY)}\")";

  const patched = patchAmbMemoryRegistry(compactRegistry);

  assert.match(patched, /from \.remnic import RemnicMemoryProvider/);
  assert.match(patched, /["']remnic["']:\s*RemnicMemoryProvider/);
  assert.match(
    patched,
    /from \.remnic import RemnicMemoryProvider\nREGISTRY/,
    "Remnic import should remain on its own physical line before REGISTRY",
  );
  assert.ok(
    patched.indexOf("from .remnic import RemnicMemoryProvider") <
      patched.indexOf("REGISTRY"),
    "Remnic import should be inserted before the registry object",
  );
  assert.ok(
    patched.indexOf('"remnic": RemnicMemoryProvider') <
      patched.indexOf('"bm25": BM25MemoryProvider'),
    "Remnic registry entry should be inserted at the start of REGISTRY",
  );
  assert.match(
    patched,
    /def get_memory_provider\(name: str\) -> MemoryProvider:/,
    "the registry patch must not insert text inside the provider function",
  );
});

test("patchAmbMemoryRegistry remains idempotent for existing Remnic entries", () => {
  const registry = `from .base import MemoryProvider
from .bm25 import BM25MemoryProvider
from .remnic import RemnicMemoryProvider

REGISTRY: dict[str, type[MemoryProvider]] = {
    "remnic": RemnicMemoryProvider,
    "bm25": BM25MemoryProvider,
}
`;

  const patched = patchAmbMemoryRegistry(registry);

  assert.equal(
    patched.match(/from \.remnic import RemnicMemoryProvider/g)?.length,
    1,
  );
  assert.equal(
    patched.match(/["']remnic["']:\s*RemnicMemoryProvider/g)?.length,
    1,
  );
});

test("patchAmbLlmRegistry handles compact single-line registries", () => {
  const compactRegistry =
    "import os; from .base import LLM, Schema; from .gemini import GeminiLLM; from .openai import OpenAILLM; REGISTRY: dict[str, type[LLM]] = {\"gemini\": GeminiLLM, \"openai\": OpenAILLM}; def get_answer_llm() -> LLM: return OpenAILLM()";

  const patched = patchAmbLlmRegistry(compactRegistry);

  assert.match(patched, /from \.codex_cli import CodexCliLLM/);
  assert.match(patched, /["']codex_cli["']:\s*CodexCliLLM/);
  assert.match(
    patched,
    /from \.codex_cli import CodexCliLLM\nREGISTRY/,
    "Codex CLI import should remain on its own physical line before REGISTRY",
  );
  assert.ok(
    patched.indexOf("from .codex_cli import CodexCliLLM") <
      patched.indexOf("REGISTRY"),
    "Codex CLI import should be inserted before the registry object",
  );
  assert.ok(
    patched.indexOf('"codex_cli": CodexCliLLM') <
      patched.indexOf('"gemini": GeminiLLM'),
    "Codex CLI registry entry should be inserted at the start of REGISTRY",
  );
  assert.match(
    patched,
    /def get_answer_llm\(\) -> LLM:/,
    "the registry patch must not insert text inside the LLM function",
  );
});

test("patchAmbLlmRegistry remains idempotent for existing Codex CLI entries", () => {
  const registry = `import os

from .base import LLM, Schema
from .codex_cli import CodexCliLLM
from .gemini import GeminiLLM

REGISTRY: dict[str, type[LLM]] = {
    "codex_cli": CodexCliLLM,
    "gemini": GeminiLLM,
}
`;

  const patched = patchAmbLlmRegistry(registry);

  assert.equal(
    patched.match(/from \.codex_cli import CodexCliLLM/g)?.length,
    1,
  );
  assert.equal(
    patched.match(/["']codex_cli["']:\s*CodexCliLLM/g)?.length,
    1,
  );
});

test("patchAmbCli makes the Gemini key gate provider-aware", () => {
  const cli = `import os
import typer

def _resolve_gemini_key() -> None:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True)
        raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key

def run(llm: str):
    _resolve_gemini_key()

    ds = get_dataset(dataset)
`;

  const patched = patchAmbCli(cli);
  const patchedAgain = patchAmbCli(patched);

  assert.equal(patchedAgain, patched);
  assert.match(patched, /REMNIC_PATCH_CODEX_AWARE_GEMINI_GATE/);
  assert.match(patched, /answer_provider != "gemini" and judge_provider != "gemini"/);
  assert.match(patched, /def _remnic_apply_answer_llm\(llm\) -> None:/);
  assert.match(
    patched,
    /if llm == "gemini" and os\.environ\.get\("OMB_ANSWER_LLM"\):\n\s+return/,
  );
  assert.match(patched, /_remnic_apply_answer_llm\(llm\)\n\s*_resolve_gemini_key\(\)/);
});

test("patchAmbCli preserves env-selected answer LLM when llm keeps the upstream default", () => {
  const cli = `import os
import typer

def _resolve_gemini_key() -> None:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True)
        raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key

def run(llm: str = "gemini"):
    _resolve_gemini_key()
    ds = get_dataset(dataset)
`;

  const patched = patchAmbCli(cli);
  const helper = patched.match(
    /def _remnic_apply_answer_llm\(llm\) -> None:[\s\S]*?(?=\ndef run)/,
  )?.[0];
  assert.ok(helper);

  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import os",
        helper,
        'os.environ["OMB_ANSWER_LLM"] = "codex_cli"',
        '_remnic_apply_answer_llm("gemini")',
        'assert os.environ["OMB_ANSWER_LLM"] == "codex_cli"',
        '_remnic_apply_answer_llm("openai")',
        'assert os.environ["OMB_ANSWER_LLM"] == "openai"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("patchAmbCli handles compact upstream run entrypoints", () => {
  const cli = `import os
import typer

def _resolve_gemini_key() -> None:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key: typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True); raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key
@app.command()
def run(llm: str): _resolve_gemini_key(); ds = get_dataset(dataset)
`;

  const patched = patchAmbCli(cli);
  const patchedAgain = patchAmbCli(patched);

  assert.equal(patchedAgain, patched);
  assert.match(patched, /REMNIC_PATCH_CODEX_AWARE_GEMINI_GATE/);
  assert.match(patched, /answer_provider != "gemini" and judge_provider != "gemini"/);
  assert.match(
    patched,
    /_remnic_apply_answer_llm\(llm\); _resolve_gemini_key\(\); ds = get_dataset\(dataset\)/,
  );
});

test("patchAmbCli rewrites legacy answer LLM assignments before the Gemini gate", () => {
  const cli = `import os
import typer

def _resolve_gemini_key() -> None:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True)
        raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key

def run(llm: str):
    os.environ["OMB_ANSWER_LLM"] = llm
    _resolve_gemini_key()

    ds = get_dataset(dataset)
`;

  const patched = patchAmbCli(cli);
  const patchedAgain = patchAmbCli(patched);

  assert.equal(patchedAgain, patched);
  assert.match(patched, /_remnic_apply_answer_llm\(llm\)\n\s*_resolve_gemini_key\(\)/);
  assert.doesNotMatch(
    patched,
    /os\.environ\["OMB_ANSWER_LLM"\]\s*=\s*llm\n\s*_resolve_gemini_key\(\)/,
  );
});

test("patchAmbCli rewrites compact legacy __setitem__ answer LLM patches", () => {
  const cli = `import os
import typer

def _resolve_gemini_key() -> None:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key: typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True); raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key
@app.command()
def run(llm: str): os.environ.__setitem__("OMB_ANSWER_LLM", llm) if llm else None; _resolve_gemini_key(); ds = get_dataset(dataset)
`;

  const patched = patchAmbCli(cli);

  assert.match(
    patched,
    /_remnic_apply_answer_llm\(llm\); _resolve_gemini_key\(\); ds = get_dataset\(dataset\)/,
  );
  assert.doesNotMatch(patched, /__setitem__\("OMB_ANSWER_LLM",\s*llm\).*_resolve_gemini_key/);
});

test("patchAmbCli repairs marker-only resolver upgrades missing the answer helper", () => {
  const cli = `import os
import typer

def _resolve_gemini_key() -> None:
    # REMNIC_PATCH_CODEX_AWARE_GEMINI_GATE
    answer_provider = os.environ.get("OMB_ANSWER_LLM", "groq")
    judge_provider = os.environ.get("OMB_JUDGE_LLM", "gemini")
    if answer_provider != "gemini" and judge_provider != "gemini":
        return
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        typer.echo("Error: GEMINI_API_KEY or GOOGLE_API_KEY environment variable is not set.", err=True)
        raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key

@app.command()
def run(llm: str):
    _remnic_apply_answer_llm(llm)
    _resolve_gemini_key()
    ds = get_dataset(dataset)
`;

  const patched = patchAmbCli(cli);
  const patchedAgain = patchAmbCli(patched);

  assert.equal(patchedAgain, patched);
  assert.match(patched, /def _remnic_apply_answer_llm\(llm\) -> None:/);
  assert.match(patched, /def _remnic_apply_answer_llm\(llm\) -> None:[\s\S]*@app\.command\(\)/);
});

test("patchAmbCli handles resolvers preceded on the same physical line", () => {
  const cli = `import os; import typer; def _resolve_gemini_key() -> None: key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"); os.environ["GOOGLE_API_KEY"] = key
@app.command()
def run(llm: str): _resolve_gemini_key(); ds = get_dataset(dataset)
`;

  const patched = patchAmbCli(cli);

  assert.doesNotMatch(patched, /;\s*def _resolve_gemini_key/);
  assert.match(patched, /import os; import typer\ndef _resolve_gemini_key\(\) -> None:/);
  assert.match(patched, /REMNIC_PATCH_CODEX_AWARE_GEMINI_GATE/);
  assert.match(
    patched,
    /_remnic_apply_answer_llm\(llm\); _resolve_gemini_key\(\); ds = get_dataset\(dataset\)/,
  );
});

test("check-remnic-run accepts the Codex CLI iteration profile", requireCodexCli, async () => {
  const ambDir = await createAmbFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "remnic-amb-store-test-"));

  try {
    const install = spawnSync(
      process.execPath,
      [path.join(__dirname, "install-remnic-provider.mjs"), ambDir],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const result = runAmbPreflight(ambDir, {
      REMNIC_REPO_PATH: path.resolve(__dirname, "../.."),
      REMNIC_AMB_STORE_DIR: storeDir,
      REMNIC_AMB_RUN_PROFILE: "codex-cli",
      REMNIC_AMB_SESSION_PREFIX: "beam",
      REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
      REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
      OMB_ANSWER_LLM: "codex_cli",
      OMB_ANSWER_MODEL: "gpt-5.5",
      OMB_JUDGE_LLM: "codex_cli",
      OMB_JUDGE_MODEL: "gpt-5.5",
      OMB_CODEX_REASONING_EFFORT: "xhigh",
      REMNIC_AMB_INTERNAL_PROVIDER: "codex-cli",
      REMNIC_AMB_INTERNAL_MODEL: "gpt-5.5",
      REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT: "xhigh",
      REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS: "false",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Codex CLI BEAM iteration preflight passed/);
  } finally {
    await rm(ambDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("check-remnic-run rejects Codex profile without AMB LLM registration", async () => {
  const ambDir = await createAmbFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "remnic-amb-store-test-"));
  const llmDir = path.join(ambDir, "src", "memory_bench", "llm");

  try {
    const install = spawnSync(
      process.execPath,
      [path.join(__dirname, "install-remnic-provider.mjs"), ambDir],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);
    await writeFile(
      path.join(llmDir, "__init__.py"),
      "import os\nfrom .base import LLM, Schema\nfrom .gemini import GeminiLLM\nREGISTRY = {\"gemini\": GeminiLLM}\n",
    );
    await rm(path.join(llmDir, "codex_cli.py"), { force: true });

    const result = runAmbPreflight(ambDir, {
      REMNIC_REPO_PATH: path.resolve(__dirname, "../.."),
      REMNIC_AMB_STORE_DIR: storeDir,
      REMNIC_AMB_RUN_PROFILE: "codex-cli",
      REMNIC_AMB_SESSION_PREFIX: "beam",
      REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
      REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
      OMB_ANSWER_LLM: "codex_cli",
      OMB_ANSWER_MODEL: "gpt-5.5",
      OMB_JUDGE_LLM: "codex_cli",
      OMB_JUDGE_MODEL: "gpt-5.5",
      OMB_CODEX_REASONING_EFFORT: "xhigh",
      REMNIC_AMB_INTERNAL_PROVIDER: "codex-cli",
      REMNIC_AMB_INTERNAL_MODEL: "gpt-5.5",
      REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT: "xhigh",
      REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS: "false",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /\[FAIL\] Codex CLI LLM provider installed/);
    assert.match(result.stdout, /\[FAIL\] Codex CLI registered in AMB LLM registry/);
    assert.match(result.stderr, /Codex CLI BEAM iteration preflight failed/);
  } finally {
    await rm(ambDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("check-remnic-run treats Codex internal LLM vars as optional unless configured", requireCodexCli, async () => {
  const ambDir = await createAmbFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "remnic-amb-store-test-"));

  try {
    const install = spawnSync(
      process.execPath,
      [path.join(__dirname, "install-remnic-provider.mjs"), ambDir],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const result = runAmbPreflight(ambDir, {
      REMNIC_REPO_PATH: path.resolve(__dirname, "../.."),
      REMNIC_AMB_STORE_DIR: storeDir,
      REMNIC_AMB_RUN_PROFILE: "codex-cli",
      REMNIC_AMB_SESSION_PREFIX: "beam",
      REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
      REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
      OMB_ANSWER_LLM: "codex_cli",
      OMB_ANSWER_MODEL: "gpt-5.5",
      OMB_JUDGE_LLM: "codex_cli",
      OMB_JUDGE_MODEL: "gpt-5.5",
      OMB_CODEX_REASONING_EFFORT: "xhigh",
      REMNIC_AMB_INTERNAL_PROVIDER: "",
      REMNIC_AMB_INTERNAL_MODEL: "",
      REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT: "",
      REMNIC_AMB_EXPECTED_INTERNAL_PROVIDER: "",
      REMNIC_AMB_EXPECTED_INTERNAL_MODEL: "",
      REMNIC_AMB_EXPECTED_INTERNAL_CODEX_REASONING_EFFORT: "",
      REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS: "false",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /REMNIC_AMB_INTERNAL_PROVIDER/);
    assert.match(result.stdout, /Codex CLI BEAM iteration preflight passed/);
  } finally {
    await rm(ambDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("check-remnic-run does not reset the caller AMB store directory", requireCodexCli, async () => {
  const ambDir = await createAmbFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "remnic-amb-store-preserve-test-"));
  const sentinelPath = path.join(storeDir, "sentinel.txt");

  try {
    const install = spawnSync(
      process.execPath,
      [path.join(__dirname, "install-remnic-provider.mjs"), ambDir],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);
    await writeFile(sentinelPath, "keep\n", "utf8");

    const result = runAmbPreflight(ambDir, {
      REMNIC_REPO_PATH: path.resolve(__dirname, "../.."),
      REMNIC_AMB_STORE_DIR: storeDir,
      REMNIC_AMB_RUN_PROFILE: "codex-cli",
      REMNIC_AMB_SESSION_PREFIX: "beam",
      REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
      REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
      OMB_ANSWER_LLM: "codex_cli",
      OMB_ANSWER_MODEL: "gpt-5.5",
      OMB_JUDGE_LLM: "codex_cli",
      OMB_JUDGE_MODEL: "gpt-5.5",
      OMB_CODEX_REASONING_EFFORT: "xhigh",
      REMNIC_AMB_INTERNAL_PROVIDER: "codex-cli",
      REMNIC_AMB_INTERNAL_MODEL: "gpt-5.5",
      REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT: "xhigh",
      REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS: "false",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(sentinelPath), true);
  } finally {
    await rm(ambDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("check-remnic-run keeps the public BEAM profile strict by default", async () => {
  const ambDir = await createAmbFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "remnic-amb-store-test-"));

  try {
    const install = spawnSync(
      process.execPath,
      [path.join(__dirname, "install-remnic-provider.mjs"), ambDir],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const result = runAmbPreflight(ambDir, {
      REMNIC_REPO_PATH: path.resolve(__dirname, "../.."),
      REMNIC_AMB_STORE_DIR: storeDir,
      REMNIC_AMB_SESSION_PREFIX: "beam",
      REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
      REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
      OMB_ANSWER_LLM: "codex_cli",
      OMB_ANSWER_MODEL: "gpt-5.5",
      OMB_JUDGE_LLM: "codex_cli",
      OMB_JUDGE_MODEL: "gpt-5.5",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /expected gemini/);
    assert.match(result.stderr, /public-comparable BEAM preflight failed/);
  } finally {
    await rm(ambDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("check-remnic-run reports unsupported profiles without crashing", async () => {
  const ambDir = await createAmbFixture();

  try {
    const result = runAmbPreflight(ambDir, {
      REMNIC_REPO_PATH: path.resolve(__dirname, "../.."),
      REMNIC_AMB_RUN_PROFILE: "experimental",
      REMNIC_AMB_SESSION_PREFIX: "beam",
      REMNIC_AMB_REPLAY_EXTRACTION_MODE: "skip",
      REMNIC_AMB_DRAIN_AFTER_INGEST: "false",
    });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /TypeError/);
    assert.match(result.stdout, /REMNIC_AMB_RUN_PROFILE=experimental/);
    assert.match(result.stderr, /Set REMNIC_AMB_RUN_PROFILE to public-beam or codex-cli/);
  } finally {
    await rm(ambDir, { recursive: true, force: true });
  }
});

test("RemnicMemoryProvider cleanup does not hang on an unresponsive bridge", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-provider-test-"));
  const packageDir = path.join(tempDir, "memory_bench");
  const memoryDir = path.join(packageDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(path.join(packageDir, "__init__.py"), "");
  await writeFile(path.join(memoryDir, "__init__.py"), "");
  await writeFile(
    path.join(packageDir, "models.py"),
    "class Document:\n    pass\n",
  );
  await writeFile(
    path.join(memoryDir, "base.py"),
    "class MemoryProvider:\n    pass\n",
  );
  await copyFile(
    path.join(__dirname, "remnic_provider.py"),
    path.join(memoryDir, "remnic.py"),
  );

  const script = `
import time
from memory_bench.memory.remnic import RemnicMemoryProvider

class BlockingStdout:
    def readline(self):
        time.sleep(30)
        return ""

class FakeStdin:
    def write(self, _value):
        pass
    def flush(self):
        pass

class FakeProc:
    def __init__(self):
        self.stdin = FakeStdin()
        self.stdout = BlockingStdout()
        self.terminated = False
        self._returncode = None
    def poll(self):
        return self._returncode
    def terminate(self):
        self.terminated = True
        self._returncode = 0
    def wait(self, timeout=None):
        return self._returncode
    def kill(self):
        self._returncode = -9

provider = RemnicMemoryProvider()
provider._cleanup_timeout_seconds = 0.05
proc = FakeProc()
provider._proc = proc
started = time.monotonic()
provider._stop_proc(send_cleanup=True)
elapsed = time.monotonic() - started
assert elapsed < 1.0, elapsed
assert proc.terminated
assert provider._proc is None
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: tempDir,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
