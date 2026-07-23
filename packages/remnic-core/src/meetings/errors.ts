/**
 * Error thrown by meeting surfaces for caller-correctable problems: invalid
 * dates/ids, unknown commands/flags, or a missing record. Transport layers map
 * this to 400-class responses; anything else is a backend fault (500). Mirrors
 * `WearablesInputError` so the meetings surfaces follow the same house style.
 */

export class MeetingsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingsInputError";
  }
}
