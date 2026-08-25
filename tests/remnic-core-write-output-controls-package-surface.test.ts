import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = path.join(repoRoot, "packages", "remnic-core");

type PackageJson = {
  files?: string[];
  exports?: Record<string, { types?: string; "remnic-source"?: string; import?: string }>;
};

test("@remnic/core exports write-output-controls on types, import, and pack surfaces", async () => {
  const pkg = JSON.parse(await readFile(path.join(coreRoot, "package.json"), "utf8")) as PackageJson;
  const expected = {
    types: "./dist/shared-context/write-output-controls.d.ts",
    "remnic-source": "./src/shared-context/write-output-controls.ts",
    import: "./dist/shared-context/write-output-controls.js",
  };

  assert.deepEqual(pkg.exports?.["./shared-context/write-output-controls"], expected);
  assert.deepEqual(pkg.exports?.["./shared-context/write-output-controls.js"], expected);
  assert.ok(pkg.files?.includes("src"), "pack includes remnic-source");
  assert.ok(pkg.files?.includes("dist"), "pack includes types and import");
  assert.equal(
    existsSync(path.join(coreRoot, "src", "shared-context", "write-output-controls.ts")),
    true,
  );

  const consumerRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-core-write-controls-"));
  try {
    const scopedDir = path.join(consumerRoot, "node_modules", "@remnic");
    await mkdir(scopedDir, { recursive: true });
    await symlink(coreRoot, path.join(scopedDir, "core"));
    const consumerPath = path.join(consumerRoot, "consumer.mjs");
    const specs = [
      "@remnic/core/shared-context/write-output-controls",
      "@remnic/core/shared-context/write-output-controls.js",
    ];
    await writeFile(
      consumerPath,
      `for (const spec of ${JSON.stringify(specs)}) {\n  console.log(spec + "\\t" + import.meta.resolve(spec));\n}\n`,
    );
    const result = spawnSync(process.execPath, [consumerPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const line of result.stdout.trim().split("\n")) {
      const tab = line.indexOf("\t");
      const spec = line.slice(0, tab);
      const resolved = line.slice(tab + 1);
      assert.match(
        resolved,
        /\/shared-context\/write-output-controls(?:\.(?:js|ts))?$/,
        `${spec} resolved to ${resolved}`,
      );
    }
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
});
