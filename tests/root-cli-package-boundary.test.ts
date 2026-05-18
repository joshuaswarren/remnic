import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_CLI_SHIMS = [
  ["src/access-cli.ts", "@remnic/core/access-cli"],
  ["src/cli.ts", "@remnic/core/cli"],
] as const;

describe("root CLI package boundaries", () => {
  for (const [filePath, publicSpecifier] of ROOT_CLI_SHIMS) {
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
});
