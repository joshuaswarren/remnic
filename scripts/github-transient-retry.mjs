/**
 * Retry GitHub REST/GraphQL lookups that fail while a brand-new PR node is
 * not yet readable. Observed 2026-08-17: opening several PRs at once made
 * `ai-reviewers` and `pr-scope-budget` crash on 404/422
 * "Could not resolve to a node" and 502/503/429 from the API.
 */

const NODE_NOT_FOUND = /could not resolve to a node/i;

export function isTransientGithubLookupError(error) {
  const status = Number(error?.status);
  const message = [
    error?.message,
    error?.response?.data?.message,
    typeof error?.response?.data === "string" ? error.response.data : "",
    Array.isArray(error?.response?.data?.errors)
      ? error.response.data.errors.map((item) => item?.message).join(" ")
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (status === 429 || status === 502 || status === 503) return true;
  if ((status === 404 || status === 422) && NODE_NOT_FOUND.test(message)) {
    return true;
  }
  return false;
}

export async function withTransientGithubRetry(
  fn,
  { attempts = 18, delayMs = 10_000, sleep } = {},
) {
  const wait =
    typeof sleep === "function"
      ? sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const maxAttempts = Math.max(1, Math.floor(attempts));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientGithubLookupError(error) || attempt === maxAttempts) {
        throw error;
      }
      await wait(delayMs);
    }
  }
  throw lastError;
}
