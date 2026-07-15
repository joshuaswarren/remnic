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
    writeFileSync(
      path.join(root, "HACKATHON.md"),
      [
        "# Build Week",
        "",
        "```bash",
        "remnic bench run --json longmemeval --limit 1 \\",
        "  --dataset-dir ./bench-datasets/longmemeval \\",
        "  --system-provider codex-cli --system-model gpt-5.6-luna",
        "",
        "remnic bench run locomo --trial-limit 1 \\",
        "  --dataset-dir ./bench-datasets/locomo \\",
        "  --judge-provider codex-cli --judge-model gpt-5.6-terra",
        "```",
        "",
      ].join("\n"),
    );

    const result = runParity(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 Build Week Codex dataset command\(s\) pinned/);
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
    assert.match(result.stderr, /must include positional benchmark `longmemeval` or `locomo`/);
  });
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
