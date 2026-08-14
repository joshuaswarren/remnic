import { isIP } from "node:net";

import { z } from "zod";

import { coerceBool } from "../connectors/coerce.js";
import type { SupportPassportConfig } from "../types.js";

export const DEFAULT_SUPPORT_PASSPORT_CONFIG: SupportPassportConfig = {
  enabled: false,
  trustedProxyAddresses: [],
};

export function parseSupportPassportConfig(raw: unknown): SupportPassportConfig {
  if (raw === undefined) {
    return {
      ...DEFAULT_SUPPORT_PASSPORT_CONFIG,
      trustedProxyAddresses: [...DEFAULT_SUPPORT_PASSPORT_CONFIG.trustedProxyAddresses],
    };
  }
  const schema = z
    .object({
      enabled: z
        .preprocess((value) => {
          if (value === undefined) return false;
          return coerceBool(value) ?? value;
        }, z.boolean())
        .default(false),
      trustedProxyAddresses: z
        .array(z.string().trim().refine((value) => isIP(value) !== 0, "must contain IP addresses"))
        .max(32)
        .default([]),
    })
    .strict();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "supportPassport must contain only enabled and up to 32 trustedProxyAddresses IP addresses"
    );
  }
  return parsed.data;
}
