const RELEASE_HEADING_RE = /^## \[(?:Unreleased|v?\d+\.\d+\.\d+)/;
const SECTION_HEADING_RE = /^##\s+/;

export function parseAllowedReleaseSections(content) {
  const lines = content.split(/\r?\n/);
  const ranges = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!RELEASE_HEADING_RE.test(lines[index])) continue;

    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (SECTION_HEADING_RE.test(lines[next])) {
        end = next;
        break;
      }
    }
    ranges.push({ start: index + 1, end });
  }

  return ranges;
}

export function parseChangedLineNumbers(patch) {
  const oldLines = [];
  const newLines = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }

    if (line.startsWith("\\ No newline")) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(oldLine);
      oldLine += 1;
      continue;
    }

    if (oldLine > 0 || newLine > 0) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return { oldLines, newLines };
}

function lineInRanges(line, ranges) {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

export function validateChangelogPatch({ patch, baseContent, headContent }) {
  if (!patch || !patch.trim()) {
    return { allowed: false, reason: "CHANGELOG.md patch data is unavailable." };
  }

  const changed = parseChangedLineNumbers(patch);
  const baseRanges = parseAllowedReleaseSections(baseContent ?? "");
  const headRanges = parseAllowedReleaseSections(headContent ?? "");

  const invalidOld = changed.oldLines.filter((line) => !lineInRanges(line, baseRanges));
  const invalidNew = changed.newLines.filter((line) => !lineInRanges(line, headRanges));

  if (invalidOld.length > 0 || invalidNew.length > 0) {
    return {
      allowed: false,
      reason:
        "CHANGELOG.md changes must be inside `## [Unreleased]` or a versioned release section.",
      invalidOld,
      invalidNew,
    };
  }

  if (changed.oldLines.length === 0 && changed.newLines.length === 0) {
    return { allowed: false, reason: "CHANGELOG.md patch did not contain changed lines." };
  }

  return { allowed: true };
}
