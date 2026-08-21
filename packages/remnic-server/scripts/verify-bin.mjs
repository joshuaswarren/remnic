#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(scriptDir, "..");
const packageJsonPath = path.join(packageDir, "package.json");

function fail(message) {
  process.stderr.write(`@remnic/server bin verification failed: ${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function verifyBin(name, relativeTarget) {
  if (typeof relativeTarget !== "string" || relativeTarget.length === 0) {
    fail(`bin.${name} must be a non-empty string`);
  }
  if (path.isAbsolute(relativeTarget) || relativeTarget.split(/[\\/]+/).includes("..")) {
    fail(`bin.${name} must stay inside the package: ${relativeTarget}`);
  }

  const target = path.resolve(packageDir, relativeTarget);
  if (!existsSync(target)) {
    fail(`bin.${name} points to missing file: ${relativeTarget}`);
  }
  if (!statSync(target).isFile()) {
    fail(`bin.${name} is not a file: ${relativeTarget}`);
  }

  const content = readFileSync(target, "utf8");
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine !== "#!/usr/bin/env node") {
    fail(`bin.${name} must start with "#!/usr/bin/env node"`);
  }

  const help = spawnSync(process.execPath, [target, "--help"], {
    cwd: packageDir,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (help.error) {
    fail(`bin.${name} --help failed to start: ${help.error.message}`);
  }
  if (help.status !== 0) {
    fail(`bin.${name} --help exited ${help.status}: ${help.stderr || help.stdout}`);
  }
  if (!help.stdout.includes(name)) {
    fail(`bin.${name} --help must include the command name`);
  }
}

const packageJson = readJson(packageJsonPath);
const bin = packageJson.bin;
if (!bin || typeof bin !== "object" || Array.isArray(bin)) {
  fail("package.json must declare a bin map");
}

for (const [name, relativeTarget] of Object.entries(bin)) {
  verifyBin(name, relativeTarget);
}

process.stdout.write(`Verified ${Object.keys(bin).length} @remnic/server bin entries.\n`);
