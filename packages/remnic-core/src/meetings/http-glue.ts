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
import { EngramAccessInputError } from "../access-service.js";
import { MeetingsInputError } from "./errors.js";

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>;

/** Minimal meetings surface the HTTP glue drives (satisfied by EngramAccessService). */
export interface MeetingsHttpService {
  meetingsList(date?: string): Promise<unknown>;
  meetingsGet(id: string): Promise<unknown>;
  meetingsBuild(date: string): Promise<unknown>;
}

function respondMeetingsError(respondJson: RespondJson, res: ServerResponse, err: unknown): boolean {
  if (err instanceof MeetingsInputError) {
    respondJson(res, 400, { error: "invalid_request", code: "invalid_request", message: err.message });
    return true;
  }
  return false;
}

export async function respondMeetingsList(
  res: ServerResponse,
  respondJson: RespondJson,
  service: MeetingsHttpService,
  date: string | undefined,
): Promise<void> {
  try {
    respondJson(res, 200, await service.meetingsList(date));
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
): Promise<void> {
  try {
    respondJson(res, 200, await service.meetingsGet(decodeURIComponent(rawId)));
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
  try {
    respondJson(res, 200, await service.meetingsBuild(date));
  } catch (err) {
    if (respondMeetingsError(respondJson, res, err)) return;
    throw err;
  }
}
