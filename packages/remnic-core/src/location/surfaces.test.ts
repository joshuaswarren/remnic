/**
 * Location surfaces regression (issue #2047): one shared runner behind the
 * CLI / MCP / HTTP / scheduler surfaces. These tests pin the contract the
 * issue requires — disabled vs empty vs failure are distinct, validation is
 * identical across surfaces, and provider registration bootstraps before
 * status/check/sync run.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseLocationConfig } from "./config.js";
import {
  clearLocationProviders,
  registerLocationProvider,
} from "./registry.js";
import { parseLocationBackfillRange, runLocationCliCommand } from "./surfaces.js";
import type { LocationProvider } from "./types.js";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    cliIo: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
  };
}

const OBSERVATION = {
  observedAtUtc: "2026-08-16T09:00:00.000Z",
  place: { id: "reitti:place:1", label: "Home" },
};

/** Observations only for the 2026-08-16 window; other days are valid empty days. */
function fakeProvider(): LocationProvider {
  return {
    id: "reitti",
    displayName: "Reitti",
    verify: async () => ({ ok: true }),
    fetchObservations: async (opts) => {
      assert.ok(opts.startUtc < opts.endUtc, "window must be half-open");
      const inWindow = opts.startUtc.startsWith("2026-08-16");
      return {
        observations: inWindow
          ? [{ observedAtUtc: OBSERVATION.observedAtUtc, place: { ...OBSERVATION.place, kind: "other" as const } }]
          : [],
        nextCursor: null,
      };
    },
  };
}

function enabledConfig() {
  return parseLocationConfig({
    enabled: true,
    timezone: "UTC",
    syncDays: 1,
    sources: [{ id: "reitti" }],
  });
}

test.afterEach(() => clearLocationProviders());

test("status reports disabled master gate and unregistered provider, never an error", async () => {
  const config = parseLocationConfig({ enabled: false, sources: [{ id: "reitti" }] });
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-status-"));
  try {
    const out = io();
    const code = await runLocationCliCommand({ config, memoryDir }, ["status", "--json"], out.cliIo);
    assert.equal(code, 0);
    const report = JSON.parse(out.stdout.join("")) as { enabled: boolean; sources: Array<{ providerRegistered: boolean }> };
    assert.equal(report.enabled, false);
    assert.equal(report.sources[0]?.providerRegistered, false, "absent provider is a skip state, not an error");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("check distinguishes skip reasons from provider failures", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-check-"));
  try {
    // Master gate off → location-disabled skip, exit non-zero.
    const disabled = io();
    const disabledCode = await runLocationCliCommand(
      { config: parseLocationConfig({ enabled: false, sources: [{ id: "reitti" }] }), memoryDir },
      ["check"],
      disabled.cliIo,
    );
    assert.match(disabled.stdout.join(""), /skipped: location-disabled/);
    assert.equal(disabledCode, 1);

    // Enabled but provider absent → provider-not-registered, distinct reason.
    const unregistered = io();
    const unregisteredCode = await runLocationCliCommand({ config: enabledConfig(), memoryDir }, ["check"], unregistered.cliIo);
    assert.match(unregistered.stdout.join(""), /skipped: provider-not-registered/);
    assert.equal(unregisteredCode, 1);

    // Registered healthy provider → OK, exit 0.
    registerLocationProvider(fakeProvider());
    const healthy = io();
    const healthyCode = await runLocationCliCommand({ config: enabledConfig(), memoryDir }, ["check"], healthy.cliIo);
    assert.match(healthy.stdout.join(""), /reitti: OK/);
    assert.equal(healthyCode, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("sync writes the day file through the shared runner and reports per-source results", async () => {
  registerLocationProvider(fakeProvider());
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-sync-"));
  try {
    const out = io();
    const code = await runLocationCliCommand(
      { config: enabledConfig(), memoryDir },
      ["sync", "--date", "2026-08-16", "--json"],
      out.cliIo,
    );
    assert.equal(code, 0);
    const payload = JSON.parse(out.stdout.join("")) as {
      days: Array<{ date: string; results: Array<{ sourceId: string; status: string; fetched: number; dayWritten: boolean }> }>;
    };
    assert.equal(payload.days.length, 1);
    assert.equal(payload.days[0]?.date, "2026-08-16");
    assert.equal(payload.days[0]?.results[0]?.status, "synced");
    assert.equal(payload.days[0]?.results[0]?.dayWritten, true);

    // day reads back what sync wrote (same shared implementation).
    const dayOut = io();
    const dayCode = await runLocationCliCommand({ config: enabledConfig(), memoryDir }, ["day", "2026-08-16", "--json"], dayOut.cliIo);
    assert.equal(dayCode, 0);
    const view = JSON.parse(dayOut.stdout.join("")) as { found: boolean; observationCount: number; sources: string[] };
    assert.equal(view.found, true);
    assert.equal(view.observationCount, 1, "one stored observation from the fake provider");
    assert.deepEqual(view.sources, ["reitti"]);

    // An unstored day is an explicit not-found, not an error.
    const missing = io();
    const missingCode = await runLocationCliCommand({ config: enabledConfig(), memoryDir }, ["day", "2026-01-01"], missing.cliIo);
    assert.equal(missingCode, 1);
    assert.match(missing.stderr.join(""), /No stored location day/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("sync exit code reflects per-source failure", async () => {
  const provider: LocationProvider = {
    id: "reitti",
    displayName: "Reitti",
    verify: async () => ({ ok: true }),
    fetchObservations: async () => {
      throw new Error("ReittiApiError");
    },
  };
  registerLocationProvider(provider);
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-fail-"));
  try {
    const out = io();
    const code = await runLocationCliCommand({ config: enabledConfig(), memoryDir }, ["sync", "--date", "2026-08-16"], out.cliIo);
    assert.equal(code, 1);
    assert.match(out.stdout.join(""), /reitti: failed/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("validation is strict and shared: unknown flags, bad dates, bad ranges", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-args-"));
  try {
    const cases: Array<[string[], RegExp]> = [
      [["sync", "--nope"], /unknown flag '--nope'/],
      [["sync", "--days"], /--days requires a value/],
      [["sync", "--days", "0"], /days expects an integer from 1 to 90/],
      [["sync", "--date", "2026-13-99"], /date is required \(YYYY-MM-DD\)/],
      [["day", "not-a-date"], /date is required \(YYYY-MM-DD\)/],
      [["backfill", "--from", "2026-08-10", "--to", "2026-08-01"], /--from must not be after --to/],
      [["sync", "positional"], /sync takes flags only/],
      [["nonsense"], /unknown command 'nonsense'/],
    ];
    for (const [args, pattern] of cases) {
      const out = io();
      const code = await runLocationCliCommand({ config: enabledConfig(), memoryDir }, args, out.cliIo);
      assert.equal(code, 1, `${JSON.stringify(args)} exits non-zero`);
      assert.match(out.stderr.join(""), pattern);
    }

    // Backfill range cap: 91 days rejects; 90 passes.
    assert.throws(() => parseLocationBackfillRange("2026-05-01", "2026-07-30"), /capped at 90 days/);
    assert.deepEqual(parseLocationBackfillRange("2026-05-02", "2026-07-30"), { endDate: "2026-07-30", days: 90 });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("backfill syncs the explicit range oldest-first; empty days are synced, not failed", async () => {
  registerLocationProvider(fakeProvider());
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-backfill-"));
  try {
    const out = io();
    const code = await runLocationCliCommand(
      { config: enabledConfig(), memoryDir },
      ["backfill", "--from", "2026-08-14", "--to", "2026-08-16", "--json"],
      out.cliIo,
    );
    assert.equal(code, 0);
    const payload = JSON.parse(out.stdout.join("")) as { days: Array<{ date: string; results: Array<{ status: string; fetched: number }> }> };
    assert.deepEqual(
      payload.days.map((d) => d.date),
      ["2026-08-14", "2026-08-15", "2026-08-16"],
      "oldest-first bounded range",
    );
    assert.deepEqual(
      payload.days.map((d) => d.results[0]?.status),
      ["synced", "synced", "synced"],
      "empty days are synced, not failed",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("bare command prints usage with exit 1; help exits 0", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-help-"));
  try {
    const bare = io();
    assert.equal(await runLocationCliCommand({ config: enabledConfig(), memoryDir }, [], bare.cliIo), 1);
    assert.match(bare.stdout.join(""), /Usage: location/);
    const help = io();
    assert.equal(await runLocationCliCommand({ config: enabledConfig(), memoryDir }, ["help"], help.cliIo), 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
