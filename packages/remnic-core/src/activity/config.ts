import path from "node:path";

import { coerceBooleanLike, coerceNumber } from "../connectors/coerce.js";
import { assertValidTimezone } from "./digest.js";
import { applyLegacyJournalHeading, validateJournalSectionName } from "./journal-heading.js";
import { publisherOwnedSectionNames } from "./journal-read.js";
import { checkVaultJournalPrerequisites } from "./journal-vault-prereq.js";
import { resolveJournalSource } from "./journal-source.js";
import { validateVaultNoteTemplate } from "./vault-path.js";
import { validateRegionName } from "./vault-region.js";
import { TIMELINE_ANALYSIS_DEFAULT_TIMEOUT_MS } from "./timeline/analysis.js";
import { ANALYSIS_METADATA_MAX_FIELD_LENGTH, isAnalysisIdentifier } from "./timeline/analysis-metadata.js";
import type {
  ActivityConfig,
  ActivityExtractionMode,
  ActivitySourceConfig,
  ActivityTimelineAnalysisConfig,
  ActivityTimelineConfig,
  ActivityTimelineJournalConfig,
  ActivityTimelineQaConfig,
  ActivityTimelineVaultConfig,
  ActivityTimelineVaultTargetConfig,
} from "./types.js";
import type { ImportanceLevel } from "../types.js";

const EXTRACTION_MODES: readonly ActivityExtractionMode[] = ["off", "smart"];
const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = ["critical", "high", "normal", "low", "trivial"];
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true };

/** The inert default: disabled, search-only, no sources, no extraction. */
export function defaultActivityConfig(): ActivityConfig {
  return {
    enabled: false,
    timezone: "UTC",
    syncDays: 1,
    autoSyncIntervalMinutes: 15,
    sources: [],
    extractionMode: "off",
    sourceTrust: 0.6,
    autoApproveTrust: 0.8,
    reviewTrust: 0.5,
    minConfidence: 0.7,
    minImportance: "normal",
    maxMemoriesPerDay: 0,
    timeline: {
      enabled: false,
      analysis: parseTimelineAnalysisConfig(undefined),
      journal: { enabled: false, source: "memoryDir", extractionMode: "off" },
      qa: { enabled: false, maxRangeDays: 31 },
      vault: parseTimelineVaultConfig(undefined),
    },
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function parseUnitInterval(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = coerceNumber(value);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RangeError(`activity.${key} must be a number in [0, 1]`);
  }
  return parsed;
}

/**
 * Parse, protocol-check, and confine an activity source base URL to a local
 * loopback host. Shared with ActivityHttpSourceClient so config-load and client
 * construction reject the exact same shapes with the same prefixed message. The
 * bearer token travels in an Authorization header, so a non-loopback baseUrl
 * would exfiltrate it; the subsystem contract is local capture daemons only.
 */
export function validateActivityBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RangeError(`activity source baseUrl must be a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("activity source baseUrl must use HTTP or HTTPS");
  }
  // URL keeps IPv6 hosts bracketed (e.g. "[::1]"); normalize before the lookup.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS[host] !== true && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    throw new RangeError(`activity source baseUrl must target a loopback host (got ${parsed.hostname})`);
  }
  return parsed;
}

function parseSource(value: unknown): ActivitySourceConfig {
  const raw = asRecord(value, "activity source");
  const machineLabel = optionalString(raw.machineLabel, "activity source machineLabel");
  const baseUrl = optionalString(raw.baseUrl, "activity source baseUrl");
  if (machineLabel === undefined || baseUrl === undefined) {
    throw new TypeError("activity source requires machineLabel and baseUrl");
  }
  // Reject whitespace-only labels here so config-load fails loudly rather than
  // parsing clean and then failing on the first sync (the client and pipeline
  // both reject a blank label via trim()).
  if (machineLabel.trim().length === 0) {
    throw new RangeError("activity source machineLabel must not be blank");
  }
  validateActivityBaseUrl(baseUrl);
  const token = optionalString(raw.token, "activity source token");
  return { machineLabel, baseUrl, ...(token === undefined ? {} : { token }) };
}

/**
 * Parse the unified `activity.*` block. `enabled` gates source ingestion (and
 * requires at least one source); `extractionMode` independently gates durable
 * trust-gated memory extraction (default `off`, i.e. search-only).
 */
export function parseActivityConfig(raw: unknown): ActivityConfig {
  const defaults = defaultActivityConfig();
  if (raw === undefined || raw === null) {
    return { ...defaults };
  }
  const config = asRecord(raw, "activity");
  const enabledValue = coerceBooleanLike(config.enabled, "activity.enabled");
  if (config.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("activity.enabled must be a boolean");
  }
  const timezone = optionalString(config.timezone, "activity.timezone") ?? "UTC";
  // Validate the IANA zone at parse so a typo fails before any daemon is
  // contacted; otherwise activityDayWindow() throws mid-sync after snapshot
  // pages may already be persisted, and every retry replays the same window.
  assertValidTimezone(timezone);
  const syncDaysValue = coerceNumber(config.syncDays, "activity.syncDays");
  if (config.syncDays !== undefined && syncDaysValue === undefined) {
    throw new TypeError("activity.syncDays must be a finite number");
  }
  const syncDays = syncDaysValue ?? 1;
  if (!Number.isInteger(syncDays) || syncDays < 1 || syncDays > 90) {
    throw new RangeError("activity.syncDays must be an integer from 1 to 90");
  }
  const intervalValue = coerceNumber(config.autoSyncIntervalMinutes, "activity.autoSyncIntervalMinutes");
  if (config.autoSyncIntervalMinutes !== undefined && intervalValue === undefined) {
    throw new TypeError("activity.autoSyncIntervalMinutes must be a finite number");
  }
  const autoSyncIntervalMinutes = intervalValue ?? 15;
  if (!Number.isInteger(autoSyncIntervalMinutes) || autoSyncIntervalMinutes < 1 || autoSyncIntervalMinutes > 1440) {
    throw new RangeError("activity.autoSyncIntervalMinutes must be an integer from 1 to 1440");
  }
  if (config.sources !== undefined && !Array.isArray(config.sources)) {
    throw new TypeError("activity.sources must be an array");
  }
  const sources = (config.sources ?? []).map(parseSource);
  // Cursors and row dedup are keyed on machineLabel alone; two sources sharing
  // a label would share a cursor and dedup namespace, silently skipping or
  // conflating snapshots. Reject the collision at parse.
  const labels = new Set<string>();
  for (const source of sources) {
    if (labels.has(source.machineLabel)) {
      throw new RangeError(`activity source machineLabel must be unique: ${source.machineLabel}`);
    }
    labels.add(source.machineLabel);
  }
  const enabled = enabledValue ?? false;
  if (enabled && sources.length === 0) throw new RangeError("activity.enabled requires at least one source");

  // Extraction gate (independent of `enabled` ingestion). Default `off`.
  // Default only for a missing key; an explicit null/non-string is a malformed
  // enum and must fail rather than silently disabling extraction.
  const extractionMode = config.extractionMode === undefined ? defaults.extractionMode : config.extractionMode;
  if (typeof extractionMode !== "string" || !EXTRACTION_MODES.includes(extractionMode as ActivityExtractionMode)) {
    throw new RangeError(`activity.extractionMode must be one of: ${EXTRACTION_MODES.join(", ")}`);
  }
  const minImportance = config.minImportance === undefined ? defaults.minImportance : config.minImportance;
  if (typeof minImportance !== "string" || !IMPORTANCE_LEVELS.includes(minImportance as ImportanceLevel)) {
    throw new RangeError(`activity.minImportance must be one of: ${IMPORTANCE_LEVELS.join(", ")}`);
  }
  // Default only for a missing key; an explicit null/unparseable value must fail
  // rather than silently uncapping (parity with the enum/unit-interval fields).
  const rawMaxMemoriesPerDay =
    config.maxMemoriesPerDay === undefined ? defaults.maxMemoriesPerDay : config.maxMemoriesPerDay;
  const maxMemoriesPerDay = coerceNumber(rawMaxMemoriesPerDay);
  if (maxMemoriesPerDay === undefined || !Number.isInteger(maxMemoriesPerDay) || maxMemoriesPerDay < 0) {
    throw new RangeError("activity.maxMemoriesPerDay must be a non-negative integer");
  }
  const autoApproveTrust = parseUnitInterval(config.autoApproveTrust, "autoApproveTrust", defaults.autoApproveTrust);
  const reviewTrust = parseUnitInterval(config.reviewTrust, "reviewTrust", defaults.reviewTrust);
  if (reviewTrust >= autoApproveTrust) {
    throw new RangeError(
      `activity.reviewTrust (${reviewTrust}) must be below autoApproveTrust (${autoApproveTrust})`,
    );
  }
  return {
    enabled,
    timezone,
    syncDays,
    autoSyncIntervalMinutes,
    sources,
    extractionMode: extractionMode as ActivityExtractionMode,
    sourceTrust: parseUnitInterval(config.sourceTrust, "sourceTrust", defaults.sourceTrust),
    autoApproveTrust,
    reviewTrust,
    minConfidence: parseUnitInterval(config.minConfidence, "minConfidence", defaults.minConfidence),
    minImportance: minImportance as ImportanceLevel,
    maxMemoriesPerDay,
    timeline: parseTimelineConfig(config.timeline),
  };
}

/**
 * Parse the `activity.timeline.*` block. `enabled` is the master gate for
 * timeline-card derivation (issue #2049); default false. A non-object block
 * is malformed and must fail rather than silently disabling the layer.
 */
function parseTimelineConfig(raw: unknown): ActivityTimelineConfig {
  if (raw === undefined) {
    return {
      enabled: false,
      analysis: parseTimelineAnalysisConfig(undefined),
      journal: { enabled: false, source: "memoryDir", extractionMode: "off" },
      qa: parseTimelineQaConfig(undefined),
      vault: parseTimelineVaultConfig(undefined),
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline must be an object");
  }
  const timeline = raw as Record<string, unknown>;
  const enabledValue = coerceBooleanLike(timeline.enabled, "activity.timeline.enabled");
  if (timeline.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("activity.timeline.enabled must be a boolean");
  }
  const journal = parseTimelineJournalConfig(timeline.journal);
  let vault = parseTimelineVaultConfig(timeline.vault);
  const journalRaw = timeline.journal;
  const headingRaw =
    typeof journalRaw === "object" && journalRaw !== null && !Array.isArray(journalRaw)
      ? (journalRaw as Record<string, unknown>).heading
      : undefined;
  if (headingRaw !== undefined) {
    const aliased = applyLegacyJournalHeading({
      journalSection: vault.readback.journalSection,
      heading: headingRaw,
    });
    process.emitWarning(
      aliased.ignoredLegacyHeading
        ? 'activity.timeline.journal.heading is deprecated and ignored because activity.timeline.vault.readback.journalSection is set; use vault.readback.journalSection.'
        : 'activity.timeline.journal.heading is deprecated; use activity.timeline.vault.readback.journalSection.',
      { type: "DeprecationWarning", code: "REMNIC_DEP_JOURNAL_HEADING" },
    );
    if (aliased.usedLegacyHeading) {
      vault = { ...vault, readback: { ...vault.readback, journalSection: aliased.journalSection } };
      validateReadbackJournalSection(vault);
    }
  }
  if (journal.source === "vault") {
    // Parse-time prerequisite gate (issue #1987): the error names EVERY
    // missing prerequisite, never just the first (§1/§39).
    const prereq = checkVaultJournalPrerequisites({
      vaultEnabled: vault.enabled,
      dailyNotePath: vault.dailyNotePath,
      journalSection: vault.readback.journalSection,
    });
    if (!prereq.ok) {
      throw new RangeError(
        `activity.timeline.journal.source "vault" requires ${prereq.message}`,
      );
    }
  }
  return {
    enabled: enabledValue ?? false,
    analysis: parseTimelineAnalysisConfig(timeline.analysis),
    journal,
    qa: parseTimelineQaConfig(timeline.qa),
    vault,
  };
}

/**
 * Parse the `activity.timeline.analysis.*` block (issue #2050). Independent
 * gate, default off: disabled means zero provider calls and zero analysis
 * artifacts. Enabling requires an explicit provider and model; every invalid
 * value is rejected at parse time — never silently defaulted or fallen back.
 */
function parseTimelineAnalysisConfig(raw: unknown): ActivityTimelineAnalysisConfig {
  if (raw === undefined) return { enabled: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline.analysis must be an object");
  }
  const analysis = raw as Record<string, unknown>;
  const enabled = requireBool(analysis.enabled, "activity.timeline.analysis.enabled", false);
  const provider = optionalNonEmptyString(analysis.provider, "activity.timeline.analysis.provider")?.trim();
  const model = optionalNonEmptyString(analysis.model, "activity.timeline.analysis.model")?.trim();
  for (const [key, value] of [
    ["provider", provider],
    ["model", model],
  ] as const) {
    if (value === undefined) continue;
    if (key === "provider" && value.includes("/")) {
      throw new RangeError(
        "activity.timeline.analysis.provider must be a single provider segment (no '/')",
      );
    }
    if (!isAnalysisIdentifier(value)) {
      throw new RangeError(
        `activity.timeline.analysis.${key} must be an identifier (letters, digits, and ._:-/ only)`,
      );
    }
    if (value.length > ANALYSIS_METADATA_MAX_FIELD_LENGTH) {
      throw new RangeError(
        `activity.timeline.analysis.${key} must be at most ${ANALYSIS_METADATA_MAX_FIELD_LENGTH} characters`,
      );
    }
  }
  if (enabled && (provider === undefined || model === undefined)) {
    throw new RangeError(
      "activity.timeline.analysis.provider and model are required when analysis is enabled",
    );
  }
  const timeoutMsValue = coerceNumber(analysis.timeoutMs, "activity.timeline.analysis.timeoutMs");
  if (analysis.timeoutMs !== undefined && timeoutMsValue === undefined) {
    throw new TypeError("activity.timeline.analysis.timeoutMs must be a finite number");
  }
  const timeoutMs = timeoutMsValue ?? TIMELINE_ANALYSIS_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new RangeError("activity.timeline.analysis.timeoutMs must be an integer from 1000 to 120000");
  }
  if (analysis.preferences !== undefined) {
    if (!Array.isArray(analysis.preferences)) {
      throw new TypeError("activity.timeline.analysis.preferences must be an array of strings");
    }
    if (analysis.preferences.length > 16) {
      throw new RangeError("activity.timeline.analysis.preferences supports at most 16 entries");
    }
    for (const entry of analysis.preferences) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new TypeError("activity.timeline.analysis.preferences entries must be non-empty strings");
      }
      if (entry.length > 200) {
        throw new RangeError("activity.timeline.analysis.preferences entries must be at most 200 characters");
      }
    }
  }
  const preferences = analysis.preferences as string[] | undefined;
  return {
    enabled,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(analysis.timeoutMs !== undefined || timeoutMsValue !== undefined ? { timeoutMs } : {}),
    ...(preferences === undefined ? {} : { preferences }),
  };
}

/**
 * Parse the `activity.timeline.vault.*` block (issue #1985). Default off.
 * Invalid values are rejected at parse time naming the missing or invalid
 * prerequisite — never silently defaulted.
 */
export function parseTimelineVaultConfig(raw: unknown): ActivityTimelineVaultConfig {
  if (raw === undefined) return defaultVaultConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline.vault must be an object");
  }
  const vault = raw as Record<string, unknown>;
  const enabled = requireBool(vault.enabled, "activity.timeline.vault.enabled", false);
  const createMissingNotes = requireBool(vault.createMissingNotes, "activity.timeline.vault.createMissingNotes", false);
  const autoPublish = requireBool(vault.autoPublish, "activity.timeline.vault.autoPublish", true);
  const vaultPath = optionalNonEmptyString(vault.vaultPath, "activity.timeline.vault.vaultPath") ?? "";
  const dailyNotePath =
    optionalNonEmptyString(vault.dailyNotePath, "activity.timeline.vault.dailyNotePath") ?? "{yyyy}-{MM}-{dd}.md";
  const weeklyNotePath = optionalNonEmptyString(vault.weeklyNotePath, "activity.timeline.vault.weeklyNotePath") ?? "";
  const noteTemplate = optionalNonEmptyString(vault.noteTemplate, "activity.timeline.vault.noteTemplate") ?? "";
  const insertUnderHeading =
    optionalNonEmptyString(vault.insertUnderHeading, "activity.timeline.vault.insertUnderHeading") ?? "";

  if (typeof vault.sectionStrategy !== "undefined" && typeof vault.sectionStrategy !== "string") {
    throw new TypeError("activity.timeline.vault.sectionStrategy must be a string");
  }
  const sectionStrategy = (vault.sectionStrategy as string | undefined) ?? "markers";
  if (sectionStrategy !== "markers" && sectionStrategy !== "heading") {
    throw new RangeError('activity.timeline.vault.sectionStrategy must be one of "markers", "heading"');
  }

  // The documented `vaultPath` contract: absolute on the host platform, or
  // `~` / `~`-rooted for `expandTildePath`. Everything else — `.`, `vault`,
  // `../notes`, whitespace — is relative and would resolve against whatever
  // directory the daemon or CLI happened to launch from, so an enabled vault
  // rejects it at parse time.
  const tildeRooted = vaultPath === "~" || vaultPath.startsWith("~/") || vaultPath.startsWith("~\\");
  if (enabled && (vaultPath.trim().length === 0 || (!tildeRooted && !path.isAbsolute(vaultPath)))) {
    throw new RangeError(
      "activity.timeline.vault.vaultPath must be an absolute or `~`-rooted path when activity.timeline.vault.enabled is true; " +
        `a relative path resolves against the process working directory (got ${JSON.stringify(vaultPath)})`,
    );
  }
  try {
    validateVaultNoteTemplate(dailyNotePath);
  } catch (err) {
    throw new RangeError(`activity.timeline.vault.dailyNotePath: ${(err as Error).message}`);
  }
  if (weeklyNotePath.length > 0) {
    try {
      validateVaultNoteTemplate(weeklyNotePath);
    } catch (err) {
      throw new RangeError(`activity.timeline.vault.weeklyNotePath: ${(err as Error).message}`);
    }
  }
  if (createMissingNotes) {
    if (noteTemplate.length === 0) {
      throw new RangeError(
        "activity.timeline.vault.noteTemplate must name a vault-relative template file when activity.timeline.vault.createMissingNotes is true",
      );
    }
    try {
      validateVaultNoteTemplate(noteTemplate);
    } catch (err) {
      throw new RangeError(`activity.timeline.vault.noteTemplate: ${(err as Error).message}`);
    }
  }

  const publish = parseVaultPublishBlock(vault.publish, weeklyNotePath);
  const wikilinksRaw = vault.wikilinks;
  const wikilinks =
    wikilinksRaw === undefined
      ? { places: false, placesFolder: "Places" }
      : parseVaultWikilinks(wikilinksRaw);
  const propertiesRaw = vault.properties;
  const properties: ActivityTimelineVaultConfig["properties"] =
    propertiesRaw === undefined ? { mode: "off", prefix: "remnic_" } : parseVaultProperties(propertiesRaw);
  const readbackRaw = vault.readback;
  if (readbackRaw !== undefined && (typeof readbackRaw !== "object" || readbackRaw === null || Array.isArray(readbackRaw))) {
    throw new TypeError("activity.timeline.vault.readback must be an object");
  }
  const readbackJournalSection = optionalNonEmptyString(
    (readbackRaw as Record<string, unknown> | undefined)?.journalSection,
    "activity.timeline.vault.readback.journalSection",
  );
  const readback = {
    journalSection: readbackJournalSection ?? "",
  };
  const parsed: ActivityTimelineVaultConfig = {
    enabled,
    vaultPath,
    dailyNotePath,
    weeklyNotePath,
    createMissingNotes,
    noteTemplate,
    sectionStrategy,
    publish,
    insertUnderHeading,
    readback,
    wikilinks,
    properties,
    autoPublish,
  };
  validateReadbackJournalSection(parsed);
  return parsed;
}

function defaultVaultConfig(): ActivityTimelineVaultConfig {
  return {
    enabled: false,
    vaultPath: "",
    dailyNotePath: "{yyyy}-{MM}-{dd}.md",
    weeklyNotePath: "",
    createMissingNotes: false,
    noteTemplate: "",
    sectionStrategy: "markers",
    publish: {
      timeline: { enabled: true, target: "daily", section: "Timeline" },
      standup: { enabled: false, target: "daily", section: "Standup" },
      weekly: { enabled: false, target: "weekly", section: "Weekly Review" },
      locations: { enabled: false, target: "daily", section: "Locations" },
    },
    insertUnderHeading: "",
    wikilinks: { places: false, placesFolder: "Places" },
    properties: { mode: "off", prefix: "remnic_" },
    autoPublish: true,
    readback: { journalSection: "" },
  };
}

/**
 * Config-time gate (issue #2894): the read-back heading must be a name the
 * shared heading parser can match, and under `sectionStrategy: "heading"`
 * it must not be publisher-owned — the selected heading itself is never
 * passed to the stripper, so reading back the publisher's own daily
 * section would feed generated timeline output into the journal. Weekly
 * targets never own daily-note sections. Errors carry the config path and
 * heading name only, never note content.
 */
function validateReadbackJournalSection(vault: ActivityTimelineVaultConfig): void {
  const journalSection = vault.readback.journalSection;
  if (journalSection.length === 0) return;
  const grammar = validateJournalSectionName(journalSection);
  if (!grammar.ok) {
    const detail =
      grammar.error === "empty_heading"
        ? "must be a non-empty heading name, not only whitespace"
        : grammar.error === "untrimmed_heading"
          ? "must not have leading or trailing whitespace; the heading parser trims it and would never match"
          : grammar.error === "control_character"
            ? "must not contain line breaks or control characters"
            : 'must be a heading text the journal heading parser can match exactly; a trailing "#" run is parsed as a closing sequence';
    throw new RangeError(`activity.timeline.vault.readback.journalSection ${detail}`);
  }
  if (publisherOwnedSectionNames(vault).includes(journalSection)) {
    const owners = (["timeline", "standup", "weekly", "locations"] as const)
      .filter((kind) => vault.publish[kind].target === "daily" && vault.publish[kind].section === journalSection)
      .map((kind) => `publish.${kind}`);
    throw new RangeError(
      `activity.timeline.vault.readback.journalSection "${journalSection}" is publisher-owned: it is a configured daily publish section (${owners.join(", ")}) under sectionStrategy "heading"; the journal heading must not be a publisher-owned section`,
    );
  }
}

function requireBool(value: unknown, key: string, fallback: boolean): boolean {
  const coerced = coerceBooleanLike(value, key);
  if (value === undefined) return fallback;
  if (coerced === undefined) {
    throw new TypeError(`${key} must be a boolean`);
  }
  return coerced;
}

function optionalNonEmptyString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string`);
  }
  return value;
}

function parseVaultPublishBlock(
  raw: unknown,
  weeklyNotePath: string,
): ActivityTimelineVaultConfig["publish"] {
  const defaults = defaultVaultConfig().publish;
  if (raw === undefined) return defaults;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline.vault.publish must be an object");
  }
  const block = raw as Record<string, unknown>;
  // Each kind is read at its literal path so the config-contract extractor
  // can attribute publish.<kind>.<leaf> to real parse sites (§40).
  const publish = {
    timeline: parseVaultTarget(block.timeline, "timeline", defaults.timeline, weeklyNotePath),
    standup: parseVaultTarget(block.standup, "standup", defaults.standup, weeklyNotePath),
    weekly: parseVaultTarget(block.weekly, "weekly", defaults.weekly, weeklyNotePath),
    locations: parseVaultTarget(block.locations, "locations", defaults.locations, weeklyNotePath),
  };
  for (const targetFile of ["daily", "weekly"] as const) {
    const sections = (["timeline", "standup", "weekly", "locations"] as const)
      .filter((kind) => publish[kind].target === targetFile && publish[kind].enabled)
      .map((kind) => publish[kind].section);
    const duplicates = sections.filter((section, index) => sections.indexOf(section) !== index);
    if (duplicates.length > 0) {
      throw new RangeError(
        `activity.timeline.vault.publish section names must be unique per target file; duplicate ${targetFile} section(s): ${[...new Set(duplicates)].join(", ")}`,
      );
    }
  }
  return publish;
}

function parseVaultTarget(
  raw: unknown,
  kind: string,
  fallback: ActivityTimelineVaultTargetConfig,
  weeklyNotePath: string,
): ActivityTimelineVaultTargetConfig {
  if (raw === undefined) return fallback;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`activity.timeline.vault.publish.${kind} must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const enabled = requireBool(entry.enabled, `activity.timeline.vault.publish.${kind}.enabled`, fallback.enabled);
  const target = entry.target === undefined ? fallback.target : entry.target;
  if (target !== "daily" && target !== "weekly") {
    throw new RangeError(`activity.timeline.vault.publish.${kind}.target must be one of "daily", "weekly"`);
  }
  const section = entry.section === undefined ? fallback.section : entry.section;
  if (typeof section !== "string" || section.trim().length === 0 || section !== section.trim()) {
    throw new RangeError(`activity.timeline.vault.publish.${kind}.section must be a non-empty trimmed string`);
  }
  // The accepted config domain must equal what the publisher accepts: a name
  // containing `-->` or a line break passes the trimmed-string check above
  // but is rejected downstream by `publishVaultNote`, which would turn an
  // apparently valid config into a runtime failure.
  if (!validateRegionName(section).ok) {
    throw new RangeError(
      `activity.timeline.vault.publish.${kind}.section must not contain a line break or "-->"`,
    );
  }
  // The path is required only by an entry that will actually publish to the
  // weekly file; a disabled entry must load the same whether its object is
  // explicit (serialized schema default) or omitted entirely.
  if (enabled && target === "weekly" && weeklyNotePath.length === 0) {
    throw new RangeError(
      `activity.timeline.vault.publish.${kind}.target is "weekly" but activity.timeline.vault.weeklyNotePath is empty; configure weeklyNotePath first`,
    );
  }
  return { enabled, target, section };
}

function parseVaultWikilinks(raw: unknown): ActivityTimelineVaultConfig["wikilinks"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline.vault.wikilinks must be an object");
  }
  const block = raw as Record<string, unknown>;
  const places = requireBool(block.places, "activity.timeline.vault.wikilinks.places", false);
  const placesFolder =
    optionalNonEmptyString(block.placesFolder, "activity.timeline.vault.wikilinks.placesFolder") ?? "Places";
  return { places, placesFolder };
}

function parseVaultProperties(raw: unknown): ActivityTimelineVaultConfig["properties"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline.vault.properties must be an object");
  }
  const block = raw as Record<string, unknown>;
  const mode = block.mode === undefined ? "off" : block.mode;
  if (mode !== "off" && mode !== "frontmatter" && mode !== "dataview-inline") {
    throw new RangeError(
      'activity.timeline.vault.properties.mode must be one of "off", "frontmatter", "dataview-inline"',
    );
  }
  const prefix = optionalNonEmptyString(block.prefix, "activity.timeline.vault.properties.prefix") ?? "remnic_";
  if (prefix.trim().length === 0 || prefix !== prefix.trim()) {
    throw new RangeError("activity.timeline.vault.properties.prefix must be non-empty and trimmed");
  }
  return { mode, prefix };
}

function parseTimelineJournalConfig(raw: unknown): ActivityTimelineJournalConfig {
  if (raw === undefined) return { enabled: false, source: "memoryDir", extractionMode: "off" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline.journal must be an object");
  }
  const journal = raw as Record<string, unknown>;
  const enabledValue = coerceBooleanLike(journal.enabled, "activity.timeline.journal.enabled");
  if (journal.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("activity.timeline.journal.enabled must be a boolean");
  }
  const source = journal.source === undefined ? "memoryDir" : typeof journal.source === "string" ? journal.source : "";
  const resolved = resolveJournalSource({ source });
  if (!resolved.ok) {
    throw new RangeError('activity.timeline.journal.source must be one of "memoryDir", "vault"');
  }
  if (resolved.deprecatedAlias === "file") {
    process.emitWarning(
      'activity.timeline.journal.source "file" is deprecated; use "memoryDir".',
      { type: "DeprecationWarning", code: "REMNIC_DEP_JOURNAL_SOURCE_FILE" },
    );
  }
  const extractionMode = journal.extractionMode === undefined ? "off" : journal.extractionMode;
  if (extractionMode !== "off" && extractionMode !== "review") {
    throw new RangeError('activity.timeline.journal.extractionMode must be one of "off", "review"');
  }
  return { enabled: enabledValue ?? false, source: resolved.mode, extractionMode };
}

function parseTimelineQaConfig(raw: unknown): ActivityTimelineQaConfig {
  if (raw === undefined) return { enabled: false, maxRangeDays: 31 };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("activity.timeline.qa must be an object");
  }
  const qa = raw as Record<string, unknown>;
  const enabledValue = coerceBooleanLike(qa.enabled, "activity.timeline.qa.enabled");
  if (qa.enabled !== undefined && enabledValue === undefined) {
    throw new TypeError("activity.timeline.qa.enabled must be a boolean");
  }
  const maxRangeDaysValue = coerceNumber(qa.maxRangeDays, "activity.timeline.qa.maxRangeDays");
  if (qa.maxRangeDays !== undefined && maxRangeDaysValue === undefined) {
    throw new TypeError("activity.timeline.qa.maxRangeDays must be an integer from 1 to 366");
  }
  const maxRangeDays = maxRangeDaysValue ?? 31;
  if (!Number.isInteger(maxRangeDays) || maxRangeDays < 1 || maxRangeDays > 366) {
    throw new RangeError("activity.timeline.qa.maxRangeDays must be an integer from 1 to 366");
  }
  return { enabled: enabledValue ?? false, maxRangeDays };
}

