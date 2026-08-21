/**
 * Meetings HTTP route glue (issue #1900) — the route bodies extracted from
 * access-http.ts so the surface file stays under its structural ceiling. The
 * thin inline hooks in access-http.ts keep the pathname/method match + the
 * `enforceTokenOp("meetings_*")` boundary-dispatch marker (required by the
 * surface-catalog fitness test) and delegate the body here.
 *
 * `MeetingsInputError` (invalid dates/ids) maps to a 400; everything else
 * rethrows so backend faults keep flowing to the global 500 handler. Behaviour,
 * validation, and `meetings.enabled` gating live in MeetingsService — these
 * functions only translate transport shape.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { EngramAccessInputError, type WearablesMeetingsScope } from "../access-service.js";
import { MeetingsInputError } from "./errors.js";

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>;

/** Minimal meetings surface the HTTP glue drives (satisfied by EngramAccessService). */
export interface MeetingsHttpService {
  meetingsList(date?: string, scope?: WearablesMeetingsScope): Promise<unknown>;
  meetingsGet(id: string, scope?: WearablesMeetingsScope): Promise<unknown>;
  meetingsBuild(date: string, scope?: WearablesMeetingsScope): Promise<unknown>;
}

function respondMeetingsError(respondJson: RespondJson, res: ServerResponse, err: unknown): boolean {
  if (err instanceof MeetingsInputError) {
    respondJson(res, 400, { error: "invalid_request", code: "invalid_request", message: err.message });
    return true;
  }
  return false;
}

/**
 * Decode a meeting `:id` URL path segment, mapping malformed percent-encoded
 * input (e.g. `%E0%A4%A`) to a 400 `MeetingsInputError` rather than letting the
 * `URIError` bubble up to the global 500 handler — mirrors the access-http
 * `decode*Segment` helpers.
 */
function decodeMeetingIdSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new MeetingsInputError("meeting id path segment is not valid percent-encoded input");
  }
}

/**
 * Per-principal write-quota hooks the build route shares with every other
 * mutating REST route: `enforceQuota` throws a 429 when the principal is over
 * budget; `recordHit` accounts the successful write. Injected from access-http
 * so the quota state stays owned by the server (issue #1937).
 */
export interface MeetingsWriteQuotaHooks {
  enforceQuota(): void;
  recordHit(): void;
}

export async function respondMeetingsList(
  res: ServerResponse,
  respondJson: RespondJson,
  service: MeetingsHttpService,
  date: string | undefined,
  scope?: WearablesMeetingsScope,
): Promise<void> {
  try {
    respondJson(res, 200, await service.meetingsList(date, scope));
  } catch (err) {
    if (respondMeetingsError(respondJson, res, err)) return;
    throw err;
  }
}

export async function respondMeetingsGet(
  res: ServerResponse,
  respondJson: RespondJson,
  service: MeetingsHttpService,
  rawId: string,
  scope?: WearablesMeetingsScope,
): Promise<void> {
  try {
    respondJson(res, 200, await service.meetingsGet(decodeMeetingIdSegment(rawId), scope));
  } catch (err) {
    if (respondMeetingsError(respondJson, res, err)) return;
    throw err;
  }
}

export async function respondMeetingsBuild(
  req: IncomingMessage,
  res: ServerResponse,
  respondJson: RespondJson,
  readJsonBody: ReadJsonBody,
  service: MeetingsHttpService,
  quota: MeetingsWriteQuotaHooks,
  scopeFor?: (bodyNamespace?: string, bodySessionKey?: string) => WearablesMeetingsScope,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const raw = body.date;
  if (raw !== undefined && raw !== null && raw !== "" && typeof raw !== "string") {
    throw new EngramAccessInputError(`date must be a string (got ${JSON.stringify(raw)})`);
  }
  const date = raw === undefined || raw === null || raw === "" ? undefined : raw;
  if (date === undefined) {
    throw new EngramAccessInputError("date is required (YYYY-MM-DD)");
  }
  // Build persists/deletes records, writes memories, and reindexes — a mutating
  // route, so it carries the same per-principal write quota as every other
  // write (capsule import/export, admin promote). Enforce before the write,
  // account the hit after it succeeds (issue #1937).
  quota.enforceQuota();
  const scope = scopeFor?.(
    typeof body.namespace === "string" ? body.namespace : undefined,
    typeof body.sessionKey === "string" ? body.sessionKey : undefined,
  );
  try {
    const result = await service.meetingsBuild(date, scope);
    quota.recordHit();
    respondJson(res, 200, result);
  } catch (err) {
    if (respondMeetingsError(respondJson, res, err)) return;
    throw err;
  }
}
