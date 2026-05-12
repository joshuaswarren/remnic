import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(dirname, "run-remnic-amb.sh");

function makeAmbCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), "remnic-amb-runner-"));
  const memoryDir = path.join(root, "src", "memory_bench", "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    path.join(memoryDir, "__init__.py"),
    [
      "from .supermemory import SupermemoryMemoryProvider",
      "",
      "MEMORY_REGISTRY = {",
      '    "supermemory": SupermemoryMemoryProvider,',
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function makeFakePnpmBin(root) {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const pnpmPath = path.join(binDir, "pnpm");
  writeFileSync(pnpmPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(pnpmPath, 0o755);
  return binDir;
}

function runRunner(args, env = {}) {
  try {
    const stdout = execFileSync("bash", [runner, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

test("official judged runs fail before registering Remnic when Gemini credentials are absent", () => {
  const root = makeAmbCheckout();
  const initPath = path.join(root, "src", "memory_bench", "memory", "__init__.py");
  const initialRegistry = readFileSync(initPath, "utf8");
  try {
    const result = runRunner([
      "--amb-dir", root,
      "--split", "100k",
      "--query-limit", "1",
      "--name", "remnic-no-key-check",
      "--output-dir", path.join(root, "outputs"),
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /GEMINI_API_KEY or GOOGLE_API_KEY is required/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(initPath, "utf8"), initialRegistry);
    assert.equal(existsSync(path.join(root, "src", "memory_bench", "memory", "remnic.py")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers Remnic in compact AMB registry layouts", () => {
  const root = makeAmbCheckout();
  const initPath = path.join(root, "src", "memory_bench", "memory", "__init__.py");
  const fakePnpmBin = makeFakePnpmBin(root);
  writeFileSync(
    initPath,
    [
      "from .base import MemoryProvider",
      "from .bm25 import BM25MemoryProvider; from .supermemory import SupermemoryMemoryProvider",
      'REGISTRY: dict[str, type[MemoryProvider]] = {"bm25": BM25MemoryProvider, "supermemory": SupermemoryMemoryProvider}',
      "",
    ].join("\n"),
  );
  try {
    const result = runRunner(
      [
        "--amb-dir", root,
        "--skip-run",
      ],
      {
        PATH: `${fakePnpmBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    );

    assert.equal(result.code, 0);
    const registry = readFileSync(initPath, "utf8");
    assert.match(registry, /from \.remnic import RemnicMemoryProvider/);
    assert.match(registry, /["']remnic["']:\s*RemnicMemoryProvider/);
    assert.equal(registry.match(/from \.remnic import RemnicMemoryProvider/g)?.length, 1);
    assert.equal(registry.match(/["']remnic["']:\s*RemnicMemoryProvider/g)?.length, 1);
    assert.equal(existsSync(path.join(root, "src", "memory_bench", "memory", "remnic.py")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported AMB modes fail before registering Remnic", () => {
  const root = makeAmbCheckout();
  const initPath = path.join(root, "src", "memory_bench", "memory", "__init__.py");
  const initialRegistry = readFileSync(initPath, "utf8");
  try {
    const result = runRunner([
      "--amb-dir", root,
      "--mode", "agent",
      "--skip-run",
    ]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unsupported AMB mode for Remnic: agent/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(initPath, "utf8"), initialRegistry);
    assert.equal(existsSync(path.join(root, "src", "memory_bench", "memory", "remnic.py")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current AMB agentic-rag mode fails before registering Remnic", () => {
  const root = makeAmbCheckout();
  const initPath = path.join(root, "src", "memory_bench", "memory", "__init__.py");
  const initialRegistry = readFileSync(initPath, "utf8");
  try {
    const result = runRunner([
      "--amb-dir", root,
      "--mode", "agentic-rag",
      "--skip-run",
    ]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unsupported AMB mode for Remnic: agentic-rag/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(initPath, "utf8"), initialRegistry);
    assert.equal(existsSync(path.join(root, "src", "memory_bench", "memory", "remnic.py")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
