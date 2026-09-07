/**
 * One-time npm bootstrap target classifier for release-and-publish.yml
 * (`bootstrap_tag` dispatches).
 *
 * npm's publish API answers E404 when an automation identity may not CREATE
 * a package name, so OIDC-only publishing can never mint a first version.
 * This script classifies each allowlisted target against the public registry
 * so the bootstrap publish step only ever creates genuinely absent names:
 *
 * - publish: the name is absent (npm answers E404 for the bare name)
 * - skip:    the exact name@version is already published (idempotent retry)
 * - refuse:  the name exists but the requested version does not — no longer a
 *            first publish; minting a new version exceeds bootstrap scope
 * - error:   the registry answered with anything other than E404 — the state
 *            is unclassifiable and must never publish
 *
 * Target manifests must live under `--root` (the checked-out release tag in
 * the workflow), carry exactly the allowlisted name, and carry the tagged
 * root version. The workflow stages this script from the trusted dispatch
 * ref into RUNNER_TEMP. Exit codes: 0 = publish (single-target mode) or no
 * refuse/error (full mode); 3 = skip (single-target mode); 1 = refuse,
 * error, or manifest/version drift. Lookups are unauthenticated; only
 * package names are transmitted.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BOOTSTRAP_TARGETS = Object.freeze([
  { name: "@remnic/connector-reitti", dir: "packages/connector-reitti" },
  { name: "@remnic/connector-x", dir: "packages/connector-x" },
  { name: "@remnic/import-okf", dir: "packages/import-okf" },
]);

const E404 = /npm error code E404/;
const NPM_VIEW_TIMEOUT_MS = 30_000;
const NPMJS_REGISTRY = "https://registry.npmjs.org";

/**
 * Pure classification from two `npm view` outcomes. `version` is
 * `npm view <name>@<version> version`; `name` is `npm view <name> version`,
 * needed only once the exact version turned out to be absent.
 */
export function classify({ version, name }) {
  if (version.ok) return { action: "skip", reason: "exact version already published" };
  if (!E404.test(version.stderr ?? "")) {
    return { action: "error", reason: firstLine(version.stderr, "version query") };
  }
  if (name.ok) {
    return { action: "refuse", reason: "package name exists at a different version; bootstrap only creates absent names" };
  }
  if (E404.test(name.stderr ?? "")) return { action: "publish", reason: "package name absent from registry" };
  return { action: "error", reason: firstLine(name.stderr, "name query") };
}

function firstLine(stderr, label) {
  return `registry not classifiable (${label}: ${(stderr ?? "").split("\n", 1)[0] || "no output"})`;
}

function npmView(spec) {
  const result = spawnSync("npm", ["view", spec, "version"], {
    encoding: "utf8",
    timeout: NPM_VIEW_TIMEOUT_MS,
  });
  return { ok: result.status === 0, stderr: result.stderr ?? "" };
}

function fail(message) {
  console.error(`::error title=Bootstrap target rejected::${message}`);
  process.exit(1);
}

function targetVersion(root, rootVersion, target) {
  const manifest = JSON.parse(readFileSync(path.join(root, target.dir, "package.json"), "utf8"));
  if (manifest.name !== target.name) {
    fail(`manifest drift: ${target.dir}/package.json is "${manifest.name}", allowlist expects "${target.name}"`);
  }
  if (manifest.version !== rootVersion) {
    fail(`version drift: ${target.dir} is ${manifest.version}, tagged root is ${rootVersion}`);
  }
  if (manifest.publishConfig?.registry && manifest.publishConfig.registry !== NPMJS_REGISTRY) {
    fail(`registry override: ${target.dir} publishConfig.registry is ${manifest.publishConfig.registry}, refusing to send credentials anywhere but ${NPMJS_REGISTRY}`);
  }
  return manifest.version;
}

function main(argv) {
  let root = REPO_ROOT;
  const rootIndex = argv.indexOf("--root");
  if (rootIndex !== -1) root = path.resolve(argv[rootIndex + 1]);

  const packageIndex = argv.indexOf("--package");
  const single = packageIndex !== -1 ? argv[packageIndex + 1] : null;
  const selected = single
    ? BOOTSTRAP_TARGETS.filter((target) => target.name === single)
    : BOOTSTRAP_TARGETS;
  if (single && selected.length === 0) fail(`unknown bootstrap target: ${single}`);

  const rootVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

  for (const target of selected) {
    const version = targetVersion(root, rootVersion, target);
    const versionQuery = npmView(`${target.name}@${version}`);
    if (versionQuery.ok) {
      console.log(`skip ${target.name}@${version}: exact version already published`);
      if (single) process.exit(3);
      continue;
    }
    const outcome = classify({ version: versionQuery, name: npmView(target.name) });
    const label = `${target.name}@${version}`;
    if (outcome.action === "publish") {
      console.log(`publish ${label}: ${outcome.reason}`);
    } else if (outcome.action === "skip") {
      console.log(`skip ${label}: ${outcome.reason}`);
      if (single) process.exit(3);
    } else {
      fail(`${label}: ${outcome.reason}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
