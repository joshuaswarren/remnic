/** Readiness-gated liveness probe. A 404 retries legacy diagnostic health within the same deadline. */
export async function probeAuthenticatedLiveness(
  base: string,
  token: string,
  timeoutMs: number,
): Promise<boolean> {
  const headers = { authorization: `Bearer ${token}` };
  const deadline = Date.now() + timeoutMs;
  try {
    let response = await fetch(`${base}/engram/v1/live`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        response = await fetch(`${base}/engram/v1/health`, {
          headers,
          signal: AbortSignal.timeout(remaining),
        });
      }
    }
    return response.status === 200;
  } catch {
    return false;
  }
}
