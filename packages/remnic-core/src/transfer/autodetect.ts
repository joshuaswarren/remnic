import path from "node:path";
import { stat } from "node:fs/promises";
import { looksLikeEngramJsonExport } from "./import-json.js";
import { looksLikeEngramMdExport } from "./export-md.js";

export type ImportFormat = "json" | "sqlite" | "md";

export async function detectImportFormat(fromPath: string): Promise<ImportFormat | null> {
  const abs = path.resolve(fromPath);
  let st: { isDirectory(): boolean; isFile(): boolean };
  try {
    st = await stat(abs);
  } catch {
    return null;
  }

  if (st.isFile()) {
    if (abs.endsWith(".sqlite") || abs.endsWith(".db")) return "sqlite";
    return null;
  }

  if (st.isDirectory()) {
    if (await looksLikeEngramJsonExport(abs)) return "json";
    if (await looksLikeEngramMdExport(abs)) return "md";
    return null;
  }

  return null;
}

