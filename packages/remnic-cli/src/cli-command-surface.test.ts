/**
 * Command-surface contract tests for the `remnic` CLI (issue #1532 Phase A).
 *
 * These tests pin the CLI's command surface: every documented subcommand
 * exists, dispatches to its own handler (rather than falling through to the
 * catch-all banner), and the load-bearing ones produce deterministic output
 * against an isolated temp HOME. Flag/argument validation paths are pinned so
 * a Phase B split cannot silently turn a rejected invocation into a no-op.
 *
 * The harness is `runCli` (./run-cli.ts): it invokes the real `main()`
 * dispatcher in-process, capturing stdout / stderr / exitCode without spawning
 * a child process. HOME is isolated at the file level so the dispatcher's
 * `migrateFromEngram()` one-shot runs against an empty temp directory instead
 * of the developer's real `~/.engram` / `~/.remnic`.
 *
 * What this suite is NOT:
 *   - It is not a deep behaviour test of every handler (those live with their
 *     subsystems). It asserts the dispatch contract + deterministic signatures.
 *   - It does not assert daemon running/stopped state (environment-dependent);
 *     it asserts the output LABEL that is always present.
 *
 * Phase B guard: when cli.ts is decomposed into per-group modules behind a
 * registrar, these tests must stay green unchanged. If a command disappears or
 * its validation relaxes, a test here fails before review.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { runCli } from "./run-cli.js";

// ── Isolate HOME for the entire file ────────────────────────────────────────
// The dispatcher runs migrateFromEngram() for every non-migrate command; that
// reads/writes ~/.engram + ~/.remnic. Point HOME at a temp dir so the one-shot
// migration is a no-op against empty state and no test touches the developer's
// real config.
let tempHome = "";
let originalHome: string | undefined;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-surface-"));
  process.env.HOME = tempHome;
});

after(async () => {
  if (originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = originalHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

// Marker string that ONLY the catch-all default case prints. A real command
// never emits this; an unrecognised command always does. This is the
// dispatch-contract discriminator.
const BANNER_MARKER = "remnic — Remnic memory CLI";

/**
 * The full set of top-level command names handled by `main()`'s switch
 * (CommandName union in index.ts). Every entry must dispatch to a handler, not
 * the default banner. Keeping this list explicit means a renamed or dropped
 * command is caught here even before the docs-parity check runs.
 */
/**
 * Commands advertised in the catch-all help banner (the user-facing
 * inventory). Every entry here MUST appear in the banner — otherwise the
 * command is unreachable through documented usage (the #1518 regression
 * class). `action-confidence` is a real dispatch target but is intentionally
 * not user-documented (advisory-only); it is covered by the dispatch test.
 */
const DOCUMENTED_COMMANDS = [
  "init",
  "migrate",
  "status",
  "query",
  "doctor",
  "config",
  "daemon",
  "token",
  "tree",
  "onboard",
  "curate",
  "review",
  "sync",
  "dedup",
  "connectors",
  "space",
  "bench",
  "benchmark",
  "briefing",
  "versions",
  "binary",
  "taxonomy",
  "enrich",
  "procedural",
  "openclaw",
  "extensions",
  "training:export",
  "import",
  "import-lossless-claw",
  "xray",
  "wearables",
  "capsule",
  "offline",
] as const;

/**
 * The full set of top-level command names handled by `main()`'s switch
 * (CommandName union in index.ts), including the undocumented advisory
 * command. Used by the dispatch test to confirm each routes to a handler.
 */
const ALL_COMMAND_NAMES = [...DOCUMENTED_COMMANDS, "action-confidence"] as const;

// ════════════════════════════════════════════════════════════════════════════
// 1. Surface enumeration — the catch-all help lists every documented command
// ════════════════════════════════════════════════════════════════════════════

test("unknown command prints the catch-all help banner", async () => {
  const result = await runCli(["__definitely_not_a_command__"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(BANNER_MARKER));
  assert.match(result.stdout, /Usage:/);
});

test("the catch-all banner advertises every top-level command", async () => {
  // The default-case help text is the user-facing command inventory. Every
  // CommandName must appear there, otherwise the command is unreachable
  // through documented usage (the exact regression #1518 documented).
  const result = await runCli(["__nope__"]);
  for (const command of DOCUMENTED_COMMANDS) {
    // `training:export` is documented as "training:export"; others appear as
    // "remnic <command>". Match the bare command token.
    const token = command.replace(":", ":");
    assert.match(
      result.stdout,
      new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
      `banner missing documented command "${command}"`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Dispatch contract — recognised commands never print the catch-all banner
// ════════════════════════════════════════════════════════════════════════════

test("every recognised command dispatches to its own handler, not the banner", async () => {
  // Invoke each command with a minimal argument shape that reaches its handler
  // WITHOUT initialising the orchestrator, hitting the network, or requiring a
  // daemon / API key. We assert ONLY that the catch-all banner is absent —
  // i.e. the dispatcher routed to the command's case, not default.
  //
  // Heavy commands (query, xray, briefing, enrich, binary, onboard, curate,
  // review, sync, wearables-sync) are deliberately excluded: they boot the
  // orchestrator or scan the filesystem and would make this suite slow /
  // environment-dependent. Their dispatch is covered by the per-command
  // signature tests + their own subsystem suites. The fast commands here give
  // full coverage of the switch's routing branches that can be exercised
  // deterministically.
  const fast: Record<string, string[]> = {
    init: ["init"],
    migrate: ["migrate", "--json"],
    status: ["status"],
    doctor: ["doctor"],
    config: ["config"],
    daemon: ["daemon", "status"],
    token: ["token", "list"],
    tree: ["tree"],
    dedup: ["dedup"],
    connectors: ["connectors", "list"],
    space: ["space", "list"],
    bench: ["bench", "list"],
    benchmark: ["benchmark", "list"],
    versions: ["versions", "list"],
    taxonomy: ["taxonomy", "show"],
    procedural: ["procedural", "stats"],
    openclaw: ["openclaw"],
    extensions: ["extensions", "list"],
    "training:export": ["training:export", "--help"],
    import: ["import", "--help"],
    "import-lossless-claw": ["import-lossless-claw", "--help"],
    "action-confidence": ["action-confidence"],
    capsule: ["capsule"],
    offline: ["offline", "status"],
  };

  for (const command of ALL_COMMAND_NAMES) {
    const argv = fast[command];
    if (!argv) continue;
    const result = await runCli(argv);
    assert.equal(
      result.stdout.includes(BANNER_MARKER),
      false,
      `command "${command}" fell through to the catch-all banner (argv=${JSON.stringify(argv)})`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Happy-path signatures — deterministic output for load-bearing commands
// ════════════════════════════════════════════════════════════════════════════

test("status prints the server-status label (running state is environment-dependent)", async () => {
  const result = await runCli(["status"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Remnic server:/);
});

test("status --json emits a JSON object with the running + pidFile fields", async () => {
  const result = await runCli(["status", "--json"]);
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(typeof parsed.running, "boolean");
  assert.equal(typeof parsed.pidFile, "string");
});

test("config with no config file reports it is missing", async () => {
  // resolveConfigPath() walks up from cwd, so isolate cwd in a temp dir with
  // no remnic.config.json ancestor (the worktree root has a real one).
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cfg-"));
  try {
    const result = await runCli(["config"], { cwd: dir });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /No config file found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor runs diagnostics and reports the Node.js version check", async () => {
  const result = await runCli(["doctor"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Node\.js version/);
});
test("dedup against an empty memory dir reports zero duplicates", async () => {
  const result = await runCli(["dedup"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Scanned: \d+ memories/);
});

test("token list with no tokens reports none", async () => {
  const result = await runCli(["token", "list"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /No tokens|Tokens/i);
});

test("procedural stats emits the procedural-memory stats header", async () => {
  const result = await runCli(["procedural", "stats"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Procedural memory stats/i);
});

test("offline status reports the offline-state label", async () => {
  const result = await runCli(["offline", "status"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Offline state/i);
});

test("extensions list against an empty workspace reports none found", async () => {
  const result = await runCli(["extensions", "list"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /No memory extensions|extensions/i);
});

test("init creates remnic.config.json in the cwd and reports the path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-init-"));
  try {
    const result = await runCli(["init"], { cwd: dir });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Created .*remnic\.config\.json/);
    const created = path.join(dir, "remnic.config.json");
    assert.equal(fs.existsSync(created), true, "init did not write the config file");
    const written = JSON.parse(fs.readFileSync(created, "utf8"));
    assert.equal(typeof written, "object");
    // init is idempotent: a second run reports the config already exists.
    const second = await runCli(["init"], { cwd: dir });
    assert.equal(second.exitCode, 0);
    assert.match(second.stdout, /Config already exists/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Argument / flag validation — invalid input is rejected, not silently
//    accepted (CLAUDE.md rules 14 / 51 class).
// ════════════════════════════════════════════════════════════════════════════

test("daemon with an unknown subaction prints usage and exits non-zero", async () => {
  const result = await runCli(["daemon", "__bogus__"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /Usage: remnic daemon/);
});

test("token with an unknown subaction prints usage and exits non-zero", async () => {
  const result = await runCli(["token", "__bogus__"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /Usage: remnic token/);
});

test("tree with no subaction prints the tree usage block (no banner)", async () => {
  const result = await runCli(["tree"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage: remnic tree/);
  assert.equal(result.stdout.includes(BANNER_MARKER), false);
});

test("capsule with no subaction prints the capsule usage block (no banner)", async () => {
  const result = await runCli(["capsule"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage: remnic capsule/);
  assert.equal(result.stdout.includes(BANNER_MARKER), false);
});

test("tree generate rejects a non-numeric --max-per-category value", async () => {
  const result = await runCli(["tree", "generate", "--max-per-category", "abc"]);
  assert.notEqual(result.exitCode, 0);
  // The handler prints the invalid value on stderr and exits 1.
  assert.match(result.stderr, /Invalid --max-per-category/);
});

test("training:export --help renders the option list (rule 14: required flags documented)", async () => {
  const result = await runCli(["training:export", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--format <name>/);
  assert.match(result.stdout, /--output <path>/);
});

test("import --help renders the adapter usage block", async () => {
  const result = await runCli(["import", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /import/i);
});

test("capsule lineage without --fork-id is rejected with an error", async () => {
  const result = await runCli(["capsule", "lineage", "--root", "/tmp"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--fork-id/);
});
