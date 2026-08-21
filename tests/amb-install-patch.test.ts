import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("AMB installer preserves AgenticRAG retrieval depth when patching llm imports", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remnic-amb-install-"));
  const modesDir = path.join(root, "src", "memory_bench", "modes");
  mkdirSync(modesDir, { recursive: true });
  writeFileSync(path.join(modesDir, "__init__.py"), "");
  writeFileSync(path.join(modesDir, "rag.py"), "");
  const agenticPath = path.join(modesDir, "agentic_rag.py");
  writeFileSync(
    agenticPath,
    [
      "from ..llm.gemini import GeminiLLM",
      "",
      "class AgenticRAGMode:",
      "    def __init__(self, llm: GeminiLLM | None = None, k: int = 10):",
      "        self._llm = llm or GeminiLLM()",
      "        self._rag = RAGMode(llm=self._llm, k=k)",
      "",
    ].join("\n"),
  );

  try {
    const installerPath = path.resolve("integrations/amb/install.py");
    const script = [
      "import importlib.util",
      "from pathlib import Path",
      `spec = importlib.util.spec_from_file_location("amb_install", ${JSON.stringify(installerPath)})`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      `module.patch_mode_llm_imports(Path(${JSON.stringify(root)}))`,
    ].join("\n");
    const result = spawnSync("python3", ["-c", script], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const patched = readFileSync(agenticPath, "utf8");
    assert.match(patched, /def __init__\(self, llm: LLM \| None = None, k: int = 10\):/);
    assert.match(patched, /self\._rag = RAGMode\(llm=self\._llm, k=k\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
