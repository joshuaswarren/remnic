import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
