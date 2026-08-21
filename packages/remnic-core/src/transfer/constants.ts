export const EXPORT_FORMAT = "openclaw-engram-export" as const;
export const EXPORT_SCHEMA_VERSION = 1 as const;

/**
 * Schema version for capsule-aware (V2) export manifests. See
 * {@link ../types.ts} `ExportManifestV2Schema` for the wire format.
 *
 * V1 manifests remain the default for non-capsule exports
 * (`exportJsonBundle` / `exportMarkdownBundle`). V2 is emitted by the
 * capsule export pipeline only.
 */
export const CAPSULE_SCHEMA_VERSION = 2 as const;

