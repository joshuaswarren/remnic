/**
 * Consolidation provenance integrity check (issue #561 PR 4).
 *
 * Validates that every memory carrying consolidation provenance frontmatter
 * (`derived_from`, `derived_via`) resolves to real data:
 *
 *   - Each `derived_from` entry `"<path>:<version>"` must name a
 *     page-version snapshot that exists on disk (via the sidecar layout
 *     documented in `page-versioning.ts`).
 *   - Each `derived_via` must be one of the known
 *     `ConsolidationOperator` values — malformed values are surfaced as
 *     warnings rather than crashes so legacy or future operators survive a
 *     rollback.
 *
 * Non-fatal: every failure renders a warning with the offending file path
 * and a human-readable reason.  Integrity problems are informational for
 * now — we do not auto-heal or archive broken memories.
 */

import path from "node:path";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { StorageManager } from "./storage.js";
import {
  DERIVED_FROM_MEMORY_ID_RE,
  isConsolidationOperator,
} from "./consolidation-operator.js";
// Import the canonical `sidecarKey` from page-versioning (PR #634
// review, cursor Medium) so a future key-format change stays in
// lock-step with the doctor scan.
import { sidecarKey } from "./page-versioning.js";

/**
 * Regex to spot a `derived_via: <value>` line in the raw YAML frontmatter
 * between the opening and first closing `---` delimiters.  We use the raw
 * text rather than the parsed `frontmatter.derived_via` because the
 * read-path parser coerces unknown values back to `undefined` — that
 * would silently hide corrupted-or-future operators from the doctor scan
 * (PR #634 review feedback, codex P2).
 */
// Allow empty capture groups so truncated/blank `derived_via:` and
// `derived_from:` lines (key present, no value) are distinguishable
// from "key missing entirely" (regex returns null).  Optional
// leading whitespace accepts indented keys which `parseFrontmatter`
// also accepts (PR #634 round-6 review, codex P2).
const DERIVED_VIA_RAW_RE = /^[\t ]*derived_via:[\t ]*(.*)$/mu;
const DERIVED_FROM_RAW_RE = /^[\t ]*derived_from:[\t ]*(.*)$/mu;

/**
 * Tokenize a YAML-block-style list under `key:` in the given
 * frontmatter slice.  Looks for lines matching `^  - <value>` after a
 * `key:` line and before the next non-list line.  Returns `null` when
 * the key is missing or the value is a scalar / flow list (no block
 * entries found).
 *
 * Only used for the mixed-list malformed-entry detection — it does
 * not try to decode YAML escape sequences since we only need the
 * entry count + raw token text to compare against the parsed array.
 */
function tokenizeRawBlockList(fmSlice: string, key: string): string[] | null {
  const lines = fmSlice.split("\n");
  // Accept indented keys too — parseFrontmatter does (PR #634 round-7
  // review, codex P2 / cursor Low).
  const keyRe = new RegExp(`^[\\t ]*${key}:[\\t ]*(.*)$`, "u");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (m) {
      if (m[1].trim().length === 0) {
        startIdx = i + 1;
      }
      break;
    }
  }
  if (startIdx < 0) return null;
  const items: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s+-/.test(line)) break; // not a block-list entry
    const m = line.match(/^\s+-\s*(.*)$/u);
    if (!m) break;
    let tok = m[1].trim();
    if (
      (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) ||
      (tok.startsWith("'") && tok.endsWith("'") && tok.length >= 2)
    ) {
      tok = tok.slice(1, -1);
    }
    items.push(tok);
  }
  return items.length > 0 ? items : null;
}

/**
 * Tokenize a YAML-flow-style list (`["a", "b", ...]`) into a flat
 * string array.  Returns `null` when the input isn't a flow list.
 * Best-effort — we don't implement a full YAML parser, just enough to
 * detect mixed valid/invalid entries for the doctor integrity check.
 */
function tokenizeRawFlowList(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1);
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inDouble) {
      if (ch === "\\" && i + 1 < inner.length) {
        current += inner[++i];
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      current += ch;
    } else if (inSingle) {
      if (ch === "'" && inner[i + 1] === "'") {
        current += "'";
        i++;
        continue;
      }
      if (ch === "'") {
        inSingle = false;
        continue;
      }
      current += ch;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0 || parts.length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

/**
 * One integrity warning attached to a specific memory.
 */
export interface ConsolidationProvenanceIssue {
  /** Absolute path to the memory markdown file. */
  memoryPath: string;
  /** Memory id from frontmatter. */
  memoryId: string;
  /** Type of integrity issue. */
  kind:
    | "derived_from_missing_snapshot"
    | "derived_from_malformed_entry"
    | "derived_via_unknown_operator";
  /** Human-readable detail — includes the offending value when relevant. */
  detail: string;
}

/**
 * Summary of a provenance-integrity scan.  Used by the operator-doctor
 * report and surfaced in the CLI output.
 */
export interface ConsolidationProvenanceReport {
  /** Total memories inspected. */
  scanned: number;
  /** Memories that carry `derived_from` and/or `derived_via`. */
  withProvenance: number;
  /** One entry per problem detected (may be empty). */
  issues: ConsolidationProvenanceIssue[];
}

const DERIVED_FROM_ENTRY_RE = /^(.+):(\d+)$/;

/**
 * Build the on-disk snapshot path for a `"<relpath>:<version>"` entry,
 * relative to the given memory directory.  Mirrors the layout documented
 * in `page-versioning.ts`:
 *
 *   memoryDir/<sidecarDir>/<sidecarKey>/<version><ext>
 */
function resolveSnapshotPath(
  memoryDir: string,
  sidecarDir: string,
  entry: string,
): { ok: true; snapshotPath: string } | { ok: false; reason: string } {
  const match = entry.match(DERIVED_FROM_ENTRY_RE);
  if (!match) {
    return { ok: false, reason: `malformed entry (expected "<path>:<version>")` };
  }
  const pagePath = match[1];
  const versionId = match[2];
  const ext = path.extname(pagePath) || ".md";
  const key = sidecarKey(pagePath);
  const snapshotPath = path.join(memoryDir, sidecarDir, key, `${versionId}${ext}`);
  return { ok: true, snapshotPath };
}

/**
 * Scan every memory under `storage` and flag consolidation-provenance
 * problems.  Does not throw on individual failures — collects them in the
 * returned report.
 */
export async function runConsolidationProvenanceCheck(options: {
  storage: StorageManager;
  memoryDir: string;
  /**
   * Page-versioning sidecar directory name.  Defaults to `.versions` —
   * matches the baked-in default used by `setVersioningConfig` when
   * versioning is enabled via config.
   */
  sidecarDir?: string;
}): Promise<ConsolidationProvenanceReport> {
  const { storage, memoryDir } = options;
  const sidecarDir = options.sidecarDir ?? ".versions";

  const report: ConsolidationProvenanceReport = {
    scanned: 0,
    withProvenance: 0,
    issues: [],
  };

  let memories;
  try {
    memories = await storage.readAllMemories();
  } catch {
    // If we can't enumerate memories at all, surface a single synthetic
    // issue rather than throwing — the doctor wrapper treats an empty
    // issues list as "ok" and we don't want a filesystem hiccup to crash
    // the whole diagnostic.
    return {
      scanned: 0,
      withProvenance: 0,
      issues: [
        {
          memoryPath: memoryDir,
          memoryId: "(unreadable)",
          kind: "derived_from_malformed_entry",
          detail: "Could not enumerate memory directory to scan provenance.",
        },
      ],
    };
  }

  for (const memory of memories) {
    report.scanned += 1;
    const fm = memory.frontmatter;
    const derivedFrom = fm.derived_from;
    const derivedVia = fm.derived_via;

    // Raw frontmatter values from disk — the read-path parser coerces
    // malformed `derived_from` and unknown `derived_via` back to
    // `undefined`, which would silently hide on-disk corruption from
    // the doctor scan (PR #634 review feedback, codex P2).  We
    // re-extract both via regex so integrity issues are reported even
    // when the parser normalized them away.  `rawDerivedVia` /
    // `rawDerivedFrom` being `""` (empty string) represents a
    // corrupted file with the key present but the value truncated —
    // that's distinct from "key missing entirely" (undefined).
    let rawDerivedVia: string | undefined;
    let rawDerivedFrom: string | undefined;
    let rawDerivedViaKeyPresent = false;
    let rawDerivedFromKeyPresent = false;
    let duplicateViaKeys = false;
    let duplicateFromKeys = false;
    let viaMatchCount = 0;
    let fromMatchCount = 0;
    let fmSlice = "";
    try {
      const raw = await readFile(memory.path, "utf-8");
      const frontmatterEnd = raw.indexOf("\n---", raw.indexOf("---") + 3);
      fmSlice = frontmatterEnd > 0 ? raw.slice(0, frontmatterEnd) : raw;
      // Use matchAll to find ALL occurrences of `derived_via` / `derived_from`
      // in the raw YAML.  `parseFrontmatter` keeps the LAST assignment when
      // duplicate keys appear, so the doctor must read the last occurrence
      // to match what the storage reader actually uses (PR #634 review,
      // codex P2 — duplicate `derived_via` keys caused false-clean or
      // false-unknown-operator warnings depending on order).
      const viaMatches = [...fmSlice.matchAll(new RegExp(DERIVED_VIA_RAW_RE.source, DERIVED_VIA_RAW_RE.flags + "g"))];
      viaMatchCount = viaMatches.length;
      duplicateViaKeys = viaMatches.length > 1;
      if (viaMatches.length > 0) {
        rawDerivedViaKeyPresent = true;
        // Use the last occurrence — `parseFrontmatter` keeps the last
        // assignment when duplicate keys appear, so the doctor must
        // match that behavior to produce accurate warnings (PR #634
        // review, codex P2).
        const lastVia = viaMatches[viaMatches.length - 1];
        let val = lastVia[1].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        rawDerivedVia = val;
      }
      const fromMatches = [...fmSlice.matchAll(new RegExp(DERIVED_FROM_RAW_RE.source, DERIVED_FROM_RAW_RE.flags + "g"))];
      fromMatchCount = fromMatches.length;
      duplicateFromKeys = fromMatches.length > 1;
      if (fromMatches.length > 0) {
        rawDerivedFromKeyPresent = true;
        const lastFrom = fromMatches[fromMatches.length - 1];
        rawDerivedFrom = lastFrom[1].trim();
      }
    } catch {
      // Fall through to the parsed values.
    }

    const hasFrom = Array.isArray(derivedFrom) && derivedFrom.length > 0;
    const hasVia = derivedVia !== undefined && derivedVia !== null;
    const hasRawVia = rawDerivedVia !== undefined && rawDerivedVia.length > 0;
    // A raw `derived_from` that the parser dropped indicates on-disk
    // corruption we must surface.  We detect this by: (a) the raw YAML
    // contains a `derived_from:` key, AND (b) the parsed frontmatter
    // has no valid array.  A scalar like `derived_from: facts/a.md:7`
    // (list brackets omitted) or a blank `derived_from:` both hit this
    // branch.
    const hasRawMalformedFrom = rawDerivedFromKeyPresent && !hasFrom;
    // A blank `derived_via:` with no value is also corrupt — the
    // parser drops it to undefined, but the raw key is still present
    // on disk (PR #634 round-3 review, codex P2).
    const hasBlankRawVia =
      rawDerivedViaKeyPresent &&
      (rawDerivedVia === undefined || rawDerivedVia.length === 0) &&
      !hasVia;
    if (
      !hasFrom && !hasVia && !hasRawVia &&
      !hasRawMalformedFrom && !hasBlankRawVia
    ) continue;
    report.withProvenance += 1;

    // Duplicate-key detection (PR #634 review, codex P2): when the raw
    // YAML contains multiple `derived_via` or `derived_from` lines,
    // `parseFrontmatter` silently uses the last one.  Flag this as a
    // malformed entry so operators can inspect and fix the file.
    if (duplicateViaKeys) {
      report.issues.push({
        memoryPath: memory.path,
        memoryId: fm.id,
        kind: "derived_via_unknown_operator",
        detail: `raw YAML contains ${viaMatchCount} "derived_via" keys; parseFrontmatter uses the last occurrence`,
      });
    }
    if (duplicateFromKeys) {
      report.issues.push({
        memoryPath: memory.path,
        memoryId: fm.id,
        kind: "derived_from_malformed_entry",
        detail: `raw YAML contains ${fromMatchCount} "derived_from" keys; parseFrontmatter uses the last occurrence`,
      });
    }

    if (hasRawMalformedFrom) {
      const display = rawDerivedFrom ?? "(blank)";
      report.issues.push({
        memoryPath: memory.path,
        memoryId: fm.id,
        kind: "derived_from_malformed_entry",
        detail: `raw YAML "derived_from: ${display}" could not be parsed as a list`,
      });
    }

    // Mixed-list detection (PR #634 round-4 + round-5 review, codex
    // P2): when the parser DID return a valid list but the raw YAML
    // includes additional tokens that got dropped, flag those as
    // malformed.  Handles both flow-style (`["a", "", "b"]`) and
    // block-style (`\n  - a\n  - \n  - b`) YAML lists.
    if (hasFrom && rawDerivedFromKeyPresent) {
      let rawList: string[] | null = null;
      if (rawDerivedFrom && rawDerivedFrom.length > 0) {
        rawList = tokenizeRawFlowList(rawDerivedFrom);
      }
      if (rawList === null) {
        // Fall back to block-list tokenization by re-reading the full
        // frontmatter (already loaded above as `raw`) and scanning
        // the lines following `derived_from:`.
        rawList = tokenizeRawBlockList(fmSlice, "derived_from");
      }
      if (rawList !== null && rawList.length > derivedFrom!.length) {
        for (const tok of rawList) {
          if (tok.length === 0) {
            report.issues.push({
              memoryPath: memory.path,
              memoryId: fm.id,
              kind: "derived_from_malformed_entry",
              detail: `raw YAML derived_from contains an empty entry (mixed list)`,
            });
            continue;
          }
          if (!derivedFrom!.includes(tok)) {
            // Accept either the snapshot format `<path>:<version>` or
            // a bare memory id (issue #687 PR 2/4 — pattern
            // reinforcement uses ID-shaped entries).  PR #730
            // review feedback, Codex P2.
            if (
              !/^(.+):(\d+)$/u.test(tok) &&
              !DERIVED_FROM_MEMORY_ID_RE.test(tok)
            ) {
              report.issues.push({
                memoryPath: memory.path,
                memoryId: fm.id,
                kind: "derived_from_malformed_entry",
                detail: `raw YAML derived_from contains a malformed entry: ${JSON.stringify(tok)}`,
              });
            }
          }
        }
      }
    }
    if (hasBlankRawVia) {
      report.issues.push({
        memoryPath: memory.path,
        memoryId: fm.id,
        kind: "derived_via_unknown_operator",
        detail: "raw YAML has `derived_via:` key with empty value",
      });
    }

    if (hasFrom) {
      for (const entry of derivedFrom!) {
        // Pattern-reinforcement (issue #687 PR 2/4) records source
        // memory IDs directly in `derived_from` rather than
        // page-versioning snapshot references.  Memory IDs may
        // contain `:` for namespace-prefixed forms like
        // `global:fact-abc-123`, but never `/` or `.` — those remain
        // exclusive to snapshot paths (PR #730 review feedback,
        // Codex P1).  For ID-shaped entries we skip the snapshot
        // file check entirely — but ONLY when the operator is
        // `pattern-reinforcement`, which is the sole operator that
        // legitimately stores IDs rather than snapshot references.
        // Allowing the bypass for split/merge/update would weaken
        // validation on those existing consolidation paths (PR #730
        // review, Codex P2).
        if (
          derivedVia === "pattern-reinforcement" &&
          DERIVED_FROM_MEMORY_ID_RE.test(entry)
        ) {
          continue;
        }
        const resolved = resolveSnapshotPath(memoryDir, sidecarDir, entry);
        if (!resolved.ok) {
          report.issues.push({
            memoryPath: memory.path,
            memoryId: fm.id,
            kind: "derived_from_malformed_entry",
            detail: `${JSON.stringify(entry)}: ${resolved.reason}`,
          });
          continue;
        }
        // Require a regular file at the snapshot path (PR #634
        // round-8 review, codex P2) — a directory or device node at
        // that path means the sidecar was corrupted and the snapshot
        // is effectively missing.
        let snapshotOk = false;
        try {
          const st = await stat(resolved.snapshotPath);
          snapshotOk = st.isFile();
        } catch {
          snapshotOk = false;
        }
        if (!snapshotOk) {
          report.issues.push({
            memoryPath: memory.path,
            memoryId: fm.id,
            kind: "derived_from_missing_snapshot",
            detail: `${entry} → ${resolved.snapshotPath} (not a regular file)`,
          });
        }
      }
    }

    // Check the RAW YAML value for unknown operators.  The parsed value
    // (`fm.derived_via`) is always known-good because the read-path
    // normalizer dropped anything else to undefined.
    if (hasRawVia && !isConsolidationOperator(rawDerivedVia)) {
      report.issues.push({
        memoryPath: memory.path,
        memoryId: fm.id,
        kind: "derived_via_unknown_operator",
        detail: `unknown operator: ${JSON.stringify(rawDerivedVia)}`,
      });
    }
  }

  // Parse-failure detection (PR #634 round-4 review, codex P2):
  // `readAllMemories()` silently drops files whose frontmatter
  // doesn't parse.  Walk the facts/ and corrections/ directories for
  // `.md` files that DO reference provenance frontmatter but didn't
  // come back from the reader — those are the corruption cases the
  // doctor is meant to surface.
  try {
    const seenPaths = new Set(memories.map((m) => m.path));
    const scanRoots = ["facts", "corrections", "procedures", "reasoning-traces"];
    for (const rootName of scanRoots) {
      const rootPath = path.join(memoryDir, rootName);
      for await (const file of walkMarkdownFiles(rootPath, memoryDir)) {
        if (seenPaths.has(file)) continue;
        try {
          const raw = await readFile(file, "utf-8");
          if (
            DERIVED_FROM_RAW_RE.test(raw) ||
            DERIVED_VIA_RAW_RE.test(raw)
          ) {
            report.withProvenance += 1;
            report.issues.push({
              memoryPath: file,
              memoryId: "(parse failed)",
              kind: "derived_from_malformed_entry",
              detail:
                "frontmatter could not be parsed by storage reader; provenance fields visible in raw YAML",
            });
          }
        } catch {
          // Unreadable file — skip.
        }
      }
    }
  } catch {
    // Best-effort; don't fail the whole scan on a filesystem hiccup.
  }

  return report;
}

/**
 * Recursively yield all `.md` file paths under `root`.  Silent on
 * missing directories — the facts/corrections dirs may not exist in
 * fresh installs.  Symlinked roots/directories are skipped so the
 * best-effort parse-failure pass cannot escape `memoryDir`.
 */
async function* walkMarkdownFiles(root: string, memoryDir: string): AsyncGenerator<string> {
  let entries;
  let memoryDirReal: string;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
    memoryDirReal = await realpath(memoryDir);
    const rootReal = await realpath(root);
    if (!isPathWithin(rootReal, memoryDirReal)) return;
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(full, memoryDirReal);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        const fileReal = await realpath(full);
        if (!isPathWithin(fileReal, memoryDirReal)) continue;
      } catch {
        continue;
      }
      yield full;
    }
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
