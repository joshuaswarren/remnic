/**
 * Wearable speaker registry — maps provider diarization labels to
 * human names, persistently, per source.
 *
 * Providers expose speakers differently (Limitless: names + a "user"
 * marker; Bee: opaque labels like "0"/"1"; Omi: "SPEAKER_00" + is_user
 * + optional person ids). The registry stores operator-confirmed
 * mappings keyed `<sourceId>:<speakerKey>` in
 * `state/wearables/speakers.json`, plus the wearer's display name.
 *
 * Resolution precedence (most-authoritative first):
 *   1. registry override for `<sourceId>:<speakerKey>`
 *   2. provider-identified wearer  -> selfName
 *   3. provider-supplied speaker name
 *   4. the raw speaker key, prefixed "Speaker" when it is bare digits
 */

import { promises as fsPromises } from "node:fs";
import * as path from "node:path";

export interface SpeakerOverride {
  name: string;
  /** Mark this speaker as the wearer (their words become "you"). */
  isSelf?: boolean;
  updatedAt: string;
}

export interface SpeakerRegistry {
  version: 1;
  /** Display name used for the wearer across all sources. */
  selfName: string;
  /** Overrides keyed `<sourceId>:<speakerKey>`. */
  speakers: Record<string, SpeakerOverride>;
}

export const DEFAULT_SELF_NAME = "Me";

export function emptySpeakerRegistry(): SpeakerRegistry {
  return { version: 1, selfName: DEFAULT_SELF_NAME, speakers: {} };
}

export function speakersFilePath(memoryDir: string): string {
  return path.join(memoryDir, "state", "wearables", "speakers.json");
}

export async function loadSpeakerRegistry(
  memoryDir: string,
): Promise<SpeakerRegistry> {
  const filePath = speakersFilePath(memoryDir);
  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptySpeakerRegistry();
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `wearables speakers file is not valid JSON (state/wearables/speakers.json): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as SpeakerRegistry).speakers !== "object" ||
    (parsed as SpeakerRegistry).speakers === null
  ) {
    throw new Error(
      'wearables speakers file has an unexpected shape (state/wearables/speakers.json); expected {"version":1,"selfName":"...","speakers":{}}',
    );
  }
  const registry = parsed as SpeakerRegistry;
  return {
    version: 1,
    selfName:
      typeof registry.selfName === "string" && registry.selfName.trim().length > 0
        ? registry.selfName.trim()
        : DEFAULT_SELF_NAME,
    speakers: registry.speakers,
  };
}

export async function saveSpeakerRegistry(
  memoryDir: string,
  registry: SpeakerRegistry,
): Promise<void> {
  const filePath = speakersFilePath(memoryDir);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsPromises.writeFile(
    tmpPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
  try {
    await fsPromises.rename(tmpPath, filePath);
  } catch (err) {
    await fsPromises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export function speakerRegistryKey(
  sourceId: string,
  speakerKey: string,
): string {
  return `${sourceId}:${speakerKey}`;
}

export interface ResolvedSpeaker {
  /** Display label used in transcripts, e.g. "Jane" or "Me (you)". */
  label: string;
  /** Whether this speaker is the wearer. */
  isSelf: boolean;
}

export function resolveSpeaker(
  sourceId: string,
  segment: { speakerKey: string; speakerName?: string; isWearer?: boolean },
  registry: SpeakerRegistry,
): ResolvedSpeaker {
  const override = registry.speakers[speakerRegistryKey(sourceId, segment.speakerKey)];
  if (override) {
    const isSelf = override.isSelf === true;
    return {
      label: isSelf ? `${override.name} (you)` : override.name,
      isSelf,
    };
  }
  if (segment.isWearer === true) {
    return { label: `${registry.selfName} (you)`, isSelf: true };
  }
  if (
    typeof segment.speakerName === "string" &&
    segment.speakerName.trim().length > 0
  ) {
    return { label: segment.speakerName.trim(), isSelf: false };
  }
  const key = segment.speakerKey.trim();
  // Bare diarization indexes read better with a prefix.
  if (/^\d+$/.test(key)) {
    return { label: `Speaker ${key}`, isSelf: false };
  }
  return { label: key.length > 0 ? key : "Unknown speaker", isSelf: false };
}

/**
 * Distinct speaker labels for a set of segments, in first-appearance
 * order — used for day-transcript frontmatter.
 */
export function distinctSpeakerLabels(
  sourceId: string,
  segments: Array<{ speakerKey: string; speakerName?: string; isWearer?: boolean }>,
  registry: SpeakerRegistry,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const { label } = resolveSpeaker(sourceId, segment, registry);
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}
