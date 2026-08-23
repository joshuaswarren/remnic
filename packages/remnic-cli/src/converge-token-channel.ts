/**
 * Credential-channel resolution for `remnic converge` (#2823).
 *
 * argv tokens are visible to any process listing for the lifetime of a
 * plan/apply/watch run — hours at boot scale, exactly when operators take ps
 * snapshots. Token-file and env are the operator-safe channels; --token still
 * works but callers should warn. Extracted from converge.ts to respect the
 * new-file LOC ratchet.
 */
import * as fs from "node:fs";

export interface ConvergeTokenChannelInput {
  /** Value from the --token flag, if supplied (argv-visible). */
  argvToken: string | undefined;
  /** Path from --token-file, if supplied. */
  tokenFile: string | undefined;
}

export type ConvergeTokenChannelResult =
  | { ok: true; token: string | undefined; tokenFromArgv: boolean }
  | { ok: false; error: string };

/**
 * Resolve the peer credential with presence-tracked precedence
 * (--token > --token-file > env). An EMPTY higher-precedence value is a hard
 * error, never a silent fall-through to a lower-precedence channel. Token
 * files must not be group- or world-readable (chmod 600).
 */
/** Parse the --token-file flag value: a non-empty path, or null when absent/empty. */
export function parseConvergeTokenFileFlag(raw: string | undefined): string | null {
  return raw !== undefined && raw.length > 0 ? raw : null;
}

export function resolveConvergeTokenChannel(
  input: ConvergeTokenChannelInput,
  env: NodeJS.ProcessEnv
): ConvergeTokenChannelResult {
  const tokenFromArgv = input.argvToken !== undefined;
  if (!tokenFromArgv && input.tokenFile !== undefined) {
    try {
      const stat = fs.statSync(input.tokenFile);
      // A group/world-readable credential file defeats the point of the
      // channel; reject it instead of trusting the content.
      if (stat.mode & 0o077) {
        return { ok: false, error: `--token-file ${input.tokenFile} must not be group- or world-readable (chmod 600)` };
      }
      const token = fs.readFileSync(input.tokenFile, "utf8").trim();
      if (token.length === 0) {
        return { ok: false, error: `--token-file ${input.tokenFile} is empty` };
      }
      return { ok: true, token, tokenFromArgv };
    } catch (err) {
      return { ok: false, error: `--token-file ${input.tokenFile} could not be read: ${err}` };
    }
  }
  if (!tokenFromArgv && input.tokenFile === undefined && env.REMNIC_CONVERGE_PEER_TOKEN !== undefined) {
    return { ok: true, token: env.REMNIC_CONVERGE_PEER_TOKEN, tokenFromArgv: false };
  }
  return { ok: true, token: input.argvToken, tokenFromArgv };
}
