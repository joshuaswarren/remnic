/**
 * Location boundary operations (issue #2047) — the five `location_*`
 * operations registered through the access boundary so MCP, HTTP, and any
 * batch transport share one validated dispatch. Handlers are thin: they run
 * the same `location/surfaces.ts` runners the CLI uses. Fleet-wide: location
 * config and day files are machine-level (no namespace scoping).
 */

import { z } from "zod";
import { defineOperation } from "../access-boundary.js";
import type { EngramAccessService } from "../access-service.js";
import { backfillMemoryStorage } from "./backfill.js";
import {
  runLocationBackfill,
  runLocationCheck,
  runLocationDay,
  runLocationStatus,
  runLocationSync,
  type LocationSurfaceDeps,
} from "./surfaces.js";

/** Zod shape shared by the location operations (null-for-absent tolerant). */
const dateField = z.union([z.string(), z.null()]).optional();
const daysField = z.union([z.number(), z.string(), z.null()]).optional();
const dryRunField = z.union([z.boolean(), z.null()]).optional();

function locationDeps(service: EngramAccessService): LocationSurfaceDeps {
  return {
    config: service.configRef.location,
    memoryDir: service.memoryDir,
    getMemoryStorage: () => backfillMemoryStorage(service.configRef),
  };
}

defineOperation({
  name: "location_status",
  description: "Location sync status (gates, providers, last sync, day counts).",
  fleetWide: true,
  schema: z.object({}).passthrough(),
  handler: async (_input, ctx) => ({
    result: await runLocationStatus(locationDeps(ctx.service)),
  }),
});

defineOperation({
  name: "location_check",
  description: "Probe every enabled location provider.",
  fleetWide: true,
  schema: z.object({}).passthrough(),
  handler: async (_input, ctx) => ({
    result: await runLocationCheck(locationDeps(ctx.service)),
  }),
});

defineOperation({
  name: "location_sync",
  description: "Sync location days (default window: syncDays ending yesterday).",
  fleetWide: true,
  schema: z.object({ date: dateField, days: daysField }).passthrough(),
  handler: async (input, ctx) => ({
    result: {
      days: await runLocationSync(locationDeps(ctx.service), {
        ...(input.date !== undefined && input.date !== null && input.date !== "" ? { endDate: input.date } : {}),
        ...(input.days !== undefined && input.days !== null && input.days !== "" ? { days: Number(input.days) } : {}),
      }),
    },
  }),
});

defineOperation({
  name: "location_backfill",
  description: "Sync an explicit historical day range (≤ 90 days) and re-tag overlapping memories (issue #2046).",
  fleetWide: true,
  schema: z.object({ from: dateField, to: dateField, dryRun: dryRunField }).passthrough(),
  handler: async (input, ctx) => ({
    result: await runLocationBackfill(locationDeps(ctx.service), {
      from: input.from ?? null,
      to: input.to ?? null,
      dryRun: input.dryRun === true,
    }),
  }),
});

defineOperation({
  name: "location_day",
  description: "Read one stored location day.",
  fleetWide: true,
  schema: z.object({ date: dateField }).passthrough(),
  handler: async (input, ctx) => ({
    result: await runLocationDay(locationDeps(ctx.service).memoryDir, input.date),
  }),
});

