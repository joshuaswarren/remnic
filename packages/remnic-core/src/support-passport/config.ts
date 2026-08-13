import { z } from "zod";

import { coerceBool } from "../connectors/coerce.js";
import type { SupportPassportConfig } from "../types.js";

export const DEFAULT_SUPPORT_PASSPORT_CONFIG: SupportPassportConfig = {
  enabled: false,
};

export function parseSupportPassportConfig(raw: unknown): SupportPassportConfig {
  if (raw === undefined) return { ...DEFAULT_SUPPORT_PASSPORT_CONFIG };
  const schema = z
    .object({
      enabled: z
        .preprocess((value) => {
          if (value === undefined) return false;
          return coerceBool(value) ?? value;
        }, z.boolean())
        .default(false),
    })
    .strict();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("supportPassport must be an object with only a boolean-like enabled value");
  }
  return parsed.data;
}
