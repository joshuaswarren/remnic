import { existsSync } from "node:fs";

import { CaptureConfigError } from "./errors.js";

export interface TranscribedSegment {
  text: string;
  startUtc: string;
  endUtc: string;
}

interface WhisperSegment {
  text?: unknown;
  offsets?: { from?: unknown; to?: unknown };
}

function timestampAt(chunkStartedAtUtc: string, offsetMs: number): string {
  const startMs = Date.parse(chunkStartedAtUtc);
  if (!Number.isFinite(startMs)) {
    throw new CaptureConfigError("chunk start timestamp is invalid");
  }
  return new Date(startMs + offsetMs).toISOString();
}

export function parseWhisperJson(output: string, chunkStartedAtUtc: string): TranscribedSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new CaptureConfigError("whisper-cli returned malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { transcription?: unknown }).transcription)) {
    throw new CaptureConfigError("whisper-cli JSON must contain a transcription array");
  }

  return (parsed as { transcription: WhisperSegment[] }).transcription.map((segment, index) => {
    if (
      typeof segment.text !== "string" ||
      segment.text.trim() === "" ||
      !segment.offsets ||
      typeof segment.offsets.from !== "number" ||
      typeof segment.offsets.to !== "number" ||
      !Number.isFinite(segment.offsets.from) ||
      !Number.isFinite(segment.offsets.to) ||
      segment.offsets.from < 0 ||
      segment.offsets.to < segment.offsets.from
    ) {
      throw new CaptureConfigError(`whisper-cli transcription[${index}] is invalid`);
    }
    return {
      text: segment.text.trim(),
      startUtc: timestampAt(chunkStartedAtUtc, segment.offsets.from),
      endUtc: timestampAt(chunkStartedAtUtc, segment.offsets.to),
    };
  });
}

export function resolveModelPath(
  configuredPath: string | undefined,
  defaultPath: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const path = configuredPath ?? defaultPath;
  if (!exists(path)) {
    throw new CaptureConfigError(
      `whisper model not found at ${path}; run remnic-capture-audio download-model or set stt.modelPath`,
    );
  }
  return path;
}

export function buildWhisperArgs(wavPath: string, modelPath: string): string[] {
  return ["-m", modelPath, "-f", wavPath, "--output-json"];
}
