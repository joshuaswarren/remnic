import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "validate-config-contract.ts");
// Resolve tsx's real JS CLI entry rather than the node_modules/.bin/tsx shim:
// under pnpm on CI the shim is a POSIX shell script, and `node <shell-shim>`
// throws "SyntaxError: missing ) after argument list". Running node against the
// .mjs entry works regardless of how the bin shim was materialized.
const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

test("config contract validator scans PluginConfig wrapper contextual types", () => {
  withConfigFixture((fixtureRoot) => {
    const result = spawnSync(process.execPath, [tsxCli, SCRIPT], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: process.env,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownExact"/);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownPartial"/);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownRequired"/);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownAlias"/);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownIntersection"/);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownScoped"/);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownNested"/);
    assert.match(result.stderr, /Unknown PluginConfig key "unknownIndexedNested"/);
    assert.doesNotMatch(result.stderr, /Unknown PluginConfig key "extraScope"/);
    assert.doesNotMatch(result.stderr, /Unknown PluginConfig key "default"/);
    assert.doesNotMatch(result.stderr, /Unknown PluginConfig key "production"/);
  });
});

function withConfigFixture(fn: (fixtureRoot: string) => void) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-config-contract-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "packages", "remnic-core", "src"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(fixtureRoot, "tests"), { recursive: true });

    fs.writeFileSync(
      path.join(fixtureRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            target: "ES2022",
          },
          include: ["packages/**/*.ts", "tests/**/*.ts"],
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "openclaw.plugin.json"),
      JSON.stringify(
        {
          configSchema: {
            properties: {
              enabled: { type: "boolean" },
              label: { type: "string" },
            },
          },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "packages", "remnic-core", "src", "types.ts"),
      ["export interface PluginConfig {", "  enabled?: boolean;", "  label?: string;", "}", ""].join("\n")
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "packages", "remnic-core", "src", "config.ts"),
      [
        'import type { PluginConfig } from "./types.js";',
        "",
        "export function parseConfig(): PluginConfig {",
        '  return { enabled: true, label: "ok" };',
        "}",
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "tests", "config-fixture.ts"),
      [
        'import type { PluginConfig } from "../packages/remnic-core/src/types.js";',
        "",
        "type AliasConfig = Partial<PluginConfig>;",
        "type IntersectionConfig = Partial<PluginConfig> & { label?: string };",
        "type ScopedConfig = Partial<PluginConfig> & { extraScope?: string };",
        "type IndexedConfigMap = Record<string, PluginConfig> & Partial<PluginConfig>;",
        "",
        "const exact: PluginConfig = { unknownExact: true };",
        "const partial: Partial<PluginConfig> = { unknownPartial: true };",
        "const required: Required<PluginConfig> = {",
        "  enabled: true,",
        '  label: "ok",',
        "  unknownRequired: true,",
        "};",
        "const alias: AliasConfig = { unknownAlias: true };",
        "const intersection: IntersectionConfig = { unknownIntersection: true };",
        'const scoped: ScopedConfig = { extraScope: "ok", unknownScoped: true };',
        "const configMap: Record<string, PluginConfig> = {",
        "  default: { enabled: true },",
        "  production: { unknownNested: true },",
        "};",
        "const indexedConfigMap: IndexedConfigMap = {",
        "  production: { unknownIndexedNested: true },",
        "};",
        "",
        "void exact;",
        "void partial;",
        "void required;",
        "void alias;",
        "void intersection;",
        "void scoped;",
        "void configMap;",
        "void indexedConfigMap;",
        "",
      ].join("\n")
    );

    fn(fixtureRoot);
  } finally {
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  }
}
