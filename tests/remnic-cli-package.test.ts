import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("remnic CLI keeps optional à-la-carte packages external and loads them via dynamic imports", async () => {
  const [pkgRaw, tsupRaw, optionalBench, optionalWeclone, optionalOpenclaw, indexSource] =
    await Promise.all([
      readFile("packages/remnic-cli/package.json", "utf8"),
      readFile("packages/remnic-cli/tsup.config.ts", "utf8"),
      readFile("packages/remnic-cli/src/optional-bench.ts", "utf8"),
      readFile("packages/remnic-cli/src/optional-weclone-export.ts", "utf8"),
      readFile("packages/remnic-cli/src/openclaw-managed-upgrade-loader.ts", "utf8"),
      readFile("packages/remnic-cli/src/index.ts", "utf8"),
    ]);
  const pkg = JSON.parse(pkgRaw) as {
    scripts?: { prebuild?: string; build?: string };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  // Build wiring stays intact — prebuild still ensures the monorepo sibling
  // builds exist for local dev runs, and tsup produces dist/index.js.
  assert.equal(
    pkg.scripts?.prebuild,
    "node ../../scripts/ensure-cli-bench-build-deps.mjs",
  );
  assert.match(
    pkg.scripts?.build ?? "",
    /^tsup --config tsup\.config\.ts(\s+&&\s+.+)?$/,
  );

  // À-la-carte invariant (see AGENTS.md §44 / CLAUDE.md gotcha #57):
  // optional companion packages must stay external in the bundler config
  // and must not appear under runtime dependencies. They belong under
  // peerDependencies with peerDependenciesMeta marking them optional.
  assert.match(tsupRaw, /external:[\s\S]*?"@remnic\/bench"/);
  assert.match(tsupRaw, /external:[\s\S]*?"@remnic\/export-weclone"/);
  assert.match(tsupRaw, /external:[\s\S]*?"@remnic\/import-weclone"/);
  assert.match(tsupRaw, /external:[\s\S]*?"@remnic\/plugin-openclaw"/);
  assert.doesNotMatch(tsupRaw, /noExternal:[\s\S]*?"@remnic\/bench"/);
  assert.doesNotMatch(tsupRaw, /noExternal:[\s\S]*?"@remnic\/export-weclone"/);

  assert.equal(pkg.dependencies?.["@remnic/bench"], undefined);
  assert.equal(pkg.dependencies?.["@remnic/export-weclone"], undefined);
  assert.equal(pkg.dependencies?.["@remnic/import-weclone"], undefined);
  assert.equal(pkg.dependencies?.["@remnic/plugin-openclaw"], undefined);

  for (const name of [
    "@remnic/bench",
    "@remnic/export-weclone",
    "@remnic/import-weclone",
    "@remnic/plugin-openclaw",
  ]) {
    const peerSpec = pkg.peerDependencies?.[name];
    assert.ok(peerSpec, `${name} missing from peerDependencies`);
    assert.equal(
      pkg.peerDependenciesMeta?.[name]?.optional,
      true,
      `${name} must be marked optional in peerDependenciesMeta`,
    );
  }

  // Loaders use computed specifiers so bundlers cannot statically resolve
  // the module — otherwise esbuild/tsup will happily inline it even with
  // external set, defeating the à-la-carte contract.
  assert.match(optionalBench, /"@remnic\/"\s*\+\s*"bench"/);
  assert.match(optionalWeclone, /"@remnic\/"\s*\+\s*"export-weclone"/);
  assert.match(optionalOpenclaw, /"@remnic\/"\s*\+\s*"plugin-openclaw\/managed-upgrade"/);

  // The CLI entry must reach the optional packages via the loaders, not via
  // direct static imports.
  assert.match(indexSource, /from "\.\/optional-bench\.js"/);
  assert.match(indexSource, /from "\.\/optional-weclone-export\.js"/);
  assert.match(indexSource, /from "\.\/openclaw-managed-upgrade-loader\.js"/);
  // A bare `from "@remnic/bench"` (without `import type`) would be a
  // static runtime import that bundles the package — forbidden.
  assert.doesNotMatch(
    indexSource,
    /^import\s+(?!type\b)[^;]*from "@remnic\/bench";?$/m,
  );
  assert.doesNotMatch(
    indexSource,
    /^import\s+(?!type\b)[^;]*from "@remnic\/export-weclone";?$/m,
  );
  assert.doesNotMatch(
    indexSource,
    /^import\s+(?!type\b)[^;]*from "@remnic\/plugin-openclaw(?:\/[^"]*)?";?$/m,
  );
});
