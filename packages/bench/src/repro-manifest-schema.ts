import { z } from "zod";
import type { CodexCreditReceipt } from "./providers/codex-credit-budget.js";
import type { BenchmarkMode } from "./types.js";

export const BENCHMARK_REPRO_MANIFEST_SCHEMA_VERSION = 2;

export interface BenchmarkReproManifestSupplementalArtifact {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface BenchmarkReproManifestFile {
  path: string;
  kind: "file" | "symlink";
  sizeBytes: number;
  sha256: string;
  target?: string;
}

export interface BenchmarkReproManifestDataset {
  benchmark: string;
  status: "not-provided" | "missing" | "hashed";
  path?: string;
  realpath?: string;
  fileCount: number;
  totalBytes: number;
  sha256?: string;
  files: BenchmarkReproManifestFile[];
}

export interface BenchmarkReproManifestResult {
  path: string;
  sha256: string;
  sizeBytes: number;
  resultId: string;
  benchmark: string;
  mode: BenchmarkMode;
  gitSha: string;
  runCount: number;
  seeds: number[];
  taskCount: number;
  configHash: string;
  judge: {
    provider: string;
    model: string;
    rubricVersion: string | null;
  } | null;
}

export interface BenchmarkReproManifest {
  schemaVersion: number;
  generatedAt: string;
  run: {
    id: string;
    mode?: BenchmarkMode;
    selectedBenchmarks: string[];
    runtimeProfiles: string[];
    selectedWorkItems: Array<{
      benchmark: string;
      runtimeProfile: string;
    }>;
    limit?: number;
    seed?: number;
  };
  git: {
    commit: string;
    shortCommit: string;
    dirty: boolean;
    dirtyEntryCount: number;
  };
  command: {
    cwd: string;
    argv: string[];
    envKeys: string[];
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    hostname?: string;
    packageManager?: string;
  };
  qmd?: {
    configDir?: string;
    cacheDir?: string;
    collections: string[];
  };
  configFiles: Array<{
    label: string;
    path: string;
    sha256?: string;
    sizeBytes?: number;
    missing?: boolean;
    redacted?: boolean;
  }>;
  datasets: BenchmarkReproManifestDataset[];
  results: BenchmarkReproManifestResult[];
  supplementalArtifacts?: BenchmarkReproManifestSupplementalArtifact[];
  codexCredit?: CodexCreditReceipt;
  artifactHash: string;
}

const ManifestStringSchema = z.string().min(1).max(16_384);
const ManifestShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestStringListSchema = z.array(ManifestStringSchema).max(100_000);
const ManifestFileSchema = z.object({
  path: ManifestStringSchema,
  kind: z.enum(["file", "symlink"]),
  sizeBytes: z.number().int().nonnegative(),
  sha256: ManifestShaSchema,
  target: ManifestStringSchema.optional(),
}).strict();
const ManifestDatasetSchema = z.object({
  benchmark: ManifestStringSchema,
  status: z.enum(["not-provided", "missing", "hashed"]),
  path: ManifestStringSchema.optional(),
  realpath: ManifestStringSchema.optional(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  sha256: ManifestShaSchema.optional(),
  files: z.array(ManifestFileSchema).max(100_000),
}).strict();
const ManifestResultSchema = z.object({
  path: ManifestStringSchema,
  sha256: ManifestShaSchema,
  sizeBytes: z.number().int().nonnegative(),
  resultId: ManifestStringSchema,
  benchmark: ManifestStringSchema,
  mode: z.enum(["full", "quick"]),
  gitSha: ManifestStringSchema,
  runCount: z.number().int().nonnegative(),
  seeds: z.array(z.number().int()).max(100_000),
  taskCount: z.number().int().nonnegative(),
  configHash: ManifestStringSchema,
  judge: z.object({
    provider: ManifestStringSchema,
    model: ManifestStringSchema,
    rubricVersion: ManifestStringSchema.nullable(),
  }).strict().nullable(),
}).strict();
const ManifestSupplementalArtifactSchema = z.object({
  path: ManifestStringSchema,
  sha256: ManifestShaSchema,
  sizeBytes: z.number().int().nonnegative(),
}).strict();

export const BenchmarkReproManifestSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_REPRO_MANIFEST_SCHEMA_VERSION),
  generatedAt: ManifestStringSchema,
  run: z.object({
    id: ManifestStringSchema,
    mode: z.enum(["full", "quick"]).optional(),
    selectedBenchmarks: ManifestStringListSchema,
    runtimeProfiles: ManifestStringListSchema,
    selectedWorkItems: z.array(z.object({
      benchmark: ManifestStringSchema,
      runtimeProfile: ManifestStringSchema,
    }).strict()).max(100_000),
    limit: z.number().int().nonnegative().optional(),
    seed: z.number().int().optional(),
  }).strict(),
  git: z.object({
    commit: ManifestStringSchema,
    shortCommit: ManifestStringSchema,
    dirty: z.boolean(),
    dirtyEntryCount: z.number().int().nonnegative(),
  }).strict(),
  command: z.object({
    cwd: z.string().max(16_384),
    argv: ManifestStringListSchema,
    envKeys: ManifestStringListSchema,
  }).strict(),
  environment: z.object({
    platform: ManifestStringSchema,
    arch: ManifestStringSchema,
    nodeVersion: ManifestStringSchema,
    hostname: ManifestStringSchema.optional(),
    packageManager: ManifestStringSchema.optional(),
  }).strict(),
  qmd: z.object({
    configDir: ManifestStringSchema.optional(),
    cacheDir: ManifestStringSchema.optional(),
    collections: ManifestStringListSchema,
  }).strict().optional(),
  configFiles: z.array(z.object({
    label: ManifestStringSchema,
    path: ManifestStringSchema,
    sha256: ManifestShaSchema.optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    missing: z.boolean().optional(),
    redacted: z.boolean().optional(),
  }).strict()).max(100_000),
  datasets: z.array(ManifestDatasetSchema).max(100_000),
  results: z.array(ManifestResultSchema).max(100_000),
  supplementalArtifacts: z.array(ManifestSupplementalArtifactSchema).max(100_000).optional(),
  codexCredit: z.object({}).passthrough().optional(),
  artifactHash: ManifestShaSchema,
}).strict();

export function parseBenchmarkReproManifest(input: unknown): BenchmarkReproManifest {
  return BenchmarkReproManifestSchema.parse(input) as BenchmarkReproManifest;
}
