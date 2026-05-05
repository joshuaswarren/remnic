export interface SupermemoryRecord {
  id?: string;
  content?: string;
  summary?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  containerTags?: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParsedSupermemoryExport {
  memories: SupermemoryRecord[];
  importedFromPath?: string;
}

export function parseSupermemoryExport(input: unknown, filePath?: string): ParsedSupermemoryExport {
  if (input == null) {
    throw new Error("Supermemory import requires JSON input. Pass --file <supermemory-export.json>.");
  }

  const raw = typeof input === "string" ? JSON.parse(input) : input;
  const memories: SupermemoryRecord[] = [];

  if (Array.isArray(raw)) {
    append(memories, raw);
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["memories", "results", "data"] as const) {
      if (Array.isArray(obj[key])) {
        append(memories, obj[key] as unknown[]);
        break;
      }
    }
  }

  return { memories, ...(filePath ? { importedFromPath: filePath } : {}) };
}

function append(dest: SupermemoryRecord[], src: unknown[]): void {
  for (const item of src) {
    if (item && typeof item === "object") dest.push(item as SupermemoryRecord);
  }
}
