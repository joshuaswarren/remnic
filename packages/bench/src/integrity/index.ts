/**
 * Integrity pipeline entry points.
 *
 * See `docs/bench/integrity.md` for the threat model and rotation policy.
 */

export {
  INTEGRITY_CIPHER_ALGORITHM,
  INTEGRITY_HASH_ALGORITHM,
  assertSha256Hex,
  canonicalJsonStringify,
  hashBytes,
  hashCanonicalJson,
  hashString,
  isSha256Hex,
  loadSealKeyFromEnv,
  openSeal,
  safeHexEqual,
  sealPayload,
  type SealedArtifact,
} from "./hash-verification.js";

export {
  computeSealHash,
  isSealedQrelsArtifact,
  loadSealedQrels,
  parseSealedQrels,
  serializeSealedQrels,
  type LoadSealedQrelsOptions,
  type SealedQrelsArtifact,
  type SealedQrelsHandle,
} from "./sealed-qrels.js";

export {
  CANARY_FIXED_RECALL,
  CANARY_SCORE_FLOOR,
  assertCanaryUnderFloor,
  createCanaryAdapter,
  type CanaryAdapterOptions,
  type CanaryFloorCheck,
} from "./canary-adapter.js";

export {
  EMPTY_CONTAMINATION_MANIFEST,
  addContaminationEntry,
  checkDatasetContamination,
  isContaminationEntry,
  isContaminationManifest,
  mergeContaminationManifests,
  type ContaminationCheckResult,
  type ContaminationEntry,
  type ContaminationManifest,
} from "./contamination.js";

export {
  createSeededRng,
  rotateDistractors,
  selectFixtureVariant,
  shuffleTasks,
  type FixtureVariant,
  type MultipleChoiceQuestion,
  type RotatedChoices,
  type SeededRng,
} from "./randomize.js";

export type {
  BenchmarkIntegrityMeta,
  BenchmarkSplitType,
} from "./types.js";

export {
  BENCHMARK_INTEGRITY_META_SCHEMA,
  BENCHMARK_SPLIT_TYPES,
  assertIntegrityMetaPresent,
  integrityMetaIsComplete,
  INTEGRITY_META_FIELDS,
} from "./types.js";
