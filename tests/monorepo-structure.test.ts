import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.join(ROOT, "packages");
const require = createRequire(import.meta.url);
const semver = require("semver") as {
  satisfies(version: string, range: string): boolean;
};

const OPENCLAW_MIN_HOST_VERSION_FLOOR = ">=2026.4.1";
const OPENCLAW_SUPPORT_PROBE_VERSIONS = [
  "2026.4.1",
  "2026.4.9-beta.1",
  "2026.5.30-beta.1",
  "2026.5.31-alpha.1",
  "2026.5.31-beta.1",
  "2026.5.31-beta.2",
  "2026.5.31-beta.3",
  "2026.5.31-beta.4",
  "2026.6.1-alpha.1",
  "2026.6.1-alpha.2",
  "2026.6.1-alpha.3",
  "2026.6.1-beta.1",
  "2026.6.1-beta.2",
  "2026.6.1-beta.3",
  "2026.6.2-alpha.1",
  "2026.6.2-alpha.2",
  "2026.6.2-beta.1",
  "2026.6.3-alpha.1",
  "2026.6.4-alpha.1",
  "2026.6.5-alpha.1",
  "2026.6.5-alpha.2",
  "2026.6.5-beta.1",
  "2026.6.5-beta.2",
  "2026.6.6-alpha.1",
];

// Expected packages after the monorepo migration
const EXPECTED_PACKAGES = [
  { dir: "remnic-core", name: "@remnic/core" },
  { dir: "remnic-server", name: "@remnic/server" },
  { dir: "remnic-cli", name: "@remnic/cli" },
  { dir: "plugin-openclaw", name: "@remnic/plugin-openclaw" },
  { dir: "plugin-claude-code", name: "@remnic/plugin-claude-code" },
  { dir: "plugin-codex", name: "@remnic/plugin-codex" },
  { dir: "connector-replit", name: "@remnic/replit" },
  { dir: "bench", name: "@remnic/bench" },
];

// Packages that must exist NOW (renamed to target names)
const REQUIRED_NOW = [
  "remnic-core",
  "remnic-server",
  "remnic-cli",
];

test("packages/ directory exists", () => {
  assert.ok(fs.existsSync(PACKAGES_DIR), "packages/ directory must exist");
});

test("each required package has a package.json", () => {
  const dirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const req of REQUIRED_NOW) {
    const found = dirs.some((d) => d === req);
    assert.ok(found, `Required package "${req}" must exist in packages/`);

    const dirName = dirs.find((d) => d === req)!;
    const pkgJsonPath = path.join(PACKAGES_DIR, dirName, "package.json");
    assert.ok(fs.existsSync(pkgJsonPath), `${dirName}/package.json must exist`);
  }
});

test("every package.json has required fields", () => {
  const dirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const dir of dirs) {
    const pkgJsonPath = path.join(PACKAGES_DIR, dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

    assert.ok(typeof pkg.name === "string" && pkg.name.length > 0,
      `${dir}/package.json must have a non-empty "name" field`);

    assert.ok(typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version),
      `${dir}/package.json must have a valid semver "version" (got "${pkg.version}")`);

    assert.equal(pkg.type, "module",
      `${dir}/package.json must have "type": "module"`);
  }
});

test("no circular dependencies between packages", () => {
  const dirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Build dependency graph
  const graph = new Map<string, Set<string>>();
  const nameToDir = new Map<string, string>();

  for (const dir of dirs) {
    const pkgJsonPath = path.join(PACKAGES_DIR, dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    nameToDir.set(pkg.name, dir);
    graph.set(pkg.name, new Set());

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    for (const dep of Object.keys(allDeps)) {
      // Only track internal workspace deps
      if (dep.startsWith("@remnic/")) {
        graph.get(pkg.name)!.add(dep);
      }
    }
  }

  // Detect cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) return [...path, node];
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);

    for (const dep of graph.get(node) ?? []) {
      const cycle = hasCycle(dep, [...path, node]);
      if (cycle) return cycle;
    }

    inStack.delete(node);
    return null;
  }

  for (const name of graph.keys()) {
    const cycle = hasCycle(name, []);
    assert.equal(cycle, null,
      `Circular dependency detected: ${cycle?.join(" → ")}`);
  }
});

test("root package.json lists workspaces", () => {
  const rootPkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));

  assert.ok(
    Array.isArray(pkg.workspaces) || (pkg.workspaces && Array.isArray(pkg.workspaces.packages)),
    "Root package.json must have a workspaces field",
  );
});

test("plugin-openclaw publishes under the Remnic scope", () => {
  const pkgJsonPath = path.join(PACKAGES_DIR, "plugin-openclaw", "package.json");
  assert.ok(fs.existsSync(pkgJsonPath), "plugin-openclaw/package.json must exist");

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  assert.equal(
    pkg.name,
    "@remnic/plugin-openclaw",
    `OpenClaw plugin package must be named "@remnic/plugin-openclaw" (got "${pkg.name}")`,
  );
});

test("published OpenClaw packages support the rolling 60-day OpenClaw window", () => {
  for (const packageDir of ["plugin-openclaw", "shim-openclaw-engram"]) {
    const pkgJsonPath = path.join(PACKAGES_DIR, packageDir, "package.json");
    assert.ok(fs.existsSync(pkgJsonPath), `${packageDir}/package.json must exist`);

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const peerRange = pkg.peerDependencies?.openclaw;
    const pluginApiRange = pkg.openclaw?.compat?.pluginApi;

    assert.equal(typeof peerRange, "string", `${packageDir} must declare an OpenClaw peer range`);
    assert.equal(
      pluginApiRange,
      peerRange,
      `${packageDir} must keep openclaw.compat.pluginApi aligned with peerDependencies.openclaw`,
    );
    assert.equal(
      pkg.openclaw?.install?.minHostVersion,
      OPENCLAW_MIN_HOST_VERSION_FLOOR,
      `${packageDir} must keep minHostVersion as the stable 60-day support floor`,
    );

    for (const version of OPENCLAW_SUPPORT_PROBE_VERSIONS) {
      assert.equal(
        semver.satisfies(version, peerRange),
        true,
        `${packageDir} peer range must accept OpenClaw ${version}`,
      );
      assert.equal(
        semver.satisfies(version, pluginApiRange),
        true,
        `${packageDir} plugin API range must accept OpenClaw ${version}`,
      );
    }
  }
});

test("non-shim openclaw.plugin.json manifests carry the slot hint phrase", () => {
  const SLOT_HINT = "plugins.slots.memory";
  for (const manifestPath of [
    path.join(ROOT, "openclaw.plugin.json"),
    path.join(PACKAGES_DIR, "plugin-openclaw", "openclaw.plugin.json"),
  ]) {
    assert.ok(fs.existsSync(manifestPath), `${path.relative(ROOT, manifestPath)} must exist`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.ok(
      typeof manifest.description === "string" && manifest.description.includes(SLOT_HINT),
      `${path.relative(ROOT, manifestPath)} description must mention "${SLOT_HINT}" (got: ${JSON.stringify(manifest.description)})`,
    );
  }
});

test("sample-openclaw-config.json uses openclaw-remnic entry and slot", () => {
  const samplePath = path.join(ROOT, "docs", "integration", "sample-openclaw-config.json");
  assert.ok(fs.existsSync(samplePath), "sample-openclaw-config.json must exist");
  const raw = fs.readFileSync(samplePath, "utf-8");
  const cfg = JSON.parse(raw);
  assert.ok(
    cfg.plugins?.entries?.["openclaw-remnic"],
    "sample config must have plugins.entries[\"openclaw-remnic\"]",
  );
  assert.equal(
    cfg.plugins?.slots?.memory,
    "openclaw-remnic",
    "sample config must have plugins.slots.memory = \"openclaw-remnic\"",
  );
});

test("design note docs/integration/plugin-id-and-memory-namespaces.md exists and mentions key concepts", () => {
  const docPath = path.join(ROOT, "docs", "integration", "plugin-id-and-memory-namespaces.md");
  assert.ok(fs.existsSync(docPath), "plugin-id-and-memory-namespaces.md must exist");
  const content = fs.readFileSync(docPath, "utf-8");
  assert.ok(content.includes("plugins.slots.memory"), "design doc must mention plugins.slots.memory");
  assert.ok(content.includes("openclaw-remnic"), "design doc must mention openclaw-remnic");
  assert.ok(content.includes("openclaw-engram"), "design doc must mention openclaw-engram for migration context");
  assert.ok(content.includes("memoryDir"), "design doc must mention memoryDir");
  assert.ok(content.includes("remnic openclaw install"), "design doc must mention remnic openclaw install");
});

test("packages that depend on LanceDB declare apache-arrow explicitly", () => {
  for (const pkgJsonPath of [
    path.join(ROOT, "package.json"),
    path.join(PACKAGES_DIR, "remnic-core", "package.json"),
  ]) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    assert.ok(
      pkg.dependencies?.["@lancedb/lancedb"],
      `${path.relative(ROOT, pkgJsonPath)} must depend on @lancedb/lancedb for this guard to apply`,
    );
    assert.equal(
      pkg.dependencies?.["apache-arrow"],
      "^18.1.0",
      `${path.relative(ROOT, pkgJsonPath)} must declare apache-arrow explicitly for LanceDB runtime compatibility`,
    );
  }
});
