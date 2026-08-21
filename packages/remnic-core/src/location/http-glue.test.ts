/**
 * Location HTTP glue regression (issue #2047): the /engram/v1/location/...
 * responders dispatch through the same boundary operations the MCP tools
 * use — identical validation messages, 404 for unstored days, 200 otherwise.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServerResponse } from "node:http";

// Import the operations module so getOperation() has the location_* set.
import "../access-operations.js";
import { EngramAccessInputError } from "../access-errors.js";
import type { EngramAccessService } from "../access-service.js";
import { parseLocationConfig } from "./config.js";
import {
  respondLocationBackfill,
  respondLocationCheck,
  respondLocationDay,
  respondLocationStatus,
  respondLocationSync,
} from "./http-glue.js";

const DUMMY_RES = {} as ServerResponse;

function makeService(memoryDir: string): EngramAccessService {
  const config = {
    location: parseLocationConfig({ enabled: true, timezone: "UTC", sources: [{ id: "reitti" }] }),
  };
  return { configRef: config, memoryDir } as unknown as EngramAccessService;
}

test("status and check respond 200 with the shared runner's disabled/empty semantics", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-http-"));
  try {
    const box: { s?: number; b?: unknown } = {};
    const respondJson = (_res: ServerResponse, status: number, payload: unknown) => {
      box.s = status;
      box.b = payload;
    };
    const service = makeService(memoryDir);
    await respondLocationStatus(DUMMY_RES, respondJson, service);
    assert.equal(box.s, 200);
    const report = box.b as { enabled: boolean; sources: Array<{ providerRegistered: boolean }> };
    assert.equal(report.enabled, true);
    assert.equal(report.sources[0]?.providerRegistered, false, "absent provider is a skip state");

    await respondLocationCheck(DUMMY_RES, respondJson, service);
    assert.equal(box.s, 200);
    const check = box.b as { results: Array<{ id: string; ok: boolean; skipped?: string }> };
    assert.deepEqual(check.results, [{ id: "reitti", ok: false, skipped: "provider-not-registered" }]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("invalid sync/backfill/day inputs reject with the SAME messages as the CLI runner", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-http-invalid-"));
  const service = makeService(memoryDir);
  const respondJson = () => {};
  try {
    await assert.rejects(
      () => respondLocationSync({ date: "2026-13-99" }, DUMMY_RES, respondJson, service),
      (err: unknown) => err instanceof EngramAccessInputError && /date is required \(YYYY-MM-DD\)/.test(err.message),
    );
    await assert.rejects(
      () => respondLocationSync({ days: 0 }, DUMMY_RES, respondJson, service),
      (err: unknown) => err instanceof EngramAccessInputError && /days expects an integer from 1 to 90/.test(err.message),
    );
    await assert.rejects(
      () => respondLocationBackfill({ from: "2026-08-10", to: "2026-08-01" }, DUMMY_RES, respondJson, service),
      (err: unknown) => err instanceof EngramAccessInputError && /--from must not be after --to/.test(err.message),
    );
    await assert.rejects(
      () => respondLocationDay(null, DUMMY_RES, respondJson, service),
      (err: unknown) => err instanceof EngramAccessInputError && /date is required \(YYYY-MM-DD\)/.test(err.message),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("day responds 404 for an unstored day", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-http-day-"));
  try {
    const box: { s?: number; b?: unknown } = {};
    const respondJson = (_res: ServerResponse, status: number, payload: unknown) => {
      box.s = status;
      box.b = payload;
    };
    await respondLocationDay("2026-08-16", DUMMY_RES, respondJson, makeService(memoryDir));
    assert.equal(box.s, 404);
    assert.equal((box.b as { found: boolean }).found, false, "unstored day is an explicit not-found");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
