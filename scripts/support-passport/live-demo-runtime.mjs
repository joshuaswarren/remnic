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

export async function readCleanCommitSha(repoRoot, runGit) {
  let status;
  let commit;
  try {
    status = await runGit(["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot });
    commit = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  } catch {
    throw new Error("Git could not identify the demo commit.");
  }
  if (status.stdout.trim()) throw new Error("Commit all tracked changes before creating a live receipt.");
  const sha = commit.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Git returned an invalid commit SHA.");
  return sha;
}
