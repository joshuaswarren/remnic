import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(packageRoot, "src");

test("OpenClaw plugin imports Remnic core through package exports", async () => {
  const violations: string[] = [];
  const forbiddenCoreSourcePattern = new RegExp(
    String.raw`(?:^|['"])` +
      String.raw`(?:\.\./)+` +
      String.raw`(?:packages/)?remnic-core/src(?:/|\.|['"])`,
  );

  for (const filePath of await listTypeScriptFiles(sourceRoot)) {
    const source = await readFile(filePath, "utf8");
    if (forbiddenCoreSourcePattern.test(source)) {
      violations.push(path.relative(packageRoot, filePath));
    }
  }

  assert.deepEqual(violations, []);
});

test("OpenClaw plugin type-check config resolves @remnic/core to one source surface", async () => {
  const tsconfig = await readFile(
    path.join(packageRoot, "tsconfig.check.json"),
    "utf8",
  );
  const config = JSON.parse(tsconfig) as {
    compilerOptions?: { paths?: Record<string, unknown> };
  };
  const paths = config.compilerOptions?.paths ?? {};
  assert.deepEqual(paths["@remnic/core"], [
    "packages/remnic-core/src/index.ts",
  ]);
  assert.deepEqual(paths["@remnic/core/*"], [
    "packages/remnic-core/src/*",
  ]);

  for (const [key, value] of Object.entries(paths)) {
    if (key === "@remnic/core" || key.startsWith("@remnic/core/")) {
      assert.ok(
        Array.isArray(value) &&
          value.every((entry) =>
            typeof entry === "string" &&
            entry.startsWith("packages/remnic-core/src/"),
          ),
      );
    }
  }
});

test("OpenClaw plugin publishes a concrete @remnic/core runtime lower bound", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(manifest.dependencies?.["@remnic/core"], "^1.1.12");
  assert.equal(manifest.devDependencies?.["@remnic/core"], "workspace:^");
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(entryPath);
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        return [entryPath];
      }
      return [];
    }),
  );
  return files.flat().sort();
}
