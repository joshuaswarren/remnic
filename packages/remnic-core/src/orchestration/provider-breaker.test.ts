import test from "node:test";
import assert from "node:assert/strict";
import { ProviderCircuitBreaker } from "./provider-breaker.js";

const CONFIG = { failureThreshold: 3, cooldownMs: 5_000, authCooldownMs: 60_000 };

test("half-open probe ownership is single-flight under parallel callers", () => {
  const breaker = new ProviderCircuitBreaker();
  breaker.failure("provider_retryable", 1_000, CONFIG);
  breaker.failure("provider_retryable", 1_100, CONFIG);
  breaker.failure("provider_retryable", 1_200, CONFIG); // threshold → open
  assert.deepEqual(breaker.acquire(1_300), { suppressed: true, probe: false }, "open suppresses during cooldown");

  // Cooldown expires: the FIRST caller takes the probe…
  assert.deepEqual(breaker.acquire(6_200), { suppressed: false, probe: true }, "expired breaker hands one probe out");
  // …a concurrent sibling stays suppressed for as long as the probe is held —
  // even far beyond any wall-clock window (long provider timeouts, retries).
  assert.deepEqual(breaker.acquire(600_000), { suppressed: true, probe: false }, "a live probe keeps suppressing");
  assert.deepEqual(breaker.acquire(3_600_000), { suppressed: true, probe: false }, "no timer expiry while held");

  // Probe attempt dies WITHOUT a terminal outcome (deadline/abort): explicit
  // release lets the next attempt re-probe.
  breaker.releaseProbe();
  assert.deepEqual(breaker.acquire(3_600_001), { suppressed: false, probe: true }, "released probe is re-acquired");

  // Terminal outcomes release ownership: failure re-opens immediately…
  breaker.failure("provider_retryable", 3_600_002, CONFIG);
  assert.deepEqual(breaker.acquire(3_600_003), { suppressed: true, probe: false }, "failed probe re-opens at once");
  // …success closes.
  assert.deepEqual(breaker.acquire(4_000_000), { suppressed: false, probe: true }, "fresh probe after cooldown");
  breaker.success();
  assert.deepEqual(breaker.acquire(4_000_001), { suppressed: false, probe: false }, "successful probe closes the breaker");
});
