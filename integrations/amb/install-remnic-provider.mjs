#!/usr/bin/env node
/**
 * Idempotently install the Remnic provider into a local AMB checkout.
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error("Usage: node integrations/amb/install-remnic-provider.mjs /path/to/agent-memory-benchmark");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const providerSource = path.join(here, "remnic_provider.py");
const scriptPath = fileURLToPath(import.meta.url);
const remnicImport = "from .remnic import RemnicMemoryProvider";
const remnicRegistryEntry = '"remnic": RemnicMemoryProvider';

function hasRemnicRegistryEntry(registry) {
  return /["']remnic["']\s*:\s*RemnicMemoryProvider/.test(registry);
}

export function patchAmbMemoryRegistry(registry) {
  let patched = registry;

  if (!patched.includes(remnicImport)) {
    const imports = [...patched.matchAll(/^from \.[^\n]+$/gm)];
    if (imports.length === 0) {
      throw new Error("AMB memory registry has no provider imports to patch.");
    }
    const lastImport = imports.at(-1);
    const insertAt = (lastImport?.index ?? 0) + (lastImport?.[0].length ?? 0);
    patched = `${patched.slice(0, insertAt)}\n${remnicImport}${patched.slice(insertAt)}`;
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

export async function installRemnicProvider(targetRoot) {
  const memoryDir = path.join(targetRoot, "src", "memory_bench", "memory");
  const registryPath = path.join(memoryDir, "__init__.py");
  const providerTarget = path.join(memoryDir, "remnic.py");

  if (!existsSync(registryPath)) {
    throw new Error(`AMB memory registry not found: ${registryPath}`);
  }

  const registry = await readFile(registryPath, "utf8");
  const patchedRegistry = patchAmbMemoryRegistry(registry);

  await copyFile(providerSource, providerTarget);
  await writeFile(registryPath, patchedRegistry);
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
