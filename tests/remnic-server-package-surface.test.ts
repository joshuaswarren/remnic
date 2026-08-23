import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(ROOT, "packages", "remnic-server");

test("@remnic/server build emits and advertises TypeScript declarations", async () => {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "pnpm.mjs"), "--filter", "@remnic/server", "run", "build"],
    {
      cwd: ROOT,
      encoding: "utf-8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  assert.equal(existsSync(path.join(SERVER_DIR, "dist", "index.d.ts")), true);

  const pkg = JSON.parse(await readFile(path.join(SERVER_DIR, "package.json"), "utf8")) as {
    types?: string;
    exports?: Record<string, { types?: string; import?: string; "remnic-source"?: string }>;
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.types, "./dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.import, "./dist/index.js");
  assert.equal(pkg.exports?.["."]?.["remnic-source"], "./src/index.ts");
  const srcTs = readdirSync(path.join(SERVER_DIR, "src"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `src/${name}`)
    .sort();
  assert.deepEqual([...(pkg.files ?? [])].sort(), ["bin/*.js", "dist", ...srcTs].sort());
  assert.match(pkg.scripts?.build ?? "", /\s--dts(\s|$)/);

  const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: SERVER_DIR,
    encoding: "utf-8",
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const packResult = JSON.parse(pack.stdout) as Array<{ files?: Array<{ path?: string }> }>;
  assert.equal(
    packResult[0]?.files?.some((file) => file.path === "src/index.ts"),
    true
  );
  assert.equal(
    packResult[0]?.files?.some((file) => file.path === "src/support-passport-runtime.ts"),
    true
  );
  assert.equal(
    packResult[0]?.files?.some((file) => file.path?.endsWith(".test.ts") === true),
    false
  );

  const packedRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-server-packed-source-"));
  try {
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packedRoot], {
      cwd: SERVER_DIR,
      encoding: "utf-8",
    });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const packedResult = JSON.parse(packed.stdout) as Array<{ filename?: string }>;
    const filename = packedResult[0]?.filename;
    assert.equal(typeof filename, "string");
    const extractedRoot = path.join(packedRoot, "extracted");
    await mkdir(extractedRoot);
    const extracted = spawnSync("tar", ["-xzf", path.join(packedRoot, filename as string), "-C", extractedRoot], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
    const packedPackage = path.join(extractedRoot, "package");
    const packedNodeModules = path.join(packedPackage, "node_modules");
    await symlink(path.join(ROOT, "node_modules"), packedNodeModules, "dir");
    const tsxLoader = pathToFileURL(path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const packedSourceEntry = pathToFileURL(path.join(packedPackage, "src", "index.ts")).href;
    const importCheck = `
      if (import.meta.resolve("@remnic/server") !== ${JSON.stringify(packedSourceEntry)}) process.exit(3);
      const api = await import("@remnic/server");
      if (typeof api.startServer !== "function") process.exit(2);
    `;
    const sourceImport = spawnSync(
      process.execPath,
      ["--import", tsxLoader, "--conditions=remnic-source", "--input-type=module", "--eval", importCheck],
      {
        cwd: packedPackage,
        encoding: "utf-8",
      }
    );
    assert.equal(sourceImport.status, 0, sourceImport.stderr || sourceImport.stdout);
  } finally {
    await rm(packedRoot, { recursive: true, force: true });
  }

  const api = await import(pathToFileURL(path.join(SERVER_DIR, "dist", "index.js")).href);
  assert.equal(typeof api.startServer, "function");

  const readme = await readFile(path.join(SERVER_DIR, "README.md"), "utf8");
  assert.match(readme, /import \{ startServer \} from "@remnic\/server"/);
  assert.doesNotMatch(readme, /import \{ createServer \} from "@remnic\/server"/);
});
