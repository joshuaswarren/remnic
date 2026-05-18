import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

if (process.env.REMNIC_SKIP_BETTER_SQLITE3_VERIFY === "1") {
  console.log("[remnic] Skipping better-sqlite3 verification by request.");
  process.exit(0);
}

try {
  verifyBetterSqlite3();
  console.log("[remnic] better-sqlite3 native binding verified.");
  process.exit(0);
} catch (error) {
  console.warn(`[remnic] better-sqlite3 verification failed: ${errorMessage(error)}`);
}

const packageDir = betterSqlite3PackageDir();
if (!packageDir) {
  console.error("[remnic] Could not resolve better-sqlite3/package.json.");
  process.exit(1);
}

const rebuild = rebuildBetterSqlite3(packageDir);
if (!rebuild.ok) {
  console.error("[remnic] better-sqlite3 native rebuild failed.");
  if (rebuild.output) console.error(rebuild.output);
  console.error(
    `[remnic] Try manually from this install directory: npx node-gyp rebuild --directory=${packageDir}`,
  );
  process.exit(rebuild.status ?? 1);
}

try {
  clearBetterSqlite3RequireCache(packageDir);
  verifyBetterSqlite3();
  console.log("[remnic] better-sqlite3 native binding rebuilt and verified.");
} catch (error) {
  console.error(
    `[remnic] better-sqlite3 rebuild completed but the binding still does not load: ${errorMessage(error)}`,
  );
  process.exit(1);
}

function verifyBetterSqlite3() {
  const loaded = require("better-sqlite3");
  const Database = typeof loaded === "function" ? loaded : loaded?.default;
  if (typeof Database !== "function") {
    throw new Error("module did not export a constructor");
  }
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  db.close();
}

function betterSqlite3PackageDir() {
  try {
    return path.dirname(require.resolve("better-sqlite3/package.json"));
  } catch {
    return null;
  }
}

function rebuildBetterSqlite3(cwd) {
  const localNodeGyp = resolveOptional("node-gyp/bin/node-gyp.js");
  if (localNodeGyp) {
    return runRebuild(process.execPath, [localNodeGyp, "rebuild", "--release"], cwd);
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return runRebuild(
    npm,
    ["exec", "--yes", "node-gyp", "--", "rebuild", "--release"],
    cwd,
  );
}

function resolveOptional(specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

function runRebuild(command, args, cwd) {
  console.log(`[remnic] Rebuilding better-sqlite3 native binding in ${cwd}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_build_from_source: "true",
    },
    windowsHide: true,
  });

  return {
    ok: result.status === 0,
    status: result.status,
    output: [
      result.error ? String(result.error) : "",
      result.stdout ?? "",
      result.stderr ?? "",
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n")
      .trim(),
  };
}

function clearBetterSqlite3RequireCache(packageDir) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(packageDir)) {
      delete require.cache[key];
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
