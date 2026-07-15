// Docs-code parity check tests (issue #1527 PR2).
//
// Mirrors check-ratchets.test.mjs conventions: spawnSync the script with a
// REMNIC_DOCS_PARITY_ROOT pointing at a synthetic fixture repo, assert exit
// codes + stderr/stdout. Each gate has a prove-fail-before case: seed a
// violation, show the script fails, then show the fix passes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "check-docs-parity.mjs",
);

function runParity(root) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_DOCS_PARITY_ROOT: root,
    },
  });
}

/**
 * Build a minimal fixture repo root. Every gate's fixture starts from this
 * base so the "green" pieces (registered commands, honest stub publishers)
 * are always present; each test then adds the specific violation it wants to
 * exercise.
 */
function makeBaseFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "docs-parity-test-"));

  // CLI: two files. remnic-cli has a case-based dispatch; cli.ts has
  // commander-style registrations. Together they exercise both registration
  // scanners.
  const cliDir = path.join(root, "packages", "remnic-cli", "src");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    path.join(cliDir, "index.ts"),
    [
      'type CommandName = "init" | "status" | "extensions" | "daemon";',
      "",
      "async function cmdExtensions(action: string, rest: string[]) {",
      "  switch (action) {",
      '    case "list":',
      '      console.log("list");',
      "      break;",
      '    case "reload": {',
      "      // No-op stub reserved for future caching",
      '      console.log("Extension cache reloaded (no-op: caching not yet implemented).");',
      "      break;",
      "    }",
      "    default:",
      "      break;",
      "  }",
      "}",
      "",
      "async function main() {",
      "  const [command, ...rest] = process.argv.slice(2);",
      "  switch (command as CommandName) {",
      '    case "init":',
      "      break;",
      '    case "extensions":',
      "      await cmdExtensions(rest[0], rest.slice(1));",
      "      break;",
      "    default:",
      "      break;",
      "  }",
      "}",
      "",
      "main();",
    ].join("\n"),
  );

  const coreCliDir = path.join(root, "packages", "remnic-core", "src");
  mkdirSync(coreCliDir, { recursive: true });
  writeFileSync(
    path.join(coreCliDir, "cli.ts"),
    [
      'const cmd = program.command("engram");',
      'cmd.command("doctor").description("Run diagnostics").action(async () => {});',
      'cmd.command("recall").description("Run recall").action(async () => {});',
      'cmd.command("tier").description("Tier ops").action(async () => {});',
    ].join("\n"),
  );

  // Stub publisher (claude-code): all-false capabilities.
  const pubDir = path.join(root, "packages", "remnic-core", "src", "memory-extension");
  mkdirSync(pubDir, { recursive: true });
  // Stub publisher (claude-code): all-false capabilities.
  writeFileSync(
    path.join(pubDir, "claude-code-publisher.ts"),
    [
      "interface PublisherCapabilities {}",
      'export class ClaudeCodeMemoryExtensionPublisher {',
      '  readonly hostId = "claude-code";',
      "  static readonly capabilities: PublisherCapabilities = {",
      "    instructionsMd: false,",
      "    skillsFolder: false,",
      "    citationFormat: false,",
      "    readPathTemplate: false,",
      "  };",
      "}",
    ].join("\n"),
  );

  // Real publisher (codex): some-true capabilities — not gated.
  writeFileSync(
    path.join(pubDir, "codex-publisher.ts"),
    [
      "interface PublisherCapabilities {}",
      'export class CodexMemoryExtensionPublisher {',
      '  readonly hostId = "codex";',
      "  static readonly capabilities: PublisherCapabilities = {",
      "    instructionsMd: true,",
      "    skillsFolder: false,",
      "    citationFormat: true,",
      "    readPathTemplate: true,",
      "  };",
      "}",
    ].join("\n"),
  );

  // Honest stub-publisher doc (no automation claims in install section).
  const pluginDocsDir = path.join(root, "docs", "plugins");
  mkdirSync(pluginDocsDir, { recursive: true });
  writeFileSync(
    path.join(pluginDocsDir, "claude-code.md"),
    [
      "# Claude Code Plugin",
      "",
      "## Install",
      "",
      "Three manual steps. The publisher is a stub — nothing is written for you.",
      "",
      "```bash",
      "remnic init",
      "```",
      "",
      "## Runtime",
      "",
      "Once set up, memory works in Claude Code sessions.",
      "",
    ].join("\n"),
  );

  // A doc with a registered fenced invocation (green path).
  const docsDir = path.join(root, "docs");
  writeFileSync(
    path.join(docsDir, "guide.md"),
    [
      "# Guide",
      "",
      "```bash",
      "remnic status",
      "remnic doctor",
      "remnic extensions list",
      "```",
      "",
      "Prose mention of remnic recall should not be checked (outside a fence).",
      "",
    ].join("\n"),
  );

  // Package README with a registered fenced invocation.
  const pkgDir = path.join(root, "packages", "plugin-claude-code");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "README.md"),
    [
      "# plugin-claude-code",
      "",
      "```bash",
      "remnic init",
      "```",
      "",
    ].join("\n"),
  );

  return root;
}

function withFixture(fn) {
  const root = makeBaseFixture();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Green path ─────────────────────────────────────────────────────────────

test("base fixture passes — all commands resolve, stub is honest, no-op tracked", () => {
  withFixture((root) => {
    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[docs-parity\] OK/);
    assert.match(result.stdout, /4 documented command\(s\) resolve/);
    assert.match(result.stdout, /1 no-op\(s\) tracked/);
    assert.match(result.stdout, /1 stub publisher\(s\) honest/);
  });
});

// ── Gate (a): nonexistent documented command ───────────────────────────────
test("a documented command that is not registered fails the check", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "docs", "bogus.md"),
      [
        "# Bogus",
        "",
        "```bash",
        "remnic nonexistent-command --flag",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documented command "remnic nonexistent-command" is not registered/);
    // Line must be 4 (the actual command line), not 3 (the fence opener) —
    // guards the off-by-one fix in extractRemnicInvocations.
    assert.match(result.stderr, /bogus\.md:4/);
  });
});

test("prose mention of a bogus command outside a fenced block does NOT fail", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "docs", "prose.md"),
      [
        "# Prose",
        "",
        "You could try `remnic totally-bogus` but it does not exist.",
        "",
        "    remnic indented-but-not-fenced",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

// ── Gate (b): automation claim for stub publisher ──────────────────────────

test("an automation phrase in a stub publisher's install section fails", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "docs", "plugins", "claude-code.md"),
      [
        "# Claude Code Plugin",
        "",
        "## Install",
        "",
        "The installer automatically configures everything for you.",
        "",
        "```bash",
        "remnic init",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stub publisher "claude-code"/);
    assert.match(result.stderr, /automation phrase "automatically"/);
  });
});

test("an automation phrase outside the install section does NOT fail", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "docs", "plugins", "claude-code.md"),
      [
        "# Claude Code Plugin",
        "",
        "## Install",
        "",
        "Manual only. The publisher is a stub.",
        "",
        "## Runtime",
        "",
        "Once installed, the daemon automatically recalls context.",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("a real publisher (some-true capabilities) is NOT gated", () => {
  withFixture((root) => {
    // Codex has instructionsMd: true — it may claim automation.
    writeFileSync(
      path.join(root, "docs", "plugins", "codex.md"),
      [
        "# Codex Plugin",
        "",
        "## Install",
        "",
        "The installer automatically writes instructions.md and configures MCP.",
        "",
        "```bash",
        "remnic init",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

// Regression: a stub publisher with the same all-false capabilities but
// REORDERED keys must still be detected as a stub. Before the
// order-independent fix, the single-sequence regex missed reordered keys
// and the automation gate was silently skipped (codex P2 thread PR #1601).
test("a stub publisher with reordered capability keys is still gated", () => {
  withFixture((root) => {
    // Rewrite claude-code publisher with all-false values in a DIFFERENT
    // order than the default (skillsFolder first, instructionsMd third).
    writeFileSync(
      path.join(root, "packages", "remnic-core", "src", "memory-extension", "claude-code-publisher.ts"),
      [
        "interface PublisherCapabilities {}",
        'export class ClaudeCodeMemoryExtensionPublisher {',
        '  readonly hostId = "claude-code";',
        "  static readonly capabilities: PublisherCapabilities = {",
        "    skillsFolder: false,",
        "    readPathTemplate: false,",
        "    instructionsMd: false,",
        "    citationFormat: false,",
        "  };",
        "}",
      ].join("\n"),
    );
    // Add an automation phrase to the install section.
    writeFileSync(
      path.join(root, "docs", "plugins", "claude-code.md"),
      [
        "# Claude Code Plugin",
        "",
        "## Install",
        "",
        "The installer automatically configures everything.",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stub publisher "claude-code".*automation phrase/);
  });
});

// ── Gate (c): unlisted no-op ───────────────────────────────────────────────

test("a no-op handler not in the allowlist fails the check", () => {
  withFixture((root) => {
    // Add a new no-op handler to the CLI that is NOT in NO_OP_ALLOWLIST.
    const cliPath = path.join(root, "packages", "remnic-cli", "src", "index.ts");
    const original = `async function main() {`;
    const withExtra = `async function cmdSync(action: string) {\n  switch (action) {\n    case "watch":\n      // No-op stub: not yet implemented\n      break;\n    default:\n      break;\n  }\n}\n\n${original}`;
    let src = readFileSyncSafe(cliPath);
    src = src.replace(original, withExtra);
    writeFileSync(cliPath, src);

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-op handler "sync watch" is not in NO_OP_ALLOWLIST/);
  });
});

test("a no-op handler that IS in the allowlist passes", () => {
  withFixture((root) => {
    // The base fixture already has "extensions reload" as a no-op, and the
    // script seeds it in NO_OP_ALLOWLIST. Verify it passes.
    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 no-op\(s\) tracked/);
  });
});

// ── Command discovery from both CLI files ──────────────────────────────────

test("commands registered in remnic-core/src/cli.ts via .command() are recognized", () => {
  withFixture((root) => {
    // "doctor", "recall", "tier" come from cli.ts. Add them to a doc.
    writeFileSync(
      path.join(root, "docs", "core-commands.md"),
      [
        "# Core Commands",
        "",
        "```bash",
        "remnic recall",
        "remnic tier",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

// Regression: Commander lets required/optional args live INSIDE the command
// string, e.g. cmd.command("memory-timeline <memoryId>"). Before the
// arg-placeholder fix, the registration regex demanded the closing quote
// immediately after the name, so three real top-level commands
// (memory-timeline, review-disposition, consolidate-undo) were dropped from
// the registered set and a doc of `remnic memory-timeline` would
// false-positive as drift (codex P2 thread PR #1601).
test("a core command registered with a required arg is recognized", () => {
  withFixture((root) => {
    // Register a top-level command whose declaration carries a <arg> placeholder.
    appendFileSync(
      path.join(root, "packages", "remnic-core", "src", "cli.ts"),
      'cmd.command("memory-timeline <memoryId>").description("Read timeline").action(async () => {});\n',
    );
    // Document it as a real `remnic` invocation in a fenced block.
    writeFileSync(
      path.join(root, "docs", "timeline.md"),
      [
        "# Timeline",
        "",
        "```bash",
        "remnic memory-timeline fact-123",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

// Regression: wrapped invocations (pnpm ... exec remnic <cmd>) must be
// detected. Before the token-regex rewrite, an anchored regex missed these
// and a drift like `pnpm ... remnic bogus` exited green (codex review
// thread on PR #1601).
test("a remnic command wrapped in a package-manager invocation is detected", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "docs", "wrapped.md"),
      [
        "# Wrapped",
        "",
        "```bash",
        "pnpm --filter @remnic/cli exec remnic bogus-wrapped",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documented command "remnic bogus-wrapped" is not registered/);
  });
});

// Regression: sibling union types in remnic-cli must NOT leak into the
// registered-command set. `type DaemonAction = ... | "install" | ...` is a
// child-action union; `install` is only valid as `remnic daemon install`,
// never as a top-level `remnic install`. Before the UNION regex was scoped
// to the CommandName type body, `remnic install` falsely passed (codex
// review thread on PR #1601).
test("a nested child label in a sibling union type is NOT treated as top-level", () => {
  withFixture((root) => {
    // Inject a sibling union (DaemonAction) whose members are NOT in
    // CommandName — `install` must still be flagged as drift.
    const cliPath = path.join(root, "packages", "remnic-cli", "src", "index.ts");
    let src = readFileSyncSafe(cliPath);
    const sibling = 'type DaemonAction = "start" | "stop" | "restart" | "install" | "uninstall" | "status";\n';
    src = sibling + src;
    writeFileSync(cliPath, src);

    writeFileSync(
      path.join(root, "docs", "daemon-child.md"),
      [
        "# Daemon Child",
        "",
        "```bash",
        "remnic install",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documented command "remnic install" is not registered/);
  });
});

// Regression: a no-op marker OUTSIDE a cmd<X> function (e.g. in main()'s
// switch) must NOT inherit the stale funcKebab of an already-closed
// function. Before the brace-depth fix, funcKebab persisted after the
// function closed, mis-attributing the no-op (cursor review thread PR #1601).
test("a no-op marker after a cmd function closes is not mis-attributed", () => {
  withFixture((root) => {
    const cliPath = path.join(root, "packages", "remnic-cli", "src", "index.ts");
    let src = readFileSyncSafe(cliPath);
    // Insert a no-op marker inside main()'s switch, AFTER cmdExtensions
    // has closed. Without the brace-depth fix, this would be detected as
    // "extensions init" (stale funcKebab) instead of bare "init".
    const marker = '    case "init":\n      // no-op: not yet implemented\n      break;\n';
    src = src.replace('    case "init":\n      break;', marker);
    writeFileSync(cliPath, src);

    const result = runParity(root);
    // "init" is a real top-level command, so it MUST be in NO_OP_ALLOWLIST
    // or the check fails. The key assertion: the detected path is "init"
    // (bare, no stale func prefix), NOT "extensions init".
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-op handler "init" is not in NO_OP_ALLOWLIST/);
    // The stale-path form must NOT appear.
    assert.doesNotMatch(result.stderr, /extensions init/);
  });
});

// Regression: a negated automation phrase ("does not automatically …") is
// an honest disclaimer, not a stub-publisher claim. Before the negation
// fix, the raw substring "automatically" was flagged regardless of context
// (cursor review thread PR #1601).
test("a negated automation phrase in a stub install section does NOT fail", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "docs", "plugins", "claude-code.md"),
      [
        "# Claude Code Plugin",
        "",
        "## Install",
        "",
        "The publisher is a stub — it does **not** automatically configure",
        "anything. You must run each step manually.",
        "",
        "```bash",
        "remnic init",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

// Regression: a no-op marker inside a commander subcommand's action must be
// attributed to the correct parent→child path ("ops list"), NOT to the
// "engram" gateway root. Before the receiver-variable fix, the rolling
// chain kept "engram" as a permanent root and reported "engram list", so
// an allowlist entry for the real stub would never match (cursor thread #1601).
test("a commander subcommand no-op is attributed to the correct path", () => {
  withFixture((root) => {
    // Mirror cli.ts's multi-line receiver-variable style:
    //   const opsCmd = cmd
    //     .command("ops");
    //   opsCmd
    //     .command("list")
    //     .action(async () => { /* no-op: not yet implemented */ });
    appendFileSync(
      path.join(root, "packages", "remnic-core", "src", "cli.ts"),
      [
        "",
        'const opsCmd = cmd',
        '  .command("ops");',
        "opsCmd",
        '  .command("list")',
        '  .description("List ops")',
        "  .action(async () => {",
        "    // no-op: not yet implemented",
        "  });",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    // MUST be "ops list", never "engram list".
    assert.match(result.stderr, /no-op handler "ops list" is not in NO_OP_ALLOWLIST/);
    assert.doesNotMatch(result.stderr, /no-op handler "engram list"/);
  });
});

// Regression: fenced commands in the root README.md must be scanned. Before
// the fix, collectDocFiles() started at docs/ and added only packages/*/README.md,
// so a typo in the primary user-facing README passed undetected (codex thread #1601).
test("a bogus command in the root README fenced block is caught", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "README.md"),
      [
        "# Remnic",
        "",
        "```bash",
        "remnic bogus-readme-cmd",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documented command "remnic bogus-readme-cmd" is not registered/);
    assert.match(result.stderr, /README\.md/);
  });
});

// Build Week credit-backed commands must not silently switch from staged real
// data to the bundled quick fixture or the CLI-managed dataset store.
test("a Build Week Codex command without a staged dataset path fails", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run --quick longmemeval \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Build Week Codex longmemeval command must include `--dataset-dir \.\/bench-datasets\/longmemeval`/,
    );
  });
});

test("Build Week Codex commands accept only the matching staged dataset path", () => {
  withFixture((root) => {
    const cliPath = path.join(root, "packages", "remnic-cli", "src", "index.ts");
    writeFileSync(
      cliPath,
      readFileSyncSafe(cliPath).replace('"extensions" | "daemon";', '"extensions" | "daemon" | "bench";'),
    );
    const readme = path.join(root, "packages", "bench", "README.md");
    mkdirSync(path.dirname(readme), { recursive: true });
    writeFileSync(
      readme,
      [
        "# Build Week",
        "",
        "```bash",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
        "remnic bench run --json longmemeval --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        "  --runtime-profile real --results-dir \"$BUILD_WEEK_RESULTS_DIR\" --drain-timeout 600000 \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "",
        "remnic bench run locomo --trial-limit <LEDGER_DERIVED_LIMIT> \\",
        "  --dataset-dir ./bench-datasets/locomo \\",
        "  --runtime-profile real --results-dir \"$BUILD_WEEK_RESULTS_DIR\" --drain-timeout 600000 \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 Build Week Codex dataset command\(s\) pinned/);
  });
});

test("a single-command paid run requires a ledger-derived bound", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
        "remnic bench run longmemeval --limit 500 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /command 1 of 1 must include exactly one of `--limit <LEDGER_DERIVED_LIMIT>`; got --limit 500/,
    );
  });
});

test("an otherwise valid Codex command fails without the credit-budget guard", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must follow an exact shell export of `export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473`/);
  });
});

test("a credit-budget guard after the Codex command does not authorize it", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run longmemeval --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must follow an exact shell export of `export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473`/);
  });
});

test("a commented credit-budget guard does not authorize a Codex command", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "# REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "remnic bench run longmemeval --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must follow an exact shell export of `export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473`/);
  });
});

test("a non-exported credit-budget assignment does not authorize a Codex command", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "remnic bench run longmemeval --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must follow an exact shell export of `export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473`/);
  });
});

test("credit protocol comments require shell whitespace before the hash", () => {
  for (const { mutation, expected } of [
    {
      mutation: "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473#not-a-comment",
      expected: "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
    },
    {
      mutation: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473#not-a-comment",
      expected: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
    },
    {
      mutation:
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"#not-a-comment',
      expected:
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
    },
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          mutation.includes("BUDGET")
            ? mutation
            : "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473 # valid comment",
          mutation.includes("RESERVE")
            ? mutation
            : "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473\t# valid comment",
          mutation.includes("LEDGER")
            ? mutation
            : 'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"   ',
          "remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> \\",
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${mutation}: ${result.stderr}`);
      assert.ok(result.stderr.includes(`exact shell export of \`${expected}\``));
    });
  }
});

test("credit protocol exports accept real shell comments and trailing whitespace", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473 # budget",
        "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473\t# reserve",
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"   ',
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results" # private result store',
        "remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 Build Week Codex dataset command\(s\) pinned/);
  });
});

test("paid runs require the exact private results-directory export", () => {
  for (const { label, resultEnvLines } of [
    { label: "missing", resultEnvLines: [] },
    {
      label: "wrong path",
      resultEnvLines: ['export BUILD_WEEK_RESULTS_DIR="/tmp/build-week-results"'],
    },
    {
      label: "non-exported assignment",
      resultEnvLines: ['BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"'],
    },
    {
      label: "overridden",
      resultEnvLines: [
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
        'export BUILD_WEEK_RESULTS_DIR="$HOME/other-results"',
      ],
    },
    {
      label: "unset",
      resultEnvLines: [
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
        "unset BUILD_WEEK_RESULTS_DIR",
      ],
    },
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
          "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
          'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
          ...resultEnvLines,
          "remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> \\",
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.match(
        result.stderr,
        /must follow an exact shell export of `export BUILD_WEEK_RESULTS_DIR="\$BUILD_WEEK_RUN_ROOT\/results"`/,
      );
    });
  }
});

test("a later exact results-directory re-export restores the paid protocol", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
        'export BUILD_WEEK_RESULTS_DIR="$HOME/other-results"',
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
        "remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 Build Week Codex dataset command\(s\) pinned/);
  });
});

test("a credit-budget export in prose does not authorize a later shell command", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "",
        "```bash",
        "remnic bench run longmemeval --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must follow an exact shell export of `export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473`/);
  });
});

test("a later credit-budget override or unset invalidates an earlier guard", () => {
  for (const mutation of [
    "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=100",
    "export REMNIC_BENCH_CODEX_CREDIT_BUDGET+=0",
    "REMNIC_BENCH_CODEX_CREDIT_BUDGET+=0",
    "REMNIC_BENCH_CODEX_CREDIT_BUDGET[0]=24730",
    "declare -x REMNIC_BENCH_CODEX_CREDIT_BUDGET=24730",
    "export OTHER=value REMNIC_BENCH_CODEX_CREDIT_BUDGET=24730",
    "unset OTHER REMNIC_BENCH_CODEX_CREDIT_BUDGET",
    "((REMNIC_BENCH_CODEX_CREDIT_BUDGET++))",
    "printf -v REMNIC_BENCH_CODEX_CREDIT_BUDGET %s 24730",
    "true; REMNIC_BENCH_CODEX_CREDIT_BUDGET=24730",
    "export -n REMNIC_BENCH_CODEX_CREDIT_BUDGET",
    "unset REMNIC_BENCH_CODEX_CREDIT_BUDGET",
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
          mutation,
          "remnic bench run longmemeval --limit 1 \\",
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${mutation}: ${result.stderr}`);
      assert.match(result.stderr, /must follow an exact shell export of `export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473`/);
    });
  }
});

test("later reserve and ledger mutations invalidate the paid protocol", () => {
  for (const { mutation, expected } of [
    {
      mutation: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=300",
      expected: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
    },
    {
      mutation: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE+=0",
      expected: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
    },
    {
      mutation: "unset REMNIC_BENCH_CODEX_CREDIT_RESERVE",
      expected: "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
    },
    {
      mutation: 'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="/tmp/other-ledger.json"',
      expected:
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
    },
    {
      mutation: "REMNIC_BENCH_CODEX_CREDIT_LEDGER+=.bak",
      expected:
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
    },
    {
      mutation: "unset REMNIC_BENCH_CODEX_CREDIT_LEDGER",
      expected:
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
    },
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
          "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
          'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
          mutation,
          "remnic bench run longmemeval --limit 1 \\",
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${mutation}: ${result.stderr}`);
      assert.ok(result.stderr.includes(`exact shell export of \`${expected}\``));
    });
  }
});

test("a same-command credit mutation or env wrapper before the run is rejected", () => {
  for (const prefix of [
    "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=100; ",
    "unset REMNIC_BENCH_CODEX_CREDIT_BUDGET; ",
    "env REMNIC_BENCH_CODEX_CREDIT_BUDGET=3000 ",
    "env REMNIC_BENCH_CODEX_CREDIT_RESERVE=300 ",
    'env REMNIC_BENCH_CODEX_CREDIT_LEDGER="/tmp/other-ledger.json" ',
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
          "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
          'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
          `${prefix}remnic bench run longmemeval --limit 1 \\`,
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${prefix}: ${result.stderr}`);
      assert.match(result.stderr, /must execute directly as `remnic bench run`/);
      assert.match(result.stderr, /must contain at least one guarded Build Week Codex benchmark command/);
    });
  }
});

test("a comment mentioning bench run before the credit guard does not invalidate it", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "# The remnic bench run command below consumes Codex credits.",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
        "remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
        "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
        "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 Build Week Codex dataset command\(s\) pinned/);
  });
});

test("Build Week paid commands must execute directly without shell wrappers", () => {
  for (const prefix of ["echo ", "printf '%s' ", "true && ", "FOO=bar ", "env "]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
          "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
          'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
          `${prefix}remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> \\`,
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${prefix}: ${result.stderr}`);
      assert.match(result.stderr, /must execute directly as `remnic bench run`/);
      assert.match(result.stderr, /must contain at least one guarded Build Week Codex benchmark command/);
    });
  }
});

test("Build Week Codex commands pin the complete paid-run protocol", () => {
  const validProtocol = [
    '--runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000',
    "--system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium",
    "--internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium",
    "--judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
  ].join(" ");
  for (const [label, protocol] of [
    ["missing real profile", validProtocol.replace("--runtime-profile real ", "")],
    ["baseline profile", validProtocol.replace("--runtime-profile real", "--runtime-profile baseline")],
    ["wrong system model", validProtocol.replace("gpt-5.6-luna", "gpt-5.6-terra")],
    ["Sol model", validProtocol.replace("gpt-5.6-luna", "gpt-5.6-sol")],
    ["explicit request timeout", `${validProtocol} --request-timeout 180000`],
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "remnic bench run longmemeval --limit 1 \\",
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          "  " + protocol + " \\",
          "  --system-provider codex-cli",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      if (label === "explicit request timeout") {
        assert.match(result.stderr, /must not include `--request-timeout`/);
      } else if (label === "Sol model") {
        assert.match(result.stderr, /must not use `gpt-5\.6-sol`/);
      } else {
        assert.match(result.stderr, /must include `--(?:runtime-profile|system-model)/);
      }
    });
  }
});

test("the first command in a two-command paid sequence is exactly a one-item smoke", () => {
  withFixture((root) => {
    const protocol = [
      '--dataset-dir ./bench-datasets/longmemeval --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR"',
      "--drain-timeout 600000",
      "--system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium",
      "--internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium",
      "--judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
    ].join(" ");
    const readme = path.join(root, "packages", "bench", "README.md");
    mkdirSync(path.dirname(readme), { recursive: true });
    writeFileSync(
      readme,
      [
        "# Bench",
        "",
        "```bash",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
        `remnic bench run longmemeval --limit 100 ${protocol}`,
        `remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> ${protocol}`,
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /command 1 of 2 must include exactly one of `--limit 1`; got --limit 100/);
  });
});

test("a two-command LoCoMo sequence accepts the benchmark-supported trial bound", () => {
  withFixture((root) => {
    const cliPath = path.join(root, "packages", "remnic-cli", "src", "index.ts");
    writeFileSync(
      cliPath,
      readFileSyncSafe(cliPath).replace('"extensions" | "daemon";', '"extensions" | "daemon" | "bench";'),
    );
    const protocol = [
      '--dataset-dir ./bench-datasets/locomo --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR"',
      "--drain-timeout 600000",
      "--system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium",
      "--internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium",
      "--judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
    ].join(" ");
    const readme = path.join(root, "packages", "bench", "README.md");
    mkdirSync(path.dirname(readme), { recursive: true });
    writeFileSync(
      readme,
      [
        "# Bench",
        "",
        "```bash",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
        'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
        'export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"',
        `remnic bench run locomo --trial-limit 1 ${protocol}`,
        `remnic bench run locomo --trial-limit <LEDGER_DERIVED_LIMIT> ${protocol}`,
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 Build Week Codex dataset command\(s\) pinned/);
  });
});

test("a guarded Build Week command cannot bypass checks by dropping Codex flags", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
        "remnic bench run longmemeval --runtime-profile baseline --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must include `--runtime-profile real`/);
    assert.match(result.stderr, /must include `--system-provider codex-cli`/);
  });
});

test("Build Week Codex quick mode is rejected even with a staged dataset path", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run --quick longmemeval \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not use `--quick`/);
    assert.match(result.stderr, /longmemeval command must include an explicit `--limit`/);
  });
});

test("Build Week LongMemEval rejects LoCoMo-only --trial-limit", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run longmemeval --trial-limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /longmemeval command must include an explicit `--limit`/);
  });
});

test("Build Week LongMemEval rejects --trial-limit even when --limit is valid", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run longmemeval --limit 1 --trial-limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /longmemeval command must not include `--trial-limit`/);
  });
});

test("Build Week dataset path cannot impersonate a missing positional benchmark", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must include exactly one positional benchmark/);
  });
});

test("malformed Build Week Codex commands cannot bypass validation", () => {
  withFixture((root) => {
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval-typo \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must include exactly one positional benchmark/);
  });
});

test("Build Week Codex commands reject benchmark and runtime fan-out selectors", () => {
  for (const [selector, command] of [
    ["--all", "remnic bench run --all longmemeval --limit 1"],
    ["multiple positional benchmarks", "remnic bench run longmemeval locomo --limit 1"],
    ["--matrix", "remnic bench run longmemeval --matrix baseline,real --limit 1"],
    ["--custom", "remnic bench run longmemeval --custom ./custom.json --limit 1"],
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          `${command} \\`,
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          "  --system-provider codex-cli --system-model gpt-5.6-luna",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${selector}: ${result.stderr}`);
      if (selector === "multiple positional benchmarks") {
        assert.match(result.stderr, /must include exactly one positional benchmark/);
      } else {
        assert.match(result.stderr, new RegExp("must not include `" + selector + "`"));
      }
    });
  }
});

test("Build Week Codex commands reject every unpinned runtime override", () => {
  for (const override of [
    "--adapter mcp --mcp-demo",
    "--mcp-url http://127.0.0.1:9999/mcp",
    "--remnic-config ./alternate.json",
    "--model-source gateway",
    "--disable-thinking",
    "--unknown-future-mode enabled",
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
          `remnic bench run longmemeval --limit 1 ${override} \\`,
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${override}: ${result.stderr}`);
      assert.match(result.stderr, /must not include unpinned run option/);
    });
  }
});

test("Build Week Codex commands reject equals-form and duplicate options", () => {
  const valueFlags = [
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
  ];
  const cases = [
    ...["--json=false", "--json=true", "--json="].map((suffix) => ({
      suffix,
      expected: new RegExp(`equals-form option \`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``),
    })),
    ...valueFlags.map((flag) => ({
      suffix: `${flag}=attached`,
      expected: new RegExp(`equals-form option \`${flag}=attached\``),
    })),
    { suffix: "--runtime-profile baseline", expected: /option `--runtime-profile` at most once/ },
    { suffix: "--limit 2", expected: /option `--limit` at most once/ },
    { suffix: "--json --json", expected: /option `--json` at most once/ },
    { suffix: "-x", expected: /unpinned run option `-x`/ },
    { suffix: "-h", expected: /unpinned run option `-h`/ },
    { suffix: "-h=foo", expected: /equals-form option `-h=foo`/ },
    { suffix: "--", expected: /unpinned run option `--`/ },
    { suffix: "-", expected: /unpinned run option `-`/ },
    {
      suffix: "--results-dir --json",
      expected: /option `--results-dir` requires a separate non-option value/,
    },
  ];
  for (const { suffix, expected } of cases) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          "export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473",
          "export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473",
          'export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"',
          `remnic bench run longmemeval --limit <LEDGER_DERIVED_LIMIT> ${suffix} \\`,
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          '  --runtime-profile real --results-dir "$BUILD_WEEK_RESULTS_DIR" --drain-timeout 600000 \\',
          "  --system-provider codex-cli --system-model gpt-5.6-luna --system-codex-reasoning-effort medium \\",
          "  --internal-provider codex-cli --internal-model gpt-5.6-luna --internal-codex-reasoning-effort medium \\",
          "  --judge-provider codex-cli --judge-model gpt-5.6-terra --judge-codex-reasoning-effort high",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1, `${suffix}: ${result.stderr}`);
      assert.match(result.stderr, expected);
    });
  }
});

test("Build Week Codex bounds reject missing, zero, and negative values", () => {
  for (const [suffix, expected] of [
    ["--limit", /has no value for `--limit`/],
    ["--limit 0", /--limit must be a positive integer/],
    ["--limit -1", /--limit must be a positive integer/],
  ]) {
    withFixture((root) => {
      writeFileSync(
        path.join(root, "HACKATHON.md"),
        [
          "# Build Week",
          "",
          "```bash",
          `remnic bench run longmemeval ${suffix} \\`,
          "  --dataset-dir ./bench-datasets/longmemeval \\",
          "  --system-provider codex-cli --system-model gpt-5.6-luna",
          "```",
          "",
        ].join("\n"),
      );

      const result = runParity(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
    });
  }
});

// ── Misc ────────────────────────────────────────────────────────────────────

test("unknown arguments are rejected with usage", () => {
  withFixture((root) => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--bogus"],
      {
        encoding: "utf8",
        env: { ...process.env, REMNIC_DOCS_PARITY_ROOT: root },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument/);
    assert.match(result.stderr, /--help/);
  });
});

test("--help prints usage and exits 0", () => {
  withFixture((root) => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--help"],
      {
        encoding: "utf8",
        env: { ...process.env, REMNIC_DOCS_PARITY_ROOT: root },
      },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /docs-code parity check/);
    assert.match(result.stdout, /REMNIC_DOCS_PARITY_ROOT/);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function readFileSyncSafe(p) {
  return readFileSync(p, "utf8");
}
