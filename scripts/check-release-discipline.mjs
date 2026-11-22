#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inferTouchedPackages } from "./changeset-stub.mjs";

export const CONFIG_PATH = "packages/remnic-core/src/config.ts";
export const REGISTRY_PATH = "scripts/flag-graduation.json";
export const STABILITY_LEVELS = Object.freeze(["alpha", "beta", "stable"]);

const REGISTRY_FIELDS = Object.freeze(["flag", "addedIn", "issue", "graduationCriterion"]);

const FLAG_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const DEFAULT_OFF_PATTERNS = Object.freeze([
  /^\s*([A-Za-z_$][A-Za-z0-9_$]*):\s*coerceBool(?:eanLike)?\([^\n]*\)\s*===\s*true\s*,?\s*$/,
  /^\s*([A-Za-z_$][A-Za-z0-9_$]*):\s*coerceBool(?:eanLike)?\([^\n]*\)\s*\?\?\s*false\s*,?\s*$/,
  /^\s*([A-Za-z_$][A-Za-z0-9_$]*):\s*cfg\.[A-Za-z0-9_$]+\s*===\s*true\s*,?\s*$/,
]);

const PARSE_CONFIG_OPENER = "export function parseConfig(";

export function isChangesetFile(filePath) {
  return /^\.changeset\/[^/]+\.md$/.test(filePath) && filePath !== ".changeset/README.md";
}

export function extractDefaultOffGates(source) {
  if (typeof source !== "string") {
    throw new TypeError("extractDefaultOffGates: source must be a string");
  }
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(PARSE_CONFIG_OPENER));
  if (start === -1) {
    throw new Error(`Could not locate \`${PARSE_CONFIG_OPENER}\` in ${CONFIG_PATH}`);
  }
  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index] === "}") {
      end = index;
      break;
    }
  }
  if (end === -1) {
    throw new Error(`Could not locate the end of \`parseConfig\` in ${CONFIG_PATH}`);
  }

  const found = new Set();
  for (let index = start; index < end; index += 1) {
    for (const pattern of DEFAULT_OFF_PATTERNS) {
      const match = lines[index].match(pattern);
      if (match) {
        found.add(match[1]);
        break;
      }
    }
  }
  return [...found].sort(compareStrings);
}

export function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function mentionsIdentifier(source, name) {
  if (!FLAG_NAME_RE.test(name)) return false;
  return new RegExp(`\\b${name}\\b`).test(source);
}

export function parseStabilityDeclarations(text) {
  if (typeof text !== "string") {
    throw new TypeError("parseStabilityDeclarations: text must be a string");
  }
  const levels = [];
  const invalid = [];
  for (const line of text.split("\n")) {
    const withoutEol = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!/^stability:/i.test(withoutEol)) continue;
    const strict = withoutEol.match(/^Stability: ([a-z]+)$/);
    if (strict && STABILITY_LEVELS.includes(strict[1])) {
      levels.push(strict[1]);
      continue;
    }
    invalid.push(withoutEol);
  }
  return { levels, invalid };
}

export function parseRegistry(raw, source = REGISTRY_PATH) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source}: expected a JSON object`);
  }
  if (!Object.hasOwn(parsed, "flags")) {
    throw new Error(`${source}: missing required "flags" array`);
  }
  const flags = parsed.flags;
  if (!Array.isArray(flags)) {
    throw new Error(`${source}: "flags" must be an array`);
  }

  const entries = new Map();
  for (const entry of flags) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${source}: every flags[] element must be an object`);
    }
    const keys = Object.getOwnPropertyNames(entry);
    for (const field of REGISTRY_FIELDS) {
      if (!keys.includes(field) || !Object.hasOwn(entry, field)) {
        throw new Error(`${source}: entry ${JSON.stringify(entry)} is missing "${field}"`);
      }
    }
    for (const key of keys) {
      if (!REGISTRY_FIELDS.includes(key)) {
        throw new Error(`${source}: unknown field "${key}" in entry for ${String(entry.flag)}`);
      }
    }
    const flag = entry.flag;
    if (typeof flag !== "string" || !FLAG_NAME_RE.test(flag)) {
      throw new Error(`${source}: "flag" must be a config key identifier, got ${JSON.stringify(flag)}`);
    }
    if (typeof entry.addedIn !== "string" || entry.addedIn.length === 0) {
      throw new Error(`${source}: ${flag} "addedIn" must be a non-empty string`);
    }
    if (typeof entry.graduationCriterion !== "string" || entry.graduationCriterion.length === 0) {
      throw new Error(`${source}: ${flag} "graduationCriterion" must be a non-empty string`);
    }
    if (typeof entry.issue !== "number" || !Number.isInteger(entry.issue) || entry.issue <= 0) {
      throw new Error(`${source}: ${flag} "issue" must be a positive integer, got ${JSON.stringify(entry.issue)}`);
    }
    if (entries.has(flag)) {
      throw new Error(`${source}: duplicate entry for ${flag}`);
    }
    entries.set(flag, {
      flag,
      addedIn: entry.addedIn,
      issue: entry.issue,
      graduationCriterion: entry.graduationCriterion,
    });
  }
  return entries;
}

/**
 * Apply every rule to one already-collected diff.
 *
 * @param {{
 *   changedFiles: string[],
 *   packages: {dir: string, name: string, kind: string, private: boolean}[],
 *   changesets: {path: string, text: string}[],
 *   baseGates: string[],
 *   headGates: string[],
 *   baseRegistry: Map<string, object>,
 *   headRegistry: Map<string, object>,
 *   headConfigSource: string,
 * }} input
 * @returns {string[]} violations, empty when clean
 */
export function evaluateReleaseDiscipline(input) {
  const {
    changedFiles,
    packages,
    changesets,
    baseGates,
    headGates,
    baseRegistry,
    headRegistry,
    headConfigSource,
  } = input;

  const violations = [];
  const touched = inferTouchedPackages(changedFiles, packages).published;

  const levels = new Set();
  for (const changeset of changesets) {
    const declared = parseStabilityDeclarations(changeset.text);
    for (const bad of declared.invalid) {
      violations.push(
        `${changeset.path}: invalid stability declaration ${JSON.stringify(bad)}. ` +
          `Write exactly one of: ${STABILITY_LEVELS.map((level) => `Stability: ${level}`).join(", ")}.`,
      );
    }
    for (const level of declared.levels) levels.add(level);
  }

  if (touched.length > 0 && levels.size === 0) {
    const names = touched.map((pkg) => pkg.name).join(", ");
    violations.push(
      `This diff changes published package(s) ${names} but no added/modified changeset ` +
        `declares a stability level. Add a changeset with a \`Stability: alpha|beta|stable\` line ` +
        `(docs/releases.md). Doc-only and CI-only diffs are exempt.`,
    );
  }

  const headGateSet = new Set(headGates);
  const baseGateSet = new Set(baseGates);
  const newGates = headGates.filter((flag) => !baseGateSet.has(flag));
  for (const flag of newGates) {
    if (!headRegistry.has(flag)) {
      violations.push(
        `New default-off gate \`${flag}\` in ${CONFIG_PATH} has no entry in ${REGISTRY_PATH}. ` +
          `Add { flag, addedIn, issue, graduationCriterion }.`,
      );
    }
  }

  const experimental = levels.has("alpha") || levels.has("beta");
  if (experimental && newGates.length === 0) {
    const named = [...headRegistry.keys()].filter((flag) =>
      changesets.some((changeset) => mentionsIdentifier(changeset.text, flag)),
    );
    if (named.length === 0) {
      violations.push(
        `A changeset declares \`Stability: alpha\` or \`Stability: beta\`, but this diff neither adds a ` +
          `new default-off gate nor names an already-registered flag from ${REGISTRY_PATH}. ` +
          `Experimental behavior must be default-off behind a registered flag.`,
      );
    }
  }
  if (levels.has("stable") && newGates.length > 0) {
    violations.push(
      `A changeset declares \`Stability: stable\`, but this diff adds default-off gate(s) ` +
        `${newGates.join(", ")}. Stable work ships default-on; ship it as alpha instead, or graduate ` +
        `the flag in its own PR.`,
    );
  }

  for (const flag of baseGates) {
    if (headGateSet.has(flag)) continue;
    const stillConfigured = mentionsIdentifier(headConfigSource, flag);
    if (stillConfigured && headRegistry.has(flag)) {
      violations.push(
        `\`${flag}\` is no longer default-off in ${CONFIG_PATH}, but its ${REGISTRY_PATH} entry survives. ` +
          `A graduation PR flips the default AND deletes the registry entry (docs/releases.md).`,
      );
    }
  }

  for (const flag of baseRegistry.keys()) {
    if (headRegistry.has(flag)) continue;
    if (headGateSet.has(flag)) {
      violations.push(
        `The ${REGISTRY_PATH} entry for \`${flag}\` was deleted, but the flag is still default-off in ` +
          `${CONFIG_PATH}. Delete the entry only when the default flips or the flag is removed.`,
      );
    }
  }

  for (const flag of headRegistry.keys()) {
    if (!mentionsIdentifier(headConfigSource, flag)) {
      violations.push(
        `${REGISTRY_PATH} registers \`${flag}\`, which no longer appears in ${CONFIG_PATH}. ` +
          `The registry never outlives the code: delete the entry in the same diff as the flag.`,
      );
    }
  }

  return violations;
}


function makeGit(repoRoot) {
  return (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
}

export function showAtRef(git, ref, filePath) {
  try {
    return git(["show", `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

export function changedFilesBetween(git, baseRef, headRef) {
  const output = git([
    "diff",
    "--name-only",
    "-z",
    "-M",
    "--diff-filter=ACMRT",
    baseRef,
    headRef,
  ]);
  return [...new Set(output.split("\0").filter(Boolean).map(normalizePath))].sort(compareStrings);
}

export function discoverPackagesAtRef(git, ref) {
  const listing = git(["ls-tree", "-r", "--name-only", "-z", ref, "--", "packages"]);
  const files = listing.split("\0").filter(Boolean);
  const dirs = new Set();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length < 3) continue;
    dirs.add(`${parts[0]}/${parts[1]}`);
  }

  const packages = [];
  for (const dir of [...dirs].sort(compareStrings)) {
    const manifest = showAtRef(git, ref, `${dir}/package.json`);
    if (manifest) {
      const parsed = JSON.parse(manifest);
      if (typeof parsed.name === "string") {
        packages.push({ dir, name: parsed.name, kind: "npm", private: parsed.private === true });
      }
      continue;
    }
    const pyproject = showAtRef(git, ref, `${dir}/pyproject.toml`);
    if (pyproject) {
      const name = pyproject.match(/^name\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
      if (name) packages.push({ dir, name, kind: "python", private: false });
    }
  }
  return packages;
}

export function collectFromGit({ repoRoot, baseRef, headRef, git = makeGit(repoRoot) }) {
  const changedFiles = changedFilesBetween(git, baseRef, headRef);

  const headConfigSource = showAtRef(git, headRef, CONFIG_PATH);
  if (headConfigSource === null) {
    throw new Error(`${CONFIG_PATH} not found at ${headRef}`);
  }
  const baseConfigSource = showAtRef(git, baseRef, CONFIG_PATH);
  if (baseConfigSource === null) {
    throw new Error(`${CONFIG_PATH} not found at ${baseRef}`);
  }

  const headRegistryRaw = showAtRef(git, headRef, REGISTRY_PATH);
  if (headRegistryRaw === null) {
    throw new Error(`${REGISTRY_PATH} not found at ${headRef}`);
  }
  const baseRegistryRaw = showAtRef(git, baseRef, REGISTRY_PATH);

  const changesets = [];
  for (const file of changedFiles) {
    if (!isChangesetFile(file)) continue;
    const text = showAtRef(git, headRef, file);
    if (text === null) continue;
    changesets.push({ path: file, text });
  }

  return {
    changedFiles,
    packages: discoverPackagesAtRef(git, headRef),
    changesets,
    baseGates: extractDefaultOffGates(baseConfigSource),
    headGates: extractDefaultOffGates(headConfigSource),
    baseRegistry: baseRegistryRaw === null ? new Map() : parseRegistry(baseRegistryRaw),
    headRegistry: parseRegistry(headRegistryRaw),
    headConfigSource,
  };
}

export function parseArgs(argv) {
  const args = { repoRoot: undefined, baseRef: undefined, headRef: "HEAD" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--repo-root" || arg === "--base" || arg === "--head") {
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--repo-root") args.repoRoot = value;
      else if (arg === "--base") args.baseRef = value;
      else args.headRef = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return [
    "Usage: node scripts/check-release-discipline.mjs [--repo-root <path>] [--base <ref>] [--head <ref>]",
    "",
    "Validates changeset stability declarations and config-flag graduation",
    "discipline on a pull request's effective diff (issue #3032).",
  ].join("\n");
}

function resolveBaseRef(git, headRef) {
  for (const candidate of ["github/main", "origin/main", "main"]) {
    try {
      return git(["merge-base", headRef, candidate]).trim();
    } catch {
      // try the next remote name
    }
  }
  throw new Error("Unable to resolve a base ref. Pass --base <ref>.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = args.repoRoot ?? path.dirname(scriptDir);
  const git = makeGit(repoRoot);
  const baseRef = args.baseRef ?? resolveBaseRef(git, args.headRef);

  const collected = collectFromGit({ repoRoot, baseRef, headRef: args.headRef, git });
  const violations = evaluateReleaseDiscipline(collected);

  if (violations.length === 0) {
    console.log(
      `release-discipline: clean (${collected.changedFiles.length} changed file(s), ` +
        `${collected.changesets.length} changeset(s), ${collected.headRegistry.size} registered flag(s)).`,
    );
    return;
  }

  for (const violation of violations) {
    console.error(`release-discipline: ${violation}`);
  }
  console.error(
    `release-discipline: ${violations.length} violation(s). See docs/releases.md for the release channel model.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`release-discipline: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
