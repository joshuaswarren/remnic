import fs from "node:fs";
import path from "node:path";

import { lintOkfDir } from "./lint.js";
import { okfTypeForCategory } from "./type-mapping.js";

export interface OkfSweepResult {
  scanned: number;
  written: number;
}

function insertType(raw: string, type: string): string | null {
  if (!raw.startsWith("---\n")) return null;
  const close = raw.indexOf("\n---", 4);
  if (close === -1) return null;
  const block = raw.slice(4, close);
  if (/^type:\s*\S/m.test(block)) return null;
  const categoryMatch = /^category:\s*(.*)$/m.exec(block);
  const category = categoryMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "fact";
  const resolved = type || okfTypeForCategory(category);
  return `${raw.slice(0, close)}\ntype: ${resolved}${raw.slice(close)}`;
}

export function runOkfConformanceSweep(
  memoryDir: string,
  options: { sweepEnabled: boolean; conformanceEnabled: boolean },
): OkfSweepResult {
  if (!options.sweepEnabled || !options.conformanceEnabled) {
    return { scanned: 0, written: 0 };
  }
  const lint = lintOkfDir(memoryDir);
  let written = 0;
  for (const finding of lint.findings) {
    if (finding.code !== "missing_type" && finding.code !== "empty_type") continue;
    const file = path.join(memoryDir, finding.file);
    const raw = fs.readFileSync(file, "utf8");
    const next = insertType(raw, "");
    if (next === null || next === raw) continue;
    fs.writeFileSync(file, next);
    written += 1;
  }
  return { scanned: lint.scanned, written };
}
