export interface SupermemoryRecord {
  id?: string;
  memory?: string;
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

  const raw = coerceJson(input);
  const memories: SupermemoryRecord[] = [];

  if (Array.isArray(raw)) {
    append(memories, raw);
    return { memories, ...(filePath ? { importedFromPath: filePath } : {}) };
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    let sawKnownKey = false;
    for (const key of ["memoryEntries", "memories", "results", "data"] as const) {
      if (key in obj) {
        sawKnownKey = true;
        if (!Array.isArray(obj[key])) {
          throw new Error(`Supermemory export key '${key}' must be an array.`);
        }
        append(memories, obj[key] as unknown[]);
        return { memories, ...(filePath ? { importedFromPath: filePath } : {}) };
      }
    }
    if (!sawKnownKey) {
      throw new Error(
        "Supermemory export object has no recognized memory key. Expected one of 'memoryEntries', 'memories', 'results', or 'data'.",
      );
    }
  }

  throw new Error(`Supermemory export must be a JSON array or object; received ${describeType(raw)}.`);
}

function append(dest: SupermemoryRecord[], src: unknown[]): void {
  for (const item of src) {
    if (item && typeof item === "object") dest.push(item as SupermemoryRecord);
  }
}

function coerceJson(input: unknown): unknown {
  if (typeof input !== "string") return input;

  try {
    return JSON.parse(input);
  } catch (err) {
    throw new Error(
      `Supermemory export is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}
