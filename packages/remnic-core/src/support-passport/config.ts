import { z } from "zod";

import type { SupportPassportConfig } from "../types.js";

export const DEFAULT_SUPPORT_PASSPORT_CONFIG: SupportPassportConfig = {
  enabled: false,
};

export function parseSupportPassportConfig(raw: unknown): SupportPassportConfig {
  if (raw === undefined) return { ...DEFAULT_SUPPORT_PASSPORT_CONFIG };
  const schema = z
    .object({
      enabled: z.boolean().default(false),
    })
    .strict();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("supportPassport must be an object with only an enabled boolean");
  }
  return parsed.data;
}
