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

const targetRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!targetRoot) usage();

const here = path.dirname(fileURLToPath(import.meta.url));
const providerSource = path.join(here, "remnic_provider.py");
const memoryDir = path.join(targetRoot, "src", "memory_bench", "memory");
const registryPath = path.join(memoryDir, "__init__.py");
const providerTarget = path.join(memoryDir, "remnic.py");

if (!existsSync(registryPath)) {
  console.error(`AMB memory registry not found: ${registryPath}`);
  process.exit(1);
}

await copyFile(providerSource, providerTarget);

let registry = await readFile(registryPath, "utf8");
if (!registry.includes("from .remnic import RemnicMemoryProvider")) {
  registry = registry.replace(
    "from .base import MemoryProvider\n",
    "from .base import MemoryProvider\nfrom .remnic import RemnicMemoryProvider\n",
  );
}
if (!registry.includes('"remnic": RemnicMemoryProvider')) {
  registry = registry.replace(
    "REGISTRY: dict[str, type[MemoryProvider]] = {\n",
    'REGISTRY: dict[str, type[MemoryProvider]] = {\n    "remnic": RemnicMemoryProvider,\n',
  );
}

await writeFile(registryPath, registry);
console.log(`Installed Remnic AMB provider into ${providerTarget}`);
