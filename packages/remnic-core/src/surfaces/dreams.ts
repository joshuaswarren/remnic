import { createHash } from "node:crypto";
import { statSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DreamEntry {
  id: string;
  timestamp: string;
  title: string | null;
  body: string;
  tags: string[];
  sourceOffset: number;
}

export interface DreamsSurface {
  read(path: string): Promise<DreamEntry[]>;
  append(
    path: string,
    entry: Omit<DreamEntry, "id" | "sourceOffset">,
  ): Promise<DreamEntry>;
  watch(path: string, onChange: (entries: DreamEntry[]) => void): () => void;
}

const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";
const appendQueues = new Map<string, Promise<void>>();

function stableDreamId(params: {
  timestamp: string;
  occurrence: number;
}): string {
  const digest = createHash("sha1")
    .update(
      JSON.stringify({
        timestamp: params.timestamp,
        occurrence: params.occurrence,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return `dream-${digest}`;
}

type ParsedDreamEntry = Omit<DreamEntry, "id">;

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function parseTagsLine(line: string): string[] {
  const match = /^Tags:\s*(.*)$/i.exec(line.trim());
  if (!match) return [];
  return match[1]
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^#/, ""));
}

function buildDreamEntry(params: {
  timestamp: string;
  title: string | null;
  body: string;
  tags: string[];
  sourceOffset: number;
}): ParsedDreamEntry {
  const title = params.title?.trim() || null;
  return {
    timestamp: params.timestamp.trim(),
    title,
    body: normalizeBody(params.body),
    tags: params.tags,
    sourceOffset: params.sourceOffset,
  };
}

function finalizeDreamEntries(entries: ParsedDreamEntry[]): DreamEntry[] {
  const seenByTimestamp = new Map<string, number>();
  return entries.map((entry) => {
    const occurrence = seenByTimestamp.get(entry.timestamp) ?? 0;
    seenByTimestamp.set(entry.timestamp, occurrence + 1);
    return {
      ...entry,
      id: stableDreamId({
        timestamp: entry.timestamp,
        occurrence,
      }),
    };
  });
}

function splitDiaryBlocks(content: string): Array<{ block: string; sourceOffset: number }> {
  const results: Array<{ block: string; sourceOffset: number }> = [];
  const starts = [...content.matchAll(/(^|\n)---\n(?=\n\*)/g)].map((match) => ({
    blockStart: (match.index ?? 0) + (match[1]?.length ?? 0),
    contentStart:
      (match.index ?? 0) + (match[1]?.length ?? 0) + "---\n".length,
  }));

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (!start) continue;
    const end = starts[index + 1]?.blockStart ?? content.length;
    const block = content.slice(start.contentStart, end).trim();
    if (!block) continue;
    results.push({ block, sourceOffset: start.contentStart });
  }
  return results;
}

function parseDiaryBlock(block: string, sourceOffset: number): ParsedDreamEntry | null {
  const lines = block.split("\n");
  const first = lines.shift()?.trim() ?? "";
  const italicMatch = /^\*(.+)\*$/.exec(first);
  if (!italicMatch) return null;
  const firstLine = italicMatch[1].trim();
  const splitIndex = firstLine.indexOf(" — ");
  const timestamp = splitIndex >= 0 ? firstLine.slice(0, splitIndex).trim() : firstLine;
  const title = splitIndex >= 0 ? firstLine.slice(splitIndex + 3).trim() : null;
  const tags = lines.length > 0 ? parseTagsLine(lines[lines.length - 1] ?? "") : [];
  const bodyLines =
    tags.length > 0
      ? lines.slice(0, Math.max(0, lines.length - 1))
      : lines;
  return buildDreamEntry({
    timestamp,
    title,
    body: bodyLines.join("\n"),
    tags,
    sourceOffset,
  });
}

function parseLegacyHeadingEntries(content: string): ParsedDreamEntry[] {
  const entries: ParsedDreamEntry[] = [];
  const headingRegex = /^##\s+(.+)$/gm;
  const matches = [...content.matchAll(headingRegex)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1]?.index ?? content.length) : content.length;
    const heading = match[1]?.trim() ?? "";
    const body = content.slice(start + match[0].length, end).replace(/^\s+/, "");
    const dividerTrimmed = body.replace(/\n---\s*$/, "").trim();
    const bodyLines = dividerTrimmed.split("\n");
    const tags = bodyLines.length > 0 ? parseTagsLine(bodyLines[bodyLines.length - 1] ?? "") : [];
    const contentLines =
      tags.length > 0
        ? bodyLines.slice(0, Math.max(0, bodyLines.length - 1))
        : bodyLines;
    const splitIndex = heading.indexOf(" — ");
    const timestamp = splitIndex >= 0 ? heading.slice(0, splitIndex).trim() : heading;
    const title = splitIndex >= 0 ? heading.slice(splitIndex + 3).trim() : null;
    entries.push(
      buildDreamEntry({
        timestamp,
        title,
        body: contentLines.join("\n"),
        tags,
        sourceOffset: start,
      }),
    );
  }
  return entries;
}

function parseDreamEntries(content: string): DreamEntry[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(DIARY_START_MARKER);
  const end = normalized.indexOf(DIARY_END_MARKER);
  if (start >= 0 && end > start) {
    const inner = normalized.slice(start + DIARY_START_MARKER.length, end);
    return finalizeDreamEntries(
      splitDiaryBlocks(inner)
      .map(({ block, sourceOffset }) =>
        parseDiaryBlock(block, start + DIARY_START_MARKER.length + sourceOffset))
      .filter((entry): entry is ParsedDreamEntry => entry !== null),
    );
  }
  return finalizeDreamEntries(parseLegacyHeadingEntries(normalized));
}

function renderDiary(entries: Array<Omit<DreamEntry, "id" | "sourceOffset">>): string {
  const blocks = entries
    .map((entry) => renderAppendBlock(entry))
    .join("\n")
    .trimEnd();
  return [
    "# Dream Diary",
    "",
    DIARY_START_MARKER,
    blocks,
    "",
    DIARY_END_MARKER,
    "",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

function ensureDiary(content: string): string {
  if (content.includes(DIARY_START_MARKER) && content.includes(DIARY_END_MARKER)) {
    return content;
  }
  const legacyEntries = parseLegacyHeadingEntries(content.replace(/\r\n/g, "\n"));
  if (legacyEntries.length > 0) {
    return renderDiary(
      legacyEntries.map((entry) => ({
        timestamp: entry.timestamp,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
      })),
    );
  }
  return renderDiary([]);
}

function renderAppendBlock(entry: Omit<DreamEntry, "id" | "sourceOffset">): string {
  const titlePart = entry.title?.trim() ? ` — ${entry.title.trim()}` : "";
  const tagsPart = entry.tags.length > 0 ? `\n\nTags: ${entry.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  return `---\n\n*${entry.timestamp}${titlePart}*\n\n${entry.body.trim()}${tagsPart}\n`;
}

function serializeAppend<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const next = current.then(
    () => undefined,
    () => undefined,
  );
  appendQueues.set(key, next);
  next.finally(() => {
    if (appendQueues.get(key) === next) appendQueues.delete(key);
  });
  return current;
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // Best-effort cleanup; the original file remains untouched if rename failed.
    }
    throw error;
  }
}

export function createDreamsSurface(): DreamsSurface {
  return {
    async read(filePath: string): Promise<DreamEntry[]> {
      try {
        const content = await readFile(filePath, "utf8");
        return parseDreamEntries(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },

    async append(
      filePath: string,
      entry: Omit<DreamEntry, "id" | "sourceOffset">,
    ): Promise<DreamEntry> {
      return serializeAppend(filePath, async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        let content = "";
        try {
          content = await readFile(filePath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const ensured = ensureDiary(content);
        const endIndex = ensured.indexOf(DIARY_END_MARKER);
        const block = renderAppendBlock(entry);
        const updated =
          endIndex >= 0
            ? `${ensured.slice(0, endIndex)}${block}\n${ensured.slice(endIndex)}`
            : `${ensureDiary("")}${block}`;
        const normalized = updated.endsWith("\n") ? updated : `${updated}\n`;
        await atomicWriteUtf8(filePath, normalized);
        const entries = parseDreamEntries(normalized);
        return entries[entries.length - 1]!;
      });
    },

    watch(filePath: string, onChange: (entries: DreamEntry[]) => void): () => void {
      let fileWatcher: FSWatcher | null = null;
      let parentWatcher: FSWatcher | null = null;
      let timer: NodeJS.Timeout | null = null;
      const watchedName = path.basename(filePath);
      const watchedDir = path.dirname(filePath);

      const resolveParentWatchTarget = (): { dir: string; expectedName: string } | null => {
        let candidateDir = watchedDir;
        while (true) {
          try {
            if (statSync(candidateDir).isDirectory()) {
              const relative = path.relative(candidateDir, watchedDir);
              return {
                dir: candidateDir,
                expectedName:
                  relative.length === 0
                    ? watchedName
                    : (relative.split(path.sep)[0] ?? watchedName),
              };
            }
          } catch {}
          const parentDir = path.dirname(candidateDir);
          if (parentDir === candidateDir) {
            return null;
          }
          candidateDir = parentDir;
        }
      };

      const rearmFileWatcher = () => {
        fileWatcher?.close();
        fileWatcher = null;
        try {
          fileWatcher = watch(filePath, { persistent: false }, emit);
        } catch {
          fileWatcher = null;
        }
      };

      const ensureParentWatcher = () => {
        if (parentWatcher) return;
        const target = resolveParentWatchTarget();
        if (!target) return;
        try {
          parentWatcher = watch(
            target.dir,
            { persistent: false },
            (_eventType, changed) => {
              if (changed && String(changed) !== target.expectedName) return;
              parentWatcher?.close();
              parentWatcher = null;
              ensureParentWatcher();
              rearmFileWatcher();
              if (target.expectedName === watchedName || fileWatcher) {
                emit();
              }
            },
          );
        } catch {
          parentWatcher = null;
        }
      };

      const emit = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          try {
            rearmFileWatcher();
            onChange(await this.read(filePath));
          } catch (error) {
            console.warn("[remnic] dreams surface watch update failed", error);
          }
        }, 25);
      };
      rearmFileWatcher();
      ensureParentWatcher();
      return () => {
        if (timer) clearTimeout(timer);
        fileWatcher?.close();
        parentWatcher?.close();
      };
    },
  };
}
