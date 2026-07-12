import assert from "node:assert/strict";
import test from "node:test";
import { abortError } from "./abort-error.js";
import { QmdClient } from "./qmd.js";

/**
 * Internals exposed only for preflight testing. Cast once to a NAMED type (not
 * an inline shape) so the compiler never fabricates a one-off member type; the
 * unchecked access is scoped to these deliberately-injected seams. Issue #1841.
 */
type QmdPreflightInternals = {
  configuredQmdPath: string | undefined;
  runVersionProbe: (qmdPath: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
  logCliProbeWarning: (message: string) => void;
  probeCli: (options?: {
    allowAutoUpgrade?: boolean;
    preserveStateOnFailure?: boolean;
    signal?: AbortSignal;
  }) => Promise<boolean>;
};

const CONFIGURED_PATH = "/opt/qmd/bin/qmd";

/** Build the Node spawn ENOENT error shape (Error carrying `code: "ENOENT"`). */
function spawnENOENT(qmdPath: string): Error & { code: string } {
  return Object.assign(new Error(`spawn ${qmdPath} ENOENT`), {
    code: "ENOENT" as const,
  });
}

function timeoutError(): Error & { timedOut: true } {
  // Mirrors the error runCommandWithTimeout rejects with on deadline: a plain
  // Error flagged with `timedOut: true` — the structured signal classifyProbeFailure
  // keys on (never the message text). Issue #1841.
  return Object.assign(new Error("qmd --version timed out after 8000ms"), {
    timedOut: true as const,
  });
}

/** Wire a fresh client whose probe runner + warning sink are fully scripted. */
function harness(opts: {
  configuredBehavior: () => Promise<{ stdout: string; stderr: string }>;
}): {
  internals: QmdPreflightInternals;
  warnings: string[];
  configuredProbeCalls: () => number;
} {
  const client = new QmdClient("memories", 3, {
    qmdPath: CONFIGURED_PATH,
    qmdFallbackPaths: [],
  });
  const internals = client as unknown as QmdPreflightInternals;
  const warnings: string[] = [];
  internals.logCliProbeWarning = (message: string) => {
    warnings.push(message);
  };
  let configuredCalls = 0;
  internals.runVersionProbe = async (qmdPath: string) => {
    if (qmdPath === CONFIGURED_PATH) {
      configuredCalls += 1;
      return opts.configuredBehavior();
    }
    // Any non-configured path (PATH/fallback probing) is a hard miss here so
    // probeCli returns false without spawning a real qmd binary.
    throw spawnENOENT(qmdPath);
  };
  return {
    internals,
    warnings,
    configuredProbeCalls: () => configuredCalls,
  };
}

test("QmdClient preflight: transient timeout retries then succeeds with NO failure warning", async () => {
  // Two timeouts, then success on the second retry.
  const scripted: Array<"timeout" | "ok"> = ["timeout", "timeout", "ok"];
  let i = 0;
  const { internals, warnings, configuredProbeCalls } = harness({
    configuredBehavior: async () => {
      const step = scripted[i++];
      if (step === "timeout") throw timeoutError();
      return { stdout: "qmd 1.2.3\n", stderr: "" };
    },
  });

  const ok = await internals.probeCli({ allowAutoUpgrade: false });

  assert.equal(ok, true, "configured probe should succeed after retry");
  assert.equal(configuredProbeCalls(), 3, "initial attempt + 2 retries for transient timeout");
  assert.deepEqual(warnings, [], "no failure warning emitted when retry succeeds");
});

test("QmdClient preflight: persistent timeout emits the distinct under-load warning (not 'configured qmdPath failed')", async () => {
  const { internals, warnings, configuredProbeCalls } = harness({
    configuredBehavior: async () => {
      throw timeoutError();
    },
  });

  const ok = await internals.probeCli({ allowAutoUpgrade: false });

  assert.equal(ok, false, "exhausted retries fall through to unavailable");
  assert.equal(configuredProbeCalls(), 3, "initial attempt + 2 retries before declaring transient failure");
  assert.equal(warnings.length, 1, "exactly one failure warning");
  const msg = warnings[0] ?? "";
  assert.match(
    msg,
    /version check timed out \(host may be under load\); retried 2 times/,
    "transient failure uses the under-load wording"
  );
  assert.doesNotMatch(msg, /configured qmdPath failed/, "must not read as a generic misconfiguration");
});

test("QmdClient preflight: genuine ENOENT fails fast (no retry) with the not-found/not-executable warning", async () => {
  const { internals, warnings, configuredProbeCalls } = harness({
    configuredBehavior: async () => {
      throw spawnENOENT(CONFIGURED_PATH);
    },
  });

  const ok = await internals.probeCli({ allowAutoUpgrade: false });

  assert.equal(ok, false, "missing binary is unavailable");
  assert.equal(configuredProbeCalls(), 1, "ENOENT is a hard misconfiguration: never retried");
  assert.equal(warnings.length, 1, "exactly one failure warning");
  const msg = warnings[0] ?? "";
  assert.match(msg, /configured qmdPath not found or not executable/, "missing binary uses the not-found wording");
  assert.match(msg, /spawn .* ENOENT/, "underlying error detail preserved");
  assert.doesNotMatch(msg, /timed out|under load/, "must not read as a transient timeout");
});

test("QmdClient preflight: non-timeout exit-code failure keeps the generic configured-failed message and does not retry", async () => {
  const { internals, warnings, configuredProbeCalls } = harness({
    configuredBehavior: async () => {
      throw new Error("qmd --version exited with code 2");
    },
  });

  const ok = await internals.probeCli({ allowAutoUpgrade: false });

  assert.equal(ok, false, "exit-code failure is unavailable");
  assert.equal(configuredProbeCalls(), 1, "non-transient, non-missing failures are not retried");
  assert.equal(warnings.length, 1, "exactly one failure warning");
  const msg = warnings[0] ?? "";
  assert.match(msg, /configured qmdPath failed/, "ambiguous exit-code failures keep the historical generic wording");
  assert.doesNotMatch(
    msg,
    /timed out|under load|not found or not executable/,
    "must not be misclassified as timeout or missing"
  );
});

test("QmdClient preflight: caller abort emits NO warning and does not retry", async () => {
  // The caller cancelled (aborted signal + AbortError). Other QMD paths treat
  // this as non-actionable noise via isCallerCancellation; the configured-path
  // probe must do the same — no under-load warning, no transient retry. #1841.
  const controller = new AbortController();
  controller.abort();
  const { internals, warnings, configuredProbeCalls } = harness({
    configuredBehavior: async () => {
      // A real probe rejects with an AbortError when the caller's signal fires.
      throw abortError("qmd --version aborted");
    },
  });

  const ok = await internals.probeCli({ allowAutoUpgrade: false, signal: controller.signal });

  assert.equal(ok, false, "aborted configured probe falls through to unavailable");
  assert.equal(configuredProbeCalls(), 1, "caller cancellation never retries");
  assert.deepEqual(warnings, [], "caller cancellation is silent noise: no operator-facing warning");
});

test("QmdClient preflight: non-zero exit whose stderr says 'timed out'/'not found' is classified 'other' (not transient/missing)", async () => {
  // Mirrors runCommandWithTimeout's non-zero-exit rejection: the child's stderr
  // (here containing "timed out" and "not found") is embedded in the message.
  // A healthy binary can emit those words in error text; they must NOT upgrade
  // the failure to transient/missing. classifyProbeFailure keys on structured
  // signals, so this generic exit-code failure stays 'other'. Issue #1841.
  const { internals, warnings, configuredProbeCalls } = harness({
    configuredBehavior: async () => {
      throw new Error("qmd --version failed (code 2): error: model timed out while loading; config not found");
    },
  });

  const ok = await internals.probeCli({ allowAutoUpgrade: false });

  assert.equal(ok, false, "exit-code failure is unavailable");
  assert.equal(configuredProbeCalls(), 1, "embedded-stderr failure is not transient — no retry");
  assert.equal(warnings.length, 1, "exactly one failure warning");
  const msg = warnings[0] ?? "";
  assert.match(msg, /configured qmdPath failed/, "classified as generic 'other'");
  assert.doesNotMatch(
    msg,
    /under load|not found or not executable/,
    "must not misclassify embedded-stderr words as transient/missing"
  );
});
