/**
 * Skill bundle export / import commands (issue #2369) — registered as
 * `remnic export skills` and `remnic import skills <dir>`.
 *
 * Lives outside cli.ts (which is at its structural ceiling) and mirrors the
 * registerMeetingsCommands seam: one registrar, no behavior of its own beyond
 * option parsing and rendering. All projection, path safety, and persistence
 * live in `procedural/skill-projection.ts` + `procedural/skill-io.ts`, so the
 * CLI and the Codex materializer share one contract.
 */

import type { CliCommand } from "../cli.js";
import type { Orchestrator } from "../orchestrator.js";
import {
  exportSkillBundles,
  persistImportedSkills,
  readSkillBundlesFromDir,
} from "../procedural/skill-io.js";
import { projectProceduresToSkills } from "../procedural/skill-projection.js";
import { BUILTIN_SKILLS } from "../skills-registry.js";
import { expandTildePath } from "../utils/path.js";

/**
 * Parse `--max-skills`. Rejects non-integers and negatives rather than
 * silently defaulting (Review Prevention Checklist §1, §39); `0` is honored as
 * the documented disable value (§33).
 */
function parseMaxSkills(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid --max-skills '${String(raw)}'. Expected a non-negative integer (0 exports nothing).`);
  }
  return value;
}

export function registerSkillsCommands(
  exportCmd: CliCommand,
  importCmd: CliCommand,
  orchestrator: Orchestrator,
): void {
  exportCmd
    .command("skills")
    .description(
      "Export active procedure memories as portable skills/<slug>/SKILL.md bundles (issue #2369). Read-only with respect to memory.",
    )
    .option("--out <dir>", "Output directory (e.g. a host skills dir or a git repo)")
    .option("--max-skills <n>", "Cap on exported bundles (0 exports none; default from config)")
    .option("--namespace <ns>", "Namespace to export (default: config defaultNamespace)", "")
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as Record<string, unknown>;
      const out = options.out ? String(options.out) : "";
      if (!out) {
        console.error("Missing --out. Example: remnic export skills --out ./exported-skills");
        process.exitCode = 1;
        return;
      }
      if (orchestrator.config.procedural.enabled !== true) {
        console.error(
          "procedural memory is disabled (procedural.enabled=false); there are no procedure memories to export.",
        );
        process.exitCode = 1;
        return;
      }
      let maxSkills: number;
      try {
        maxSkills = parseMaxSkills(options.maxSkills, orchestrator.config.procedural.skillProjection.maxSkills);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      const namespace = options.namespace ? String(options.namespace) : "";
      const storage = await orchestrator.getStorageForNamespace(namespace || undefined);
      const bundles = projectProceduresToSkills(await storage.readAllMemories(), {
        maxSkills,
        reservedSlugs: BUILTIN_SKILLS.map((skill) => skill.slug),
      });
      const result = await exportSkillBundles({ bundles, outDir: expandTildePath(out) });
      console.log(`Exported ${result.slugs.length} skill bundle(s) to ${result.outDir}`);
      for (const slug of result.slugs) {
        console.log(`  ${slug}/SKILL.md`);
      }
      console.log("OK");
    });

  importCmd
    .command("skills <dir>")
    .description(
      "Import skills/<slug>/SKILL.md bundles as pending_review procedure memories (issue #2369). Never executes bundle scripts.",
    )
    .option("--namespace <ns>", "Namespace to import into (default: config defaultNamespace)", "")
    .action(async (...args: unknown[]) => {
      const dir = args[0] ? String(args[0]) : "";
      const options = (args[1] ?? {}) as Record<string, unknown>;
      if (!dir) {
        console.error("Usage: remnic import skills <dir>");
        process.exitCode = 1;
        return;
      }
      if (orchestrator.config.procedural.enabled !== true) {
        console.error(
          "procedural memory is disabled (procedural.enabled=false); enable it before importing procedures.",
        );
        process.exitCode = 1;
        return;
      }

      let read;
      try {
        read = await readSkillBundlesFromDir(expandTildePath(dir));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      for (const skip of read.skipped) {
        console.log(`Skipped ${skip.entry}: ${skip.reason}`);
      }
      if (read.bundles.length === 0) {
        console.log("No SKILL.md bundles found.");
        console.log("OK");
        return;
      }

      const namespace = options.namespace ? String(options.namespace) : "";
      const storage = await orchestrator.getStorageForNamespace(namespace || undefined);
      const { imported, rejected } = await persistImportedSkills({ storage, bundles: read.bundles });

      // Direct writes bypass extraction, so the search index needs an explicit
      // refresh or imported procedures stay undiscoverable (§31).
      await orchestrator.qmd.probe();
      if (orchestrator.qmd.isAvailable()) {
        await orchestrator.qmd.update();
      } else {
        console.log(`QMD unavailable in this process; skipped reindex. Status: ${orchestrator.qmd.debugStatus()}`);
      }

      console.log(`Imported ${imported.length} procedure(s) as pending_review (promote after review).`);
      for (const record of imported) {
        const resources = record.hasUnimportedResources ? " [has unimported resources]" : "";
        console.log(`  ${record.slug}: ${record.steps} step(s)${resources}`);
      }
      for (const reject of rejected) {
        console.log(`  ${reject.slug}: ${reject.reason}`);
      }
      console.log("OK");
    });
}
