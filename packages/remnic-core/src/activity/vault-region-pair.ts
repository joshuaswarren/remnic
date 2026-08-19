/**
 * Assert a managed-region begin/end name pair (issue #1985).
 *
 * Trim both names. Empty throws. Mismatch is name_mismatch. Else ok.
 */

export type BeginEndPairInput = {
  beginName: string;
  endName: string;
};

export type BeginEndPairResult = { ok: true } | { ok: false; error: "name_mismatch" };

export function assertBeginEndPair({ beginName, endName }: BeginEndPairInput): BeginEndPairResult {
  const begin = beginName.trim();
  const end = endName.trim();
  if (begin.length === 0 || end.length === 0) {
    throw new RangeError("Region name must be non-empty.");
  }
  if (begin !== end) {
    return { ok: false, error: "name_mismatch" };
  }
  return { ok: true };
}
