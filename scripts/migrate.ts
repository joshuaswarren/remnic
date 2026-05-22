/**
 * Migration script: Import memories from existing systems into Engram.
 *
 * Sources:
 * 1. Context files (~/.openclaw/workspace/context/*.md) → seed profile + entities
 * 2. Supermemory daily logs (~/.openclaw/workspace/memory/*.md) → extract facts
 * 3. Honcho API (conclusions from owner peer) → extract processed facts
 *
 * Deduplication:
 * - Loads all existing engram facts into a normalized text index
 * - Each new candidate is checked against existing + previously imported in this run
 * - Skips duplicates and near-duplicates (normalized substring match)
 *
 * Usage: npx tsx scripts/migrate.ts [--dry-run] [--source context|supermemory|honcho|all]
 */

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { makeMigrationMemoryId, writeMemoryFileWithRetry } from "./migrate-utils.js";

const MEMORY_DIR = path.join(
  process.env.HOME ?? "~",
  ".openclaw",
  "workspace",
  "memory",
  "local",
);
const CONTEXT_DIR = path.join(
  process.env.HOME ?? "~",
  ".openclaw",
  "workspace",
  "context",
);
const SUPERMEMORY_DIR = path.join(
  process.env.HOME ?? "~",
  ".openclaw",
  "workspace",
  "memory",
);

const args = process.argv.slice(2);
type MigrationSource = "context" | "supermemory" | "honcho" | "all";

const VALID_SOURCES = new Set<MigrationSource>([
  "context",
  "supermemory",
  "honcho",
  "all",
]);

function parseSource(value: string | undefined): MigrationSource {
  if (!value || value.startsWith("--")) {
    throw new Error("--source requires a value: context|supermemory|honcho|all");
  }
  if (!VALID_SOURCES.has(value as MigrationSource)) {
    throw new Error(
      `--source must be one of context|supermemory|honcho|all; got ${JSON.stringify(value)}`,
    );
  }
  return value as MigrationSource;
}

function parseArgs(rawArgs: string[]): { dryRun: boolean; source: MigrationSource } {
  let dryRun = false;
  let source: MigrationSource = "all";
  let sawSource = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--source") {
      if (sawSource) throw new Error("--source may only be provided once");
      source = parseSource(rawArgs[i + 1]);
      sawSource = true;
      i++;
      continue;
    }
    if (arg.startsWith("--source=")) {
      if (sawSource) throw new Error("--source may only be provided once");
      source = parseSource(arg.slice("--source=".length));
      sawSource = true;
      continue;
    }

    throw new Error(
      arg.startsWith("--")
        ? `Unknown argument: ${arg}`
        : `Unexpected argument: ${arg}`,
    );
  }

  return { dryRun, source };
}

let parsedArgs: { dryRun: boolean; source: MigrationSource };
try {
  parsedArgs = parseArgs(args);
} catch (err) {
  console.error(`Invalid arguments: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const { dryRun, source } = parsedArgs;

interface MigrationStats {
  contextFiles: number;
  profileSeeded: boolean;
  entitiesCreated: number;
  factsCreated: number;
  duplicatesSkipped: number;
  honchoConclusions: number;
  supermemoryFacts: number;
  errors: string[];
}

const stats: MigrationStats = {
  contextFiles: 0,
  profileSeeded: false,
  entitiesCreated: 0,
  factsCreated: 0,
  duplicatesSkipped: 0,
  honchoConclusions: 0,
  supermemoryFacts: 0,
  errors: [],
};

// ── Dedup index ──────────────────────────────────────────────────────────

/** Normalize text for dedup comparison: lowercase, strip markdown, collapse whitespace */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\*\*([^*]+)\*\*/g, "$1") // strip bold
    .replace(/\*([^*]+)\*/g, "$1") // strip italic
    .replace(/`([^`]+)`/g, "$1") // strip inline code
    .replace(/[#\-*>]/g, " ") // strip markdown chars
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
}

/** Set of normalized strings for dedup. Checks both exact and substring containment. */
class DedupIndex {
  private entries: Set<string> = new Set();
  private longEntries: string[] = []; // for substring checks

  add(text: string): void {
    const n = normalize(text);
    if (n.length < 5) return;
    this.entries.add(n);
    if (n.length > 30) {
      this.longEntries.push(n);
    }
  }

  /** Returns true if text is a duplicate or near-duplicate of something already indexed */
  isDuplicate(text: string): boolean {
    const n = normalize(text);
    if (n.length < 5) return true; // too short to be useful

    // Exact match
    if (this.entries.has(n)) return true;

    // Check if the new text is a substring of an existing entry or vice versa
    for (const existing of this.longEntries) {
      if (existing.includes(n) || n.includes(existing)) {
        return true;
      }
    }

    return false;
  }
}

const dedupIndex = new DedupIndex();

// ── Load existing engram facts ───────────────────────────────────────────

async function loadExistingFacts(): Promise<number> {
  let count = 0;
  const factsDir = path.join(MEMORY_DIR, "facts");

  if (!existsSync(factsDir)) return 0;

  const dateDirs = await readdir(factsDir).catch(() => []);
  for (const dateDir of dateDirs) {
    const dayPath = path.join(factsDir, dateDir);
    const files = await readdir(dayPath).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(dayPath, file), "utf-8");
        // Extract the body after YAML frontmatter
        const parts = content.split("---");
        if (parts.length >= 3) {
          const body = parts.slice(2).join("---").trim();
          dedupIndex.add(body);
          count++;
        }
      } catch {
        // skip unreadable
      }
    }
  }

  // Also load corrections
  const correctionsDir = path.join(MEMORY_DIR, "corrections");
  if (existsSync(correctionsDir)) {
    const files = await readdir(correctionsDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(
          path.join(correctionsDir, file),
          "utf-8",
        );
        const parts = content.split("---");
        if (parts.length >= 3) {
          dedupIndex.add(parts.slice(2).join("---").trim());
          count++;
        }
      } catch {
        // skip
      }
    }
  }

  return count;
}

// ── File writing ─────────────────────────────────────────────────────────

async function ensureDirs(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await mkdir(path.join(MEMORY_DIR, "facts", today), { recursive: true });
  await mkdir(path.join(MEMORY_DIR, "corrections"), { recursive: true });
  await mkdir(path.join(MEMORY_DIR, "entities"), { recursive: true });
  await mkdir(path.join(MEMORY_DIR, "state"), { recursive: true });
}

function buildFrontmatter(opts: {
  id: string;
  category: string;
  source: string;
  confidence: number;
  tags: string[];
}): string {
  return [
    "---",
    `id: ${opts.id}`,
    `category: ${opts.category}`,
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    `source: ${opts.source}`,
    `confidence: ${opts.confidence}`,
    `tags: ${JSON.stringify(opts.tags)}`,
    "---",
  ].join("\n");
}

/** Write a fact if it's not a duplicate. Returns true if written, false if skipped. */
async function writeFact(
  body: string,
  opts: {
    prefix: string;
    source: string;
    confidence: number;
    tags: string[];
    category?: string;
  },
): Promise<boolean> {
  if (dedupIndex.isDuplicate(body)) {
    stats.duplicatesSkipped++;
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  const category = opts.category ?? "fact";
  const subdir = category === "correction" ? "corrections" : `facts/${today}`;
  await writeMemoryFileWithRetry({
    memoryDir: MEMORY_DIR,
    dryRun,
    subdir,
    prefix: opts.prefix,
    makeId: makeMigrationMemoryId,
    buildContent: (id) => {
      const fm = buildFrontmatter({
        id,
        category,
        source: opts.source,
        confidence: opts.confidence,
        tags: opts.tags,
      });
      return `${fm}\n\n${body}\n`;
    },
  });

  dedupIndex.add(body);
  stats.factsCreated++;
  return true;
}

// ── Source 1: Context files ──────────────────────────────────────────────

async function migrateContextFiles(): Promise<void> {
  console.log("\n=== Migrating context files ===\n");

  let files: string[];
  try {
    files = await readdir(CONTEXT_DIR);
  } catch {
    console.log("  No context directory found. Skipping.");
    return;
  }

  const mdFiles = files.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) {
    console.log("  No context files found.");
    return;
  }

  const profileSections: string[] = [];

  for (const file of mdFiles) {
    const filePath = path.join(CONTEXT_DIR, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const baseName = file.replace(".md", "");
      stats.contextFiles++;

      console.log(`  Processing: ${file} (${content.length} chars)`);

      // Extract bullet points as facts
      const lines = content.split("\n");
      const bullets = lines
        .filter((l) => l.match(/^[-*]\s+/))
        .map((l) => l.replace(/^[-*]\s+/, "").trim())
        .filter((l) => l.length > 5);

      let written = 0;
      for (const bullet of bullets) {
        const ok = await writeFact(bullet, {
          prefix: `ctx-${baseName}`,
          source: "migration-context",
          confidence: 0.85,
          tags: ["migrated", baseName],
        });
        if (ok) written++;
      }
      console.log(
        `    → ${written} new facts (${bullets.length - written} duplicates skipped)`,
      );

      // Add content summary to profile
      if (content.length > 20) {
        profileSections.push(`## ${baseName}\n\n${content.trim()}`);
      }
    } catch (err) {
      stats.errors.push(`Failed to read ${file}: ${err}`);
    }
  }

  // Seed profile.md (only if it doesn't exist)
  const profilePath = path.join(MEMORY_DIR, "profile.md");
  if (profileSections.length > 0 && !existsSync(profilePath)) {
    const profileContent = [
      "# Behavioral Profile",
      "",
      `*Last updated: ${new Date().toISOString()}*`,
      `*Seeded from ${stats.contextFiles} context files during migration*`,
      "",
      ...profileSections,
      "",
    ].join("\n");

    if (dryRun) {
      console.log(
        `  [dry-run] Would write profile.md (${profileContent.length} chars)`,
      );
    } else {
      await writeFile(profilePath, profileContent, "utf-8");
    }
    stats.profileSeeded = true;
    console.log(`  Profile seeded from ${profileSections.length} sections`);
  } else if (existsSync(profilePath)) {
    console.log("  Profile already exists — skipping seed.");
  }
}

// ── Source 2: Supermemory daily logs ─────────────────────────────────────

async function migrateSupermemory(): Promise<void> {
  console.log("\n=== Migrating Supermemory daily logs ===\n");

  if (!existsSync(SUPERMEMORY_DIR)) {
    console.log("  No memory directory found. Skipping.");
    return;
  }

  let files: string[];
  try {
    files = await readdir(SUPERMEMORY_DIR);
  } catch {
    console.log("  Cannot read memory directory. Skipping.");
    return;
  }

  const mdFiles = files
    .filter((f) => f.endsWith(".md") && f.match(/^\d{4}-\d{2}-\d{2}/))
    .sort();

  if (mdFiles.length === 0) {
    console.log("  No daily log files found.");
    return;
  }

  console.log(`  Found ${mdFiles.length} daily log files`);

  for (const file of mdFiles) {
    const filePath = path.join(SUPERMEMORY_DIR, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const dateStr = file.replace(".md", "");

      // Extract meaningful bullets (skip checkpoint/receipt metadata)
      const lines = content.split("\n");
      const bullets: string[] = [];

      let inCheckpoint = false;
      for (const line of lines) {
        const trimmed = line.trim();

        // Skip checkpoint/receipt system metadata
        if (
          trimmed.match(
            /^\d{2}:\d{2}\s+(Checkpoint|Receipt|Heartbeat|System):/i,
          )
        ) {
          inCheckpoint = true;
          continue;
        }

        // Skip header lines
        if (trimmed.startsWith("# ")) {
          inCheckpoint = false;
          continue;
        }

        // New section header resets checkpoint mode
        if (trimmed.startsWith("## ")) {
          inCheckpoint = false;
          // Section headers themselves aren't facts
          continue;
        }

        // Skip if we're in a checkpoint block
        if (inCheckpoint && trimmed.startsWith("- ")) continue;

        // Extract bullets that look like real facts
        if (trimmed.match(/^[-*]\s+/) && !inCheckpoint) {
          const bullet = trimmed.replace(/^[-*]\s+/, "").trim();
          // Skip very short or system-like entries
          if (bullet.length > 10 && !bullet.match(/^(Cron|Git|Repo|Modified)/i)) {
            bullets.push(bullet);
          }
        }
      }

      if (bullets.length === 0) {
        console.log(`  ${file}: no extractable facts`);
        continue;
      }

      let written = 0;
      for (const bullet of bullets) {
        // Determine category from content
        let category = "fact";
        let confidence = 0.8;

        if (
          bullet.match(
            /\b(prefer|don't|do not|always|never|instead of|rather than)\b/i,
          )
        ) {
          category = "preference";
          confidence = 0.85;
        }
        if (
          bullet.match(
            /\b(actually|correction|wrong|not true|mistake)\b/i,
          )
        ) {
          category = "correction";
          confidence = 0.9;
        }

        const ok = await writeFact(bullet, {
          prefix: `sm-${dateStr}`,
          source: "migration-supermemory",
          confidence,
          tags: ["migrated", "supermemory", dateStr],
          category,
        });
        if (ok) written++;
      }

      stats.supermemoryFacts += written;
      console.log(
        `  ${file}: ${written} new facts (${bullets.length - written} duplicates skipped)`,
      );
    } catch (err) {
      stats.errors.push(`Failed to read ${file}: ${err}`);
    }
  }
}

// ── Source 3: Honcho API ─────────────────────────────────────────────────

async function migrateHoncho(): Promise<void> {
  console.log("\n=== Migrating Honcho conclusions ===\n");

  // Load API key from environment or .env file
  let apiKey = process.env.HONCHO_API_KEY;

  if (!apiKey) {
    // Try reading from .env file
    const envPath = path.join(
      process.env.HOME ?? "~",
      ".openclaw",
      ".env",
    );
    try {
      const envContent = await readFile(envPath, "utf-8");
      const match = envContent.match(/^HONCHO_API_KEY=(.+)$/m);
      if (match) {
        apiKey = match[1].trim();
      }
    } catch {
      // .env not found
    }
  }

  if (!apiKey) {
    console.log("  HONCHO_API_KEY not found in environment or ~/.openclaw/.env");
    console.log("  Skipping Honcho migration.");
    return;
  }

  console.log("  Honcho API key found. Connecting...");

  try {
    // Dynamic import to avoid requiring the SDK when not migrating honcho
    const { Honcho } = await import("@honcho-ai/sdk");

    const honcho = new Honcho({
      apiKey,
      workspaceId: "openclaw",
    });

    // Get the owner peer (user-facing conclusions)
    const ownerPeer = await honcho.peer("owner");
    console.log(`  Connected. Peer: owner (${ownerPeer.id})`);

    // List all self-conclusions (paginated)
    let page = 1;
    let totalConclusions = 0;
    let hasMore = true;

    while (hasMore) {
      const conclusionsPage = await ownerPeer.conclusions.list({
        page,
        size: 50,
      });

      const items = conclusionsPage.items ?? [];
      if (items.length === 0) {
        hasMore = false;
        break;
      }

      for (const conclusion of items) {
        totalConclusions++;
        const content = conclusion.content?.trim();
        if (!content || content.length < 10) continue;

        // Determine category from content
        let category = "fact";
        let confidence = 0.8;

        if (
          content.match(
            /\b(prefer|don't|do not|always|never|instead of|rather than|wants?|likes?|dislikes?)\b/i,
          )
        ) {
          category = "preference";
          confidence = 0.85;
        }
        if (
          content.match(
            /\b(actually|correction|wrong|not true|mistake|corrected)\b/i,
          )
        ) {
          category = "correction";
          confidence = 0.9;
        }
        if (
          content.match(
            /\b(decided|decision|chose|going with|settled on)\b/i,
          )
        ) {
          category = "decision";
          confidence = 0.85;
        }

        const ok = await writeFact(content, {
          prefix: "honcho",
          source: "migration-honcho",
          confidence,
          tags: ["migrated", "honcho"],
          category,
        });
        if (ok) stats.honchoConclusions++;
      }

      // Check pagination
      if (items.length < 50) {
        hasMore = false;
      } else {
        page++;
      }

      process.stdout.write(
        `\r  Processed ${totalConclusions} conclusions (${stats.honchoConclusions} new, ${stats.duplicatesSkipped} dupes so far)`,
      );
    }

    console.log(
      `\n  Honcho: ${totalConclusions} total conclusions → ${stats.honchoConclusions} new facts`,
    );

    // Also get the owner's representation (processed summary)
    try {
      const representation = await ownerPeer.representation({
        maxConclusions: 100,
      });
      if (representation && representation.length > 50) {
        console.log(
          `  Got owner representation (${representation.length} chars)`,
        );
        // Store as a special reference file (not deduplicated against)
        if (!dryRun) {
          const refPath = path.join(
            MEMORY_DIR,
            "honcho-representation.md",
          );
          await writeFile(
            refPath,
            `# Honcho Representation (migrated)\n\n*Exported: ${new Date().toISOString()}*\n\n${representation}\n`,
            "utf-8",
          );
          console.log("  Saved representation to honcho-representation.md");
        }
      }
    } catch (err) {
      console.log(`  Could not fetch representation: ${err}`);
    }

    // Try the openclaw peer's conclusions about the owner too
    try {
      const clawPeer = await honcho.peer("openclaw");
      const clawConclusions = clawPeer.conclusionsOf("owner");
      let clawPage = 1;
      let clawMore = true;
      let clawTotal = 0;

      while (clawMore) {
        const cPage = await clawConclusions.list({
          page: clawPage,
          size: 50,
        });
        const cItems = cPage.items ?? [];
        if (cItems.length === 0) {
          clawMore = false;
          break;
        }

        for (const c of cItems) {
          clawTotal++;
          const content = c.content?.trim();
          if (!content || content.length < 10) continue;

          const ok = await writeFact(content, {
            prefix: "honcho-claw",
            source: "migration-honcho-openclaw",
            confidence: 0.75,
            tags: ["migrated", "honcho", "openclaw-observed"],
          });
          if (ok) stats.honchoConclusions++;
        }

        if (cItems.length < 50) {
          clawMore = false;
        } else {
          clawPage++;
        }
      }

      if (clawTotal > 0) {
        console.log(
          `  OpenClaw→Owner conclusions: ${clawTotal} processed`,
        );
      }
    } catch (err) {
      console.log(`  Could not fetch openclaw peer conclusions: ${err}`);
    }
  } catch (err) {
    stats.errors.push(`Honcho migration failed: ${err}`);
    console.error(`  Honcho migration error: ${err}`);
  }
}

// ── State management ─────────────────────────────────────────────────────

async function updateMetaState(): Promise<void> {
  const metaPath = path.join(MEMORY_DIR, "state", "meta.json");

  // Read existing meta if available
  let meta: Record<string, unknown> = {
    extractionCount: 0,
    lastExtractionAt: null,
    lastConsolidationAt: null,
    totalMemories: 0,
    totalEntities: 0,
  };

  try {
    const existing = await readFile(metaPath, "utf-8");
    meta = JSON.parse(existing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`failed to read existing migration meta state at ${metaPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Count total memories on disk
  let totalMemories = 0;
  const factsDir = path.join(MEMORY_DIR, "facts");
  if (existsSync(factsDir)) {
    const dateDirs = await readdir(factsDir).catch(() => []);
    for (const d of dateDirs) {
      const files = await readdir(path.join(factsDir, d)).catch(() => []);
      totalMemories += files.filter((f) => f.endsWith(".md")).length;
    }
  }
  const correctionsDir = path.join(MEMORY_DIR, "corrections");
  if (existsSync(correctionsDir)) {
    const files = await readdir(correctionsDir).catch(() => []);
    totalMemories += files.filter((f) => f.endsWith(".md")).length;
  }

  meta.totalMemories = totalMemories;

  if (dryRun) {
    console.log(
      `\n  [dry-run] Would update meta.json (totalMemories: ${totalMemories})`,
    );
    return;
  }

  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  // Ensure buffer.json exists
  const bufferPath = path.join(MEMORY_DIR, "state", "buffer.json");
  if (!existsSync(bufferPath)) {
    await writeFile(
      bufferPath,
      JSON.stringify(
        { turns: [], lastExtractionAt: null, extractionCount: 0 },
        null,
        2,
      ),
      "utf-8",
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("============================================");
  console.log("  Engram Migration Tool");
  console.log("============================================");
  console.log(`  Target:  ${MEMORY_DIR}`);
  console.log(`  Source:  ${source}`);
  console.log(`  Dry run: ${dryRun}`);

  if (!dryRun) {
    await ensureDirs();
  }

  // Load existing facts for dedup
  const existingCount = await loadExistingFacts();
  console.log(`  Existing facts loaded for dedup: ${existingCount}`);

  // Run selected sources
  if (source === "all" || source === "context") {
    await migrateContextFiles();
  }
  if (source === "all" || source === "supermemory") {
    await migrateSupermemory();
  }
  if (source === "all" || source === "honcho") {
    await migrateHoncho();
  }

  if (!dryRun) {
    await updateMetaState();
  }

  console.log("\n============================================");
  console.log("  Migration Report");
  console.log("============================================");
  console.log(`  Context files processed:  ${stats.contextFiles}`);
  console.log(`  Profile seeded:           ${stats.profileSeeded}`);
  console.log(`  New facts created:        ${stats.factsCreated}`);
  console.log(`    from Supermemory:       ${stats.supermemoryFacts}`);
  console.log(`    from Honcho:            ${stats.honchoConclusions}`);
  console.log(`  Duplicates skipped:       ${stats.duplicatesSkipped}`);
  console.log(`  Entities created:         ${stats.entitiesCreated}`);
  if (stats.errors.length > 0) {
    console.log(`  Errors: ${stats.errors.length}`);
    for (const err of stats.errors) {
      console.log(`    - ${err}`);
    }
  }
  console.log("============================================");

  if (!dryRun && stats.factsCreated > 0) {
    console.log("\nNext steps:");
    console.log("  1. Run: qmd update && qmd embed");
    console.log("  2. Restart gateway: kill -USR1 $(pgrep openclaw-gateway)");
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
