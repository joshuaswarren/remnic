
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
