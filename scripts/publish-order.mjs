#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value === "--" || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    repoRoot: process.cwd(),
    output: "",
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      args.repoRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output") {
      args.output = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return [
    "Usage: node scripts/publish-order.mjs [--repo-root <path>] [--output <path>] [--json]",
    "",
    "Prints public workspace package directories in dependency-safe publish order.",
  ].join("\n");
}

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function packageDeps(manifest) {
  const deps = new Set();
  for (const field of dependencyFields) {
    const values = manifest[field];
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      continue;
    }
    for (const name of Object.keys(values)) {
      deps.add(name);
    }
  }
  return deps;
}

export async function discoverWorkspacePackages(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relativeDir = normalizeRelativePath(path.join("packages", entry.name));
    const packageJsonPath = path.join(repoRoot, relativeDir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!manifest.name) {
      throw new Error(`${relativeDir}/package.json is missing a package name`);
    }
    packages.push({
      dir: relativeDir,
      name: manifest.name,
      private: manifest.private === true,
      deps: packageDeps(manifest),
    });
  }

  return packages.sort((left, right) => left.dir.localeCompare(right.dir));
}

export function resolvePublishOrder(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  if (byName.size !== packages.length) {
    throw new Error("Workspace package names must be unique before generating publish order");
  }

  const publicPackages = packages.filter((pkg) => !pkg.private);
  const publicNames = new Set(publicPackages.map((pkg) => pkg.name));
  const edges = new Map(publicPackages.map((pkg) => [pkg.dir, new Set()]));
  const indegree = new Map(publicPackages.map((pkg) => [pkg.dir, 0]));

  for (const pkg of publicPackages) {
    for (const depName of pkg.deps) {
      const dep = byName.get(depName);
      if (!dep) {
        continue;
      }
      if (dep.private) {
        throw new Error(
          `${pkg.dir} depends on private workspace package ${dep.name}; it cannot be published safely`,
        );
      }
      if (!publicNames.has(dep.name)) {
        continue;
      }
      edges.get(dep.dir).add(pkg.dir);
      indegree.set(pkg.dir, indegree.get(pkg.dir) + 1);
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([dir]) => dir)
    .sort();
  const order = [];

  while (ready.length > 0) {
    const dir = ready.shift();
    order.push(dir);
    for (const dependent of [...edges.get(dir)].sort()) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== publicPackages.length) {
    const blocked = [...indegree.entries()]
      .filter(([, count]) => count > 0)
      .map(([dir]) => dir)
      .sort();
    throw new Error(`Workspace dependency cycle blocks publish order: ${blocked.join(", ")}`);
  }

  validatePublishOrder(publicPackages, order);
  return order;
}

export function validatePublishOrder(publicPackages, order) {
  const expected = new Map(publicPackages.map((pkg) => [pkg.dir, pkg]));
  const seen = new Set();

  for (const dir of order) {
    if (!expected.has(dir)) {
      throw new Error(`Publish order includes unknown public package directory: ${dir}`);
    }
    if (seen.has(dir)) {
      throw new Error(`Publish order includes duplicate package directory: ${dir}`);
    }
    seen.add(dir);
  }

  const missing = [...expected.keys()].filter((dir) => !seen.has(dir)).sort();
  if (missing.length > 0) {
    throw new Error(`Publish order is missing public package directories: ${missing.join(", ")}`);
  }

  const position = new Map(order.map((dir, index) => [dir, index]));
  const byName = new Map(publicPackages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of publicPackages) {
    for (const depName of pkg.deps) {
      const dep = byName.get(depName);
      if (!dep) {
        continue;
      }
      if (position.get(dep.dir) > position.get(pkg.dir)) {
        throw new Error(`${pkg.dir} appears before dependency ${dep.dir} in publish order`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const packages = await discoverWorkspacePackages(args.repoRoot);
  const order = resolvePublishOrder(packages);
  const output = args.json ? `${JSON.stringify(order, null, 2)}\n` : `${order.join("\n")}\n`;
  if (args.output) {
    await writeFile(args.output, output);
  } else {
    process.stdout.write(output);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
