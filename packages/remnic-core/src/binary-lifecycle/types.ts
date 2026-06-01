/**
 * Binary file lifecycle management types.
 *
 * Defines the configuration, manifest, and record structures for the
 * three-stage binary lifecycle pipeline: mirror, redirect, clean.
 */

export interface BinaryLifecycleConfig {
  /** Master toggle. Default: false. */
  enabled: boolean;
  /** Days after mirror before local copy is eligible for cleanup. Default: 7. */
  gracePeriodDays: number;
  /** Files larger than this are skipped during scan. Default: 50 MB. */
  maxBinarySizeBytes: number;
  /** Glob patterns for binary file types to manage. */
  scanPatterns: string[];
  /** Backend configuration for binary storage. */
  backend: BinaryStorageBackendConfig;
}

export interface BinaryStorageBackendConfig {
  /** Backend type. "filesystem" copies to a local directory. "none" is a no-op (dry-run/testing). */
  type: "filesystem" | "s3" | "none";
  /** Destination directory for the filesystem backend. */
  basePath?: string;
  /** S3 bucket name (future). */
  s3Bucket?: string;
  /** S3 region (future). */
  s3Region?: string;
  /** S3 key prefix (future). */
  s3Prefix?: string;
}

export type BinaryAssetStatus =
  | "pending"
  | "mirrored"
  | "redirected"
  | "cleaned"
  | "error";

export interface BinaryAssetRecord {
  /** Relative path from memoryDir to the original file. */
  originalPath: string;
  /** Path (or URL) in the backend storage. */
  mirroredPath: string;
  /** Optional user-resolvable target to write into markdown links. */
  redirectPath?: string;
  /** SHA-256 hex digest of file content. */
  contentHash: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** MIME type (e.g. "image/png"). */
  mimeType: string;
  /** ISO 8601 timestamp when the file was mirrored. */
  mirroredAt: string;
  /** ISO 8601 timestamp when markdown references were rewritten. */
  redirectedAt?: string;
  /** ISO 8601 timestamp when the local copy was deleted. */
  cleanedAt?: string;
  /** Current lifecycle status. */
  status: BinaryAssetStatus;
}

export interface BinaryLifecycleManifest {
  version: 1;
  assets: BinaryAssetRecord[];
  lastScanAt?: string;
}

export interface PipelineResult {
  scanned: number;
  mirrored: number;
  redirected: number;
  cleaned: number;
  errors: string[];
  dryRun: boolean;
}

export const DEFAULT_SCAN_PATTERNS = [
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.pdf",
  "*.mp3",
  "*.mp4",
  "*.wav",
];

export const DEFAULT_MAX_BINARY_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_GRACE_PERIOD_DAYS = 7;
