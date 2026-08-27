import { createHash } from "node:crypto";
import { INJECTION_PAYLOAD_TEMPLATES } from "../injection-templates/index.js";
import {
  generateSuiteVariants,
  injectionSuiteVariantHash,
  validateInjectionSuiteVariant,
} from "./generator.js";
import type { InjectionSuiteStage } from "./types.js";
import { INJECTION_SUITE_FAMILIES, INJECTION_SUITE_VERSION } from "./types.js";

export interface InjectionSuiteCorpusManifest {
  schemaVersion: 1;
  suiteVersion: string;
  stage: InjectionSuiteStage;
  seed: number;
  variantsPerFamily: number;
  scenarioCount: number;
  templateIds: string[];
  scenarios: Array<{
    scenarioId: string;
    family: string;
    templateId: string;
    canaryType: string;
    sha256: string;
  }>;
  payloadRuleAudit: {
    templates: number;
    pass: number;
    date: "2026-08-27";
  };
  manifestSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildInjectionSuiteCorpusManifest(
  stage: InjectionSuiteStage,
  variantsPerFamily: number,
  seed = 71,
): InjectionSuiteCorpusManifest {
  const variants = generateSuiteVariants(variantsPerFamily, seed, stage);
  const failures = variants.flatMap((variant) =>
    validateInjectionSuiteVariant(variant).map((error) => `${variant.variantId}: ${error}`),
  );
  if (failures.length > 0) {
    throw new Error(`H5 corpus safety validation failed:\n${failures.join("\n")}`);
  }
  for (const family of INJECTION_SUITE_FAMILIES) {
    const templateCount = new Set(
      INJECTION_PAYLOAD_TEMPLATES.filter((template) => template.family === family)
        .map((template) => template.templateId),
    ).size;
    if (templateCount < 10) throw new Error(`H5 family ${family} has only ${templateCount} templates`);
  }

  const withoutHash = {
    schemaVersion: 1 as const,
    suiteVersion: INJECTION_SUITE_VERSION,
    stage,
    seed,
    variantsPerFamily,
    scenarioCount: variants.length,
    templateIds: INJECTION_PAYLOAD_TEMPLATES.map((template) => template.templateId).sort(),
    scenarios: variants.map((variant) => ({
      scenarioId: variant.variantId,
      family: variant.family,
      templateId: variant.templateId,
      canaryType: variant.canarySpec.type,
      sha256: injectionSuiteVariantHash(variant),
    })),
    payloadRuleAudit: {
      templates: INJECTION_PAYLOAD_TEMPLATES.length,
      pass: INJECTION_PAYLOAD_TEMPLATES.length,
      date: "2026-08-27" as const,
    },
  };
  return {
    ...withoutHash,
    manifestSha256: sha256(JSON.stringify(withoutHash)),
  };
}
