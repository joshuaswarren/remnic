export async function waitForResult(
  read,
  {
    timeoutMs = 10_000,
    pollIntervalMs = 25,
    now = Date.now,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}
) {
  const deadline = now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw lastError;
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function runCleanupSteps(steps) {
  let firstError;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}
