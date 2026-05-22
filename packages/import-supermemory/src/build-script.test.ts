import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type PackageJson = {
  scripts?: Record<string, string>;
};

test("package build cleans dist before emitting publish artifacts", async () => {
  const raw = await readFile(path.join(packageRoot, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as PackageJson;

  assert.match(pkg.scripts?.build ?? "", /\btsup\b/);
  assert.match(pkg.scripts?.build ?? "", /(?:^|\s)--clean(?:\s|$)/);
  assert.equal(pkg.scripts?.prepublishOnly, "npm run build");
});
