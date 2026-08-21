import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lifecycleScriptNames = new Set(["preinstall", "install", "postinstall"]);

type PackageJson = {
  files?: string[];
  scripts?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

function nodeScriptTarget(command: string): string | null {
  const match = command.match(/^node\s+(\S+)/);
  return match ? normalizePackagePath(match[1]) : null;
}

function normalizePackagePath(value: string): string {
  return value.replace(/^\.\//, "").split(posix.sep).join(posix.sep);
}

function filesInclude(target: string, files: string[]): boolean {
  return files.some((entry) => {
    const normalizedEntry = normalizePackagePath(entry).replace(/\/$/, "");
    return target === normalizedEntry || target.startsWith(`${normalizedEntry}/`);
  });
}

test("root lifecycle script targets are included in packed files", () => {
  const pkg = readPackageJson();
  const files = pkg.files ?? [];
  const missingTargets: string[] = [];

  for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
    if (!lifecycleScriptNames.has(scriptName)) continue;
    const target = nodeScriptTarget(command);
    if (!target) continue;

    assert.equal(
      existsSync(join(repoRoot, target)),
      true,
      `${scriptName} target ${target} must exist in the repository`,
    );
    if (!filesInclude(target, files)) {
      missingTargets.push(target);
    }
  }

  assert.deepEqual(missingTargets, []);
});
