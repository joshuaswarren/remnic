import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_CLI_SHIMS = [
  ["src/access-cli.ts", "@remnic/core/access-cli"],
  ["src/cli.ts", "@remnic/core/cli"],
] as const;

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
  ["src/memory-projection-format.ts", "@remnic/core/memory-projection-format"],
  ["src/model-registry.ts", "@remnic/core/model-registry"],
  ["src/orchestrator.ts", "@remnic/core/orchestrator"],
] as const;

const ROOT_PACKAGE_ENTRIES = [...ROOT_CLI_SHIMS, ...ROOT_CONNECTOR_SHIMS] as const;

describe("root CLI package boundaries", () => {
  for (const [filePath, publicSpecifier] of [
    ...ROOT_PACKAGE_ENTRIES,
    ...ROOT_CORE_SOURCE_SHIMS,
  ] as const) {
    it(`${filePath} uses the public @remnic/core package export`, () => {
      const source = readFileSync(resolve(filePath), "utf8");

      assert.ok(
        source.includes(`from "${publicSpecifier}"`),
        `${filePath} should import ${publicSpecifier}`,
      );
      assert.doesNotMatch(
        source,
        /packages\/remnic-core\/src/,
        `${filePath} must not import core private source paths`,
      );
    });
  }

  it("root build prepares core public subpath artifacts before bundling shims", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: { build?: string };
    };
    const buildScript = manifest.scripts?.build ?? "";
    const coreBuild = "pnpm --filter @remnic/core build";
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

  it("root package exposes each CLI shim through package exports and build entries", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      exports?: Record<string, { import?: string }>;
    };
    const tsupConfig = readFileSync(resolve("tsup.config.ts"), "utf8");

    for (const [filePath] of ROOT_PACKAGE_ENTRIES) {
      const subpath = `./${filePath
        .replace(/^src\//, "")
        .replace(/\/index\.ts$/, "")
        .replace(/\.ts$/, "")}`;
      const distPath = `./dist/${filePath
        .replace(/^src\//, "")
        .replace(/\.ts$/, ".js")}`;

      assert.equal(
        manifest.exports?.[subpath]?.import,
        distPath,
        `${subpath} must resolve to ${distPath} through package exports`,
      );
      assert.ok(
        tsupConfig.includes(`"${filePath}"`) ||
          tsupConfig.includes(`'${filePath}'`),
        `${filePath} must be a root tsup entry so ${distPath} exists after build`,
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

    for (const [, publicSpecifier] of ROOT_CORE_SOURCE_SHIMS) {
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
        typesPath,
        `${publicSpecifier} must publish declarations`,
      );
    }
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
