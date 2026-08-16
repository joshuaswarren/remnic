#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PYTHON_PUBLISHED_NAME = "remnic-hermes";
const ROOT_PACKAGE_PATH = "package.json";
const OPENCLAW_ROOT_MANIFEST = "openclaw.plugin.json";
const DEFAULT_BASE_REF = "origin/main";

function runGit(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(repoRoot, args, git = runGit) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function parsePythonProjectName(source) {
  const match = source.match(/^name\s*=\s*["']([^"']+)["']\s*$/m);
  return match?.[1] ?? PYTHON_PUBLISHED_NAME;
}

export async function discoverPackages(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relativeDir = normalizePath(path.join("packages", entry.name));
    const packageDir = path.join(repoRoot, relativeDir);
    const packageJsonPath = path.join(packageDir, "package.json");
    try {
      const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (typeof manifest.name === "string") {
        packages.push({
          dir: relativeDir,
          name: manifest.name,
          kind: "npm",
          private: manifest.private === true,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const pyprojectPath = path.join(packageDir, "pyproject.toml");
      try {
        const pyproject = await readFile(pyprojectPath, "utf8");
        packages.push({
          dir: relativeDir,
          name: parsePythonProjectName(pyproject),
          kind: "python",
          private: false,
        });
      } catch (pyprojectError) {
        if (pyprojectError?.code !== "ENOENT") throw pyprojectError;
      }
    }
  }

  return packages.sort((left, right) => left.dir.localeCompare(right.dir));
}

function packageForFile(filePath, packages) {
  const normalized = normalizePath(filePath);
  return packages.find(
    (pkg) => normalized === pkg.dir || normalized.startsWith(`${pkg.dir}/`),
  );
}

export function inferTouchedPackages(changedFiles, packages) {
  const touched = new Map();
  const skipped = new Map();
  const python = new Map();

  for (const file of changedFiles) {
    const normalized = normalizePath(file);
    const packageMatch = packageForFile(normalized, packages);
    if (packageMatch) {
      if (packageMatch.kind === "python") {
        python.set(packageMatch.dir, packageMatch);
      } else if (packageMatch.private) {
        skipped.set(packageMatch.dir, packageMatch);
      } else {
        touched.set(packageMatch.dir, packageMatch);
      }
      continue;
    }

    if (normalized === OPENCLAW_ROOT_MANIFEST) {
      const openclaw = packages.find((pkg) => pkg.dir === "packages/plugin-openclaw");
      if (openclaw && !openclaw.private) touched.set(openclaw.dir, openclaw);
      else if (openclaw) skipped.set(openclaw.dir, openclaw);
      continue;
    }

    if (normalized === ROOT_PACKAGE_PATH) {
      skipped.set(".", { dir: ".", name: "remnic-workspace", kind: "npm", private: true });
    }
  }

  return {
    published: [...touched.values()].sort((left, right) => left.name.localeCompare(right.name)),
    python: [...python.values()].sort((left, right) => left.name.localeCompare(right.name)),
    skipped: [...skipped.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function renderChangeset(packages) {
  if (packages.length === 0) return "";
  const frontmatter = packages.map((pkg) => `"${pkg.name}": patch`).join("\n");
  const names = packages.map((pkg) => pkg.name).join(", ");
  return `---\n${frontmatter}\n---\n\nTODO: Summarize the user-visible changes for ${names}.\n`;
}

function splitLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizePath);
}

export function changedWorkingTreeFiles(repoRoot, options = {}) {
  const git = options.git ?? runGit;
  const baseRef = options.baseRef ?? process.env.PREFLIGHT_BASE_REF ?? DEFAULT_BASE_REF;
  const mergeBase = tryGit(repoRoot, ["merge-base", "HEAD", baseRef], git) ?? "HEAD~1";
  const tracked = tryGit(repoRoot, ["diff", "--name-only", mergeBase, "--"], git) ?? "";
  const untracked = tryGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], git) ?? "";
  return [...new Set([...splitLines(tracked), ...splitLines(untracked)])].sort();
}

export function renderNotes(result) {
  const notes = [];
  for (const pkg of result.python) {
    notes.push(
      `changeset-stub: ${pkg.name} is Python-published; no npm changeset emitted. ` +
        `Update ${pkg.dir}/pyproject.toml and ${pkg.dir}/plugin.yaml release metadata instead.`,
    );
  }
  for (const pkg of result.skipped) {
    notes.push(`changeset-stub: skipped unpublished/private package ${pkg.name} (${pkg.dir}).`);
  }
  return notes.length > 0 ? `${notes.join("\n")}\n` : "";
}

export function parseArgs(argv) {
  const args = { baseRef: undefined, repoRoot: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --base");
      args.baseRef = value;
      index += 1;
    } else if (arg === "--repo-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --repo-root");
      args.repoRoot = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function usage() {
  return [
    "Usage: node scripts/changeset-stub.mjs [--base <ref>] [--repo-root <path>]",
    "",
    "Prints a changeset for published packages touched by the working-tree diff.",
  ].join("\n");
}

export async function inferChangeset(repoRoot, options = {}) {
  const packages = options.packages ?? (await discoverPackages(repoRoot));
  const changedFiles = options.changedFiles ?? changedWorkingTreeFiles(repoRoot, options);
  const result = inferTouchedPackages(changedFiles, packages);
  return { ...result, changedFiles, markdown: renderChangeset(result.published) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const result = await inferChangeset(args.repoRoot, { baseRef: args.baseRef });
  process.stderr.write(renderNotes(result));
  process.stdout.write(result.markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`changeset-stub: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
