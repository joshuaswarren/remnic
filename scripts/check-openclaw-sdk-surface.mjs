#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const defaultExpectedPath = path.join(
  repoRoot,
  "packages",
  "plugin-openclaw",
  "openclaw-sdk-surface.expected.json",
);
const SNAPSHOT_DESCRIPTION =
  "Conservative OpenClaw plugin SDK surface allow-list for Remnic adapter review. Refresh with `npm run check:openclaw-sdk-surface -- --write` after intentionally upgrading OpenClaw.";
const PREFERRED_SDK_SURFACE_FILES = [
  "dist/plugin-sdk/src/plugins/types.d.ts",
  "dist/plugin-sdk/src/plugins/hook-types.d.ts",
  "dist/plugin-sdk/src/plugins/manifest.d.ts",
  "dist/plugin-sdk/src/plugins/manifest-registry.d.ts",
  "dist/plugin-sdk/src/plugins/memory-embedding-providers.d.ts",
  "dist/plugin-sdk/src/plugins/compaction-provider.d.ts",
  "src/plugins/types.ts",
  "src/plugins/hook-types.ts",
  "src/plugins/manifest.ts",
  "src/plugins/manifest-registry.ts",
  "src/plugins/memory-embedding-providers.ts",
  "src/plugins/compaction-provider.ts",
];
const EXPECTED_REGISTRAR_PREFIXES = [
  "registerCli",
  "registerCommand",
  "registerCompaction",
  "registerMemory",
  "registerService",
  "registerTool",
];
const EXPECTED_HOOK_PREFIXES = [
  "after_",
  "agent_",
  "before_",
  "commands.",
  "gateway_",
  "llm_",
  "session_",
];
const EXPECTED_CONTRACT_PREFIXES = ["memory", "tools"];

const args = parseArgs(process.argv.slice(2));
const expectedPath = resolveUserPath(args.expected ?? defaultExpectedPath);
const packageRoot = args.packageRoot
  ? resolveUserPath(args.packageRoot)
  : await resolveInstalledOpenClawRoot();

if (!packageRoot) {
  const message =
    "OpenClaw SDK surface check skipped: `openclaw` is not installed. " +
    "Install the peer package or pass --package-root to check a specific checkout.";
  if (args.require || process.env.REMNIC_OPENCLAW_SURFACE_REQUIRE === "1") {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

const packageRootInfo = await stat(packageRoot).catch(() => null);
if (!packageRootInfo?.isDirectory()) {
  console.error(`OpenClaw SDK surface check failed: --package-root is not a directory: ${packageRoot}`);
  process.exit(1);
}

let surface;
try {
  surface = await inspectOpenClawSurface(packageRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (args.write) {
  await writeFile(expectedPath, `${JSON.stringify(surface, null, 2)}\n`);
  console.log(`Updated ${path.relative(repoRoot, expectedPath)}`);
  process.exit(0);
}

const expected = JSON.parse(await readFile(expectedPath, "utf-8"));
const diffs = diffSurface(expected, surface);
if (diffs.length > 0) {
  console.error("OpenClaw SDK surface drift detected.");
  console.error(`Package root: ${packageRoot}`);
  for (const diff of diffs) console.error(`- ${diff}`);
  console.error(
    "Review the new surface, update the Remnic adapter if needed, then refresh the snapshot with `npm run check:openclaw-sdk-surface -- --write`.",
  );
  process.exit(1);
}

console.log(
  `OpenClaw SDK surface matches expected snapshot (${surface.registrars.length} registrars, ${surface.hooks.length} hooks, ${surface.manifestContracts.length} manifest contracts).`,
);

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--require") {
      parsed.require = true;
      continue;
    }
    if (arg === "--package-root" || arg === "--expected") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      parsed[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function resolveUserPath(value) {
  return path.resolve(expandTilde(value));
}

function expandTilde(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function resolveInstalledOpenClawRoot() {
  if (process.env.REMNIC_OPENCLAW_SURFACE_DISABLE_AUTO_RESOLVE === "1") {
    return null;
  }

  const packageRoots = [
    path.join(repoRoot, "packages", "plugin-openclaw", "node_modules", "openclaw"),
    path.join(repoRoot, "node_modules", "openclaw"),
  ];
  for (const packageRoot of packageRoots) {
    const packageInfo = await stat(path.join(packageRoot, "package.json")).catch(() => null);
    if (packageInfo?.isFile()) {
      return packageRoot;
    }
  }
  return null;
}

async function inspectOpenClawSurface(root) {
  const files = await collectFiles(root);
  if (files.length === 0) {
    throw new Error(
      `OpenClaw SDK surface check failed: no SDK declaration or source files found under ${root}. Build OpenClaw or pass --package-root to a package containing dist/plugin-sdk declarations.`,
    );
  }
  const manifestFiles = files.filter((file) =>
    /^manifest(?:-registry)?\.d\.ts$/.test(path.basename(file)),
  );
  const contractFiles = manifestFiles.length > 0 ? manifestFiles : files;
  const registrars = new Set();
  const hooks = new Set();
  const manifestContracts = new Set();

  for (const file of files) {
    const text = await readFile(file, "utf-8").catch(() => "");
    for (const match of text.matchAll(/\b(register[A-Z][A-Za-z0-9]+)\b/g)) {
      registrars.add(match[1]);
    }
    for (const match of text.matchAll(/["'`]([a-z]+(?:[._-][a-z0-9]+)+)["'`]/g)) {
      const value = match[1];
      if (looksLikeHookName(value)) hooks.add(value);
    }
  }

  for (const file of contractFiles) {
    const text = await readFile(file, "utf-8").catch(() => "");
    const contractsText = extractPluginManifestContractsBlock(text);
    if (!contractsText) continue;
    for (const match of contractsText.matchAll(/\b([A-Za-z][A-Za-z0-9]+Providers|tools|commands|hooks|services|memory[A-Za-z0-9]+)\b/g)) {
      const value = match[1];
      if (looksLikeManifestContract(value)) manifestContracts.add(value);
    }
  }

  return {
    description: SNAPSHOT_DESCRIPTION,
    registrars: filterRelevant([...registrars], EXPECTED_REGISTRAR_PREFIXES),
    hooks: filterRelevant([...hooks], EXPECTED_HOOK_PREFIXES),
    manifestContracts: filterRelevant([...manifestContracts], EXPECTED_CONTRACT_PREFIXES),
  };
}

function filterRelevant(values, prefixes) {
  return values
    .filter((value) => prefixes.some((prefix) => value.startsWith(prefix)))
    .sort();
}

function looksLikeHookName(value) {
  return EXPECTED_HOOK_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function looksLikeManifestContract(value) {
  return EXPECTED_CONTRACT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function extractPluginManifestContractsBlock(text) {
  const match =
    /\b(?:export\s+)?(?:interface|type)\s+PluginManifestContracts\b[^={]*[={]/.exec(text);
  if (!match) return null;

  const openBraceIndex = text.indexOf("{", match.index);
  if (openBraceIndex === -1) return null;

  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex + 1, index);
    }
  }
  return null;
}

async function collectFiles(root) {
  const files = [];
  const seen = new Set();
  const addFile = async (fullPath) => {
    if (seen.has(fullPath)) return;
    const info = await stat(fullPath).catch(() => null);
    if (info?.isFile() && info.size <= 500_000) {
      seen.add(fullPath);
      files.push(fullPath);
    }
  };

  for (const relativePath of PREFERRED_SDK_SURFACE_FILES) {
    await addFile(path.join(root, relativePath));
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!/\.d\.ts$/.test(entry.name)) continue;
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      if (relativePath !== "plugin-sdk.d.ts" && !relativePath.includes("plugin-sdk/")) {
        continue;
      }
      await addFile(fullPath);
    }
  }
  return files;
}

function diffSurface(expected, actual) {
  const diffs = [];
  for (const key of ["registrars", "hooks", "manifestContracts"]) {
    const expectedSet = new Set(expected[key] ?? []);
    const actualSet = new Set(actual[key] ?? []);
    const added = [...actualSet].filter((value) => !expectedSet.has(value)).sort();
    const removed = [...expectedSet].filter((value) => !actualSet.has(value)).sort();
    if (added.length > 0) diffs.push(`${key} added: ${added.join(", ")}`);
    if (removed.length > 0) diffs.push(`${key} missing: ${removed.join(", ")}`);
  }
  return diffs;
}
