import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const shimPackageJsonPath = new URL("../packages/shim-openclaw-engram/package.json", import.meta.url);
const shimManifestPath = new URL("../packages/shim-openclaw-engram/openclaw.plugin.json", import.meta.url);
const shimSourcePath = new URL("../packages/shim-openclaw-engram/src/index.ts", import.meta.url);
const bannerScriptPath = new URL("../packages/shim-openclaw-engram/scripts/postinstall-banner.mjs", import.meta.url);

test("Phase C shim package keeps its source manifest aligned", async () => {
  const raw = await readFile(shimPackageJsonPath, "utf8");
  const manifestRaw = await readFile(shimManifestPath, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  const bin = pkg.bin as Record<string, string>;
  const exportsMap = pkg.exports as Record<string, { import: string }>;
  const dependencies = pkg.dependencies as Record<string, string>;

  assert.equal(pkg.name, "@joshuaswarren/openclaw-engram");
  assert.equal(pkg.version, manifest.version);
  assert.equal(bin["engram-access"], "./bin/engram-access.js");
  assert.equal(exportsMap["."].import, "./dist/index.js");
  assert.equal(exportsMap["./access-cli"].import, "./dist/access-cli.js");
  assert.equal(dependencies["@remnic/plugin-openclaw"], "^1.0.36");
  assert.equal(dependencies["@remnic/core"], "^1.1.12");
});

test("Phase C shim register binds the legacy plugin id even when called unbound", async () => {
  const source = await readFile(shimSourcePath, "utf8");

  assert.match(source, /id:\s*"openclaw-engram"\s+as\s+const/);
  assert.match(
    source,
    /remnicPluginDefinition\.register\.call\(shimPluginDefinition,\s*api\)/,
  );
});

test("Phase C shim package includes the rename postinstall banner script", async () => {
  const bannerScript = await readFile(bannerScriptPath, "utf8");

  assert.match(bannerScript, /Engram is now Remnic/);
  assert.match(bannerScript, /https:\/\/remnic\.ai\/rename/);
});
