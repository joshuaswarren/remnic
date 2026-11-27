#!/usr/bin/env node
/**
 * Gate: the documented install must resolve the current release line
 * (issue #3439).
 *
 * npm `latest` only moves on a maintainer promotion while every merge to
 * `main` publishes to `alpha`. A bare `npm install @remnic/<pkg>` silently
 * resolves `latest`, which can sit a whole major line behind the packages
 * the docs describe (9.69.x vs 10.0.x). Every install command in the
 * documented install surfaces therefore names an explicit tag or version.
 *
 * Two modes:
 *   default (static) — every `@remnic/<pkg>` argument of an `npm install`
 *     or `pnpm add` command in the scanned docs must carry an explicit
 *     `@<tag>` or `@<version>`. Runs offline; wired into check-pre-push.
 *   --resolve        — additionally resolves each documented channel tag on
 *     npm (`npm view <pkg>@<tag>`) and fails when it does not match the
 *     major of that package's workspace version — i.e. the install docs
 *     would hand the user a different line than the one just published.
 *     Wired into release-and-publish.yml after publish.
 *
 * Scanning only counts real commands: `npm install`/`npm i`/`pnpm add` inside fenced
 * code blocks or inline-code spans. Prose that merely mentions a bare
 * install (channel docs, checklists, templates) is not scanned — see
 * EXEMPT_FILES.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, isAbsolute } from "node:path";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const CHANNEL_TAGS = new Set(["alpha", "beta", "latest"]);
const EXEMPT_FILES = new Set([
  // Contract/policy prose that quotes a bare install to describe the hazard
  // itself, plus checklists that are not install instructions.
  "AGENTS.md",
  "docs/review-checklist.md",
  "docs/integration/omp.md",
]);

// Files that DEFINE the channels: their install examples legitimately name a
// tag that does not (yet) resolve to the current line, so --resolve skips
// them. The static bare-tag rule still applies.
const RESOLVE_EXEMPT_FILES = new Set(["docs/releases.md"]);

// `<name>` placeholders count as part of the package name or tag so docs can
// write `npm install @remnic/import-<source>@alpha`; the tag is still required.
const PKG_TOKEN = /@remnic\/[a-z0-9][a-z0-9<>-]*(?:@[A-Za-z0-9._<>-]+)?/g;

function scanRoots() {
  // Test hook: REMNIC_TEST_DOC=<abs path> scans exactly one file.
  if (process.env.REMNIC_TEST_DOC) return [process.env.REMNIC_TEST_DOC];
  const files = ["README.md"];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(p);
      } else if (entry.name.endsWith(".md")) {
        files.push(relative(repoRoot, p));
      }
    }
  };
  walk(join(repoRoot, "docs"));
  walk(join(repoRoot, "packages"));
  return files;
}

// Extract the text of every `npm install`/`npm i` command in a markdown
// file: whole fenced lines whose (stripped) content starts with the command,
// and inline-code spans that are themselves an install command.
// An install command may sit anywhere on a line — after a comment marker
// (`# or: npm i ...`), a shell prefix (`mkdir d && npm install ...`), or
// inside an inline-code span. The gate still checks every spec the command
// names, so commands are matched anywhere on the line rather than anchored.
const CMD_ANYWHERE = /(?:^|[^\w./-])((?:npm\s+i(?:nstall)?|pnpm\s+add)\s[^&|;`]*)/g;

function* installCommands(markdown) {
  // CommonMark fences: ```` ``` ```` and `~~~` both open blocks; the closer
  // must use the same marker character, be at least as long as the opener,
  // and carry only whitespace after it.
  let fenceChar = null;
  let fenceLen = 0;
  for (const line of markdown.split("\n")) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fenceChar === null) {
        fenceChar = fence[1][0];
        fenceLen = fence[1].length;
      } else if (
        fence[1][0] === fenceChar &&
        fence[1].length >= fenceLen &&
        /^\s*$/.test(line.slice(line.indexOf(fence[1]) + fence[1].length))
      ) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar !== null) {
      const cmd = line.replace(/^\s*(?:[$#>]\s*)?/, "");
      for (const m of cmd.matchAll(CMD_ANYWHERE)) yield m[1].trim();
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      for (const c of m[1].matchAll(CMD_ANYWHERE)) yield c[1].trim();
    }
  }
}

function* documentedSpecs(files) {
  for (const file of files) {
    if (EXEMPT_FILES.has(file)) continue;
    const text = readFileSync(isAbsolute(file) ? file : join(repoRoot, file), "utf8");
    for (const cmd of installCommands(text)) {
      for (const m of cmd.matchAll(PKG_TOKEN)) {
        const token = m[0];
        const at = token.indexOf("@", 1); // version/tag separator after the scope @
        const spec = at === -1 ? { file, pkg: token, tag: null, token } : {
          file,
          pkg: token.slice(0, at),
          tag: token.slice(at + 1),
          token,
        };
        yield spec;
      }
    }
  }
}

// Packages restricted to one OS (the darwin capture-native helpers) publish
// from capture-native-helper.yml AFTER this gate runs, so their channel tag
// cannot resolve to the just-published version yet. --resolve skips them;
// skipping the gate's release-blocking on them keeps a lagging Darwin tag
// from stranding the release and helper dispatch that would advance it.
const osRestricted = new Set();

function workspaceVersions() {
  const map = new Map();
  const pkgsDir = join(repoRoot, "packages");
  for (const dir of readdirSync(pkgsDir)) {
    try {
      const pj = JSON.parse(readFileSync(join(pkgsDir, dir, "package.json"), "utf8"));
      if (pj.name && pj.version) map.set(pj.name, pj.version);
      if (pj.name && Array.isArray(pj.os) && pj.os.length > 0) osRestricted.add(pj.name);
    } catch {
      // no package.json — not a package dir
    }
  }
  return map;
}

const files = scanRoots();
const specs = [...documentedSpecs(files)];

const bare = specs.filter((s) => s.tag === null);
if (bare.length > 0) {
  console.error("[install-tag-agreement] FAIL — bare `npm install`/`pnpm add` of `@remnic/<pkg>` resolves npm `latest`, which promotion can leave behind the published line. Name an explicit tag (`@alpha` while latest trails the line) or version:");
  for (const s of bare) console.error(`  ${s.file}: ${s.token}`);
  process.exit(1);
}

if (!process.argv.includes("--resolve")) {
  console.log(`[install-tag-agreement] OK — ${specs.length} documented install specs, all with explicit tags`);
  process.exit(0);
}

const versions = workspaceVersions();
const resolved = new Map();
let failures = 0;
const warned = new Set();
for (const s of specs) {
  if (!CHANNEL_TAGS.has(s.tag)) continue; // pinned versions resolve by definition
  if (RESOLVE_EXEMPT_FILES.has(s.file)) continue; // channel-defining docs
  if (osRestricted.has(s.pkg)) continue; // helper-published after this gate
  const expected = versions.get(s.pkg);
  if (!expected) continue; // documented package not in this workspace
  const key = `${s.pkg}@${s.tag}`;
  if (!resolved.has(key)) {
    let v = null;
    try {
      v = execFileSync("npm", ["view", key, "version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      v = null;
    }
    resolved.set(key, v);
  }
  const actual = resolved.get(key);
  if (actual === null) {
    // Unresolvable is a provisioning gap, not a doc/line disagreement — the
    // publish loop already reports those loudly. Warn once per spec.
    if (!warned.has(key)) {
      warned.add(key);
      console.log(`[install-tag-agreement] WARN — ${key} does not resolve on npm (unprovisioned or tag not yet moved); skipping line check`);
    }
    continue;
  }
  if (actual !== expected) {
    failures += 1;
    console.error(
      `[install-tag-agreement] FAIL — ${s.file}: ${s.token} resolves to ${actual} ` +
        `but the current line is ${expected}. Pin a tag that resolves the current line, ` +
        `or promote: npm dist-tag add ${s.pkg}@${expected} ${s.tag}`,
    );
  }
}
if (failures > 0) process.exit(1);
console.log(`[install-tag-agreement] OK — ${specs.length} specs resolve to the current line`);
process.exit(0);
