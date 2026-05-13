#!/usr/bin/env node
/**
 * Idempotently install the Remnic provider into a local AMB checkout.
 */

import { copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error("Usage: node integrations/amb/install-remnic-provider.mjs /path/to/agent-memory-benchmark");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const providerSource = path.join(here, "remnic_provider.py");
const codexLlmSource = path.join(here, "codex_cli_llm.py");
const scriptPath = fileURLToPath(import.meta.url);
const remnicImport = "from .remnic import RemnicMemoryProvider";
const remnicRegistryEntry = '"remnic": RemnicMemoryProvider';
const codexLlmImport = "from .codex_cli import CodexCliLLM";
const codexLlmRegistryEntry = '"codex_cli": CodexCliLLM';
const providerImportPattern =
  /\bfrom\s+\.[A-Za-z_][A-Za-z0-9_.]*\s+import\s+(?:\([^)]+\)|[A-Za-z_][A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?)*)/g;
const codexAwareGeminiGateMarker = "REMNIC_PATCH_CODEX_AWARE_GEMINI_GATE";
const legacyAnswerLlmBeforeResolvePattern =
  /(^|[;:\n])([ \t]*)(?:os\.environ\["OMB_ANSWER_LLM"\]\s*=\s*llm|os\.environ\.__setitem__\(\s*["']OMB_ANSWER_LLM["']\s*,\s*llm\s*\))(?:\s+if\s+llm\s+else\s+None)?(\s*(?:[;\n])\s*_resolve_gemini_key\(\))/g;
const remnicApplyAnswerLlmHelper = `def _remnic_apply_answer_llm(llm) -> None:
    if not llm:
        return
    if llm == "gemini" and os.environ.get("OMB_ANSWER_LLM"):
        return
    os.environ["OMB_ANSWER_LLM"] = llm
`;

async function readExistingFile(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") {
      return undefined;
    }
    throw error;
  }
}

async function restoreInstalledFile(filePath, previousContent) {
  if (previousContent === undefined) {
    await unlink(filePath).catch(() => undefined);
    return;
  }
  await writeFile(filePath, previousContent).catch(() => undefined);
}

function hasRemnicRegistryEntry(registry) {
  return /["']remnic["']\s*:\s*RemnicMemoryProvider/.test(registry);
}

function hasCodexLlmRegistryEntry(registry) {
  return /["']codex_cli["']\s*:\s*CodexCliLLM/.test(registry);
}

export function patchAmbMemoryRegistry(registry) {
  let patched = registry;

  if (!patched.includes(remnicImport)) {
    const imports = [...patched.matchAll(providerImportPattern)];
    if (imports.length === 0) {
      throw new Error("AMB memory registry has no provider imports to patch.");
    }
    const lastImport = imports.at(-1);
    const insertAt = (lastImport?.index ?? 0) + (lastImport?.[0].length ?? 0);
    const tail = patched.slice(insertAt).replace(/^\s*;\s*/, "");
    patched = `${patched.slice(0, insertAt)}\n${remnicImport}\n${tail}`;
  }

  if (!hasRemnicRegistryEntry(patched)) {
    const registryStart = /REGISTRY\s*(?::\s*[^=]+)?=\s*\{/.exec(patched);
    if (!registryStart || registryStart.index === undefined) {
      throw new Error("AMB memory REGISTRY object was not found.");
    }
    const insertAt = registryStart.index + registryStart[0].length;
    patched = `${patched.slice(0, insertAt)}\n    ${remnicRegistryEntry},${patched.slice(insertAt)}`;
  }

  if (!patched.includes(remnicImport) || !hasRemnicRegistryEntry(patched)) {
    throw new Error("Failed to register Remnic in the AMB memory registry.");
  }

  return patched;
}

export function patchAmbLlmRegistry(registry) {
  let patched = registry;

  if (!patched.includes(codexLlmImport)) {
    const imports = [...patched.matchAll(providerImportPattern)];
    if (imports.length === 0) {
      throw new Error("AMB LLM registry has no provider imports to patch.");
    }
    const lastImport = imports.at(-1);
    const insertAt = (lastImport?.index ?? 0) + (lastImport?.[0].length ?? 0);
    const tail = patched.slice(insertAt).replace(/^\s*;\s*/, "");
    patched = `${patched.slice(0, insertAt)}\n${codexLlmImport}\n${tail}`;
  }

  if (!hasCodexLlmRegistryEntry(patched)) {
    const registryStart = /REGISTRY\s*(?::\s*[^=]+)?=\s*\{/.exec(patched);
    if (!registryStart || registryStart.index === undefined) {
      throw new Error("AMB LLM REGISTRY object was not found.");
    }
    const insertAt = registryStart.index + registryStart[0].length;
    patched = `${patched.slice(0, insertAt)}\n    ${codexLlmRegistryEntry},${patched.slice(insertAt)}`;
  }

  if (!patched.includes(codexLlmImport) || !hasCodexLlmRegistryEntry(patched)) {
    throw new Error("Failed to register Codex CLI in the AMB LLM registry.");
  }

  return patched;
}

function rewriteLegacyAnswerLlmPatch(cli) {
  return cli.replace(
    legacyAnswerLlmBeforeResolvePattern,
    (_match, delimiter, indent, resolverCall) =>
      `${delimiter}${indent}_remnic_apply_answer_llm(llm)${resolverCall}`,
  );
}

function ensureApplyAnswerLlmHelper(cli, resolvePattern) {
  if (/def\s+_remnic_apply_answer_llm\s*\(/.test(cli)) {
    return cli;
  }

  const match = resolvePattern.exec(cli);
  if (!match || match.index === undefined) {
    throw new Error("AMB CLI Gemini key resolver was not found.");
  }
  const insertAt = match.index + match[0].length;
  const head = cli.slice(0, insertAt).replace(/\s*$/, "");
  return `${head}\n\n${remnicApplyAnswerLlmHelper}${cli.slice(insertAt)}`;
}

export function patchAmbCli(cli) {
  const newResolve = `def _resolve_gemini_key() -> None:
    # ${codexAwareGeminiGateMarker}
    answer_provider = os.environ.get("OMB_ANSWER_LLM", "groq")
    judge_provider = os.environ.get("OMB_JUDGE_LLM", "gemini")
    if answer_provider != "gemini" and judge_provider != "gemini":
        return
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        typer.echo("Error: GEMINI_API_KEY or GOOGLE_API_KEY environment variable is not set.", err=True)
        raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key

${remnicApplyAnswerLlmHelper}
`;
  const resolvePattern =
    /(^|[;\n])([ \t]*)def\s+_resolve_gemini_key\s*\(\s*\)\s*->\s*None\s*:[\s\S]*?(?=(?:^|[;\n])\s*(?:@|def\s+|class\s+)|$(?![\s\S]))/m;
  let patched = rewriteLegacyAnswerLlmPatch(cli);
  if (!patched.includes(codexAwareGeminiGateMarker)) {
    const resolvePatched = patched.replace(
      resolvePattern,
      (_match, delimiter) => `${delimiter === ";" ? "\n" : delimiter}${newResolve}`,
    );
    if (resolvePatched === patched) {
      throw new Error("AMB CLI Gemini key resolver was not found.");
    }
    patched = resolvePatched;
  }
  patched = ensureApplyAnswerLlmHelper(patched, resolvePattern);

  const hasAnswerLlmPatch =
    /(^|[;:\n])\s*_remnic_apply_answer_llm\(llm\)\s*(?:[;\n])/.test(patched);
  if (!hasAnswerLlmPatch) {
    const callPattern =
      /^([ \t]*)_resolve_gemini_key\(\)\s*\n([ \t]*\n)?([ \t]*ds\s*=\s*get_dataset\(dataset\))/m;
    const callPatched = patched.replace(
      callPattern,
      (_match, indent, blankLine = "", datasetLine) =>
        `${indent}_remnic_apply_answer_llm(llm)\n` +
        `${indent}_resolve_gemini_key()\n` +
        `${blankLine}${datasetLine}`,
    );
    if (callPatched !== patched) {
      patched = callPatched;
    } else {
      const compactCallPattern =
        /\b_resolve_gemini_key\(\)(\s*;\s*ds\s*=\s*get_dataset\(dataset\))/;
      const compactCallPatched = patched.replace(
        compactCallPattern,
        '_remnic_apply_answer_llm(llm); _resolve_gemini_key()$1',
      );
      if (compactCallPatched === patched) {
        throw new Error("AMB CLI run entrypoint was not patched.");
      }
      patched = compactCallPatched;
    }
  }
  return patched;
}

export async function installRemnicProvider(targetRoot) {
  const memoryDir = path.join(targetRoot, "src", "memory_bench", "memory");
  const registryPath = path.join(memoryDir, "__init__.py");
  const providerTarget = path.join(memoryDir, "remnic.py");
  const providerTemp = path.join(
    memoryDir,
    `.remnic.py.${process.pid}.${Date.now()}.tmp`,
  );

  if (!existsSync(registryPath)) {
    throw new Error(`AMB memory registry not found: ${registryPath}`);
  }

  const llmDir = path.join(targetRoot, "src", "memory_bench", "llm");
  const llmRegistryPath = path.join(llmDir, "__init__.py");
  const shouldInstallCodexLlm = existsSync(llmRegistryPath);
  const codexLlmTarget = path.join(llmDir, "codex_cli.py");
  const codexLlmTemp = path.join(
    llmDir,
    `.codex_cli.py.${process.pid}.${Date.now()}.tmp`,
  );
  const cliPath = path.join(targetRoot, "src", "memory_bench", "cli.py");
  const shouldPatchCli = existsSync(cliPath);

  const registry = await readFile(registryPath, "utf8");
  const patchedRegistry = patchAmbMemoryRegistry(registry);
  const llmRegistry = shouldInstallCodexLlm
    ? await readFile(llmRegistryPath, "utf8")
    : undefined;
  const patchedLlmRegistry = llmRegistry === undefined
    ? undefined
    : patchAmbLlmRegistry(llmRegistry);
  const cli = shouldPatchCli ? await readFile(cliPath, "utf8") : undefined;
  const patchedCli = cli === undefined ? undefined : patchAmbCli(cli);
  const previousProviderTarget = await readExistingFile(providerTarget);
  const previousCodexLlmTarget = shouldInstallCodexLlm
    ? await readExistingFile(codexLlmTarget)
    : undefined;

  let tempProviderWritten = false;
  let tempCodexLlmWritten = false;
  let providerTargetWritten = false;
  let codexLlmTargetWritten = false;
  let registryWritten = false;
  let llmRegistryWritten = false;
  let cliWritten = false;
  try {
    await copyFile(providerSource, providerTemp);
    tempProviderWritten = true;
    if (shouldInstallCodexLlm) {
      await copyFile(codexLlmSource, codexLlmTemp);
      tempCodexLlmWritten = true;
    }
    await rename(providerTemp, providerTarget);
    tempProviderWritten = false;
    providerTargetWritten = true;
    if (shouldInstallCodexLlm) {
      await rename(codexLlmTemp, codexLlmTarget);
      tempCodexLlmWritten = false;
      codexLlmTargetWritten = true;
    }
    await writeFile(registryPath, patchedRegistry);
    registryWritten = true;
    if (shouldInstallCodexLlm && patchedLlmRegistry !== undefined) {
      await writeFile(llmRegistryPath, patchedLlmRegistry);
      llmRegistryWritten = true;
    }
    if (shouldPatchCli && patchedCli !== undefined) {
      await writeFile(cliPath, patchedCli);
      cliWritten = true;
    }
  } catch (error) {
    if (cliWritten && cli !== undefined) {
      await writeFile(cliPath, cli).catch(() => undefined);
    }
    if (llmRegistryWritten && llmRegistry !== undefined) {
      await writeFile(llmRegistryPath, llmRegistry).catch(() => undefined);
    }
    if (registryWritten) {
      await writeFile(registryPath, registry).catch(() => undefined);
    }
    if (codexLlmTargetWritten) {
      await restoreInstalledFile(codexLlmTarget, previousCodexLlmTarget);
    }
    if (providerTargetWritten) {
      await restoreInstalledFile(providerTarget, previousProviderTarget);
    }
    if (tempCodexLlmWritten) {
      await unlink(codexLlmTemp).catch(() => undefined);
    }
    if (tempProviderWritten) {
      await unlink(providerTemp).catch(() => undefined);
    }
    throw error;
  }
  return providerTarget;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const targetRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  if (!targetRoot) usage();

  try {
    const providerTarget = await installRemnicProvider(targetRoot);
    console.log(`Installed Remnic AMB provider into ${providerTarget}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
