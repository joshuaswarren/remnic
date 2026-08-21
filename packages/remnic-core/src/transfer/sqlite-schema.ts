export const SQLITE_SCHEMA_VERSION = 1 as const;

export const SQLITE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path_rel TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content TEXT NOT NULL
);
`;

