import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const tsupConfigUrl = new URL("../tsup.config.ts", import.meta.url);

test("@remnic/capture-screen preserves dependency-light package configuration", async () => {
  const raw = await readFile(packageJsonUrl, "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(
    pkg.dependencies?.["@remnic/core"],
    undefined,
    "@remnic/capture-screen must not carry @remnic/core in runtime dependencies",
  );
  assert.equal(
    pkg.peerDependencies?.["@remnic/core"],
    undefined,
    "@remnic/capture-screen must not require @remnic/core as a peer dependency",
  );
  assert.equal(
    pkg.devDependencies?.["@remnic/core"],
    "workspace:*",
    "@remnic/capture-screen must keep @remnic/core as a dev dependency for source and build",
  );
});

test("@remnic/capture-screen configures tsup to bundle @remnic/core/activity/digest", async () => {
  const tsupRaw = await readFile(tsupConfigUrl, "utf8");
  assert.ok(
    tsupRaw.includes('noExternal: ["@remnic/core/activity/digest"]'),
    "tsup config must bundle @remnic/core/activity/digest via noExternal so built dist has no runtime @remnic/core import",
  );
  assert.doesNotMatch(
    tsupRaw,
    /remnic-core\/src/,
    "tsup config must not contain private remnic-core/src source alias hacks",
  );
});

test("built dist artifacts (if present) have no runtime @remnic/core imports", async () => {
  for (const file of ["dist/index.js", "dist/cli-bin.js"]) {
    const fileUrl = new URL(`../${file}`, import.meta.url);
    try {
      const content = await readFile(fileUrl, "utf8");
      assert.doesNotMatch(
        content,
        /from\s+["']@remnic\/core(\/[^"']*)?["']|import\s*\(\s*["']@remnic\/core(\/[^"']*)?["']\s*\)|require\s*\(\s*["']@remnic\/core(\/[^"']*)?["']\s*\)/,
        `${file} must not contain runtime imports from @remnic/core`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
});
