import fs from "node:fs";
import path from "node:path";

import { lintOkfDir } from "./lint.js";
import { okfTypeForCategory } from "./type-mapping.js";

export interface OkfSweepResult {
  scanned: number;
  written: number;
}

function insertType(raw: string, type: string): string | null {
  const crlf = raw.startsWith("---\r\n");
  if (!crlf && !raw.startsWith("---\n")) return null;
  const lines = raw.split("\n");
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "---" || line === "---\r" || line === "...") {
      close = index;
      break;
    }
  }
  if (close === -1) return null;
  const block = lines.slice(1, close);
  const categoryLine = block.find((line) => line.startsWith("category:"));
  const category = categoryLine
    ? categoryLine.slice("category:".length).trim().replace(/^["']|["']$/g, "")
    : "fact";
  const resolved = type || okfTypeForCategory(category);
  const typeIndex = block.findIndex((line) => line.startsWith("type:"));
  if (typeIndex === -1) {
    block.push(`type: ${resolved}${crlf ? "\r" : ""}`);
  } else {
    const current = block[typeIndex]!;
    const bare = current.endsWith("\r") ? current.slice(0, -1) : current;
    const value = bare.slice("type:".length).trim().replace(/^["']|["']$/g, "");
    if (value !== "") return null;
    block[typeIndex] = `type: ${resolved}${current.endsWith("\r") ? "\r" : ""}`;
  }
  return [lines[0], ...block, ...lines.slice(close)].join("\n");
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
