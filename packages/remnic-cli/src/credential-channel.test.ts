/**
 * Credential-channel contract tests (#2831).
 *
 * The shared resolver (./credential-channel.ts) backs both `remnic converge`
 * (#2823) and the offline family (prepare/sync/status/watch). These tests pin:
 *
 *   - presence-tracked precedence: --token > --token-file > env chain, where
 *     an EMPTY higher source is a hard error and never falls through
 *   - token-file safety: 0600 regular file, no symlinks, no directories
 *   - argv tokens resolve but are flagged tokenFromArgv so callers warn once
 *     without echoing the value
 *   - the offline CLI routes all four subcommands through the channel
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { parseTokenFileFlag, resolveCredentialChannel } from "./credential-channel.js";
import { runCli } from "./run-cli.js";

const OFFLINE_ENV = ["REMNIC_OFFLINE_TOKEN", "REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN"] as const;

/** env object for runCli: strip every credential env var the resolver reads. */
const NO_TOKEN_ENV = Object.fromEntries(OFFLINE_ENV.map((name) => [name, undefined]));

// ── Isolate HOME for CLI-level tests (the dispatcher runs migrateFromEngram) ──
let tempHome = "";
let originalHome: string | undefined;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-credential-"));
  process.env.HOME = tempHome;
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
});

async function makeTokenFile(dir: string, name: string, content: string, mode = 0o600): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content);
  await chmod(file, mode);
  return file;
}

// ── Resolver unit tests ───────────────────────────────────────────────────────

test("argv token wins over file and env; tokenFromArgv is true", () => {
  const result = resolveCredentialChannel(
    { argvToken: "argv-secret", tokenFile: "/nonexistent", envNames: OFFLINE_ENV },
    { REMNIC_OFFLINE_TOKEN: "env-secret" }
  );
  assert.deepEqual(result, { ok: true, token: "argv-secret", tokenFromArgv: true });
});

test("an empty or whitespace-only argv token is a hard error, not a fall-through", () => {
  for (const argvToken of ["", "   "]) {
    const result = resolveCredentialChannel(
      { argvToken, tokenFile: undefined, envNames: OFFLINE_ENV },
      { REMNIC_OFFLINE_TOKEN: "env-secret" }
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /--token requires a non-empty value/);
  }
});

test("a 0600 regular token file resolves with trimmed content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-token-file-"));
  try {
    const file = await makeTokenFile(dir, "peer.token", "  file-secret\n");
    const result = resolveCredentialChannel(
      { argvToken: undefined, tokenFile: file, envNames: OFFLINE_ENV },
      { REMNIC_OFFLINE_TOKEN: "env-secret" }
    );
    assert.deepEqual(result, { ok: true, token: "file-secret", tokenFromArgv: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing or empty-content token file errors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-token-file-"));
  try {
    const missing = resolveCredentialChannel(
      { argvToken: undefined, tokenFile: path.join(dir, "absent.token"), envNames: OFFLINE_ENV },
      {}
    );
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.error : "", /absent\.token could not be read/);

    const empty = await makeTokenFile(dir, "empty.token", "   \n");
    const emptyResult = resolveCredentialChannel(
      { argvToken: undefined, tokenFile: empty, envNames: OFFLINE_ENV },
      {}
    );
    assert.equal(emptyResult.ok, false);
    assert.match(!emptyResult.ok ? emptyResult.error : "", /empty\.token is empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a permissive token file is rejected on POSIX", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-token-file-"));
  try {
    const permissive = await makeTokenFile(dir, "open.token", "file-secret\n", 0o644);
    const result = resolveCredentialChannel(
      { argvToken: undefined, tokenFile: permissive, envNames: OFFLINE_ENV },
      {}
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /must not be group- or world-readable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlinked token file is rejected even when the target is 0600", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-token-file-"));
  try {
    const target = await makeTokenFile(dir, "real.token", "file-secret\n");
    const link = path.join(dir, "link.token");
    await symlink(target, link);
    const result = resolveCredentialChannel(
      { argvToken: undefined, tokenFile: link, envNames: OFFLINE_ENV },
      {}
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /link\.token must be a regular file, not a symlink/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a directory passed as --token-file is rejected as non-regular", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-token-file-"));
  try {
    const nested = path.join(dir, "nested");
    await mkdir(nested);
    const result = resolveCredentialChannel(
      { argvToken: undefined, tokenFile: nested, envNames: OFFLINE_ENV },
      {}
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /nested must be a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env chain: first defined name wins in declared order", () => {
  const full = resolveCredentialChannel(
    { argvToken: undefined, tokenFile: undefined, envNames: OFFLINE_ENV },
    { REMNIC_OFFLINE_TOKEN: "offline-secret", REMNIC_AUTH_TOKEN: "auth-secret", ENGRAM_AUTH_TOKEN: "engram-secret" }
  );
  assert.deepEqual(full, { ok: true, token: "offline-secret", tokenFromArgv: false });

  const legacy = resolveCredentialChannel(
    { argvToken: undefined, tokenFile: undefined, envNames: OFFLINE_ENV },
    { REMNIC_AUTH_TOKEN: "auth-secret", ENGRAM_AUTH_TOKEN: "engram-secret" }
  );
  assert.deepEqual(legacy, { ok: true, token: "auth-secret", tokenFromArgv: false });

  const engramOnly = resolveCredentialChannel(
    { argvToken: undefined, tokenFile: undefined, envNames: OFFLINE_ENV },
    { ENGRAM_AUTH_TOKEN: "engram-secret" }
  );
  assert.deepEqual(engramOnly, { ok: true, token: "engram-secret", tokenFromArgv: false });
});

test("env chain: an empty higher-precedence env var errors instead of falling through", () => {
  for (const empty of ["", "   "]) {
    const result = resolveCredentialChannel(
      { argvToken: undefined, tokenFile: undefined, envNames: OFFLINE_ENV },
      { REMNIC_OFFLINE_TOKEN: empty, REMNIC_AUTH_TOKEN: "auth-secret" }
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /REMNIC_OFFLINE_TOKEN is set but empty/);
  }
  const authEmpty = resolveCredentialChannel(
    { argvToken: undefined, tokenFile: undefined, envNames: OFFLINE_ENV },
    { REMNIC_AUTH_TOKEN: "", ENGRAM_AUTH_TOKEN: "engram-secret" }
  );
  assert.equal(authEmpty.ok, false);
  assert.match(!authEmpty.ok ? authEmpty.error : "", /REMNIC_AUTH_TOKEN is set but empty/);
});

test("no credential source present resolves to ok with token undefined", () => {
  const result = resolveCredentialChannel(
    { argvToken: undefined, tokenFile: undefined, envNames: OFFLINE_ENV },
    {}
  );
  assert.deepEqual(result, { ok: true, token: undefined, tokenFromArgv: false });
});

test("parseTokenFileFlag maps absent and empty values to null", () => {
  assert.equal(parseTokenFileFlag(undefined), null);
  assert.equal(parseTokenFileFlag(""), null);
  assert.equal(parseTokenFileFlag("/home/user/secrets/peer.token"), "/home/user/secrets/peer.token");
});

// ── Offline CLI routing tests ────────────────────────────────────────────────

test("offline status with an empty REMNIC_OFFLINE_TOKEN fails before any work (#2831)", async () => {
  const result = await runCli(["offline", "status"], {
    env: { ...NO_TOKEN_ENV, REMNIC_OFFLINE_TOKEN: "" },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /offline: REMNIC_OFFLINE_TOKEN is set but empty/);
});

test("offline status with no credential anywhere still succeeds", async () => {
  const result = await runCli(["offline", "status"], { env: NO_TOKEN_ENV });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Offline state/i);
});

test("offline argv token warns exactly once and never echoes the value", async () => {
  const result = await runCli(["offline", "status", "--token", "synthetic-argv-secret-2831"], {
    env: NO_TOKEN_ENV,
  });
  assert.equal(result.exitCode, 0);
  const warnings = result.stderr.match(/argv-visible/g) ?? [];
  assert.equal(warnings.length, 1, `expected exactly one argv warning, got: ${result.stderr}`);
  assert.equal(result.stderr.includes("synthetic-argv-secret-2831"), false);
  assert.equal(result.stdout.includes("synthetic-argv-secret-2831"), false);
});

test("offline prepare with an unreadable token file fails before any network call", async () => {
  const result = await runCli(
    ["offline", "prepare", "--remote-url", "http://127.0.0.1:1", "--token-file", "/nonexistent/offline.token"],
    { env: NO_TOKEN_ENV }
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /offline: --token-file \/nonexistent\/offline\.token could not be read/);
});

test("offline prepare with an empty --token value fails instead of using env", async () => {
  const result = await runCli(
    ["offline", "prepare", "--remote-url", "http://127.0.0.1:1", "--token", ""],
    { env: { ...NO_TOKEN_ENV, REMNIC_AUTH_TOKEN: "auth-secret" } }
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--token requires a non-empty value/);
});

test("offline status rejects a directory passed as --token-file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-tokenfile-"));
  try {
    const result = await runCli(["offline", "status", "--token-file", dir], { env: NO_TOKEN_ENV });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /must be a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offline help documents --token-file and the full env chain", async () => {
  const result = await runCli(["offline", "help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--token-file <path>/);
  assert.match(result.stdout, /ENGRAM_AUTH_TOKEN/);
  // The chain may wrap across lines in the rendered help; collapse whitespace
  // before asserting the full precedence order.
  const flat = result.stdout.replace(/\s+/g, " ");
  assert.match(flat, /--token > --token-file > REMNIC_OFFLINE_TOKEN > REMNIC_AUTH_TOKEN > ENGRAM_AUTH_TOKEN/);
});

test("offline unknown actions fall through to usage instead of failing on token flags", async () => {
  const result = await runCli(["offline", "__bogus__", "--token-file", "/nonexistent/offline.token"], {
    env: NO_TOKEN_ENV,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /Usage: remnic offline/);
});
