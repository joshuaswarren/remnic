/**
 * Daemon config (`~/.remnic/capture/audio.json`), created by
 * `remnic-capture-audio init`. Strict and loud: an absent field takes the
 * documented default, but a present-but-invalid value throws
 * CaptureConfigError (rule 39 — no silent defaulting). Ports are integers
 * in [1, 65535] (rule 17); booleans coerce boolean-like strings (rule 24).
 *
 * Only `whisper-cpp` is currently accepted for STT. VAD configuration maps
 * directly to the optional Sherpa Silero runtime adapter.
 */

import { readFileSync } from "node:fs";

import { coerceNumber } from "./coerce.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import { CaptureConfigError } from "./errors.js";
import { describeValue } from "./util.js";

export interface SttConfig {
  engine: "whisper-cpp";
  modelPath: string | null;
  threads: number | null;
}
export interface VadConfig {
  modelPath: string | null;
  minSpeechMs: number;
  minSilenceMs: number;
  maxSpeechMs: number;
  threshold: number;
  threads: number;
}
export interface DiarizationConfig {
  similarityThreshold: number;
}
export interface DeviceConfig {
  mic: string | null;
  system: string | null;
}
export interface DaemonConfig {
  host: string;
  port: number;
  chunkSeconds: number;
  captureChannel: "mic" | "system" | "both";
  conversationGapMinutes: number;
  rawRetentionHours: number;
  spoolRetentionDays: number;
  vad: VadConfig;
  diarization: DiarizationConfig;
  stt: SttConfig;
  denyApps: string[];
  devices: DeviceConfig;
}

export function defaultDaemonConfig(): DaemonConfig {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    chunkSeconds: 30,
    captureChannel: "both",
    conversationGapMinutes: 10,
    rawRetentionHours: 0,
    spoolRetentionDays: 30,
    vad: {
      modelPath: null,
      minSpeechMs: 500,
      minSilenceMs: 500,
      maxSpeechMs: 30_000,
      threshold: 0.5,
      threads: 1,
    },
    diarization: { similarityThreshold: 0.4 },
    stt: { engine: "whisper-cpp", modelPath: null, threads: null },
    denyApps: [],
    devices: { mic: null, system: null },
  };
}

const KNOWN_TOP_KEYS: Record<string, true> = {
  host: true,
  port: true,
  chunkSeconds: true,
  captureChannel: true,
  conversationGapMinutes: true,
  rawRetentionHours: true,
  spoolRetentionDays: true,
  vad: true,
  diarization: true,
  stt: true,
  denyApps: true,
  devices: true,
};

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CaptureConfigError(`${label}: expected an object, got ${describeValue(value)}`);
  }
  return value as Record<string, unknown>;
}

function warnUnknownKeys(obj: Record<string, unknown>, known: Record<string, true>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(known, key)) {
      console.warn(`remnic-capture-audio: ${label}: ignoring unknown key '${key}'`);
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CaptureConfigError(`${label}: expected a non-empty string, got ${describeValue(value)}`);
  }
  return value.trim();
}

export function parseDaemonConfig(raw: unknown): DaemonConfig {
  const cfg = defaultDaemonConfig();
  const obj = asObject(raw, "config");
  warnUnknownKeys(obj, KNOWN_TOP_KEYS, "config");

  if (obj.host !== undefined) cfg.host = requireString(obj.host, "host");
  if (obj.port !== undefined) {
    cfg.port = coerceNumber(obj.port, "port", { integer: true, min: 1, max: 65535 });
  }
  if (obj.chunkSeconds !== undefined) {
    cfg.chunkSeconds = coerceNumber(obj.chunkSeconds, "chunkSeconds", { integer: true, min: 1, max: 3600 });
  }
  if (obj.captureChannel !== undefined) {
    if (obj.captureChannel !== "mic" && obj.captureChannel !== "system" && obj.captureChannel !== "both") {
      throw new CaptureConfigError(
        `captureChannel: expected 'mic' | 'system' | 'both', got ${describeValue(obj.captureChannel)}`,
      );
    }
    cfg.captureChannel = obj.captureChannel;
  }
  if (obj.conversationGapMinutes !== undefined) {
    cfg.conversationGapMinutes = coerceNumber(obj.conversationGapMinutes, "conversationGapMinutes", { min: 0 });
  }
  if (obj.rawRetentionHours !== undefined) {
    cfg.rawRetentionHours = coerceNumber(obj.rawRetentionHours, "rawRetentionHours", { min: 0 });
  }
  if (obj.spoolRetentionDays !== undefined) {
    cfg.spoolRetentionDays = coerceNumber(obj.spoolRetentionDays, "spoolRetentionDays", { integer: true, min: 1 });
  }

  if (obj.vad !== undefined) {
    const vad = asObject(obj.vad, "vad");
    warnUnknownKeys(
      vad,
      {
        modelPath: true,
        minSpeechMs: true,
        minSilenceMs: true,
        maxSpeechMs: true,
        threshold: true,
        threads: true,
      },
      "vad",
    );
    if (vad.modelPath !== undefined) {
      cfg.vad.modelPath = vad.modelPath === null ? null : requireString(vad.modelPath, "vad.modelPath");
    }
    if (vad.minSpeechMs !== undefined) {
      cfg.vad.minSpeechMs = coerceNumber(vad.minSpeechMs, "vad.minSpeechMs", { integer: true, min: 1 });
    }
    if (vad.minSilenceMs !== undefined) {
      cfg.vad.minSilenceMs = coerceNumber(vad.minSilenceMs, "vad.minSilenceMs", { integer: true, min: 0 });
    }
    if (vad.maxSpeechMs !== undefined) {
      cfg.vad.maxSpeechMs = coerceNumber(vad.maxSpeechMs, "vad.maxSpeechMs", { integer: true, min: 1 });
    }
    if (vad.threshold !== undefined) {
      const threshold = coerceNumber(vad.threshold, "vad.threshold", { max: 1 });
      if (threshold <= 0 || threshold >= 1) {
        throw new CaptureConfigError("vad.threshold must be between 0 and 1");
      }
      cfg.vad.threshold = threshold;
    }
    if (vad.threads !== undefined) {
      cfg.vad.threads = coerceNumber(vad.threads, "vad.threads", { integer: true, min: 1, max: 256 });
    }
    if (cfg.vad.minSpeechMs > cfg.vad.maxSpeechMs) {
      throw new CaptureConfigError("vad.maxSpeechMs must be greater than or equal to vad.minSpeechMs");
    }
  }

  if (obj.diarization !== undefined) {
    const dia = asObject(obj.diarization, "diarization");
    warnUnknownKeys(dia, { similarityThreshold: true }, "diarization");
    if (dia.similarityThreshold !== undefined) {
      const threshold = coerceNumber(dia.similarityThreshold, "diarization.similarityThreshold", { max: 1 });
      if (threshold <= 0 || threshold >= 1) {
        throw new CaptureConfigError("diarization.similarityThreshold must be between 0 and 1");
      }
      cfg.diarization.similarityThreshold = threshold;
    }
  }

  if (obj.stt !== undefined) {
    const stt = asObject(obj.stt, "stt");
    warnUnknownKeys(stt, { engine: true, modelPath: true, threads: true }, "stt");
    if (stt.engine !== undefined && stt.engine !== "whisper-cpp") {
      throw new CaptureConfigError(`stt.engine: only 'whisper-cpp' is supported, got ${describeValue(stt.engine)}`);
    }
    if (stt.modelPath !== undefined && stt.modelPath !== null) {
      if (typeof stt.modelPath !== "string") {
        throw new CaptureConfigError(`stt.modelPath: expected a string, got ${describeValue(stt.modelPath)}`);
      }
      cfg.stt.modelPath = stt.modelPath.trim() || null;
    }
    if (stt.threads !== undefined && stt.threads !== null) {
      cfg.stt.threads = coerceNumber(stt.threads, "stt.threads", { integer: true, min: 1, max: 256 });
    }
  }

  if (obj.denyApps !== undefined) {
    if (!Array.isArray(obj.denyApps) || !obj.denyApps.every((app) => typeof app === "string")) {
      throw new CaptureConfigError(`denyApps: expected an array of strings, got ${describeValue(obj.denyApps)}`);
    }
    cfg.denyApps = [...(obj.denyApps as string[])];
  }

  if (obj.devices !== undefined) {
    const dev = asObject(obj.devices, "devices");
    warnUnknownKeys(dev, { mic: true, system: true }, "devices");
    if (dev.mic !== undefined && dev.mic !== null) {
      if (typeof dev.mic !== "string") {
        throw new CaptureConfigError(`devices.mic: expected a string, got ${describeValue(dev.mic)}`);
      }
      cfg.devices.mic = dev.mic;
    }
    if (dev.system !== undefined && dev.system !== null) {
      if (typeof dev.system !== "string") {
        throw new CaptureConfigError(`devices.system: expected a string, got ${describeValue(dev.system)}`);
      }
      cfg.devices.system = dev.system;
    }
  }

  return cfg;
}

export function loadDaemonConfig(configPath: string): DaemonConfig {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    throw new CaptureConfigError(
      `config not found at ${configPath} — run \`remnic-capture-audio init\` first`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CaptureConfigError(`config at ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  return parseDaemonConfig(raw);
}

export function serializeDaemonConfig(cfg: DaemonConfig): string {
  return `${JSON.stringify(cfg, null, 2)}\n`;
}
