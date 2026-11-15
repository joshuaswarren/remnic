/** Legacy shape admission stays permissive; receipt emptiness is validated separately. */
import { z } from "zod";
const providerPayload = z.object({}).passthrough();
export function looksLikeExtractionResultPayload(parsed: z.input<ReturnType<typeof z.unknown>>): boolean {
  const value = providerPayload.safeParse(parsed);
  return (
    value.success &&
    ["facts", "entities", "profileUpdates", "questions", "relationships", "identityReflection"].some(
      (key) => key in value.data
    )
  );
}
