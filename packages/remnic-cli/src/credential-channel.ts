/**
 * Credential-channel resolution for CLI commands that talk to a remote
 * Remnic peer (#2823, #2831).
 *
 * argv tokens are visible to any process listing for the lifetime of a run —
 * hours at boot scale, exactly when operators take ps snapshots. Token-file
 * and env are the operator-safe channels; --token still works but callers
 * should warn once per invocation and never echo the value.
 *
 * Precedence (--token > --token-file > env chain) is presence-tracked: an
 * EMPTY higher-precedence source is a hard error, never a silent fall-through
 * to a lower-precedence channel. `envNames` lets each command declare its own
 * chain (converge: REMNIC_CONVERGE_PEER_TOKEN; offline: REMNIC_OFFLINE_TOKEN
 * > REMNIC_AUTH_TOKEN > ENGRAM_AUTH_TOKEN).
 */
import * as fs from "node:fs";

export interface CredentialChannelInput {
  /** Value from the --token flag, if supplied (argv-visible). */
  argvToken: string | undefined;
  /** Path from --token-file, if supplied. */
  tokenFile: string | undefined;
  /** Environment variable names, highest precedence first. */
  envNames: readonly string[];
}

export type CredentialChannelResult =
  | { ok: true; token: string | undefined; tokenFromArgv: boolean }
  | { ok: false; error: string };

/** Parse the --token-file flag value: a non-empty path, or null when absent/empty. */
export function parseTokenFileFlag(raw: string | undefined): string | null {
  return raw !== undefined && raw.length > 0 ? raw : null;
}

export function resolveCredentialChannel(
  input: CredentialChannelInput,
  env: NodeJS.ProcessEnv
): CredentialChannelResult {
  if (input.argvToken !== undefined && input.argvToken.trim().length === 0) {
    return { ok: false, error: "--token requires a non-empty value" };
  }
  if (input.argvToken !== undefined) {
    return { ok: true, token: input.argvToken, tokenFromArgv: true };
  }
  if (input.tokenFile !== undefined) {
    if (input.tokenFile.length === 0) {
      return { ok: false, error: "--token-file requires a non-empty path" };
    }
    try {
      // lstat (not stat): a symlink must be rejected as a channel, not
      // followed — a symlinked credential can be repointed between this
      // check and the read below, defeating the mode check.
      const stat = fs.lstatSync(input.tokenFile);
      if (stat.isSymbolicLink()) {
        return { ok: false, error: `--token-file ${input.tokenFile} must be a regular file, not a symlink` };
      }
      if (!stat.isFile()) {
        return { ok: false, error: `--token-file ${input.tokenFile} must be a regular file` };
      }
      // A group/world-readable credential file defeats the point of the
      // channel; reject it instead of trusting the content. Windows mode bits
      // are synthesized (readable files commonly present as 0666), so the
      // check is POSIX-only.
      if (process.platform !== "win32" && stat.mode & 0o077) {
        return { ok: false, error: `--token-file ${input.tokenFile} must not be group- or world-readable (chmod 600)` };
      }
      const token = fs.readFileSync(input.tokenFile, "utf8").trim();
      if (token.length === 0) {
        return { ok: false, error: `--token-file ${input.tokenFile} is empty` };
      }
      return { ok: true, token, tokenFromArgv: false };
    } catch (err) {
      return { ok: false, error: `--token-file ${input.tokenFile} could not be read: ${err}` };
    }
  }
  for (const name of input.envNames) {
    const value = env[name];
    if (value === undefined) continue;
    // An empty env credential is a hard error, never a silent no-token run
    // or a fall-through to a lower-precedence (e.g. legacy) alias.
    if (value.trim().length === 0) {
      return { ok: false, error: `${name} is set but empty` };
    }
    return { ok: true, token: value, tokenFromArgv: false };
  }
  return { ok: true, token: undefined, tokenFromArgv: false };
}
