/**
 * Wearables HTTP glue (issue #2047) — the wearables-input→400 error mapper
 * extracted from access-http.ts so that size-grandfathered file keeps only
 * thin route branches (same pattern as meetings/http-glue.ts). Returns false
 * for non-wearables faults so backend errors keep flowing to the global 500
 * handler.
 */

import type { ServerResponse } from "node:http";
import { WearablesInputError } from "./errors.js";

type RespondJson = (res: ServerResponse, status: number, payload: unknown) => void;

export function respondWearablesErrorGlue(
  respondJson: RespondJson,
  res: ServerResponse,
  err: unknown,
): boolean {
  if (err instanceof WearablesInputError) {
    respondJson(res, 400, {
      error: "invalid_request",
      code: "invalid_request",
      message: err.message,
    });
    return true;
  }
  return false;
}
