import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(ROOT, "packages", "remnic-server");

test("@remnic/server build emits and advertises TypeScript declarations", async () => {
  const result = spawnSync("pnpm", ["--filter", "@remnic/server", "run", "build"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
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
  assert.deepEqual(pkg.files, [
    "bin/*.js",
    "dist",
    "src/index.ts",
    "src/oauth.ts",
    "src/server-env.ts",
    "src/startup-readiness.ts",
  ]);
  assert.match(pkg.scripts?.build ?? "", /\s--dts(\s|$)/);

  const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: SERVER_DIR,
    encoding: "utf-8",
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const packResult = JSON.parse(pack.stdout) as Array<{ files?: Array<{ path?: string }> }>;
  assert.equal(packResult[0]?.files?.some((file) => file.path === "src/index.ts"), true);
  assert.equal(packResult[0]?.files?.some((file) => file.path?.endsWith(".test.ts") === true), false);

  const api = await import(pathToFileURL(path.join(SERVER_DIR, "dist", "index.js")).href);
  assert.equal(typeof api.startServer, "function");

  const readme = await readFile(path.join(SERVER_DIR, "README.md"), "utf8");
  assert.match(readme, /import \{ startServer \} from "@remnic\/server"/);
  assert.doesNotMatch(readme, /import \{ createServer \} from "@remnic\/server"/);
});
