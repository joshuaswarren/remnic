/**
 * Error thrown by wearables surfaces for caller-correctable problems:
 * invalid parameters, unknown sources, disabled subsystem, missing
 * connector packages. Transport layers map this to 400-class responses;
 * anything else is a backend fault and bubbles to the 500 handler.
 */
export class WearablesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WearablesInputError";
  }
}

const MAX_DETAIL_LENGTH = 200;

/**
 * Render a caught error for operator-facing sync warnings. Warnings
 * travel back through HTTP/MCP responses, so raw Node error text is
 * scrubbed: filesystem paths are reduced to their basename and the
 * detail is length-capped. Non-Error throws yield a generic marker.
 */
export function describeErrorForOperator(err: unknown): string {
  if (!(err instanceof Error)) return "unexpected non-Error failure";
  // Collapse absolute-path-looking runs (two or more /segments) to
  // ".../<basename>" so memory-dir layouts never leak into responses.
  const scrubbed = err.message.replace(
    /(?:[A-Za-z]:)?(?:[\\/][\w.~-]+){2,}/g,
    (match) => {
      const segments = match.split(/[\\/]/).filter((part) => part.length > 0);
      return `…/${segments[segments.length - 1] ?? ""}`;
    },
  );
  return scrubbed.length > MAX_DETAIL_LENGTH
    ? `${scrubbed.slice(0, MAX_DETAIL_LENGTH)}…`
    : scrubbed;
}
