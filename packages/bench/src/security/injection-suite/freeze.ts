import { createHash } from "node:crypto";
import { captureBenchmarkExecutionProvenance } from "../../reporter.js";
import { buildInjectionSuiteCorpusManifest } from "./corpus.js";
import {
  H5_DECISION_RULE_BYTES,
  H5_DECISION_RULE_SHA256,
} from "./decision-rule.js";
import {
  generateFamilyVariants,
  injectionSuiteVariantHash,
  parseOnlineVariantId,
} from "./generator.js";
import { buildInjectionSuiteRowKey } from "./store.js";
import type { InjectionSuiteCliInput, InjectionSuiteRowIdentity } from "./types.js";

export interface InjectionSuiteModelProfile {
  schemaVersion: 2;
  modelProfileId: string;
  modelProfileHash: string;
  executor: string;
  model: string;
  servedModelDigest: string;
  baseUrl: string;
  requestTimeoutMs: number;
  contextTokens: number;
  temperature: 0;
  maxOutputTokens: 256;
  disableThinking: true;
  plantMode: "sealed-candidate-v1";
  extractionModel: string;
  behaviorModel: string;
}

export interface InjectionSuiteExpectedDesign {
  schemaVersion: 1;
  stage: string;
  modelProfileHash: string;
  rows: Array<{
    order: number;
    rowKey: string;
    identity: InjectionSuiteRowIdentity;
    templateId: string;
    scenarioSha256: string;
  }>;
}

export interface PreparedInjectionSuiteFreeze {
  profile: InjectionSuiteModelProfile;
  profileBytes: string;
  corpusBytes: string;
  corpusManifestHash: string;
  design: InjectionSuiteExpectedDesign;
  designBytes: string;
  expectedDesignHash: string;
  decisionRuleBytes: string;
  decisionRuleHash: string;
  gitSha: string;
  cleanTree: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function stableInjectionSuiteJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scenarioForIdentity(identity: InjectionSuiteRowIdentity) {
  const match = /-(\d+)$/.exec(identity.variantId);
  const index = match ? Number(match[1]) : Number.NaN;
  const online = parseOnlineVariantId(identity.variantId);
  if (identity.stage === "adaptive-online-r1") {
    if (!online || online.family !== identity.family) {
      throw new Error(`invalid H5 variant id ${identity.variantId}`);
    }
    return generateFamilyVariants(online.family, online.index, identity.seed, "base")[
      online.index - 1
    ];
  }
  const variant = generateFamilyVariants(
    identity.family,
    index,
    identity.seed,
    identity.stage,
  )[index - 1];
  if (!variant || variant.variantId !== identity.variantId) {
    throw new Error(`cannot regenerate H5 variant ${identity.variantId}`);
  }
  return variant;
}

function buildModelProfile(
  input: InjectionSuiteCliInput,
): InjectionSuiteModelProfile {
  const executor = input.executor ?? "local";
  const model = input.model ?? "local-dry";
  const withoutHash = {
    schemaVersion: 2 as const,
    modelProfileId: input.modelProfileId,
    executor,
    model,
    servedModelDigest: input.modelDigest?.trim() || "unverified",
    baseUrl: input.baseUrl ?? "",
    requestTimeoutMs: input.requestTimeoutMs ?? 300_000,
    contextTokens: input.modelContextTokens ?? 0,
    temperature: 0 as const,
    maxOutputTokens: 256 as const,
    disableThinking: true as const,
    plantMode: "sealed-candidate-v1" as const,
    extractionModel: "deterministic-sealed-candidate-v1",
    behaviorModel: model,
  };
  return {
    ...withoutHash,
    modelProfileHash: sha256(stableInjectionSuiteJson(withoutHash)),
  };
}

function enforceRunGate(
  input: InjectionSuiteCliInput,
  cleanTree: boolean,
): void {
  const runKind = input.runKind ?? "dev";
  const stage = input.stage ?? "base";
  if (runKind === "pilot" && input.variantsPerFamily < 25) {
    throw new Error("H5 pilot requires at least 25 variants per family");
  }
  if (runKind === "dev") return;
  if (!input.modelDigest?.trim())
    throw new Error(`H5 ${runKind} requires --model-digest`);
  if (
    !Number.isInteger(input.modelContextTokens) ||
    (input.modelContextTokens ?? 0) < 8_192
  ) {
    throw new Error(`H5 ${runKind} requires --model-context-tokens >= 8192`);
  }
  if (!cleanTree) throw new Error(`H5 ${runKind} requires a clean git tree`);
  if (runKind !== "main") return;
  if (input.seeds !== 1) {
    throw new Error(
      "H5 main injection runs use one frozen corpus seed; utility owns five paired seeds",
    );
  }
  const minimum = stage === "benign" || stage === "benign-use" ? 10 : 100;
  if (input.variantsPerFamily < minimum) {
    throw new Error(
      `H5 main ${stage} run requires at least ${minimum} variants per family`,
    );
  }
  if (input.family !== undefined) throw new Error("H5 main forbids --family");
  if (input.limit !== undefined) throw new Error("H5 main forbids --limit");
}

export function prepareInjectionSuiteFreeze(
  input: InjectionSuiteCliInput,
  rows: readonly InjectionSuiteRowIdentity[],
): PreparedInjectionSuiteFreeze {
  const provenance = captureBenchmarkExecutionProvenance();
  enforceRunGate(input, !provenance.gitDirty);
  const profile = buildModelProfile(input);
  const stage = input.stage ?? "base";
  const corpus = buildInjectionSuiteCorpusManifest(
    stage,
    input.variantsPerFamily,
    input.seedBase ?? 71,
  );
  const design: InjectionSuiteExpectedDesign = {
    schemaVersion: 1,
    stage,
    modelProfileHash: profile.modelProfileHash,
    rows: rows.map((identity, order) => {
      const variant = scenarioForIdentity(identity);
      return {
        order,
        rowKey: buildInjectionSuiteRowKey(identity),
        identity,
        templateId: variant.templateId,
        scenarioSha256: injectionSuiteVariantHash(variant),
      };
    }),
  };
  const profileBytes = `${JSON.stringify(profile, null, 2)}\n`;
  const corpusBytes = `${JSON.stringify(corpus, null, 2)}\n`;
  const designBytes = `${JSON.stringify(design, null, 2)}\n`;
  return {
    profile,
    profileBytes,
    corpusBytes,
    corpusManifestHash: corpus.manifestSha256,
    design,
    designBytes,
    expectedDesignHash: sha256(stableInjectionSuiteJson(design)),
    decisionRuleBytes: H5_DECISION_RULE_BYTES,
    decisionRuleHash: H5_DECISION_RULE_SHA256,
    gitSha: provenance.gitSha,
    cleanTree: !provenance.gitDirty,
  };
}
