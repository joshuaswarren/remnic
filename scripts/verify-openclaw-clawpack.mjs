import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const packageDir = path.resolve(repoRoot, process.argv[2] ?? "packages/plugin-openclaw");
const packageJsonPath = path.join(packageDir, "package.json");

function fail(message) {
  console.error(`OpenClaw ClawPack verification failed: ${message}`);
  process.exit(1);
}

function parsePackOutput(stdout) {
  const candidates = [0];
  for (let index = stdout.indexOf("["); index !== -1; index = stdout.indexOf("[", index + 1)) {
    if (!candidates.includes(index)) {
      candidates.push(index);
    }
  }

  for (const index of candidates) {
    const candidate = stdout.slice(index).trim();
    if (candidate.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Lifecycle scripts can write logs before npm's JSON payload. Keep scanning.
    }
  }

  throw new Error("could not find npm pack JSON array in stdout");
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageDir,
  encoding: "utf8",
});

if (pack.status !== 0) {
  process.stdout.write(pack.stdout);
  process.stderr.write(pack.stderr);
  fail(`npm pack --dry-run exited with status ${pack.status ?? "unknown"}`);
}

let entries;
try {
  const parsed = parsePackOutput(pack.stdout);
  entries = parsed[0]?.files ?? [];
} catch (error) {
  fail(`could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
}

const files = new Set(entries.map((entry) => entry.path));
const requiredFiles = new Set([
  "package.json",
  "README.md",
  "openclaw.plugin.json",
  "dist/index.js",
]);

for (const extension of packageJson.openclaw?.extensions ?? []) {
  requiredFiles.add(extension.replace(/^\.\//, ""));
}

for (const runtimeExtension of packageJson.openclaw?.runtimeExtensions ?? []) {
  requiredFiles.add(runtimeExtension.replace(/^\.\//, ""));
}

for (const requiredFile of requiredFiles) {
  if (!files.has(requiredFile)) {
    fail(`${packageJson.name}@${packageJson.version} packlist is missing ${requiredFile}`);
  }
}

const distFiles = [...files].filter((file) => file.startsWith("dist/"));
if (distFiles.length < 2) {
  fail(`${packageJson.name}@${packageJson.version} packlist only includes ${distFiles.length} dist file(s)`);
}

console.log(
  `Verified ${packageJson.name}@${packageJson.version} ClawPack packlist: ${files.size} files, ${distFiles.length} dist files.`,
);
