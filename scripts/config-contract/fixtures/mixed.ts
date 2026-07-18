/**
 * Fixture: mixed parser — a zod schema for one half, hand-rolled reads for
 * the rest of the same input.
 */
declare const z: {
  object(shape: Record<string, unknown>): { parse(v: unknown): unknown };
  string(): unknown;
};
type Rec = Record<string, unknown>;

export function parseFixtureMixedConfig(value: unknown): Rec {
  const raw = value && typeof value === "object" ? (value as Rec) : {};
  const validated = z.object({ mode: z.string() }).parse(raw);
  const extra = typeof raw.extraKnob === "string" ? raw.extraKnob : "default";
  return { validated, extra };
}
