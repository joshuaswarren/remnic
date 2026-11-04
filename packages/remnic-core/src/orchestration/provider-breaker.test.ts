import test from "node:test";
import assert from "node:assert/strict";
import { ProviderCircuitBreaker } from "./provider-breaker.js";

const CONFIG = { failureThreshold: 3, cooldownMs: 5_000, authCooldownMs: 60_000 };

test("half-open probe ownership is single-flight under parallel callers", () => {
  const breaker = new ProviderCircuitBreaker();
  breaker.failure("provider_retryable", 1_000, CONFIG);
  breaker.failure("provider_retryable", 1_100, CONFIG);
  breaker.failure("provider_retryable", 1_200, CONFIG); // threshold → open
  assert.deepEqual(breaker.acquire(1_300).suppressed, true, "open suppresses during cooldown");

  // Cooldown expires: the FIRST caller takes the probe…
  const probe = breaker.acquire(6_200);
  assert.equal(probe.probe, true, "expired breaker hands one probe out");
  // …siblings stay suppressed for as long as the probe is held — no wall-clock
  // expiry, however long the provider attempt runs (timeouts + retries).
  assert.deepEqual(breaker.acquire(600_000).suppressed, true, "a live probe keeps suppressing");
  assert.deepEqual(breaker.acquire(3_600_000).suppressed, true, "no timer expiry while held");

  // Probe attempt dies WITHOUT a terminal outcome (deadline/abort): explicit
  // release lets the next attempt re-probe.
  breaker.releaseProbe(probe.token);
  const reprobe = breaker.acquire(3_600_001);
  assert.equal(reprobe.probe, true, "released probe is re-acquired");
  assert.deepEqual(breaker.acquire(3_600_002).suppressed, true, "re-probe is also single-flight");

  // Terminal outcomes release ownership: the OWNER's failed probe re-opens
  // immediately (cooldown to 6_500 + 5_000).
  breaker.failure("provider_retryable", 6_500, CONFIG, reprobe.token);
  assert.deepEqual(breaker.acquire(7_000).suppressed, true, "failed probe re-opens at once");
  assert.deepEqual(breaker.acquire(12_000).suppressed, false, "cooldown expiry admits a fresh probe");
  breaker.success();
  assert.deepEqual(breaker.acquire(12_001).probe, false, "successful probe closes the breaker");
});

test("a forced attempt's failure never releases another attempt's live probe", () => {
  const breaker = new ProviderCircuitBreaker();
  breaker.failure("provider_retryable", 1_000, CONFIG);
  breaker.failure("provider_retryable", 1_100, CONFIG);
  breaker.failure("provider_retryable", 1_200, CONFIG); // threshold → open
  const probe = breaker.acquire(6_200);
  assert.equal(probe.probe, true, "ordinary attempt owns the probe");

  // A FORCED attempt bypassed acquire, fails while the probe is in flight:
  // it must not release the owner or masquerade as the probe result.
  breaker.failure("provider_retryable", 6_300, CONFIG /* no token */);
  assert.deepEqual(breaker.acquire(6_400), { suppressed: true, probe: false }, "probe stays single-flight");

  // Only the owner's failure settles it: re-open at once.
  breaker.failure("provider_retryable", 6_500, CONFIG, probe.token);
  assert.deepEqual(breaker.acquire(6_600), { suppressed: true, probe: false }, "failed probe re-opens immediately");

  // A released probe is re-acquired only via its own token path.
  const fresh = breaker.acquire(12_000);
  assert.equal(fresh.probe, true);
  breaker.releaseProbe(fresh.token);
  const reprobe = breaker.acquire(12_001);
  assert.equal(reprobe.probe, true, "released probe is re-acquired by the next attempt");
  // A non-owner release with a foreign token is a no-op.
  breaker.releaseProbe({ __probeOwner: true });
  assert.deepEqual(breaker.acquire(12_002), { suppressed: true, probe: false });
});

test("an unowned forced outcome neither trips the half-open threshold nor settles a held probe", () => {
  const breaker = new ProviderCircuitBreaker();
  breaker.failure("provider_retryable", 1_000, CONFIG);
  breaker.failure("provider_retryable", 1_100, CONFIG);
  breaker.failure("provider_retryable", 1_200, CONFIG); // threshold → open
  const probe = breaker.acquire(6_200);
  assert.equal(probe.probe, true, "ordinary attempt owns the probe");

  // Forced failures bypass acquire; even crossing the threshold they must
  // not reopen over a held probe (PRRT_kwDORJXyws6zxG6V).
  breaker.failure("provider_retryable", 6_250, CONFIG /* no token */);
  breaker.failure("provider_retryable", 6_300, CONFIG /* no token */);
  breaker.failure("provider_retryable", 6_350, CONFIG /* no token */);
  assert.deepEqual(breaker.acquire(6_400), { suppressed: true, probe: false }, "probe stays single-flight");

  // A forced success without the owner token must not settle the probe or
  // close the breaker mid-probe (PRRT_kwDORJXyws6zxG6u).
  breaker.success();
  assert.deepEqual(breaker.acquire(6_450), { suppressed: true, probe: false }, "probe survives an unowned success");

  // The owner's success settles it for real.
  breaker.success(probe.token);
  assert.deepEqual(breaker.acquire(6_500).suppressed, false, "owner success closes the breaker");
});

test("an unowned auth_config failure does not reopen over a held probe", () => {
  const breaker = new ProviderCircuitBreaker();
  breaker.failure("provider_retryable", 1_000, CONFIG);
  breaker.failure("provider_retryable", 1_050, CONFIG);
  breaker.failure("provider_retryable", 1_100, CONFIG);
  const probe = breaker.acquire(6_100);
  assert.equal(probe.probe, true);

  // A forced extraction reporting auth_config while the probe runs must not
  // flip the breaker open over the still-held owner token (PRRT_kwDORJXyws6z07Mu).
  breaker.failure("auth_config", 1_200, CONFIG);
  assert.deepEqual(breaker.acquire(1_300), { suppressed: true, probe: false }, "probe stays held");

  // The owner's own auth_config failure settles it with the auth cooldown.
  breaker.failure("auth_config", 1_400, CONFIG, probe.token);
  assert.deepEqual(breaker.acquire(1_500).suppressed, true, "owned auth_config failure reopens at once");
  assert.deepEqual(breaker.acquire(60_000).suppressed, true, "auth cooldown still gates the next probe");
  // The stranded-owner hazard: after the auth cooldown elapses, no SECOND
  // probe may mint while the original owner is still held.
  assert.deepEqual(breaker.acquire(60_001), { suppressed: true, probe: false }, "no second probe over a held one");
});
