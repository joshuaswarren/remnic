/**
 * `@remnic/coding-graph` — SQLite knowledge-graph store for the Remnic
 * coding-memory track (issue #1552 PR1).
 *
 * PR1 ships the schema and the write pipeline only. Traversal, search,
 * dead-code, and the openCypher subset land in PR2/PR3.
 */

export {
  CODING_GRAPH_SCHEMA_VERSION,
  EDGE_PROVENANCE_VALUES,
  applyCodingGraphSchema,
  readSchemaVersion,
  isEdgeProvenance,
  type EdgeProvenance,
} from "./graph-schema.js";

export {
  GraphStore,
  nodeIdFor,
  type ByteSpan,
  type ExportIR,
  type FileIR,
  type GraphStoreFailure,
  type GraphStoreFailureCode,
  type GraphStoreOptions,
  type ImportIR,
  type NodeIdInput,
  type SymbolIR,
  type SymbolKind,
  type UpsertBatchResult,
  type UpsertResult,
  type UpsertSuccess,
} from "./graph-store.js";
