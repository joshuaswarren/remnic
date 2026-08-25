import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_CONNECTOR_SHIMS = [
  ["src/connectors/index.ts", "@remnic/core/connectors"],
  [
    "src/connectors/codex-materialize.ts",
    "@remnic/core/connectors/codex-materialize",
  ],
  [
    "src/connectors/codex-materialize-runner.ts",
    "@remnic/core/connectors/codex-materialize-runner",
  ],
] as const;

const ROOT_CORE_SOURCE_SHIMS = [
  "@remnic/core/memory-projection-format",
  "@remnic/core/model-registry",
  "@remnic/core/models-json",
  "@remnic/core/orchestrator",
  "@remnic/core/session-integrity",
] as const;

describe("root CLI package boundaries", () => {
  it("root build prepares core public subpath artifacts before bundling remaining root entries", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: { build?: string };
    };
    const buildScript = manifest.scripts?.build ?? "";
    const coreBuild = "node scripts/pnpm.mjs --filter @remnic/core build";
    const rootBundle = "tsup";

    assert.ok(
      buildScript.includes(coreBuild),
      "root build should build @remnic/core before relying on its public subpath exports",
    );
    assert.ok(
      buildScript.indexOf(coreBuild) < buildScript.indexOf(rootBundle),
      "root build should prepare @remnic/core dist before running root tsup",
    );
  });

  it("collapsed CLI subpaths alias the core package export contract", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      exports?: Record<string, { import?: string }>;
    };

    for (const specifier of [
      "./access-cli",
      "./cli",
      "./connectors",
      "./connectors/codex-materialize",
      "./connectors/codex-materialize-runner",
    ]) {
      assert.match(
        manifest.exports?.[specifier]?.import ?? "",
        /^\.\/packages\/remnic-core\//,
        `${specifier} must alias the workspace core build`,
      );
    }
  });

  it("core package exposes connector shims through public exports and build entries", () => {
    const manifest = JSON.parse(
      readFileSync(resolve("packages/remnic-core/package.json"), "utf8"),
    ) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const tsupConfig = readFileSync(resolve("packages/remnic-core/tsup.config.ts"), "utf8");

    for (const [coreFilePath, publicSpecifier] of ROOT_CONNECTOR_SHIMS) {
      const subpath = publicSpecifier.replace(/^@remnic\/core/, ".");
      const distPath = `./dist/${coreFilePath
        .replace(/^src\//, "")
        .replace(/\.ts$/, ".js")}`;
      const typesPath = distPath.replace(/\.js$/, ".d.ts");

      assert.equal(
        manifest.exports?.[subpath]?.import,
        distPath,
        `${subpath} must resolve to ${distPath} through @remnic/core exports`,
      );
      assert.equal(
        manifest.exports?.[subpath]?.types,
        typesPath,
        `${subpath} must publish declarations at ${typesPath}`,
      );
      assert.ok(
        tsupConfig.includes(`"${coreFilePath}"`) ||
          tsupConfig.includes(`'${coreFilePath}'`),
        `${coreFilePath} must be a core tsup entry so ${distPath} exists after build`,
      );
    }
  });

  it("core package exposes the contradiction module through public exports", () => {
    const manifest = JSON.parse(
      readFileSync(resolve("packages/remnic-core/package.json"), "utf8"),
    ) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const tsupConfig = readFileSync(resolve("packages/remnic-core/tsup.config.ts"), "utf8");

    assert.equal(
      manifest.exports?.["./contradiction"]?.import,
      "./dist/contradiction/index.js",
      "@remnic/core/contradiction must resolve to the built contradiction entrypoint",
    );
    assert.equal(
      manifest.exports?.["./contradiction"]?.types,
      "./dist/contradiction/index.d.ts",
      "@remnic/core/contradiction must publish declaration files",
    );
    assert.ok(
      tsupConfig.includes('"src/contradiction/index.ts"') ||
        tsupConfig.includes("'src/contradiction/index.ts'"),
      "src/contradiction/index.ts must be a core tsup entry so the exported subpath exists after build",
    );
  });

  it("core package exposes root source shim dependencies through public exports", () => {
    const manifest = JSON.parse(
      readFileSync(resolve("packages/remnic-core/package.json"), "utf8"),
    ) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };

    for (const publicSpecifier of ROOT_CORE_SOURCE_SHIMS) {
      const subpath = publicSpecifier.replace(/^@remnic\/core/, ".");
      const distPath = `./dist/${subpath.replace(/^\.\//, "")}.js`;
      const typesPath = distPath.replace(/\.js$/, ".d.ts");

      assert.equal(
        manifest.exports?.[subpath]?.import,
        distPath,
        `${publicSpecifier} must resolve through @remnic/core exports`,
      );
      assert.equal(
        manifest.exports?.[subpath]?.types,
        manifest.exports?.[subpath]?.types === typesPath
          ? typesPath
          : `./src/${subpath.replace(/^\.\//, "")}.ts`,
        `${publicSpecifier} must publish declarations`,
      );
    }
  });

  it("core package exposes bulk-import helpers through the main entrypoint and public subpath", () => {
    const source = readFileSync(resolve("packages/remnic-core/src/index.ts"), "utf8");
    const manifest = JSON.parse(
      readFileSync(resolve("packages/remnic-core/package.json"), "utf8"),
    ) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const tsupConfig = readFileSync(resolve("packages/remnic-core/tsup.config.ts"), "utf8");

    for (const symbol of [
      "validateBatchSize",
      "resolveBulkImportContext",
      "type ProcessBatchContext",
    ]) {
      assert.ok(
        source.includes(symbol),
        `@remnic/core main entrypoint must re-export ${symbol}`,
      );
    }

    for (const subpath of [
      "./bulk-import",
      "./bulk-import.js",
      "./bulk-import/index",
      "./bulk-import/index.js",
    ]) {
      assert.equal(
        manifest.exports?.[subpath]?.import,
        "./dist/bulk-import/index.js",
        `${subpath} must resolve to the built bulk-import public entrypoint`,
      );
      assert.equal(
        manifest.exports?.[subpath]?.types,
        "./dist/bulk-import/index.d.ts",
        `${subpath} must publish bulk-import declarations`,
      );
    }

    assert.ok(
      tsupConfig.includes("publicExportEntryFiles"),
      "core tsup config must derive nested entries from package exports",
    );
  });

  it("root postinstall runs a root-level script included in the package files", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      files?: string[];
      scripts?: { postinstall?: string };
    };
    const postinstall = manifest.scripts?.postinstall ?? "";
    const postinstallHelper = readFileSync(
      resolve("scripts/ensure-better-sqlite3.mjs"),
      "utf8",
    );

    assert.equal(
      postinstall,
      "node scripts/ensure-better-sqlite3.mjs",
      "root postinstall should not depend on workspace-internal package paths",
    );
    assert.ok(
      manifest.files?.includes("scripts/ensure-better-sqlite3.mjs"),
      "root package files must include the postinstall helper",
    );
    assert.doesNotMatch(
      postinstall,
      /packages\/remnic-core\//,
      "root postinstall must use a stable root-level published path",
    );
    assert.doesNotMatch(
      postinstallHelper,
      /packages\/remnic-core\//,
      "root postinstall helper must not delegate through workspace-internal paths",
    );
  });
});
