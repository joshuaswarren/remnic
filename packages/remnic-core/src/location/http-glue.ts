/**
 * Location HTTP route glue (issue #2047) — the `/engram/v1/location/...` (and
 * `/remnic/v1/...` alias) route bodies, extracted so access-http.ts (size-
 * grandfathered) keeps only thin route branches (same pattern as
 * meetings/http-glue.ts). Every responder dispatches through the access
 * boundary operation — the identical validated path the MCP tools use — so
 * HTTP and MCP can never diverge on validation or error mapping.
 * EngramAccessInputError bubbles to the global 400 handler; backend faults
 * keep flowing to the global 500 handler.
 */

import type { ServerResponse } from "node:http";
import { getOperation, type OperationName } from "../access-boundary.js";
import type { EngramAccessService } from "../access-service.js";

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;

function requireLocationOperation(name: OperationName) {
  const op = getOperation(name);
  if (!op) {
    throw new Error(`access-boundary: operation not registered: ${name}`);
  }
  return op;
}

export async function respondLocationStatus(
  res: ServerResponse,
  respondJson: RespondJson,
  service: EngramAccessService,
): Promise<void> {
  const output = (await requireLocationOperation("location_status").run({}, { service })) as {
    result: unknown;
  };
  respondJson(res, 200, output.result);
}

export async function respondLocationCheck(
  res: ServerResponse,
  respondJson: RespondJson,
  service: EngramAccessService,
): Promise<void> {
  const output = (await requireLocationOperation("location_check").run({}, { service })) as {
    result: unknown;
  };
  respondJson(res, 200, { results: output.result });
}

export async function respondLocationSync(
  body: Record<string, unknown>,
  res: ServerResponse,
  respondJson: RespondJson,
  service: EngramAccessService,
): Promise<void> {
  const output = (await requireLocationOperation("location_sync").run(
    { date: body.date ?? null, days: body.days ?? null },
    { service },
  )) as { result: unknown };
  respondJson(res, 200, output.result);
}

export async function respondLocationBackfill(
  body: Record<string, unknown>,
  res: ServerResponse,
  respondJson: RespondJson,
  service: EngramAccessService,
): Promise<void> {
  const output = (await requireLocationOperation("location_backfill").run(
    { from: body.from ?? null, to: body.to ?? null },
    { service },
  )) as { result: unknown };
  respondJson(res, 200, output.result);
}

export async function respondLocationDay(
  date: string | null,
  res: ServerResponse,
  respondJson: RespondJson,
  service: EngramAccessService,
): Promise<void> {
  const output = (await requireLocationOperation("location_day").run(
    { date: date ?? null },
    { service },
  )) as { result: { found: boolean } & Record<string, unknown> };
  respondJson(res, output.result.found ? 200 : 404, output.result);
}
