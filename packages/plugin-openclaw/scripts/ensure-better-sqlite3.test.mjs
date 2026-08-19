import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("plugin-openclaw better-sqlite3 postinstall wiring", () => {
  it("manifest postinstall runs the packaged ensure script", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    );

    assert.equal(
      manifest.scripts?.postinstall,
      "node ./scripts/ensure-better-sqlite3.mjs",
      "plugin postinstall must run the packaged root-level script copy",
    );
  });

  it("manifest files includes the ensure script so the tarball ships it", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    );

    assert.ok(
      manifest.files?.includes("scripts/ensure-better-sqlite3.mjs"),
      "plugin package files must include the postinstall helper",
    );
  });

  it("shipped script is byte-identical to the remnic-core copy", () => {
    const pluginCopy = readFileSync(resolve(here, "ensure-better-sqlite3.mjs"));
    const coreCopy = readFileSync(
      resolve(here, "../../remnic-core/scripts/ensure-better-sqlite3.mjs"),
    );

    assert.ok(pluginCopy.equals(coreCopy), "script copies must stay in sync");
  });

  it("script never fetches an unpinned node-gyp", () => {
    const text = readFileSync(resolve(here, "ensure-better-sqlite3.mjs"), "utf8");

    assert.doesNotMatch(
      text,
      /--yes/,
      "script must not implicitly fetch node-gyp via --yes",
    );
    assert.match(
      text,
      /--build-from-source/,
      "script must name the build-from-source recovery command",
    );
    assert.match(
      text,
      /process\.versions\.modules/,
      "script must surface the running ABI on failure",
    );
  });
});
