#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REMNIC_DOCS_PARITY_ROOT
  ? path.resolve(process.env.REMNIC_DOCS_PARITY_ROOT)
  : path.resolve(SCRIPT_DIR, "..");


//
//
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

const BUILD_WEEK_CODEX_DOCS = Object.freeze([
  { path: "HACKATHON.md", expectedCommands: 1 },
  { path: "packages/bench/README.md", expectedCommands: 2 },
  { path: "docs/benchmarks.md", expectedCommands: 2 },
  { path: "docs/paper/repro-appendix.md", expectedCommands: 2 },
]);

const BENCH_RUN_BOOLEAN_FLAGS = new Set([
  "--mcp-demo",
  "--quick",
  "--all",
  "--json",
  "--internal-disable-thinking",
  "--disable-thinking",
  "--no-judge-cache",
  "--resume",
  "--retry-failed",
  "--help",
  "-h",
]);

const BUILD_WEEK_ALLOWED_RUN_BOOLEAN_FLAGS = new Set(["--json"]);

const BUILD_WEEK_ALLOWED_RUN_VALUE_FLAGS = new Set([
  "--runtime-profile",
  "--limit",
  "--trial-limit",
  "--dataset-dir",
  "--results-dir",
  "--drain-timeout",
  "--system-provider",
  "--system-model",
  "--system-codex-reasoning-effort",
  "--internal-provider",
  "--internal-model",
  "--internal-codex-reasoning-effort",
  "--judge-provider",
  "--judge-model",
  "--judge-codex-reasoning-effort",
]);

const BUILD_WEEK_ALLOWED_RUN_FLAGS = new Set([
  ...BUILD_WEEK_ALLOWED_RUN_BOOLEAN_FLAGS,
  ...BUILD_WEEK_ALLOWED_RUN_VALUE_FLAGS,
]);

const BUILD_WEEK_CREDIT_ENV_CONTRACTS = Object.freeze([
  {
    name: "REMNIC_BENCH_CODEX_CREDIT_BUDGET",
    expected: "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
    valid: /^\s*export\s+REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473(?:[ \t]+#.*)?[ \t]*$/,
  },
  {
    name: "REMNIC_BENCH_CODEX_CREDIT_RESERVE",
    expected: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
    valid: /^\s*export\s+REMNIC_BENCH_CODEX_CREDIT_RESERVE=473(?:[ \t]+#.*)?[ \t]*$/,
  },
  {
    name: "REMNIC_BENCH_CODEX_CREDIT_LEDGER",
    expected:
      'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
    valid:
      /^\s*export\s+REMNIC_BENCH_CODEX_CREDIT_LEDGER="\$BUILD_WEEK_RUN_ROOT\/codex-credit-ledger\.json"(?:[ \t]+#.*)?[ \t]*$/,
  },
]);
const BUILD_WEEK_RUN_ROOT_ENV_CONTRACT = Object.freeze({
  name: "BUILD_WEEK_RUN_ROOT",
  expected: 'export BUILD_WEEK_RUN_ROOT="$HOME/.remnic/bench/build-week-2026"',
  valid:
    /^\s*export\s+BUILD_WEEK_RUN_ROOT="\$HOME\/\.remnic\/bench\/build-week-2026"(?:[ \t]+#.*)?[ \t]*$/,
});
const BUILD_WEEK_RESULTS_ENV_CONTRACT = Object.freeze({
  name: "BUILD_WEEK_RESULTS_DIR",
  expected: 'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
  valid:
    /^\s*export\s+BUILD_WEEK_RESULTS_DIR="\$BUILD_WEEK_RUN_ROOT\/results"(?:[ \t]+#.*)?[ \t]*$/,
});
const BUILD_WEEK_PAID_ENV_CONTRACTS = Object.freeze([
  BUILD_WEEK_RUN_ROOT_ENV_CONTRACT,
  ...BUILD_WEEK_CREDIT_ENV_CONTRACTS,
  BUILD_WEEK_RESULTS_ENV_CONTRACT,
]);
const BUILD_WEEK_ROOT_DEPENDENT_ENV_NAMES = new Set([
  "REMNIC_BENCH_CODEX_CREDIT_LEDGER",
  "BUILD_WEEK_RESULTS_DIR",
]);
const BUILD_WEEK_SHELL_LANGS = new Set(["", "bash", "sh", "shell", "shell-session", "zsh", "console"]);

function containsShellCreditProtocolName(line, name) {
  return new RegExp(`\\b${name}\\b`).test(line);
}

function containsShellPathVariableMutation(line, contract) {
  return new RegExp(`(?<![\\$\\{])\\b${contract.name}\\b`).test(line);
}

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})/;
const REMNIC_TOKEN_RE = /\bremnic\s+([A-Za-z][A-Za-z0-9:_-]*)/g;

const STUB_AUTOMATION_PHRASES = [
  "installs the plugin",
  "configures mcp",
  "automatically",
];

const INSTALL_HEADING_RE = /^#{1,6}\s*(install|installation|setup|quick\s*start|getting\s*started|prerequisites)\b/i;

const NO_OP_MARKER_RE = /\b(no-op stub|no-op:|not yet implemented|caching not yet implemented)\b/i;

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

/** @type {Record<string, string>} */
const NO_OP_ALLOWLIST = {
  "extensions reload": "#1518",
};


function toPosix(p) {
  return p.split(path.sep).join("/");
}

function isMarkdown(name) {
  return name.endsWith(".md");
}

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

  for (const f of walkMarkdown(docsDir)) {
    files.push(toPosix(path.relative(ROOT, f)));
  }
  const rootReadme = path.join(ROOT, "README.md");
  if (existsSync(rootReadme) && statSync(rootReadme).isFile()) {
    files.push("README.md");
  }

  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const readme = path.join(packagesDir, entry.name, "README.md");
      if (existsSync(readme) && statSync(readme).isFile()) {
        files.push(toPosix(path.relative(ROOT, readme)));
      }
    }
  }

  return [...new Set(files)].sort();
}


/**
 * Iterate fenced code blocks in markdown source, calling back with the text
 * inside each fence. Handles ``` and ~~~ fences and ignores fences nested
 * inside blockquotes (the > ``` form) only when the fence markers don't line
 * up — the common case in this repo is plain top-level fences.
 *
 * @param {string} src
 * @returns {Array<{ text: string; startLine: number; lang: string }>}
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
    const infoStr = lines[i].slice(openMatch[0].length).trim().split(/\s+/)[0] ?? "";
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
    blocks.push({ text: bodyLines.join("\n"), startLine, lang: infoStr });
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
  const SHELL_LANGS = new Set([
    "",
    "bash",
    "sh",
    "shell",
    "shell-session",
    "zsh",
    "console",
    "bat",
    "powershell",
    "ps1",
  ]);
  for (const block of blocks) {
    if (!SHELL_LANGS.has(block.lang)) continue;
    const lines = block.text.split("\n");
    for (let j = 0; j < lines.length; j++) {
      const raw = lines[j];
      if (/^\s*#/.test(raw)) continue;
      REMNIC_TOKEN_RE.lastIndex = 0;
      let m;
      while ((m = REMNIC_TOKEN_RE.exec(raw)) !== null) {
        const subcommand = m[1];
        out.push({
          file: relPath,
          line: block.startLine + 1 + j,
          subcommand,
          full: raw.trim(),
        });
      }
    }
  }
  return out;
}

/**
 * Normalize shell-like fenced blocks into logical commands by joining lines
 * ending in a backslash. This is intentionally small: the Build Week commands
 * are ordinary multiline shell invocations, not arbitrary shell programs.
 *
 * @param {string} src
 * @returns {Array<{ command: string; commandStartLine: number; blockHasCreditProtocolMutation: boolean }>}
 */
function extractLogicalShellCommands(src) {
  const commands = [];
  for (const block of extractFencedBlocks(src)) {
    if (!BUILD_WEEK_SHELL_LANGS.has(block.lang)) continue;
    const lines = block.text.split("\n");
    const blockHasCreditProtocolMutation = lines.some(
      (line) =>
        !/^\s*#/.test(line) &&
        BUILD_WEEK_CREDIT_ENV_CONTRACTS.some(({ name }) => containsShellCreditProtocolName(line, name)),
    );
    let logicalParts = [];
    let logicalStartIndex = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (logicalParts.length === 0) logicalStartIndex = index;
      const continues = /\\\s*$/.test(line);
      logicalParts.push(line.replace(/\\\s*$/, ""));
      if (continues && index + 1 < lines.length) continue;
      const command = logicalParts.join(" ").trim();
      if (command.length > 0 && !command.startsWith("#")) {
        commands.push({
          command,
          commandStartLine: block.startLine + 1 + logicalStartIndex,
          blockHasCreditProtocolMutation,
        });
      }
      logicalParts = [];
    }
  }
  return commands;
}

/**
 * Return document-ordered shell mutations of paid-run environment contracts.
 * The last mutation before a command determines whether its child process is
 * guarded and writes to the private result store. Prose and non-shell fences
 * never affect executable environment state.
 *
 * @param {string} src
 * @returns {Array<{ name: string; line: number; valid: boolean }>}
 */
function extractShellPaidRunEnvMutations(src) {
  const mutations = [];
  for (const block of extractFencedBlocks(src)) {
    if (!BUILD_WEEK_SHELL_LANGS.has(block.lang)) continue;
    for (const [index, line] of block.text.split("\n").entries()) {
      if (/^\s*#/.test(line)) continue;
      for (const contract of BUILD_WEEK_PAID_ENV_CONTRACTS) {
        const isPathContract =
          contract === BUILD_WEEK_RUN_ROOT_ENV_CONTRACT ||
          contract === BUILD_WEEK_RESULTS_ENV_CONTRACT;
        const isMutation = isPathContract
          ? containsShellPathVariableMutation(line, contract)
          : containsShellCreditProtocolName(line, contract.name);
        if (!isMutation) continue;
        mutations.push({
          name: contract.name,
          line: block.startLine + 1 + index,
          valid: contract.valid.test(line),
        });
      }
    }
  }
  return mutations;
}

/**
 * Read every positional benchmark after `remnic bench run`, skipping options
 * and their values. This intentionally tokenizes only the simple documented
 * shell commands handled by extractLogicalShellCommands.
 *
 * @param {string} command
 * @returns {string[] | undefined}
 */
function extractRunBenchmarks(command) {
  const tokens = command.trim().split(/\s+/);
  const remnicAt = tokens.indexOf("remnic");
  if (remnicAt < 0 || tokens[remnicAt + 1] !== "bench" || tokens[remnicAt + 2] !== "run") {
    return undefined;
  }
  const benchmarks = [];
  for (let i = remnicAt + 3; i < tokens.length; i++) {
    const token = tokens[i];
    if (BENCH_RUN_BOOLEAN_FLAGS.has(token)) continue;
    if (token.startsWith("-")) {
      const next = tokens[i + 1];
      if (!token.includes("=") && next && !next.startsWith("-")) i += 1;
      continue;
    }
    benchmarks.push(token);
  }
  return benchmarks;
}

/**
 * Read a simple, space-separated option value from a documented command.
 * Missing values and another flag in value position both return undefined.
 *
 * @param {string} command
 * @param {string} flag
 * @returns {string | undefined}
 */
function extractShellOptionValue(command, flag) {
  const tokens = command.trim().split(/\s+/);
  const at = tokens.indexOf(flag);
  if (at < 0) return undefined;
  const value = tokens[at + 1];
  if (!value || (value.startsWith("-") && !/^-\d/.test(value))) return undefined;
  return value;
}

/**
 * Enforce the staged-dataset contract for every documented Codex CLI
 * LongMemEval/LoCoMo benchmark command.
 *
 * @returns {{ failures: string[]; checked: number }}
 */
function checkBuildWeekCodexDatasetPaths() {
  const failures = [];
  let checked = 0;
  const completeProtocolDocSet = BUILD_WEEK_CODEX_DOCS.every(({ path: rel }) =>
    existsSync(path.join(ROOT, ...rel.split("/"))),
  );
  for (const { path: rel, expectedCommands } of BUILD_WEEK_CODEX_DOCS) {
    const abs = path.join(ROOT, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const paidRunEnvMutations = extractShellPaidRunEnvMutations(src);
    let checkedInDoc = 0;
    for (const { command, commandStartLine, blockHasCreditProtocolMutation } of extractLogicalShellCommands(src)) {
      if (!/\bremnic\s+bench\s+run\b/.test(command)) continue;
      const usesCodexCli = /\bcodex-cli\b/.test(command);
      if (!blockHasCreditProtocolMutation && !usesCodexCli) continue;
      const commandTokens = command.trim().split(/\s+/);
      if (
        commandTokens[0] !== "remnic" ||
        commandTokens[1] !== "bench" ||
        commandTokens[2] !== "run"
      ) {
        failures.push(
          `${rel}: Build Week Codex benchmark must execute directly as \`remnic bench run\` ` +
            "with no shell wrapper or command prefix",
        );
        continue;
      }
      const datasetFlag = extractShellOptionValue(command, "--dataset-dir");
      const positionalBenchmarks = extractRunBenchmarks(command) ?? [];
      checked += 1;
      checkedInDoc += 1;
      const remnicCommandAt = command.search(/\bremnic\s+bench\s+run\b/);
      const commandPrefix = remnicCommandAt > 0 ? command.slice(0, remnicCommandAt) : "";
      const lastEnvMutations = new Map(
        BUILD_WEEK_PAID_ENV_CONTRACTS.map((contract) => [
          contract.name,
          paidRunEnvMutations.findLast(
            ({ name, line }) => name === contract.name && line < commandStartLine,
          ),
        ]),
      );
      const lastRunRootMutation = lastEnvMutations.get(BUILD_WEEK_RUN_ROOT_ENV_CONTRACT.name);
      for (const contract of BUILD_WEEK_PAID_ENV_CONTRACTS) {
        const lastMutation = lastEnvMutations.get(contract.name);
        const dependsOnRunRoot = BUILD_WEEK_ROOT_DEPENDENT_ENV_NAMES.has(contract.name);
        const followsCurrentRunRoot =
          !dependsOnRunRoot ||
          (lastRunRootMutation?.valid === true &&
            lastMutation !== undefined &&
            lastMutation.line > lastRunRootMutation.line);
        if (
          !lastMutation?.valid ||
          !followsCurrentRunRoot ||
          commandPrefix.includes(contract.name)
        ) {
          failures.push(
            `${rel}: Build Week Codex command must follow an exact shell export of ` +
              `\`${contract.expected}\`` +
              (dependsOnRunRoot
                ? ` after \`${BUILD_WEEK_RUN_ROOT_ENV_CONTRACT.expected}\``
                : ""),
          );
        }
      }
      const remnicAt = commandTokens.indexOf("remnic");
      const runOptionTokens = commandTokens.slice(remnicAt + 3);
      const optionCounts = new Map();
      for (let optionIndex = 0; optionIndex < runOptionTokens.length; optionIndex += 1) {
        const token = runOptionTokens[optionIndex];
        if (!token.startsWith("-")) continue;
        if (!BUILD_WEEK_ALLOWED_RUN_FLAGS.has(token)) {
          failures.push(
            token.includes("=")
              ? `${rel}: Build Week Codex command must use separate option/value tokens; ` +
                `equals-form option \`${token}\` is not supported by the bench CLI`
              : `${rel}: Build Week Codex command must not include unpinned run option \`${token}\``,
          );
          continue;
        }
        const count = (optionCounts.get(token) ?? 0) + 1;
        optionCounts.set(token, count);
        if (count > 1) {
          failures.push(
            `${rel}: Build Week Codex command must include option \`${token}\` at most once`,
          );
        }
        if (BUILD_WEEK_ALLOWED_RUN_BOOLEAN_FLAGS.has(token)) continue;
        const value = runOptionTokens[optionIndex + 1];
        if (!value || value.startsWith("-")) {
          failures.push(
            `${rel}: Build Week Codex command option \`${token}\` requires a separate non-option value`,
          );
          continue;
        }
        optionIndex += 1;
      }
      for (const selector of ["--all", "--custom", "--matrix"]) {
        if (commandTokens.some((token) => token === selector || token.startsWith(`${selector}=`))) {
          failures.push(
            `${rel}: Build Week Codex command must not include \`${selector}\`; ` +
              "run exactly one pinned benchmark and runtime profile",
          );
        }
      }
      if (
        positionalBenchmarks.length !== 1 ||
        (positionalBenchmarks[0] !== "longmemeval" && positionalBenchmarks[0] !== "locomo")
      ) {
        failures.push(
          `${rel}: Build Week Codex command must include exactly one positional benchmark, ` +
            `\`longmemeval\` or \`locomo\`, after \`remnic bench run\``,
        );
        continue;
      }
      const benchmark = positionalBenchmarks[0];
      const expected = `./bench-datasets/${benchmark}`;
      if (datasetFlag !== expected) {
        failures.push(
          `${rel}: Build Week Codex ${benchmark} command must include ` +
            `\`--dataset-dir ${expected}\`; got ${datasetFlag ?? "no --dataset-dir"}`,
        );
      }
      if (commandTokens.includes("--quick")) {
        failures.push(
          `${rel}: Build Week Codex ${benchmark} command must not use \`--quick\`; ` +
            "use full mode with an explicit item bound so a bad staged path fails before provider dispatch",
        );
      }
      const requiredProtocolOptions = new Map([
        ["--runtime-profile", "real"],
        ["--results-dir", '"$BUILD_WEEK_RESULTS_DIR"'],
        ["--drain-timeout", "600000"],
        ["--system-provider", "codex-cli"],
        ["--system-model", "gpt-5.6-luna"],
        ["--system-codex-reasoning-effort", "medium"],
        ["--internal-provider", "codex-cli"],
        ["--internal-model", "gpt-5.6-luna"],
        ["--internal-codex-reasoning-effort", "medium"],
        ["--judge-provider", "codex-cli"],
        ["--judge-model", "gpt-5.6-terra"],
        ["--judge-codex-reasoning-effort", "high"],
      ]);
      for (const [flag, requiredValue] of requiredProtocolOptions) {
        const actualValue = extractShellOptionValue(command, flag);
        if (actualValue !== requiredValue) {
          failures.push(
            `${rel}: Build Week Codex ${benchmark} command must include ` +
              `\`${flag} ${requiredValue}\`; got ${actualValue ?? `no ${flag}`}`,
          );
        }
      }
      if (commandTokens.some((token) => token === "--request-timeout" || token.startsWith("--request-timeout="))) {
        failures.push(
          `${rel}: Build Week Codex ${benchmark} command must not include \`--request-timeout\`; ` +
            "the Codex transport profile owns that timeout",
        );
      }
      if (command.includes("gpt-5.6-sol")) {
        failures.push(
          `${rel}: Build Week Codex ${benchmark} command must not use \`gpt-5.6-sol\``,
        );
      }
      const allBoundFlags = ["--limit", "--trial-limit"];
      const supportedBoundFlags =
        benchmark === "longmemeval" ? ["--limit"] : allBoundFlags;
      const unsupportedBoundFlags = allBoundFlags.filter(
        (flag) =>
          !supportedBoundFlags.includes(flag) &&
          commandTokens.some((token) => token === flag || token.startsWith(`${flag}=`)),
      );
      for (const flag of unsupportedBoundFlags) {
        failures.push(
          `${rel}: Build Week Codex ${benchmark} command must not include \`${flag}\`; ` +
            "the benchmark CLI does not support that bound",
        );
      }
      const presentBoundFlags = supportedBoundFlags.filter((flag) =>
        commandTokens.some((token) => token === flag || token.startsWith(`${flag}=`)),
      );
      if (presentBoundFlags.length === 0) {
        failures.push(
          benchmark === "longmemeval"
            ? `${rel}: Build Week Codex longmemeval command must include an explicit \`--limit\``
            : `${rel}: Build Week Codex locomo command must include an explicit \`--limit\` or \`--trial-limit\``,
        );
      }
      for (const flag of presentBoundFlags) {
        const value = extractShellOptionValue(command, flag);
        if (value === undefined) {
          failures.push(`${rel}: Build Week Codex ${benchmark} command has no value for \`${flag}\``);
          continue;
        }
        if (!/^(?:[1-9]\d*|<LEDGER_DERIVED_LIMIT>)$/.test(value)) {
          failures.push(
            `${rel}: Build Week Codex ${benchmark} ${flag} must be a positive integer or \`<LEDGER_DERIVED_LIMIT>\`; got ${value}`,
          );
        }
      }
      if (expectedCommands === 1 || expectedCommands === 2) {
        const requiredLimit =
          expectedCommands === 1 || checkedInDoc === 2 ? "<LEDGER_DERIVED_LIMIT>" : "1";
        const roleBounds = presentBoundFlags.map((flag) => ({
          flag,
          value: extractShellOptionValue(command, flag),
        }));
        if (roleBounds.length !== 1 || roleBounds[0].value !== requiredLimit) {
          const acceptedFlags = supportedBoundFlags.map((flag) => `\`${flag} ${requiredLimit}\``);
          const actualBounds = roleBounds.map(({ flag, value }) => `${flag} ${value ?? "<missing>"}`);
          failures.push(
            `${rel}: Build Week Codex command ${checkedInDoc} of ${expectedCommands} must include exactly one of ` +
              `${acceptedFlags.join(" or ")}; got ${actualBounds.join(", ") || "no supported bound"}`,
          );
        }
      }
    }
    if (checkedInDoc === 0) {
      failures.push(
        `${rel}: must contain at least one guarded Build Week Codex benchmark command`,
      );
    } else if (completeProtocolDocSet && checkedInDoc !== expectedCommands) {
      failures.push(
        `${rel}: expected ${expectedCommands} guarded Build Week Codex benchmark command(s); ` +
          `found ${checkedInDoc}`,
      );
    }
  }
  return { failures, checked };
}


const COMMAND_NAME_TYPE_RE = /type\s+CommandName\s*=\s*([\s\S]*?);/;
const QUOTED_MEMBER_RE = /"([A-Za-z][A-Za-z0-9:_-]*)"/g;

//
const CORE_TOP_LEVEL_RE = /\bcmd\b\s*\.\s*command\(\s*"([A-Za-z][A-Za-z0-9:_-]*)(?:\s+[<\[][^"]*)?"\s*\)/g;

/**
 * Collect the set of registered top-level command names from both CLI files.
 *
 * CONTRACT — this gate verifies REGISTRATION, not DISPATCH. A documented
 * `remnic <cmd>` passes if the command is registered in EITHER CLI surface
 * (the standalone binary's `CommandName` union OR the core plugin-runtime
 * commander tree). See the CLI_FILES comment above for why both are merged.
 *
 * For remnic-cli/src/index.ts, extracts the `type CommandName = …;` body
 * and scans only that — the authoritative top-level set. Sibling union
 * types in the same file are excluded so that `remnic install` (a docs
 * typo) is not masked by `type DaemonAction = … | "install" | …`, and
 * nested `case "install":` labels inside `cmdDaemon` are excluded too.
 *
 * For remnic-core/src/cli.ts, uses only `.command("X")` calls whose
 * receiver is the `cmd` (engram parent) variable — grandchild commands
 * like `tierCmd.command("list")` are excluded.
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
    const typeMatch = src.match(COMMAND_NAME_TYPE_RE);
    if (typeMatch) {
      const body = typeMatch[1];
      QUOTED_MEMBER_RE.lastIndex = 0;
      let m;
      while ((m = QUOTED_MEMBER_RE.exec(body)) !== null) {
        commands.add(m[1]);
      }
    }
    let m;
    CORE_TOP_LEVEL_RE.lastIndex = 0;
    while ((m = CORE_TOP_LEVEL_RE.exec(src)) !== null) {
      commands.add(m[1]);
    }
  }
  return commands;
}


/**
 * Scan CLI source for no-op handler markers and return the set of
 * "command path" strings (e.g. "extensions reload") whose handler contains a
 * no-op label.
 *
 * Two CLI styles are handled:
 *  - remnic-cli/src/index.ts — `async function cmd<X>(...)` enclosing a
 *    `switch` with `case "Y":` arms. The no-op path is `<kebab(X)> <Y>`.
 *    When no function context is found, falls back to the bare case label.
 *  - remnic-core/src/cli.ts — commander `.command()` registrations. The
 *    path is built by resolving receiver variables
 *    (`const tierCmd = cmd.command("tier"); tierCmd.command("list")` →
 *    "tier list"), with the "engram" gateway-prefix root dropped.
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

    let funcName = null; // current cmd<X> suffix, e.g. "Extensions"
    let funcKebab = null; // kebab form, e.g. "extensions"
    let currentCase = null;
    let depth = 0; // running brace depth across the file
    let funcDepth = null; // depth inside the current cmd<X> function body

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const opens = (line.match(/{/g) || []).length;
      const closes = (line.match(/}/g) || []).length;

      const funcMatch = line.match(FUNC_RE);
      if (funcMatch) {
        funcName = funcMatch[1];
        funcKebab = pascalToKebab(funcName);
        currentCase = null;
        funcDepth = depth + opens;
      }

      depth += opens - closes;

      if (funcDepth !== null && depth < funcDepth) {
        funcKebab = null;
        currentCase = null;
        funcDepth = null;
      }

      const caseMatch = line.match(CASE_RE);
      if (caseMatch) {
        currentCase = caseMatch[1];
      }

      if (NO_OP_MARKER_RE.test(line)) {
        if (funcKebab && currentCase) {
          detected.add(`${funcKebab} ${currentCase}`);
        } else if (currentCase) {
          detected.add(currentCase);
        }
      }
    }

    /** @type {Map<string, string[]>} commander var → full path (incl. root) */
    const varPath = new Map();
    let prevReceiver = null; // receiver var on the prior line (multi-line chain)
    let pendingAssign = null; // var assigned in a multi-line `const X = recv`
    let currentCmdPath = null; // most recent .command() path (root dropped)

    const dropRoot = (p) => (p.length > 0 && p[0] === "engram" ? p.slice(1) : p);
    const PH = '(?:\\s+[<\\[][^"]*)?';
    const RE_ASSIGN_INLINE = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*command\\(\\s*"([A-Za-z][A-Za-z0-9:_-]*)${PH}"\\s*\\)`);
    const RE_CALL_INLINE = new RegExp(`(?:^|[^.\\w$])([A-Za-z_$][\\w$]*)\\s*\\.\\s*command\\(\\s*"([A-Za-z][A-Za-z0-9:_-]*)${PH}"\\s*\\)`);
    const RE_TAIL = new RegExp(`^\\.\\s*command\\(\\s*"([A-Za-z][A-Za-z0-9:_-]*)${PH}"\\s*\\)`);
    const RE_ASSIGN_HEAD = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)$/;
    const RE_BARE_VAR = /^([A-Za-z_$][\w$]*)$/;

    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();

      let receiver = null;
      let leaf = null;
      let assignVar = null;

      const aInline = stripped.match(RE_ASSIGN_INLINE);
      const cInline = !aInline ? stripped.match(RE_CALL_INLINE) : null;
      const tail = !aInline && !cInline ? stripped.match(RE_TAIL) : null;

      if (aInline) {
        assignVar = aInline[1];
        receiver = aInline[2];
        leaf = aInline[3];
      } else if (cInline) {
        receiver = cInline[1];
        leaf = cInline[2];
      } else if (tail) {
        leaf = tail[1];
        receiver = prevReceiver;
        assignVar = pendingAssign;
      } else {
        const head = stripped.match(RE_ASSIGN_HEAD);
        if (head) {
          prevReceiver = head[2];
          pendingAssign = head[1];
        } else if (stripped.match(RE_BARE_VAR)) {
          prevReceiver = stripped;
          pendingAssign = null;
        } else {
          prevReceiver = null;
          pendingAssign = null;
        }
      }

      if (leaf !== null && receiver !== null) {
        const parent = varPath.get(receiver) ?? [];
        const full = [...parent, leaf];
        if (assignVar) varPath.set(assignVar, full);
        currentCmdPath = dropRoot(full);
        prevReceiver = null;
        pendingAssign = null;
      }

      if (NO_OP_MARKER_RE.test(lines[i]) && currentCmdPath && currentCmdPath.length > 0) {
        detected.add(currentCmdPath.join(" "));
      }
    }
  }
  return detected;
}


const PUBLISHERS = [
  "packages/remnic-core/src/memory-extension/claude-code-publisher.ts",
  "packages/remnic-core/src/memory-extension/codex-publisher.ts",
  "packages/remnic-core/src/memory-extension/hermes-publisher.ts",
];

const CAPABILITIES_BLOCK_RE = /static\s+readonly\s+capabilities\s*:[\s\S]*?=\s*\{([\s\S]*?)\}/;
const STUB_FLAG_KEYS = ["instructionsMd", "skillsFolder", "citationFormat", "readPathTemplate"];
const HOST_ID_RE = /readonly\s+hostId\s*=\s*"([^"]+)"/;
const IS_STUB_TRUE_RE = /\bisStub\s*:\s*true\b/;

/**
 * A publisher is a stub when EITHER:
 *   (a) it explicitly declares `isStub: true` in its capabilities block
 *       (the source of truth since #1518 — a real publisher that happens to
 *       produce no instructions.md/skills/citation/read-path artefacts, like
 *       the Pi-family host publisher, must declare `isStub: false` so the
 *       inference backstop does not mis-classify it); OR
 *   (b) the legacy inference: ALL four artefact flags are false AND no
 *       explicit `isStub` key is present (backstop for not-yet-migrated
 *       publishers).
 *
 * Once every publisher declares `isStub` explicitly, branch (b) is dead code
 * kept only as a safety net.
 *
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
    const blockMatch = src.match(CAPABILITIES_BLOCK_RE);
    const body = blockMatch ? blockMatch[1] : "";
    const hasExplicit = /\bisStub\s*:/.test(body);
    const explicitStub = IS_STUB_TRUE_RE.test(body);
    const inferredStub =
      !hasExplicit &&
      STUB_FLAG_KEYS.every((k) => new RegExp(`\\b${k}\\s*:\\s*false`).test(body));
    out.set(hostId, { hostId, isStub: explicitStub || inferredStub, file: rel });
  }
  return out;
}


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
  const NEGATOR_RE = /\b(no|not|never|don'?t|doesn'?t|won'?t|cannot|can'?t|neither|nor|without)\b[^a-z0-9]*$/;
  for (const phrase of STUB_AUTOMATION_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const prefix = lower.slice(Math.max(0, idx - 40), idx);
      if (!NEGATOR_RE.test(prefix)) {
        hits.push({ phrase, idx });
      }
      idx = lower.indexOf(phrase, idx + 1);
    }
  }
  return hits;
}


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

  const buildWeekDatasets = checkBuildWeekCodexDatasetPaths();
  failures.push(...buildWeekDatasets.failures);

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

  const docCommands = [...documented.keys()].sort();
  console.log(
    `[docs-parity] OK — ${docCommands.length} documented command(s) resolve; ` +
      `${detectedNoOps.size} no-op(s) tracked; ` +
      `${[...publishers.values()].filter((p) => p.isStub).length} stub publisher(s) honest; ` +
      `${buildWeekDatasets.checked} Build Week Codex dataset command(s) pinned.`,
  );
  if (docCommands.length > 0) {
    console.log(`[docs-parity]   commands: ${docCommands.join(", ")}`);
  }
}

main();
