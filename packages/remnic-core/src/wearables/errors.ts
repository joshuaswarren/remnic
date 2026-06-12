/**
 * Error thrown by wearables surfaces for caller-correctable problems:
 * invalid parameters, unknown sources, disabled subsystem, missing
 * connector packages. Transport layers map this to 400-class responses;
 * anything else is a backend fault and bubbles to the 500 handler.
 */

import { displayErrorDetail } from "../runtime/better-sqlite.js";

export class WearablesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WearablesInputError";
  }
}

/**
 * Render a caught error for operator-facing sync warnings and auth
 * details. Warnings travel back through CLI/MCP/HTTP responses, so
 * foreign error text never passes through — delegation to the
 * project-standard `displayErrorDetail` exposes only the error class
 * and Node errno code. Wearables' own input errors (authored messages,
 * no foreign text) pass through verbatim.
 */
export function describeErrorForOperator(err: unknown): string {
  if (err instanceof WearablesInputError) return err.message;
  const detail = displayErrorDetail(err);
  return detail.length > 0 ? detail : "unexpected non-Error failure";
}
