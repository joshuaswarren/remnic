/**
 * Vault publisher service (issue #1985): composes the landed primitives —
 * path templates (`vault-path.ts`), managed regions (`vault-publish.ts`),
 * marker insertion (`vault-insert.ts`), region-name validation
 * (`vault-region.ts`), begin/end pair assertion (`vault-region-pair.ts`) —
 * into one publish pass over a single vault note.
 *
 * Guarantees: everything outside the managed region (and, in frontmatter
 * mode, everything except `prefix`-owned keys) is byte-identical after
 * publish; unchanged content produces no write; all writes are temp-file +
 * rename in the note's own directory; dry-run performs zero writes;
 * symlinked paths that resolve outside the vault are refused before any
 * read or write.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expandTildePath } from "../utils/path.js";
import { applyManagedRegion } from "./vault-publish.js";
import { insertMarkersUnderHeading } from "./vault-insert.js";
import { validateRegionName } from "./vault-region.js";
import { assertBeginEndPair } from "./vault-region-pair.js";
import { expandVaultTemplateTokens, resolveVaultNotePath } from "./vault-path.js";
import { summarizeVaultPublish, type VaultPublishResult, type VaultPublishStatus } from "./vault-status.js";

export interface VaultSectionProvenance {
  generatorVersion: string;
  /** Local-time generation stamp of the artifact; supplied by the caller so republishing an unchanged artifact stays a no-op. */
  generatedAt: string;
}

export interface VaultSectionPublish {
  /** Managed-region name (the heading name under the heading strategy). */
  name: string;
  /** Rendered artifact body the region owns. */
  content: string;
  /** Unprefixed stats, e.g. `{ focus_minutes: "220" }`; keys get the configured prefix. */
  properties?: Readonly<Record<string, string>>;
  /** When present, a provenance footer line is appended inside the region. */
  provenance?: VaultSectionProvenance;
}

export interface PublishVaultNoteInput {
  /** Vault root; absolute or `~` path; must be an existing directory. */
  vaultPath: string;
  /** Vault-relative note path template (date tokens). */
  notePathTemplate: string;
  /** Local day, YYYY-MM-DD. */
  date: string;
  sections: readonly VaultSectionPublish[];
  strategy?: "markers" | "heading";
  /** Markers strategy: heading under which missing marker pairs are inserted. */
  insertUnderHeading?: string;
  createMissingNotes?: boolean;
  /** Vault-relative template file used only when creating a missing note. */
  noteTemplate?: string;
  propertiesMode?: "off" | "frontmatter" | "dataview-inline";
  /** Property key prefix, default `remnic_`. */
  propertiesPrefix?: string;
  dryRun?: boolean;
}

// Bounded whitespace runs: an unbounded `\s*` chain around a lazy capture is the
// CodeQL js/polynomial-redos shape `check:regex-safety` rejects (issue #2439).
const START_MARKER_RE = /^<!--\s{0,8}remnic:([^:]+?):start\s{0,8}-->$/;
const END_MARKER_RE = /^<!--\s{0,8}remnic:([^:]+?):end\s{0,8}-->$/;

type SectionOutcome =
  | { ok: true; text: string }
  | { ok: false; outcome: "skipped" | "error"; reason: string };

export function publishVaultNote(input: PublishVaultNoteInput): VaultPublishStatus {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("publishVaultNote requires an input object.");
  }
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new RangeError("publishVaultNote requires at least one section.");
  }
  const strategy = input.strategy ?? "markers";
  const propertiesMode = input.propertiesMode ?? "off";
  const prefix = input.propertiesPrefix ?? "remnic_";
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new RangeError("propertiesPrefix must be a non-empty string.");
  }
  for (const section of input.sections) {
    const name = validateRegionName(section.name);
    if (!name.ok) {
      throw new RangeError(`Section name ${JSON.stringify(section.name)} is not a valid region name.`);
    }
  }

  const relative = resolveVaultNotePath(input.notePathTemplate, input.date);
  const result = publishRelative(input, relative, { strategy, propertiesMode, prefix });
  return summarizeVaultPublish(result);
}

function publishRelative(
  input: PublishVaultNoteInput,
  relative: string,
  opts: { strategy: "markers" | "heading"; propertiesMode: string; prefix: string },
): VaultPublishResult[] {
  const vault = expandTildePath(input.vaultPath);
  try {
    // A symlinked vault root is rejected outright (security checklist §3):
    // statSync follows links, lstatSync does not.
    const rootStat = lstatSync(vault);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return refuse(relative, "error", "not_directory");
  } catch {
    return refuse(relative, "error", "not_directory");
  }

  const root = path.resolve(vault);
  const dest = path.resolve(root, relative);
  const lexical = path.relative(root, dest);
  if (lexical.length === 0 || lexical.startsWith("..") || path.isAbsolute(lexical)) {
    return refuse(relative, "error", "path_escape");
  }
  if (!containedBySymlinks(root, dest)) {
    return refuse(relative, "error", "symlink_escape");
  }

  let currentText: string | null = null;
  try {
    const st = statSync(dest);
    if (st.isFile()) currentText = readFileSync(dest, "utf8");
    else return refuse(relative, "error", "not_a_file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let created = false;
  if (currentText === null) {
    if (input.createMissingNotes === true && typeof input.noteTemplate === "string" && input.noteTemplate.length > 0) {
      const templatePath = path.resolve(root, input.noteTemplate);
      const templateRel = path.relative(root, templatePath);
      if (templateRel.startsWith("..") || path.isAbsolute(templateRel) || templateRel.length === 0 || !containedBySymlinks(root, templatePath)) {
        return refuse(relative, "error", "template_escape");
      }
      try {
        const templateText = readFileSync(templatePath, "utf8");
        currentText = expandVaultTemplateTokens(templateText, input.date);
        if (!currentText.endsWith("\n")) currentText += "\n";
        created = true;
      } catch {
        return refuse(relative, "error", "template_unreadable");
      }
    } else {
      return refuse(relative, "skipped", "missing_file");
    }
  }

  const original = currentText;
  let text = original;
  const failures: Array<{ outcome: "skipped" | "error"; reason: string }> = [];
  let applied = 0;

  for (const section of input.sections) {
    const prefixed =
      opts.propertiesMode === "off" || !section.properties
        ? undefined
        : Object.fromEntries(
            Object.entries(section.properties).map(([key, value]) => [`${opts.prefix}${key}`, value]),
          );
    const content = decorate(section, prefixed, opts.propertiesMode);
    const step = applySection(text, section, content, opts.strategy, input.insertUnderHeading, created);
    if (step.ok) {
      text = step.text;
      applied += 1;
    } else {
      failures.push({ outcome: step.outcome, reason: step.reason });
    }
  }

  if (failures.length > 0 && applied === 0) {
    const worst = failures.find((f) => f.outcome === "error") ?? failures[0]!;
    return [{ path: relative, outcome: worst.outcome, reason: failures.map((f) => f.reason).join("; ") }];
  }
  if (failures.some((f) => f.outcome === "error")) {
    return [{ path: relative, outcome: "error", reason: failures.map((f) => f.reason).join("; ") }];
  }

  if (opts.propertiesMode === "frontmatter") {
    const updates = frontmatterUpdates(input.sections, opts.prefix);
    if (Object.keys(updates).length > 0) {
      const merged = mergeFrontmatterKeys(text, updates);
      if (!merged.ok) {
        return [{ path: relative, outcome: "error", reason: merged.reason }];
      }
      text = merged.text;
    }
  }

  const prevHash = createHash("sha256").update(original, "utf8").digest("hex");
  const nextHash = createHash("sha256").update(text, "utf8").digest("hex");
  if (prevHash === nextHash) {
    return [{ path: relative, outcome: "unchanged" }];
  }
  if (input.dryRun === true) {
    return [{ path: relative, outcome: "updated" }];
  }

  if (!writeAtomic(dest, text)) {
    return [{ path: relative, outcome: "error", reason: "rename_failed" }];
  }
  return [{ path: relative, outcome: "updated" }];
}

function refuse(relative: string, outcome: "skipped" | "error", reason: string): VaultPublishResult[] {
  return [{ path: relative, outcome, reason }];
}

function decorate(
  section: VaultSectionPublish,
  prefixed: Record<string, string> | undefined,
  mode: string,
): string {
  const parts: string[] = [section.content];
  if (prefixed !== undefined && mode === "dataview-inline") {
    for (const [key, value] of Object.entries(prefixed)) {
      parts.push(`${key}:: ${value}`);
    }
  }
  if (section.provenance !== undefined) {
    parts.push(
      `*(generated by Remnic timeline · ${section.provenance.generatorVersion} · ${section.provenance.generatedAt})*`,
    );
  }
  return parts.join("\n");
}

function applySection(
  text: string,
  section: VaultSectionPublish,
  content: string,
  strategy: "markers" | "heading",
  insertUnderHeading: string | undefined,
  freshNote: boolean,
): SectionOutcome {
  if (strategy === "markers") {
    const crossed = findCrossedPair(text);
    if (crossed !== null) {
      return { ok: false, outcome: "skipped", reason: `name_mismatch:${crossed.begin}:${crossed.end}` };
    }
    const applied = applyManagedRegion(text, { strategy: "markers", name: section.name, content });
    if (applied.ok) return { ok: true, text: applied.text };
    if (typeof insertUnderHeading === "string" && insertUnderHeading.length > 0) {
      const inserted = insertMarkersUnderHeading(text, {
        heading: insertUnderHeading,
        name: section.name,
        content,
      });
      if (inserted.ok) return { ok: true, text: inserted.text };
      if (inserted.reason === "duplicate_heading") {
        return {
          ok: false,
          outcome: "error",
          reason: `duplicate_heading:${inserted.lines.join(",")}`,
        };
      }
      return { ok: false, outcome: "skipped", reason: "no_marker" };
    }
    if (freshNote) {
      const suffix = `${text.endsWith("\n") ? "" : "\n"}<!-- remnic:${section.name}:start -->\n${content}\n<!-- remnic:${section.name}:end -->\n`;
      return { ok: true, text: text + suffix };
    }
    return { ok: false, outcome: "skipped", reason: "no_marker" };
  }

  const applied = applyManagedRegion(text, { strategy: "heading", name: section.name, content });
  if (applied.ok) return { ok: true, text: applied.text };
  if (applied.reason === "duplicate_heading") {
    return { ok: false, outcome: "error", reason: `duplicate_heading:${applied.lines.join(",")}` };
  }
  return { ok: false, outcome: "skipped", reason: "no_heading" };
}

/**
 * A begin marker whose next end marker names a different region is a
 * malformed pair; replacing inside it could clobber another section's
 * bytes. The WHOLE note is scanned: a valid pair only closes the current
 * region and the scan continues, because `applyManagedRegion` pairs a
 * start with the next end of the SAME name, which can span a malformed
 * region and delete every byte in between. A mismatch anywhere refuses the
 * file — ambiguity always resolves to "keep the user's bytes".
 */
function findCrossedPair(text: string): { begin: string; end: string } | null {
  const lines = text.split(/(?<=\n)/);
  let begin: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (begin === null) {
      const start = START_MARKER_RE.exec(trimmed);
      if (start) begin = start[1]!;
      continue;
    }
    const match = END_MARKER_RE.exec(trimmed);
    if (!match) continue;
    const end = match[1]!;
    // A blank marker name cannot be paired at all: refuse rather than let
    // assertBeginEndPair throw out of the publisher.
    if (begin.trim().length === 0 || end.trim().length === 0) return { begin, end };
    if (!assertBeginEndPair({ beginName: begin, endName: end }).ok) return { begin, end };
    begin = null;
  }
  return null;
}

function frontmatterUpdates(
  sections: readonly VaultSectionPublish[],
  prefix: string,
): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const section of sections) {
    if (!section.properties) continue;
    for (const [key, value] of Object.entries(section.properties)) {
      updates[`${prefix}${key}`] = value;
    }
  }
  return updates;
}

/**
 * Targeted frontmatter edit: only `updates` keys are inserted or replaced;
 * every other byte of the note (key order, comments, anchors, spacing) is
 * preserved. Never parses-and-redumps the YAML block.
 */
export function mergeFrontmatterKeys(
  noteText: string,
  updates: Readonly<Record<string, string>>,
): { ok: true; text: string } | { ok: false; reason: string } {
  const entries = Object.entries(updates);
  if (entries.length === 0) return { ok: true, text: noteText };
  for (const [key] of entries) {
    if (key.includes("\n") || key.includes("\r") || key.trim() !== key || key.length === 0) {
      return { ok: false, reason: "invalid_property_key" };
    }
  }

  const eol = noteText.includes("\r\n") ? "\r\n" : "\n";
  const openRe = /^---\r?$/;
  const firstLineEnd = noteText.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? noteText : noteText.slice(0, firstLineEnd);

  if (!openRe.test(firstLine)) {
    const block = ["---", ...entries.map(([key, value]) => `${key}: ${value}`), "---", ""].join(eol);
    return { ok: true, text: block + eol + noteText };
  }

  const lines = noteText.split(eol);
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (openRe.test(lines[i]!)) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { ok: false, reason: "malformed_frontmatter" };
  }

  const pending = new Map(entries);
  for (let i = 1; i < closeIdx; i += 1) {
    const line = lines[i]!;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const rawKey = line.slice(0, idx);
    // Leading whitespace is exactly the signal that this is a nested,
    // user-owned child key (`custom:` / `  remnic_focus: old`). Only an
    // unindented top-level mapping may satisfy a pending update, so the
    // key is NOT trimmed before that decision.
    if (rawKey !== rawKey.trimStart()) continue;
    const key = rawKey.trimEnd();
    if (!pending.has(key)) continue;
    lines[i] = `${rawKey}: ${pending.get(key)}`;
    pending.delete(key);
  }
  const insertAt = closeIdx;
  const added: string[] = [];
  for (const [key, value] of pending.entries()) {
    added.push(`${key}: ${value}`);
  }
  lines.splice(insertAt, 0, ...added);
  return { ok: true, text: lines.join(eol) };
}

/**
 * Containment under symlinks: the deepest existing ancestor of `dest` must
 * still resolve inside the (real) vault root. A symlink chain that leaves
 * the vault is refused before any note byte is read.
 */
function containedBySymlinks(root: string, dest: string): boolean {
  const realRoot = realpathSync(root);
  let probe = dest;
  for (;;) {
    try {
      if (lstatSync(probe).isSymbolicLink() || statSync(probe).isFile() || statSync(probe).isDirectory()) {
        const real = realpathSync(probe);
        return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
      }
    } catch {
      // ENOENT: walk up to the parent.
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
}

/** Temp file + rename in the note's own directory; one retry on EBUSY/EPERM. */
function writeAtomic(dest: string, text: string): boolean {
  const tmpPath = path.join(path.dirname(dest), `.remnic-vault-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, text);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      renameSync(tmpPath, dest);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt === 1 || (code !== "EBUSY" && code !== "EPERM")) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // best-effort cleanup
        }
        if (code === "EBUSY" || code === "EPERM") return false;
        throw err;
      }
    }
  }
  return false;
}
