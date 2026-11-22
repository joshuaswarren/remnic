import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const packageDir = path.resolve(repoRoot, process.argv[2] ?? "packages/plugin-openclaw");
const packageJsonPath = path.join(packageDir, "package.json");
const distDir = path.join(packageDir, "dist");

function fail(message) {
  console.error(`OpenClaw ClawPack verification failed: ${message}`);
  process.exit(1);
}

function assertRealDirectory(dir, label) {
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) return false;
  if (stats.isSymbolicLink()) fail(`${label} is a symlink (${dir}); refusing to scan outside the package`);
  if (!stats.isDirectory()) fail(`${label} is not a directory (${dir})`);
  return true;
}

assertRealDirectory(packageDir, "package directory");
assertRealDirectory(distDir, "dist directory");

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

/**
 * Walk dist/ one level at a time, `lstat`-ing every entry BEFORE descending.
 * Node's recursive `readdirSync` follows directory symlinks while building its
 * result, so a post-hoc filter would already have enumerated whatever the link
 * pointed at — possibly outside the package, possibly a cycle.
 */
function listBuiltDistFiles() {
  const found = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDir = pending.pop();
    for (const name of readdirSync(path.join(distDir, relativeDir))) {
      const relative = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const stats = lstatSync(path.join(distDir, relative), { throwIfNoEntry: false });
      if (stats === undefined) fail(`dist/${relative} disappeared while scanning`);
      if (stats.isSymbolicLink()) fail(`dist/${relative} is a symlink; build output must be real files`);
      if (stats.isDirectory()) pending.push(relative);
      else if (stats.isFile()) found.push(`dist/${relative}`);
    }
  }
  return found;
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
const builtDistFiles = assertRealDirectory(distDir, "dist directory") ? listBuiltDistFiles() : [];
if (builtDistFiles.length === 0) {
  fail(`${packageJson.name}@${packageJson.version} has no built dist/ — run the package build before packing`);
}
const unpacked = builtDistFiles.filter((file) => !files.has(file));
if (unpacked.length > 0) {
  fail(`${packageJson.name}@${packageJson.version} built ${unpacked.join(", ")} but the packlist omits them`);
}

// size threshold is a number rather than an invariant. "The build ran and
const entryBundle = entries.find((entry) => entry.path === "dist/index.js");
if (!entryBundle || typeof entryBundle.size !== "number") {
  fail("npm pack output has no size for dist/index.js");
}
if (entryBundle.size === 0) {
  fail(`${packageJson.name}@${packageJson.version} packs an empty dist/index.js`);
}

// OpenClaw rejects plugin manifests >= 256 KiB (MAX_PLUGIN_MANIFEST_BYTES) with
// "unsafe plugin manifest path (validation)". The prepack minifier must keep the
// packed manifest under that cap or every install on current hosts fails.
const MANIFEST_CAP_BYTES = 256 * 1024;
const manifestEntry = entries.find((entry) => entry.path === "openclaw.plugin.json");
if (!manifestEntry || typeof manifestEntry.size !== "number") {
  fail("npm pack output has no size for openclaw.plugin.json");
}
if (manifestEntry.size >= MANIFEST_CAP_BYTES) {
  fail(
    `packed openclaw.plugin.json is ${manifestEntry.size} bytes — OpenClaw rejects manifests >= ${MANIFEST_CAP_BYTES} bytes. ` +
      "Ensure the prepack minifier ran and shrink configSchema/uiHints if the compact form still exceeds the cap.",
  );
}

console.log(
  `Verified ${packageJson.name}@${packageJson.version} ClawPack packlist: ${files.size} files, ${distFiles.length} dist files.`,
);
