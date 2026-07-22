import { statSync } from "node:fs";
import { spawn } from "node:child_process";

import { expandTilde } from "./paths.js";
import { CaptureConfigError } from "./errors.js";

export interface TranscribedSegment {
  text: string;
  startUtc: string;
  endUtc: string;
}

export interface WhisperRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WhisperTranscriptionInput {
  wavPath: string;
  modelPath: string;
  chunkStartedAtUtc: string;
  run: (command: string, args: string[]) => Promise<WhisperRunResult>;
}

interface WhisperSegment {
  text?: unknown;
  offsets?: { from?: unknown; to?: unknown };
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function timestampAt(chunkStartedAtUtc: string, offsetMs: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(chunkStartedAtUtc);
  if (!match) {
    throw new CaptureConfigError("chunk start timestamp is invalid");
  }
  const [, year, month, day, hour, minute, second, millisecond = "0"] = match;
  const startMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond.padEnd(3, "0")),
  );
  const start = new Date(startMs);
  if (
    start.getUTCFullYear() !== Number(year) ||
    start.getUTCMonth() !== Number(month) - 1 ||
    start.getUTCDate() !== Number(day) ||
    start.getUTCHours() !== Number(hour) ||
    start.getUTCMinutes() !== Number(minute) ||
    start.getUTCSeconds() !== Number(second) ||
    start.getUTCMilliseconds() !== Number(millisecond.padEnd(3, "0"))
  ) {
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

  return (parsed as { transcription: unknown[] }).transcription.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new CaptureConfigError(`whisper-cli transcription[${index}] is invalid`);
    }
    const segment = value as WhisperSegment;
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
  exists: (path: string) => boolean = isRegularFile,
): string {
  const modelPath = expandTilde(configuredPath ?? defaultPath);
  if (!exists(modelPath)) {
    throw new CaptureConfigError(
      `whisper model not found at ${modelPath}; run remnic-capture-audio download-model or set stt.modelPath`,
    );
  }
  return modelPath;
}

export function buildWhisperArgs(wavPath: string, modelPath: string): string[] {
  return ["-m", modelPath, "-f", wavPath, "--output-json", "--output-file", "-"];
}

export async function transcribeWithWhisper(input: WhisperTranscriptionInput): Promise<TranscribedSegment[]> {
  const result = await input.run("whisper-cli", buildWhisperArgs(input.wavPath, input.modelPath));
  if (result.code !== 0) {
    throw new CaptureConfigError(`whisper-cli failed with exit code ${result.code}`);
  }
  return parseWhisperJson(result.stdout, input.chunkStartedAtUtc);
}

export function runWhisperCli(command: string, args: string[]): Promise<WhisperRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
