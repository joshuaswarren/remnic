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
