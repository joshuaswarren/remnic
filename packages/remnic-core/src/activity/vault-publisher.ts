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
 * rename in the note's own directory; dry-run performs zero writes; a
 * destination that changed after it was read aborts with `concurrent_write`
 * instead of clobbering an editor's concurrent save; symlinked paths that
 * resolve outside the vault, and symlinked note files, are refused before
 * any write.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";

import { expandTildePath } from "../utils/path.js";
import { applyManagedRegion, fileLines } from "./vault-publish.js";
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
// The name is captured up to the TERMINAL `:start`/`:end` suffix, so a marker
// carrying a stray colon (`remnic:A:B:start`) is still seen by the scanner
// instead of being silently invisible to it. `validateRegionName` rejects `:`
// in a configured name, so such a marker can never be a legitimate pair and
// always resolves to a refusal below.
const START_MARKER_RE = /^<!--\s{0,8}remnic:(.+):start\s{0,8}-->$/;
const END_MARKER_RE = /^<!--\s{0,8}remnic:(.+):end\s{0,8}-->$/;

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
  // `..notes/x.md` is an in-vault name, not parent traversal: only `..`
  // exactly or a `..${path.sep}` prefix escapes.
  if (lexical.length === 0 || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
    return refuse(relative, "error", "path_escape");
  }
  if (!containedBySymlinks(root, dest)) {
    return refuse(relative, "error", "symlink_escape");
  }
  let currentText: string | null = null;
  let expected: DestExpectation | null = null;
  try {
    // A symlinked note is refused even when its target lives inside the
    // vault (issue #1985): writeAtomic renames over the link itself, which
    // would destroy the symlink and leave the target stale while the
    // status still says `updated`.
    if (lstatSync(dest).isSymbolicLink()) {
      return refuse(relative, "error", "symlinked_note");
    }
    const st = statSync(dest);
    if (st.isFile()) {
      currentText = readFileSync(dest, "utf8");
      expected = {
        ino: st.ino,
        mtimeMs: st.mtimeMs,
        size: st.size,
        sha256: createHash("sha256").update(currentText, "utf8").digest("hex"),
      };
    } else return refuse(relative, "error", "not_a_file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let created = false;
  if (currentText === null) {
    if (input.createMissingNotes === true && typeof input.noteTemplate === "string" && input.noteTemplate.length > 0) {
      const templatePath = path.resolve(root, input.noteTemplate);
      const templateRel = path.relative(root, templatePath);
      if (templateRel === ".." || templateRel.startsWith(`..${path.sep}`) || path.isAbsolute(templateRel) || templateRel.length === 0 || !containedBySymlinks(root, templatePath)) {
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
  const appliedSections: VaultSectionPublish[] = [];

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
      appliedSections.push(section);
    } else {
      failures.push({ outcome: step.outcome, reason: step.reason });
    }
  }

  if (failures.length > 0 && appliedSections.length === 0) {
    const worst = failures.find((f) => f.outcome === "error") ?? failures[0]!;
    return [{ path: relative, outcome: worst.outcome, reason: failures.map((f) => f.reason).join("; ") }];
  }
  if (failures.some((f) => f.outcome === "error")) {
    return [{ path: relative, outcome: "error", reason: failures.map((f) => f.reason).join("; ") }];
  }

  // Partial publish (issue #1985 review): when some sections applied and
  // others were skipped, the write covers ONLY the applied sections — their
  // frontmatter properties, and the reported status. A skipped section's
  // properties must never reach the file, and the omission must be surfaced
  // as its own `skipped` row rather than reported as a plain `updated`.
  const skippedReason = failures.length > 0 ? failures.map((f) => f.reason).join("; ") : undefined;
  const withSkipped = (rows: VaultPublishResult[]): VaultPublishResult[] =>
    skippedReason === undefined ? rows : [...rows, { path: relative, outcome: "skipped", reason: skippedReason }];

  if (opts.propertiesMode === "frontmatter") {
    const updates = frontmatterUpdates(appliedSections, opts.prefix);
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
    return withSkipped([{ path: relative, outcome: "unchanged" }]);
  }
  if (input.dryRun === true) {
    return withSkipped([{ path: relative, outcome: "updated" }]);
  }
  if (created) {
    // A brand-new note may live in absent folders (Daily/{yyyy}/{MM}). Make
    // the parent chain only here, after every refusal above has passed: the
    // lexical path check and `containedBySymlinks` already proved the deepest
    // existing ancestor is a real directory inside the vault, so every segment
    // `mkdirSync` adds lands beneath that contained ancestor.
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
    } catch {
      return refuse(relative, "error", "mkdir_failed");
    }
  }

  const write = writeAtomic(dest, text, expected);
  if (write === "concurrent") {
    // The note changed after it was read (editor autosave): keep the user's
    // bytes and surface the abort — never a silent overwrite, never `updated`.
    return [{ path: relative, outcome: "error", reason: "concurrent_write" }];
  }
  if (write !== "written") {
    return [{ path: relative, outcome: "error", reason: "rename_failed" }];
  }
  return withSkipped([{ path: relative, outcome: "updated" }]);
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
    const mismatch = findMarkerMismatch(text);
    if (mismatch !== null) {
      return { ok: false, outcome: "skipped", reason: mismatch };
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
 * Refuse any note whose `remnic:<name>:{start,end}` markers are not a flat
 * sequence of correctly named pairs. Every line outside a code block is
 * scanned — a fenced or indented pair is sample text, invisible to this
 * scan and to replacement —
 * because `applyManagedRegion` pairs a start with the next end of the SAME
 * name and would otherwise span a malformed region and delete every byte
 * in between. Four shapes are malformed:
 *   - a crossed pair (`start:A` closed by `end:B`)
 *   - a nested start (`start:A`, `start:B`, `end:A`, `end:B`), where the
 *     inner region's end is the ONLY end left after A closes, so a
 *     replacement spans B's start marker and the user bytes around it
 *   - an orphan end with no open region, which cannot be paired at all
 *   - a marker line that carries the `remnic:…:start`/`:end` shape but no
 *     parseable name (empty name, or whitespace past the bounded run), which
 *     the pairing scan cannot classify at all
 * Ambiguity always resolves to "keep the user's bytes".
 */
function findMarkerMismatch(text: string): string | null {
  let begin: string | null = null;
  for (const row of fileLines(text)) {
    if (row.fenced) continue;
    const trimmed = row.line.trim();
    const start = START_MARKER_RE.exec(trimmed);
    if (start) {
      const name = start[1]!;
      if (begin !== null) return `nested_start:${begin}:${name}`;
      begin = name;
      continue;
    }
    const match = END_MARKER_RE.exec(trimmed);
    if (!match) {
      if (looksLikeRemnicMarkerLine(trimmed)) return `unparsable_marker:${trimmed}`;
      continue;
    }
    const end = match[1]!;
    if (begin === null) return `orphan_end:${end}`;
    // A blank marker name cannot be paired at all: refuse rather than let
    // assertBeginEndPair throw out of the publisher.
    if (begin.trim().length === 0 || end.trim().length === 0) return `name_mismatch:${begin}:${end}`;
    if (!assertBeginEndPair({ beginName: begin, endName: end }).ok) return `name_mismatch:${begin}:${end}`;
    begin = null;
  }
  return null;
}

/**
 * True for a line shaped like this publisher's own marker — `<!--` … `-->`
 * wrapping `remnic:` … terminal `:start`/`:end` — that neither marker regex
 * accepted. Classification only; the caller refuses the file. The exact
 * trimmed line is inspected, never a normalized rewrite of it, so no
 * "helpful" transform can widen what counts as parseable.
 */
function looksLikeRemnicMarkerLine(trimmed: string): boolean {
  if (!trimmed.startsWith("<!--") || !trimmed.endsWith("-->")) return false;
  const inner = trimmed.slice(4, -3).trim();
  if (!inner.startsWith("remnic:")) return false;
  return inner.endsWith(":start") || inner.endsWith(":end");
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

/**
 * Destination identity captured when the note was read for this publish:
 * inode + mtime + size + content hash. Any drift by replace time is a
 * concurrent write (an editor that saves in place changes mtimeMs/size/
 * bytes; one that saves atomically changes the inode) and aborts the
 * replace. `null` means the destination did not exist at read time.
 */
interface DestExpectation {
  ino: number;
  mtimeMs: number;
  size: number;
  sha256: string;
}

/** Test-only injection point (issue #1985 review): runs after the note was
 *  read and rendered but before the pre-replace verification, so tests can
 *  simulate a concurrent editor save landing inside that window. Never set
 *  in production code. */
export interface VaultPublisherTestHooks {
  beforeReplaceVerify?: (dest: string) => void;
}

let vaultPublisherTestHooks: VaultPublisherTestHooks | null = null;

export function setVaultPublisherTestHooks(hooks: VaultPublisherTestHooks | null): void {
  vaultPublisherTestHooks = hooks;
}

/**
 * Temp file + rename in the note's own directory; one retry on EBUSY/EPERM.
 *
 * The replacement inode must inherit the destination's permissions: a fresh
 * temp file is `0666 & ~umask`, so renaming it over a `0600` note under a
 * `0022` umask silently widens the note to `0644`. Mode is carried via
 * chmodSync (not a writeFileSync mode option, which umask would mask);
 * ownership is carried only as far as the process's privilege allows
 * (chownSync to another owner fails EPERM for non-root and is ignored).
 *
 * Concurrent-write guard (issue #1985 final review): `text` is derived from
 * the snapshot in `expect`; if the destination no longer matches that
 * snapshot — different inode, mtime, size, bytes, or existence — the rename
 * is refused (`"concurrent"`) and the user's bytes are kept. Deliberately
 * abort-only, no re-read/re-render retry: the refusal direction is the
 * contract, and the next scheduled publish converges against fresh content.
 */
function writeAtomic(dest: string, text: string, expect: DestExpectation | null): "written" | "concurrent" | "failed" {
  const tmpPath = path.join(path.dirname(dest), `.remnic-vault-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, text);
  let prev: Stats | null = null;
  try {
    prev = statSync(dest);
  } catch {
    prev = null; // destination absent (new note) — not an error yet
  }
  if (prev !== null) {
    try {
      chmodSync(tmpPath, prev.mode & 0o7777);
      chownSync(tmpPath, prev.uid, prev.gid);
    } catch {
      // Insufficient privilege (EPERM): the temp file keeps its default
      // mode/owner.
    }
  }
  vaultPublisherTestHooks?.beforeReplaceVerify?.(dest);
  try {
    const concurrent =
      expect === null
        ? prev !== null // someone created the note after we planned to
        : prev === null || // the note vanished since it was read
          prev.ino !== expect.ino ||
          prev.mtimeMs !== expect.mtimeMs ||
          prev.size !== expect.size ||
          createHash("sha256").update(readFileSync(dest, "utf8"), "utf8").digest("hex") !== expect.sha256;
    if (concurrent) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
      return "concurrent";
    }
  } catch {
    // Destination unreadable at verify time: refuse to replace.
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    return "concurrent";
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      renameSync(tmpPath, dest);
      return "written";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt === 1 || (code !== "EBUSY" && code !== "EPERM")) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // best-effort cleanup
        }
        if (code === "EBUSY" || code === "EPERM") return "failed";
        throw err;
      }
    }
  }
  return "failed";
}
