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

/**
 * A symlinked scan root or entry would let the release gate inspect artifacts
 * outside the package it was asked about, and a dangling one would abort the
 * verifier with an uncaught filesystem error. Everything under `dist/` must be
 * a real file or directory (AGENTS.md: reject symlink traversal in directory
 * scans). Runs before `npm pack` so a redirected root is reported as such
 * rather than as whatever downstream assertion happens to notice first.
 */
function assertRealDirectory(dir, label) {
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) return false;
  if (stats.isSymbolicLink()) fail(`${label} is a symlink (${dir}); refusing to scan outside the package`);
  if (!stats.isDirectory()) fail(`${label} is not a directory (${dir})`);
  return true;
}

assertRealDirectory(packageDir, "package directory");
const distDirExists = assertRealDirectory(distDir, "dist directory");

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

// Every emitted dist file must be IN the tarball. This is the invariant that
// matters: tsup code-splits whenever the entry gains a dynamic import, and a
// split chunk missing from the packlist breaks the plugin at runtime with a
// module-not-found the tests never see. It replaces an older `>= 2 dist files`
// proxy that silently encoded one such chunk (`legacy-hook-compat-*.js`) as a
// requirement; removing that module in #2279 left the assertion unsatisfiable
// and blocked every release from 2026-07-31 on.
const distFiles = [...files].filter((file) => file.startsWith("dist/"));
const builtDistFiles = distDirExists
  ? readdirSync(distDir, { recursive: true })
      .map((relative) => String(relative).split(path.sep).join("/"))
      .filter((relative) => {
        const stats = lstatSync(path.join(distDir, relative), { throwIfNoEntry: false });
        if (stats === undefined) fail(`dist/${relative} disappeared while scanning`);
        if (stats.isSymbolicLink()) fail(`dist/${relative} is a symlink; build output must be real files`);
        return stats.isFile();
      })
      .map((relative) => `dist/${relative}`)
  : [];
if (builtDistFiles.length === 0) {
  fail(`${packageJson.name}@${packageJson.version} has no built dist/ — run the package build before packing`);
}
const unpacked = builtDistFiles.filter((file) => !files.has(file));
if (unpacked.length > 0) {
  fail(`${packageJson.name}@${packageJson.version} built ${unpacked.join(", ")} but the packlist omits them`);
}

// Deliberately no byte floor on the entry bundle: this script also verifies
// the shim package, whose legitimate build is a few hundred bytes, so any
// size threshold is a number rather than an invariant. "The build ran and
// everything it emitted is packed" is the property that holds for both.
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
