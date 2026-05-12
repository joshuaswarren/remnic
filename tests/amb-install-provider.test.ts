import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeAmbRegistry(root: string, registry: string): Promise<string> {
  const memoryDir = path.join(root, "src", "memory_bench", "memory");
  await mkdir(memoryDir, { recursive: true });
  const registryPath = path.join(memoryDir, "__init__.py");
  await writeFile(registryPath, registry, "utf8");
  return registryPath;
}

async function writeAmbLlmRegistry(root: string, registry: string): Promise<string> {
  const llmDir = path.join(root, "src", "memory_bench", "llm");
  await mkdir(llmDir, { recursive: true });
  const registryPath = path.join(llmDir, "__init__.py");
  await writeFile(registryPath, registry, "utf8");
  return registryPath;
}

async function writeAmbCli(root: string, cli: string): Promise<string> {
  const packageDir = path.join(root, "src", "memory_bench");
  await mkdir(packageDir, { recursive: true });
  const cliPath = path.join(packageDir, "cli.py");
  await writeFile(cliPath, cli, "utf8");
  return cliPath;
}

test("AMB provider installer patches one-line memory registries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-amb-install-"));
  const registryPath = await writeAmbRegistry(
    root,
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      'REGISTRY: dict[str, type[MemoryProvider]] = {"bm25": BM25MemoryProvider}',
      "",
    ].join("\n"),
  );

  try {
    await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
      { cwd: repoRoot },
    );
    await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
      { cwd: repoRoot },
    );

    const registry = await readFile(registryPath, "utf8");
    const provider = await readFile(
      path.join(root, "src", "memory_bench", "memory", "remnic.py"),
      "utf8",
    );

    assert.match(provider, /class RemnicMemoryProvider/);
    assert.equal(
      registry.match(/from \.remnic import RemnicMemoryProvider/g)?.length,
      1,
    );
    assert.equal(registry.match(/["']remnic["']:\s*RemnicMemoryProvider/g)?.length, 1);
    assert.match(registry, /["']bm25["']:\s*BM25MemoryProvider/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AMB provider installer also patches LLM registries for Codex CLI runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-amb-install-llm-"));
  await writeAmbRegistry(
    root,
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      'REGISTRY: dict[str, type[MemoryProvider]] = {"bm25": BM25MemoryProvider}',
      "",
    ].join("\n"),
  );
  const llmRegistryPath = await writeAmbLlmRegistry(
    root,
    [
      "import os",
      "from .base import LLM, Schema",
      "from .gemini import GeminiLLM",
      "from .openai import OpenAILLM",
      'REGISTRY: dict[str, type[LLM]] = {"gemini": GeminiLLM, "openai": OpenAILLM}',
      "",
    ].join("\n"),
  );

  try {
    await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
      { cwd: repoRoot },
    );
    await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
      { cwd: repoRoot },
    );

    const registry = await readFile(llmRegistryPath, "utf8");
    const provider = await readFile(
      path.join(root, "src", "memory_bench", "llm", "codex_cli.py"),
      "utf8",
    );

    assert.match(provider, /class CodexCliLLM/);
    assert.match(provider, /REMNIC_BENCH_CODEX_CLI_EXECUTABLE/);
    assert.equal(
      registry.match(/from \.codex_cli import CodexCliLLM/g)?.length,
      1,
    );
    assert.equal(registry.match(/["']codex_cli["']:\s*CodexCliLLM/g)?.length, 1);
    assert.match(registry, /["']gemini["']:\s*GeminiLLM/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AMB provider installer patches CLI Gemini gate for non-Gemini providers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-amb-install-cli-"));
  await writeAmbRegistry(
    root,
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      'REGISTRY: dict[str, type[MemoryProvider]] = {"bm25": BM25MemoryProvider}',
      "",
    ].join("\n"),
  );
  await writeAmbLlmRegistry(
    root,
    [
      "import os",
      "from .base import LLM, Schema",
      "from .gemini import GeminiLLM",
      'REGISTRY: dict[str, type[LLM]] = {"gemini": GeminiLLM}',
      "",
    ].join("\n"),
  );
  const cliPath = await writeAmbCli(
    root,
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
      "def run(llm: str):",
      "    _resolve_gemini_key()",
      "",
      "    ds = get_dataset(dataset)",
      "",
    ].join("\n"),
  );

  try {
    await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
      { cwd: repoRoot },
    );

    const cli = await readFile(cliPath, "utf8");
    assert.match(cli, /REMNIC_PATCH_CODEX_AWARE_GEMINI_GATE/);
    assert.match(cli, /answer_provider = os\.environ\.get\("OMB_ANSWER_LLM", "groq"\)/);
    assert.match(cli, /judge_provider = os\.environ\.get\("OMB_JUDGE_LLM", "gemini"\)/);
    assert.match(cli, /answer_provider != "gemini" and judge_provider != "gemini"/);
    assert.match(
      cli,
      /key = os\.environ\.get\("GEMINI_API_KEY"\) or os\.environ\.get\("GOOGLE_API_KEY"\)/,
    );
    assert.match(cli, /os\.environ\["GOOGLE_API_KEY"\] = key/);
    assert.match(cli, /def _remnic_apply_answer_llm\(llm\) -> None:/);
    assert.doesNotMatch(cli, /if llm and \(llm != "gemini"/);
    assert.match(cli, /_remnic_apply_answer_llm\(llm\)\n\s*_resolve_gemini_key\(\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AMB provider installer patches compact CLI Gemini gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-amb-install-cli-compact-"));
  await writeAmbRegistry(
    root,
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      'REGISTRY: dict[str, type[MemoryProvider]] = {"bm25": BM25MemoryProvider}',
      "",
    ].join("\n"),
  );
  await writeAmbLlmRegistry(
    root,
    [
      "import os",
      "from .base import LLM, Schema",
      "from .gemini import GeminiLLM",
      'REGISTRY: dict[str, type[LLM]] = {"gemini": GeminiLLM}',
      "",
    ].join("\n"),
  );
  const cliPath = await writeAmbCli(
    root,
    [
      "import os",
      "import typer",
      "",
      "def _resolve_gemini_key() -> None:",
      '    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")',
      '    if not key: typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True); raise typer.Exit(1)',
      '    os.environ["GOOGLE_API_KEY"] = key',
      "@app.command()",
      "def run(llm: str): _resolve_gemini_key(); ds = get_dataset(dataset)",
      "",
    ].join("\n"),
  );

  try {
    await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
      { cwd: repoRoot },
    );

    const cli = await readFile(cliPath, "utf8");
    assert.match(cli, /REMNIC_PATCH_CODEX_AWARE_GEMINI_GATE/);
    assert.match(cli, /answer_provider != "gemini" and judge_provider != "gemini"/);
    assert.match(
      cli,
      /_remnic_apply_answer_llm\(llm\); _resolve_gemini_key\(\); ds = get_dataset\(dataset\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AMB provider installer fails when the registry cannot be patched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-amb-install-bad-"));
  await writeAmbRegistry(root, "REGISTRY = {}\n");

  try {
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
          { cwd: repoRoot },
        ),
      /no provider imports to patch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AMB provider installer does not expose provider file when registry write fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-amb-install-readonly-"));
  const registryPath = await writeAmbRegistry(
    root,
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      'REGISTRY: dict[str, type[MemoryProvider]] = {"bm25": BM25MemoryProvider}',
      "",
    ].join("\n"),
  );
  const memoryDir = path.dirname(registryPath);
  const providerPath = path.join(memoryDir, "remnic.py");

  try {
    await chmod(registryPath, 0o444);
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
          { cwd: repoRoot },
        ),
      /EACCES|permission denied|operation not permitted/i,
    );

    assert.equal(existsSync(providerPath), false);
    const memoryEntries = await readdir(memoryDir);
    assert.equal(
      memoryEntries.some((entry) => entry.startsWith(".remnic.py.")),
      false,
    );
  } finally {
    await chmod(registryPath, 0o644).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMB provider installer removes installed provider when LLM provider rename fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-amb-install-llm-rename-fail-"));
  const registryPath = await writeAmbRegistry(
    root,
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider",
      'REGISTRY: dict[str, type[MemoryProvider]] = {"bm25": BM25MemoryProvider}',
      "",
    ].join("\n"),
  );
  const originalRegistry = await readFile(registryPath, "utf8");
  const llmRegistryPath = await writeAmbLlmRegistry(
    root,
    [
      "import os",
      "from .base import LLM, Schema",
      "from .gemini import GeminiLLM",
      'REGISTRY: dict[str, type[LLM]] = {"gemini": GeminiLLM}',
      "",
    ].join("\n"),
  );
  const originalLlmRegistry = await readFile(llmRegistryPath, "utf8");
  const memoryDir = path.dirname(registryPath);
  const llmDir = path.dirname(llmRegistryPath);
  const providerPath = path.join(memoryDir, "remnic.py");
  const codexLlmPath = path.join(llmDir, "codex_cli.py");

  try {
    await mkdir(codexLlmPath);
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [path.join(repoRoot, "integrations", "amb", "install-remnic-provider.mjs"), root],
          { cwd: repoRoot },
        ),
      /EISDIR|is a directory|ENOTDIR|not a directory/i,
    );

    assert.equal(existsSync(providerPath), false);
    assert.equal(await readFile(registryPath, "utf8"), originalRegistry);
    assert.equal(await readFile(llmRegistryPath, "utf8"), originalLlmRegistry);
    const memoryEntries = await readdir(memoryDir);
    const llmEntries = await readdir(llmDir);
    assert.equal(
      memoryEntries.some((entry) => entry.startsWith(".remnic.py.")),
      false,
    );
    assert.equal(
      llmEntries.some((entry) => entry.startsWith(".codex_cli.py.")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
