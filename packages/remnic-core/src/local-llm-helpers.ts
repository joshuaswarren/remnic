export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { name?: string; message?: string };
  return (
    maybe.name === "AbortError" ||
    maybe.message === "This operation was aborted" ||
    maybe.message === "The operation was aborted"
  );
}

export function waitForRetryBackoff(backoffMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const onTimer = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    };
    timer = setTimeout(onTimer, backoffMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function normalizeBackendTripReason(reason: string): string {
  const cleaned = reason.replace(/\s+/g, " ").replace(/^[-:–—\s]+/, "").trim();
  if (!cleaned) return "unknown local backend failure";
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

export function extractNonRecoverableBackendReason(reason: string): string | null {
  const match = reason.match(
    /Failed to load model|Library not loaded|different Team IDs|code signature|llm_engine_mlx_amphibian/i,
  );
  return match?.[0] ?? null;
}

export function extractNonRecoverableBackendReasonFromErrorText(errorText: string): string | null {
  const directReason = extractNonRecoverableBackendReason(errorText);
  if (directReason) return directReason;
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string } };
    return extractNonRecoverableBackendReason(parsed?.error?.message ?? "");
  } catch {
    return null;
  }
}
