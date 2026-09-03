import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { InjectionSuiteCampaignDecision } from "./campaign.js";
import type { InjectionSuiteStatisticalAnalysis } from "./stats.js";
import type { InjectionSuiteUtilityAnalysis } from "./utility-stats.js";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function format(value: number | null): string {
  return value === null ? "NA" : value.toFixed(4);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function familyCsv(base: readonly InjectionSuiteStatisticalAnalysis[]): string {
  const rows = [[
    "model_profile",
    "family",
    "baseline_attack_rate",
    "fencing_block_rate",
    "fencing_wilson_lower_95",
    "quarantine_block_rate",
    "both_block_rate",
    "fencing_voids",
    "parity_mismatches",
    "holm_p",
  ]];
  for (const analysis of base) {
    for (const family of analysis.families) {
      rows.push([
        analysis.modelProfileId,
        family.family,
        format(family.baseline.rate),
        format(family.fencing.rate),
        format(family.fencing.wilsonLower95),
        format(family.quarantine.rate),
        format(family.both.rate),
        String(family.fencing.voids),
        String(family.parityMismatches),
        format(family.fencingVsQuarantineHolmP),
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function blockRateSvg(base: readonly InjectionSuiteStatisticalAnalysis[]): string {
  const entries = base.flatMap((analysis) => analysis.families.map((family) => ({
    label: `${analysis.modelProfileId} / ${family.family}`,
    fencing: family.fencing.rate,
    quarantine: family.quarantine.rate,
  })));
  const rowHeight = 52;
  const height = 80 + entries.length * rowHeight;
  const bars = entries.map((entry, index) => {
    const y = 55 + index * rowHeight;
    const label = entry.label.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    const fencingBar = entry.fencing === null
      ? `<text x="250" y="${y - 2}" font-size="12" fill="#6b7280">NA</text>`
      : `<rect x="250" y="${y - 14}" width="${Math.round(entry.fencing * 500)}" height="14" fill="#2563eb"/>`;
    const quarantineBar = entry.quarantine === null
      ? `<text x="250" y="${y + 15}" font-size="12" fill="#6b7280">NA</text>`
      : `<rect x="250" y="${y + 3}" width="${Math.round(entry.quarantine * 500)}" height="14" fill="#d97706"/>`;
    return [
      `<text x="10" y="${y}" font-size="12">${label}</text>`,
      fencingBar,
      quarantineBar,
    ].join("\n");
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}" role="img" aria-labelledby="title desc">
<title id="title">H5 block rates by model and family</title>
<desc id="desc">Blue bars are fencing-only block rates. Orange bars are quarantine-only block rates.</desc>
<rect width="100%" height="100%" fill="white"/>
<text x="250" y="20" font-size="12">0</text><text x="495" y="20" font-size="12">0.5</text><text x="745" y="20" font-size="12">1.0</text>
${bars}
<rect x="250" y="${height - 28}" width="14" height="14" fill="#2563eb"/><text x="270" y="${height - 16}" font-size="12">fencing</text>
<rect x="350" y="${height - 28}" width="14" height="14" fill="#d97706"/><text x="370" y="${height - 16}" font-size="12">quarantine</text>
</svg>\n`;
}

function reportMarkdown(input: {
  decision: InjectionSuiteCampaignDecision;
  base: readonly InjectionSuiteStatisticalAnalysis[];
  utility: readonly InjectionSuiteUtilityAnalysis[];
  adaptive: readonly InjectionSuiteStatisticalAnalysis[];
}): string {
  const claim = input.decision.h5 === "SUPPORTED"
    ? "Under the registered threat model, core Remnic blocked this frozen canary suite while satisfying the utility gate."
    : "The registered campaign did not support the full H5 claim.";
  const baseRows = input.base.map((analysis) =>
    `| ${analysis.modelProfileId} | ${analysis.decision} | ${analysis.observedRows}/${analysis.expectedRows} | ${analysis.invalidRows} |`,
  ).join("\n");
  const utilityRows = input.utility.map((analysis, index) =>
    `| ${input.base[index]?.modelProfileId ?? `profile-${index + 1}`} | ${format(analysis.relativeDelta)} | ${analysis.relativeBootstrap90 ? `${format(analysis.relativeBootstrap90.lower)} to ${format(analysis.relativeBootstrap90.upper)}` : "NA"} | ${analysis.equivalent ?? "NA"} |`,
  ).join("\n");
  const adaptiveRows = input.adaptive.length === 0
    ? "| not run | NOT_RUN |"
    : input.adaptive.map((analysis) => `| ${analysis.modelProfileId} | ${analysis.decision} |`).join("\n");
  return `# H5 origin-authority experiment report

Generated entirely from frozen run artifacts. Raw JSON controls every decision.

## Decision

- H5: **${input.decision.h5}**
- H5d: **${input.decision.h5d}**
- Recommended core mode: **${input.decision.recommendedCoreMode ?? "none"}**

${claim}

## Threat model

The attacker controls synthetic text entering user turns or trusted-host-labeled tool output, but not Remnic, model weights, filesystem, benchmark code, or canary checks. Claims are limited to this canary suite and first-round adaptation; this report does not claim the system is secure.

## Base runs

| Model profile | Decision | Rows | Invalid |
|---|---:|---:|---:|
${baseRows}

## Paired utility

| Model profile | Relative delta | 90% interval | Equivalent |
|---|---:|---:|---:|
${utilityRows}

## Adaptive r1

| Model profile | Decision |
|---|---:|
${adaptiveRows}

## Artifacts

- [Family results](tables/family-results.csv)
- [Block-rate figure](figures/block-rates.svg)
- Machine decision: campaign-decision.json
`;
}

export async function writeInjectionSuiteReport(input: {
  outputDir: string;
  decision: InjectionSuiteCampaignDecision;
  base: readonly InjectionSuiteStatisticalAnalysis[];
  utility: readonly InjectionSuiteUtilityAnalysis[];
  adaptive: readonly InjectionSuiteStatisticalAnalysis[];
}): Promise<void> {
  const paperDir = path.join(input.outputDir, "paper");
  await Promise.all([
    mkdir(path.join(paperDir, "tables"), { recursive: true }),
    mkdir(path.join(paperDir, "figures"), { recursive: true }),
  ]);
  const artifacts = {
    "report.md": reportMarkdown(input),
    "tables/family-results.csv": familyCsv(input.base),
    "figures/block-rates.svg": blockRateSvg(input.base),
  };
  for (const [relative, content] of Object.entries(artifacts)) {
    await writeFileAtomically(path.join(paperDir, relative), content);
  }
  const manifest = {
    schemaVersion: 1,
    decision: input.decision,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([relative, content]) => [relative, { sha256: sha256(content), bytes: Buffer.byteLength(content) }]),
    ),
  };
  await writeFileAtomically(
    path.join(paperDir, "report-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
