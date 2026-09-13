export const BRIEFING_FOLLOWUP_TIMEOUT_MS = 8_000;

export async function withBriefingFollowupTimeout<T>(
  work: Promise<T>,
  timeoutMs = BRIEFING_FOLLOWUP_TIMEOUT_MS,
): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error("briefing follow-up timeout")), timeoutMs);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
