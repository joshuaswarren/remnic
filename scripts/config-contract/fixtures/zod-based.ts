/**
 * Fixture: zod-style parser. The extractor walks `z.object({ … })` literals
 * STATICALLY (no runtime import), including nesting.
 */
declare const z: {
  object(shape: Record<string, unknown>): { parse(v: unknown): unknown; optional(): unknown };
  string(): { optional(): unknown };
  number(): unknown;
  boolean(): unknown;
};

export function parseFixtureZodConfig(value: unknown): unknown {
  const schema = z.object({
    endpoint: z.string(),
    retries: z.number(),
    nested: z.object({
      deadlineMs: z.number(),
      verbose: z.boolean(),
    }),
  });
  return schema.parse(value ?? {});
}
