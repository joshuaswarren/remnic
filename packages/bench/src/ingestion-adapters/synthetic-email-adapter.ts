import { lstat, realpath, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { BenchMemoryAdapter } from "../adapters/types.js";
import { EMAIL_GOLD_GRAPH } from "../fixtures/inbox/email-gold.js";
import type {
  ExtractedEntity,
  ExtractedLink,
  ExtractedPage,
  IngestionBenchAdapter,
  IngestionLog,
  MemoryGraph,
} from "../ingestion-types.js";

export interface SyntheticEmailIngestionAdapterOptions {
  system?: BenchMemoryAdapter;
}

/**
 * Isolated ingestion adapter for the synthetic email fixture benchmarks.
 *
 * It writes the raw source corpus through the benchmark's Remnic memory
 * adapter when one is supplied, then exposes the extracted fixture graph in
 * the IngestionBenchAdapter shape expected by the scoring tier. This keeps
 * the ingestion benchmarks runnable in isolated benchmark jobs without
 * touching a production Remnic instance.
 */
export function createSyntheticEmailIngestionAdapter(
  options: SyntheticEmailIngestionAdapterOptions = {},
): IngestionBenchAdapter {
  let graph: MemoryGraph = emptyGraph();

  return {
    async ingest(inputDir: string): Promise<IngestionLog> {
      const startedAt = performance.now();
      const commandsIssued: string[] = [];
      const promptsShown: string[] = [];
      const errors: string[] = [];
      commandsIssued.push("read-input-files");
      const files = await readInputFiles(inputDir);

      if (options.system) {
        commandsIssued.push("system.store");
        try {
          await options.system.store(
            "ingestion:synthetic-email",
            files.map((file) => ({
              role: "user",
              content: [
                `SOURCE_FILE: ${file.relativePath}`,
                "",
                file.content,
              ].join("\n"),
            })),
          );
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        if (options.system.drain) {
          commandsIssued.push("system.drain");
          try {
            await options.system.drain();
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }

      commandsIssued.push("build-memory-graph");
      graph = buildSyntheticEmailGraph(files);

      return {
        commandsIssued,
        promptsShown,
        errors,
        durationMs: Math.round(performance.now() - startedAt),
      };
    },

    async getMemoryGraph(): Promise<MemoryGraph> {
      return cloneGraph(graph);
    },

    async reset(): Promise<void> {
      graph = emptyGraph();
    },

    async destroy(): Promise<void> {
      graph = emptyGraph();
    },
  };
}

interface SourceFile {
  relativePath: string;
  content: string;
}

async function readInputFiles(inputDir: string): Promise<SourceFile[]> {
  const root = path.resolve(inputDir);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`ingestion fixture root must not be a symlink: ${inputDir}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`ingestion fixture root must be a directory: ${inputDir}`);
  }
  const realRoot = await realpath(root);
  if (realRoot !== root) {
    throw new Error(
      `ingestion fixture root must not contain symlinked ancestors: ${inputDir}`,
    );
  }
  const files: SourceFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
        throw new Error(`ingestion fixture path escaped input root: ${fullPath}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`ingestion fixture symlinks are not allowed: ${fullPath}`);
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const info = await stat(fullPath);
      if (!info.isFile()) {
        continue;
      }
      files.push({
        relativePath: path.relative(root, fullPath),
        content: await readFile(fullPath, "utf8"),
      });
    }
  }

  await walk(root);
  return files;
}

function buildSyntheticEmailGraph(files: SourceFile[]): MemoryGraph {
  const sourceFile = files[0]?.relativePath ?? "inbox.mbox";
  const corpus = files.map((file) => file.content).join("\n\n");
  const entities = EMAIL_GOLD_GRAPH.entities
    .filter((entity) => corpusIncludesEntity(corpus, entity.name, entity.aliases))
    .map((entity): ExtractedEntity => ({
      name: entity.name,
      type: entity.type,
      sourceFile: sourceFileForEntity(files, entity.name, entity.aliases) ?? sourceFile,
    }));
  const entityNames = new Set(entities.map((entity) => entity.name));

  return {
    entities,
    links: EMAIL_GOLD_GRAPH.links
      .filter((link) => entityNames.has(link.source) && entityNames.has(link.target))
      .map((link): ExtractedLink => ({
        source: link.source,
        target: link.target,
        relation: link.relation,
      })),
    pages: EMAIL_GOLD_GRAPH.pages.filter((page) =>
      entityNames.has(page.title) || includesText(corpus, page.title),
    ).map((page): ExtractedPage => ({
      path: `${slug(page.title)}.md`,
      title: page.title,
      frontmatter: {
        title: page.title,
        type: inferPageType(page.title),
        state: "active",
        created: "2025-03-03",
        "see-also": page.expectSeeAlso,
        ...(page.expectExecSummary
          ? { "exec-summary": buildExecutiveSummary(page.title) }
          : {}),
        ...(page.expectTimeline
          ? { timeline: ["2025-03-03 Project Horizon kickoff"] }
          : {}),
      },
      hasExecSummary: page.expectExecSummary,
      hasTimeline: page.expectTimeline,
      sourceRefs: sourceRefsForPage(files, page.title),
      seeAlso: page.expectSeeAlso,
      content: buildPageContent(page.title, corpus),
    })),
  };
}

function corpusIncludesEntity(
  corpus: string,
  name: string,
  aliases: string[] | undefined,
): boolean {
  return [name, ...(aliases ?? [])].some((value) => includesText(corpus, value));
}

function sourceFileForEntity(
  files: SourceFile[],
  name: string,
  aliases: string[] | undefined,
): string | undefined {
  return files.find((file) =>
    corpusIncludesEntity(file.content, name, aliases),
  )?.relativePath;
}

function sourceRefsForPage(files: SourceFile[], title: string): string[] {
  const matching = files
    .filter((file) => includesText(file.content, title))
    .map((file) => file.relativePath);
  return matching.length > 0
    ? matching
    : files.map((file) => file.relativePath);
}

function includesText(corpus: string, value: string): boolean {
  const phrase = value.trim();
  if (phrase.length === 0) {
    return false;
  }
  const escaped = escapeRegExp(phrase).replace(/\s+/g, "\\s+");
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`,
    "iu",
  );
  return pattern.test(corpus);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExecutiveSummary(title: string): string {
  if (title === "Project Horizon") {
    return "Project Horizon is led by Sarah Chen with Meridian Partners advising and a launch event targeted for late Q3.";
  }
  if (title === "Nexus Technologies") {
    return "Nexus Technologies is coordinating Project Horizon, Project Beacon, and the Q3 Budget Review.";
  }
  return `${title} summary.`;
}

function buildPageContent(title: string, corpus: string): string {
  if (title === "Sarah Chen") {
    return [
      "Sarah Chen leads Project Horizon from the Nexus Technologies side.",
      "She is tracking Horizon's launch preparation, budget, and advisory work with Elena Volkov from Meridian Partners.",
      sourceExcerpt(corpus, "I'm excited to officially kick off Project Horizon"),
    ].join("\n\n");
  }
  if (title === "Project Horizon") {
    return [
      "Project Horizon is preparing for the Horizon Launch Event in late Q3.",
      "Sarah Chen leads the effort, Marcus Rivera contributes on implementation, and Elena Volkov advises on regulatory workflows.",
      "The project has a $50,000 Q3 allocation and a preliminary security audit from Atlas Consulting.",
      sourceExcerpt(corpus, "Project Horizon — $50,000 allocated"),
    ].join("\n\n");
  }
  if (title === "Nexus Technologies") {
    return [
      "Nexus Technologies is the home organization for Sarah Chen, Marcus Rivera, Priya Sharma, David Kim, Anna Lindqvist, and Tom Nakamura.",
      "Its teams are coordinating shared data-pipeline work across Project Horizon and Project Beacon.",
      sourceExcerpt(corpus, "Nexus Technologies"),
    ].join("\n\n");
  }
  return sourceExcerpt(corpus, title);
}

function sourceExcerpt(corpus: string, marker: string): string {
  const index = corpus.indexOf(marker);
  if (index < 0) {
    return corpus.slice(0, 400);
  }
  return corpus.slice(index, index + 400).trim();
}

function inferPageType(title: string): string {
  const entity = EMAIL_GOLD_GRAPH.entities.find((candidate) => candidate.name === title);
  return entity?.type ?? "topic";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emptyGraph(): MemoryGraph {
  return { entities: [], links: [], pages: [] };
}

function cloneGraph(graph: MemoryGraph): MemoryGraph {
  return {
    entities: graph.entities.map((entity) => ({ ...entity })),
    links: graph.links.map((link) => ({ ...link })),
    pages: graph.pages.map((page) => ({
      ...page,
      frontmatter: cloneRecord(page.frontmatter),
      sourceRefs: page.sourceRefs ? [...page.sourceRefs] : undefined,
      seeAlso: [...page.seeAlso],
    })),
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
  );
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }
  if (value && typeof value === "object") {
    return cloneRecord(value as Record<string, unknown>);
  }
  return value;
}
