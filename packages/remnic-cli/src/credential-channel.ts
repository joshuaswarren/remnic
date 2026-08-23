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

/**
 * Bind type/mode/symlink checks and the token read to one inode.
 * POSIX: O_NONBLOCK|O_NOFOLLOW open so a FIFO/device cannot block before
 * fstat; then regular+0600 and a same-fd read. Windows: reject a non-regular
 * lstat before open (named pipes block); O_NOFOLLOW when present; post-open
 * path↔fd identity — never lstat then pathname readFile.
 */
function readTokenFileSameInode(
  tokenFile: string,
  afterValidate?: () => void
): CredentialChannelResult {
  let fd: number | undefined;
  try {
    if (process.platform === "win32") {
      const pre = fs.lstatSync(tokenFile);
      if (pre.isSymbolicLink()) {
        return { ok: false, error: `--token-file ${tokenFile} must be a regular file, not a symlink` };
      }
      if (!pre.isFile()) {
        return { ok: false, error: `--token-file ${tokenFile} must be a regular file` };
      }
    }
    fd = fs.openSync(
      tokenFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      return { ok: false, error: `--token-file ${tokenFile} must be a regular file, not a symlink` };
    }
    if (
      code === "EISDIR" ||
      code === "ENOTDIR" ||
      code === "ENXIO" ||
      code === "EAGAIN" ||
      code === "EWOULDBLOCK" ||
      code === "EOPNOTSUPP" ||
      code === "ENOTSUP"
    ) {
      return { ok: false, error: `--token-file ${tokenFile} must be a regular file` };
    }
    return { ok: false, error: `--token-file ${tokenFile} could not be read: ${err}` };
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return { ok: false, error: `--token-file ${tokenFile} must be a regular file` };
    }
    // Windows mode bits are synthesized (readable files commonly present as
    // 0666), so the owner-only check is POSIX-only.
    if (process.platform !== "win32" && opened.mode & 0o077) {
      return { ok: false, error: `--token-file ${tokenFile} must not be group- or world-readable (chmod 600)` };
    }
    if (process.platform === "win32" || (fs.constants.O_NOFOLLOW ?? 0) === 0) {
      const pathStat = fs.lstatSync(tokenFile);
      if (pathStat.isSymbolicLink()) {
        return { ok: false, error: `--token-file ${tokenFile} must be a regular file, not a symlink` };
      }
      if (!pathStat.isFile() || pathStat.dev !== opened.dev || pathStat.ino !== opened.ino) {
        return { ok: false, error: `--token-file ${tokenFile} must be a regular file` };
      }
    }
    afterValidate?.();
    const size = opened.size;
    const buf = Buffer.alloc(size);
    const got = size > 0 ? fs.readSync(fd, buf, 0, size, 0) : 0;
    const token = buf.subarray(0, got).toString("utf8").trim();
    const after = fs.fstatSync(fd);
    if (opened.dev !== after.dev || opened.ino !== after.ino || !after.isFile()) {
      return { ok: false, error: `--token-file ${tokenFile} could not be read: file changed during read` };
    }
    if (token.length === 0) {
      return { ok: false, error: `--token-file ${tokenFile} is empty` };
    }
    return { ok: true, token, tokenFromArgv: false };
  } catch (err) {
    return { ok: false, error: `--token-file ${tokenFile} could not be read: ${err}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed or unusable
      }
    }
  }
}

export function resolveCredentialChannel(
  input: CredentialChannelInput,
  env: NodeJS.ProcessEnv,
  hooks?: { afterTokenFileValidated?: () => void }
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
    return readTokenFileSameInode(input.tokenFile, hooks?.afterTokenFileValidated);
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
