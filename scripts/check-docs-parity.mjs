#!/usr/bin/env node
/**
 * Docs-code parity check (issue #1527 PR2, epic #1520).
 *
 * Fails when user-facing docs drift from the CLI or from host-publisher
 * reality. Three gates, all pure static analysis (no daemon, no network —
 * CI runs it cold, see #1518):
 *
 *   (a) Command existence — every `remnic <subcommand>` invocation extracted
 *       from fenced code blocks in docs/ and every packages README.md must resolve
 *       to a command registered in the CLI. Until #1532 ships a registrar
 *       table, registration is discovered by grepping the command-definition
 *       strings in packages/remnic-cli/src/index.ts (the `CommandName` union
 *       and `case "..."` dispatch) and packages/remnic-core/src/cli.ts
 *       (`.command("...")` calls). See TODO_REGISTRY below.
 *
 *   (b) Stub-honesty — a memory-extension publisher whose
 *       `PublisherCapabilities` static declares no capabilities (all-false,
 *       i.e. a stub) may not have install-section docs claiming automation
 *       ("installs the plugin", "configures MCP", "automatically"). The
 *       host→doc mapping is maintained in STUB_PUBLISHER_DOCS below. This is
 *       the #1518 class: docs that promise an install the publisher cannot
 *       deliver.
 *
 *   (c) No-op allowlist — a CLI handler that is a reserved no-op stub must be
 *       explicitly listed in NO_OP_ALLOWLIST below WITH a tracking-issue
 *       number. A silent unlisted no-op is exactly what #1518 hit
 *       (`extensions reload`). The script detects no-op handlers by scanning
 *       for the marker phrases that label them in the CLI source.
 *
 * Same conventions as check-ratchets.mjs: Node stdlib only, cross-platform,
 * REMNIC_DOCS_PARITY_ROOT is a test seam (absolute path to a fake repo root).
 * Wired into pr-preflight.sh and the CI quality job.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REMNIC_DOCS_PARITY_ROOT
  ? path.resolve(process.env.REMNIC_DOCS_PARITY_ROOT)
  : path.resolve(SCRIPT_DIR, "..");

// TODO_REGISTRY (#1532): once the CLI registrar table lands, import it and
// replace collectRegisteredCommands() with a direct lookup. The current grep
// approach is deliberately conservative — it over-approximates the set of
// registered commands (case strings + .command() names) so a rename that the
// grep misses fails loudly here rather than silently in docs. When #1532
// ships, delete GREP_PATTERNS and read the registrar directly.

const CLI_FILES = [
  "packages/remnic-cli/src/index.ts",
  "packages/remnic-core/src/cli.ts",
];

const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "target",
]);

// Fenced code blocks: ```lang ... ``` or ~~~lang ... ~~~. We only extract
// from inside fences to avoid prose false-positives like "remnic recall is
// the command you use" (issue #1527 PR2 spec).
const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})/;
const REMNIC_INVOCATION_RE = /^(\s*)(?:\$\s+)?(?:#\s+)?remnic\s+([A-Za-z][A-Za-z0-9:_-]*)/;

// Automation phrases a stub publisher cannot back. Scoped to install sections
// only so that an honest runtime-behavior description ("once installed, the
// daemon automatically recalls ...") is not a false positive — the gate is
// about install-time claims, not runtime behaviour.
const STUB_AUTOMATION_PHRASES = [
  "installs the plugin",
  "configures mcp",
  "automatically",
];

// Section headings that describe the install flow. Phrases are checked only
// within these sections.
const INSTALL_HEADING_RE = /^#{1,6}\s*(install|installation|setup|quick\s*start|getting\s*started|prerequisites)\b/i;

// No-op handler markers — the phrases the codebase uses to label a reserved
// stub. If a handler body contains one of these AND the command is not in
// NO_OP_ALLOWLIST, the check fails.
const NO_OP_MARKER_RE = /\b(no-op stub|no-op:|not yet implemented|caching not yet implemented)\b/i;

// Host ID → docs whose install sections are gated when the corresponding
// publisher is a stub. Maintain the mapping here (issue #1527 PR2 spec:
// "Maintain the host→doc mapping in the script").
const STUB_PUBLISHER_DOCS = {
  "claude-code": [
    "docs/plugins/claude-code.md",
    "packages/plugin-claude-code/README.md",
  ],
  hermes: [
    "docs/plugins/hermes.md",
    "packages/plugin-hermes/README.md",
  ],
};

// Explicitly accepted no-op commands. Each entry MUST reference a tracking
// issue explaining why the no-op is reserved. Seed: `extensions reload`
// (issue #1518 — "caching not yet implemented").
/** @type {Record<string, string>} */
const NO_OP_ALLOWLIST = {
  "extensions reload": "#1518",
};

// ── File walking ───────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function isMarkdown(name) {
  return name.endsWith(".md");
}

/** Recursively list .md files under dir, returning repo-relative posix paths. */
function walkMarkdown(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIR_NAMES.has(entry.name)) {
        out.push(...walkMarkdown(full));
      }
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectDocFiles() {
  const docsDir = path.join(ROOT, "docs");
  const packagesDir = path.join(ROOT, "packages");
  const files = [];

  // docs/**.md
  for (const f of walkMarkdown(docsDir)) {
    files.push(toPosix(path.relative(ROOT, f)));
  }

  // packages/*/README.md (top-level package readmes only)
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const readme = path.join(packagesDir, entry.name, "README.md");
      if (existsSync(readme) && statSync(readme).isFile()) {
        files.push(toPosix(path.relative(ROOT, readme)));
      }
    }
  }

  // De-dup + sort for stable output.
  return [...new Set(files)].sort();
}

// ── Fenced-block extraction ────────────────────────────────────────────────

/**
 * Iterate fenced code blocks in markdown source, calling back with the text
 * inside each fence. Handles ``` and ~~~ fences and ignores fences nested
 * inside blockquotes (the > ``` form) only when the fence markers don't line
 * up — the common case in this repo is plain top-level fences.
 *
 * @param {string} src
 * @returns {Array<{ text: string; startLine: number }>}
 */
function extractFencedBlocks(src) {
  const lines = src.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = lines[i].match(FENCE_OPEN_RE);
    if (!openMatch) {
      i++;
      continue;
    }
    const indent = openMatch[1];
    const marker = openMatch[2][0];
    const markerLen = openMatch[2].length;
    const closeRe = new RegExp(`^${indent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${marker}{${markerLen},})\\s*$`);
    const startLine = i + 1; // 1-indexed line of the fence opener
    const bodyLines = [];
    i++;
    while (i < lines.length) {
      if (closeRe.test(lines[i])) {
        i++;
        break;
      }
      bodyLines.push(lines[i]);
      i++;
    }
    blocks.push({ text: bodyLines.join("\n"), startLine });
  }
  return blocks;
}

/**
 * Extract `remnic <subcommand>` invocations from fenced code blocks only.
 * Returns a list of { file, line, subcommand, full } entries. `subcommand`
 * is the first token after `remnic` (e.g. "connectors" from
 * "remnic connectors install codex-cli"), because the parity check is against
 * top-level command registration.
 *
 * @param {string} relPath
 * @param {string} src
 * @returns {Array<{ file: string; line: number; subcommand: string; full: string }>}
 */
function extractRemnicInvocations(relPath, src) {
  const blocks = extractFencedBlocks(src);
  const out = [];
  for (const block of blocks) {
    const lines = block.text.split("\n");
    for (let j = 0; j < lines.length; j++) {
      const raw = lines[j];
      const m = raw.match(REMNIC_INVOCATION_RE);
      if (!m) continue;
      const subcommand = m[2];
      // Strip the leading indent + prompt prefix for the "full" display.
      const full = raw.replace(/^\s*(?:\$\s+)?(?:#\s+)?/, "").trim();
      out.push({
        file: relPath,
        line: block.startLine + j,
        subcommand,
        full,
      });
    }
  }
  return out;
}

// ── Registered-command discovery (TODO: replace with #1532 registrar) ─────

const CASE_COMMAND_RE = /case\s+"([A-Za-z][A-Za-z0-9:_-]*)"\s*:/g;
const COMMANDER_COMMAND_RE = /\.command\(\s*"([A-Za-z][A-Za-z0-9:_-]*)"\s*\)/g;
const COMMAND_NAME_UNION_RE = /\|\s*"([A-Za-z][A-Za-z0-9:_-]*)"\s*(?=\||$)/gm;

/**
 * Collect the set of registered top-level command names from both CLI files.
 * Conservative: includes every `case "X":`, `.command("X")`, and `| "X"` in
 * the CommandName union. Over-approximation is safe — it means we might fail
 * to flag a nonexistent command, but #1532's registrar will tighten this.
 *
 * @param {string[]} cliFiles — repo-relative posix paths
 * @returns {Set<string>}
 */
function collectRegisteredCommands(cliFiles) {
  const commands = new Set();
  for (const rel of cliFiles) {
    const abs = path.join(ROOT, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    let m;
    CASE_COMMAND_RE.lastIndex = 0;
    while ((m = CASE_COMMAND_RE.exec(src)) !== null) {
      commands.add(m[1]);
    }
    COMMANDER_COMMAND_RE.lastIndex = 0;
    while ((m = COMMANDER_COMMAND_RE.exec(src)) !== null) {
      commands.add(m[1]);
    }
    COMMAND_NAME_UNION_RE.lastIndex = 0;
    while ((m = COMMAND_NAME_UNION_RE.exec(src)) !== null) {
      commands.add(m[1]);
    }
  }
  return commands;
}

// ── No-op handler detection ────────────────────────────────────────────────

/**
 * Scan CLI source for no-op handler markers and return the set of
 * "command path" strings (e.g. "extensions reload") whose handler contains a
 * no-op label.
 *
 * Two CLI styles are handled:
 *  - remnic-cli/src/index.ts — `async function cmd<X>(...)` enclosing a
 *    `switch` with `case "Y":` arms. The no-op path is `<kebab(X)> <Y>`.
 *    When no function context is found, falls back to the bare case label.
 *  - remnic-core/src/cli.ts — commander `.command("parent")` chained with
 *    `.command("child")`. The path is the chain joined with spaces.
 *
 * The detection is intentionally conservative: it only flags handlers that
 * explicitly label themselves as no-ops (`No-op stub`, `no-op:`,
 * `not yet implemented`). A genuinely empty handler without a marker is
 * invisible to static analysis and is caught at review time.
 *
 * @param {string[]} cliFiles
 * @returns {Set<string>} detected no-op command paths
 */
function detectNoOpHandlers(cliFiles) {
  const detected = new Set();

  const FUNC_RE = /(?:async\s+)?function\s+cmd([A-Z][A-Za-z0-9]*)\s*\(/;
  const CASE_RE = /^\s*case\s+"([A-Za-z][A-Za-z0-9:_-]*)"\s*:/;
  const COMMANDER_RE = /\.\s*command\(\s*"([A-Za-z][A-Za-z0-9:_-]*)"\s*\)/;

  /** Convert a PascalCase function-name suffix to the CLI command name
   *  (e.g. `Extensions` → `extensions`, `ConnectorsMarketplace` →
   *  `connectors-marketplace`). */
  function pascalToKebab(p) {
    return p
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
  }

  for (const rel of cliFiles) {
    const abs = path.join(ROOT, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const lines = src.split("\n");

    // ── Pass 1: function-scoped case dispatch (remnic-cli style) ──────
    let funcName = null; // current cmd<X> suffix, e.g. "Extensions"
    let funcKebab = null; // kebab form, e.g. "extensions"
    let currentCase = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Function entry — remember the cmd<Name> suffix for path building.
      const funcMatch = line.match(FUNC_RE);
      if (funcMatch) {
        funcName = funcMatch[1];
        funcKebab = pascalToKebab(funcName);
        currentCase = null;
      }

      // Case label inside the function's switch.
      const caseMatch = line.match(CASE_RE);
      if (caseMatch) {
        currentCase = caseMatch[1];
      }

      // No-op marker — attribute to the current scope.
      if (NO_OP_MARKER_RE.test(line)) {
        if (funcKebab && currentCase) {
          detected.add(`${funcKebab} ${currentCase}`);
        } else if (currentCase) {
          detected.add(currentCase);
        }
      }
    }

    // ── Pass 2: commander-style `.command("X")` chains (cli.ts style) ─
    const cmdChain = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cmdMatch = line.match(COMMANDER_RE);
      if (cmdMatch) {
        const name = cmdMatch[1];
        // Sibling commands pop the chain: a new .command() on the same
        // object replaces the leaf. We keep the chain at length <= 2
        // (parent + child), matching every use in cli.ts.
        if (cmdChain.length >= 2) cmdChain.pop();
        cmdChain.push(name);
        continue;
      }
      if (NO_OP_MARKER_RE.test(line) && cmdChain.length > 0) {
        detected.add(cmdChain.join(" "));
      }
    }
  }
  return detected;
}

// ── Stub-publisher capability scan ─────────────────────────────────────────

const PUBLISHERS = [
  "packages/remnic-core/src/memory-extension/claude-code-publisher.ts",
  "packages/remnic-core/src/memory-extension/codex-publisher.ts",
  "packages/remnic-core/src/memory-extension/hermes-publisher.ts",
];

const CAPABILITIES_FALSE_RE = /static\s+readonly\s+capabilities\s*:[\s\S]*?instructionsMd:\s*false[\s\S]*?skillsFolder:\s*false[\s\S]*?citationFormat:\s*false[\s\S]*?readPathTemplate:\s*false/s;
const HOST_ID_RE = /readonly\s+hostId\s*=\s*"([^"]+)"/;

/**
 * @returns {Map<string, { hostId: string; isStub: boolean; file: string }>}
 */
function collectPublishers() {
  const out = new Map();
  for (const rel of PUBLISHERS) {
    const abs = path.join(ROOT, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const hostMatch = src.match(HOST_ID_RE);
    if (!hostMatch) continue;
    const hostId = hostMatch[1];
    // A publisher is a stub when ALL four capability flags are false. We
    // require the full all-false literal block so a partial publisher (some
    // true, some false) is not mis-flagged.
    const allFalse = CAPABILITIES_FALSE_RE.test(src);
    out.set(hostId, { hostId, isStub: allFalse, file: rel });
  }
  return out;
}

// ── Install-section automation-phrase scan ─────────────────────────────────

/**
 * Extract the concatenated text of install sections from a markdown source.
 * Sections are identified by INSTALL_HEADING_RE; the section extends from the
 * heading to the next heading of the same or higher level (or EOF).
 *
 * @param {string} src
 * @returns {Array<{ heading: string; text: string; startLine: number }>}
 */
function extractInstallSections(src) {
  const lines = src.split("\n");
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INSTALL_HEADING_RE.test(lines[i])) continue;
    const headingMatch = lines[i].match(/^(#{1,6})/);
    const level = headingMatch ? headingMatch[1].length : 1;
    const heading = lines[i];
    const startLine = i + 1;
    const bodyLines = [];
    i++;
    while (i < lines.length) {
      const nextHeading = lines[i].match(/^(#{1,6})\s/);
      if (nextHeading && nextHeading[1].length <= level) break;
      bodyLines.push(lines[i]);
      i++;
    }
    sections.push({ heading, text: bodyLines.join("\n"), startLine });
    i--; // compensate for outer loop's i++
  }
  return sections;
}

function findAutomationPhases(text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const phrase of STUB_AUTOMATION_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      hits.push({ phrase, idx });
      idx = lower.indexOf(phrase, idx + 1);
    }
  }
  return hits;
}

// ── Main ───────────────────────────────────────────────────────────────────

function usage() {
  return [
    "Usage: node scripts/check-docs-parity.mjs [--help]",
    "",
    "  Static docs-code parity check (#1527 PR2). Verifies every",
    "  `remnic <subcommand>` in docs fenced code blocks resolves to a",
    "  registered CLI command; gates automation claims in stub-publisher",
    "  install docs; rejects unlisted no-op commands. No flags beyond --help.",
    "",
    "  REMNIC_DOCS_PARITY_ROOT — test seam (absolute path to fake repo root).",
  ].join("\n");
}

function fail(failures) {
  console.error("[docs-parity] drift detected — docs and CLI are out of sync (#1527):");
  for (const f of failures) {
    console.error(`[docs-parity]   - ${f}`);
  }
  console.error(
    "[docs-parity] fix the docs, the CLI, or — for a deliberate no-op — add to NO_OP_ALLOWLIST with a tracking issue.",
  );
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--help");
  if (unknown.length > 0) {
    console.error(`[docs-parity] ERROR: unknown argument(s): ${unknown.join(", ")}`);
    console.error(usage());
    process.exit(2);
  }
  if (args.includes("--help")) {
    console.log(usage());
    return;
  }

  const failures = [];

  // (a) Command existence.
  const registered = collectRegisteredCommands(CLI_FILES);
  if (registered.size === 0) {
    fail([
      "no registered commands found — CLI_FILES resolved to nothing. " +
        "Check that packages/remnic-cli/src/index.ts and packages/remnic-core/src/cli.ts exist under the scan root.",
    ]);
  }

  const docFiles = collectDocFiles();
  /** @type {Map<string, Array<{ file: string; line: number; subcommand: string; full: string }>>} */
  const documented = new Map();
  for (const rel of docFiles) {
    const abs = path.join(ROOT, ...rel.split("/"));
    const src = readFileSync(abs, "utf8");
    const invocations = extractRemnicInvocations(rel, src);
    for (const inv of invocations) {
      const list = documented.get(inv.subcommand) ?? [];
      list.push(inv);
      documented.set(inv.subcommand, list);
    }
  }

  for (const [subcommand, occs] of documented) {
    if (registered.has(subcommand)) continue;
    const first = occs[0];
    failures.push(
      `documented command "remnic ${subcommand}" is not registered in the CLI ` +
        `(first occurrence: ${first.file}:${first.line}: \`${first.full}\`)`,
    );
  }

  // (c) No-op allowlist. Detect no-op handlers in the CLI, then require every
  // detected no-op to be in NO_OP_ALLOWLIST with a non-empty tracking issue.
  const detectedNoOps = detectNoOpHandlers(CLI_FILES);
  for (const cmd of detectedNoOps) {
    if (!(cmd in NO_OP_ALLOWLIST)) {
      failures.push(
        `no-op handler "${cmd}" is not in NO_OP_ALLOWLIST — ` +
          "add it with a tracking-issue number, or implement the handler",
      );
    }
  }
  for (const [cmd, issue] of Object.entries(NO_OP_ALLOWLIST)) {
    if (!issue || !issue.trim()) {
      failures.push(
        `NO_OP_ALLOWLIST entry "${cmd}" is missing a tracking-issue reference`,
      );
    }
  }

  // (b) Stub-honesty. For each stub publisher, scan its mapped docs' install
  // sections for automation phrases.
  const publishers = collectPublishers();
  for (const [hostId, info] of publishers) {
    if (!info.isStub) continue;
    const docs = STUB_PUBLISHER_DOCS[hostId] ?? [];
    for (const rel of docs) {
      const abs = path.join(ROOT, ...rel.split("/"));
      if (!existsSync(abs)) continue;
      const src = readFileSync(abs, "utf8");
      const sections = extractInstallSections(src);
      for (const section of sections) {
        const hits = findAutomationPhases(section.text);
        for (const hit of hits) {
          failures.push(
            `stub publisher "${hostId}" doc ${rel} (section "${section.heading.trim()}") ` +
              `contains automation phrase "${hit.phrase}" — the publisher declares no capabilities`,
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    fail(failures);
  }

  // Summary for green runs.
  const docCommands = [...documented.keys()].sort();
  console.log(
    `[docs-parity] OK — ${docCommands.length} documented command(s) resolve; ` +
      `${detectedNoOps.size} no-op(s) tracked; ` +
      `${[...publishers.values()].filter((p) => p.isStub).length} stub publisher(s) honest.`,
  );
  if (docCommands.length > 0) {
    console.log(`[docs-parity]   commands: ${docCommands.join(", ")}`);
  }
}

main();
