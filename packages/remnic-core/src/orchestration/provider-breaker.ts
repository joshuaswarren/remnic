import { log } from "../logger.js";
import type { ExtractionFailureClass } from "../types.js";

export interface ProviderBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly authCooldownMs: number;
}

export interface ProviderBreakerSnapshot {
  readonly state: "closed" | "open" | "half_open";
  readonly openUntilMs: number;
  readonly consecutiveFailures: number;
  readonly lastReason: string;
}

export interface ProbeAcquisition {
  /** True when the attempt is suppressed (breaker open, or the half-open
   *  probe is owned by another attempt). */
  readonly suppressed: boolean;
  /** True when THIS attempt owns the single half-open probe and must
   *  terminate it via {@link failure}/{@link success}, or release it via
   *  {@link releaseProbe} on any early exit (deadline, abort, throw). */
  readonly probe: boolean;
}

/**
 * Provider circuit breaker with single-flight half-open probe OWNERSHIP
 * (codex P2 on #3311): under extractionQueueConcurrency > 1 several sessions
 * can pass an expired `open` breaker in the same window, and a wall-clock
 * reservation either expires under a live long provider attempt (600s
 * timeouts) or pins the breaker when an attempt dies without settling. So the
 * probe is OWNED, not timed: exactly one attempt holds it from the
 * open→half_open flip until its terminal `failure()`/`success()`, and any
 * early exit releases it explicitly. A released-but-unfinished probe lets the
 * next attempt re-probe; a retry backoff still throttles that namespace.
 */
export class ProviderCircuitBreaker {
  private consecutiveFailures = 0;
  private openUntilMs = 0;
  private state: ProviderBreakerSnapshot["state"] = "closed";
  private lastReason = "";
  private probeHeld = false;

  acquire(now: number): ProbeAcquisition {
    if (now < this.openUntilMs) return { suppressed: true, probe: false };
    if (this.state === "open") {
      this.state = "half_open";
      this.probeHeld = true;
      this.logTransition();
      return { suppressed: false, probe: true }; // THIS attempt is the probe.
    }
    if (this.state === "half_open") {
      if (this.probeHeld) return { suppressed: true, probe: false };
      this.probeHeld = true; // previous owner released without settling; re-probe.
      return { suppressed: false, probe: true };
    }
    return { suppressed: false, probe: false };
  }

  /** Release an owned probe on an attempt that exits without a terminal
   *  outcome (deadline, abort, throw). Idempotent; state stays half_open so
   *  the next attempt re-probes. */
  releaseProbe(): void {
    this.probeHeld = false;
  }

  failure(cls: ExtractionFailureClass, now: number, config: ProviderBreakerConfig): void {
    this.probeHeld = false;
    this.consecutiveFailures += 1;
    const trip =
      cls === "auth_config" ||
      // A failed half-open probe re-opens immediately (standard breaker
      // semantics). Without this, an auth_config-opened breaker (which trips
      // below the threshold) would get stuck half_open after a transient
      // probe failure and stop suppressing (cursor review).
      this.state === "half_open" ||
      this.consecutiveFailures >= config.failureThreshold;
    if (!trip) return;
    const cooldown = cls === "auth_config" ? config.authCooldownMs : config.cooldownMs;
    this.openUntilMs = now + Math.max(0, cooldown);
    this.lastReason = cls;
    if (this.state !== "open") {
      this.state = "open";
      this.logTransition();
    }
  }

  success(): void {
    const wasDisturbed =
      this.state !== "closed" || this.consecutiveFailures > 0 || this.openUntilMs > 0;
    if (!wasDisturbed) return;
    const wasOpen = this.state !== "closed";
    this.probeHeld = false;
    this.consecutiveFailures = 0;
    this.openUntilMs = 0;
    this.lastReason = "";
    this.state = "closed";
    if (wasOpen) this.logTransition();
  }

  snapshot(): ProviderBreakerSnapshot {
    return {
      state: this.state,
      openUntilMs: this.openUntilMs,
      consecutiveFailures: this.consecutiveFailures,
      lastReason: this.lastReason,
    };
  }

  private logTransition(): void {
    // Once per state change (not per attempt) — AGENTS.md observability rule.
    log.warn("extraction: provider circuit breaker transition", {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastReason: this.lastReason,
      openUntilMs: this.openUntilMs,
    });
  }
}
