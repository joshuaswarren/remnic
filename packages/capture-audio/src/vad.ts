import { CaptureConfigError } from "./errors.js";
import { expandTilde } from "./paths.js";


export interface SileroVadInput {
  modelPath: string;
  minSpeechMs: number;
  minSilenceMs?: number;
  maxSpeechMs?: number;
  threshold?: number;
  threads?: number;
}

export interface SherpaOnnxModule {
  Vad: new (config: unknown, bufferSeconds: number) => unknown;
}

export function sileroVadConfig(input: SileroVadInput): { config: object; bufferSeconds: number } {
  if (typeof input.modelPath !== "string" || input.modelPath.trim() === "") {
    throw new CaptureConfigError("Silero VAD modelPath must be a non-empty string");
  }
  if (!Number.isFinite(input.minSpeechMs) || input.minSpeechMs <= 0) {
    throw new CaptureConfigError("Silero VAD minSpeechMs must be positive");
  }
  const minSilenceMs = input.minSilenceMs ?? 500;
  const maxSpeechMs = input.maxSpeechMs ?? 30_000;
  const threshold = input.threshold ?? 0.5;
  const threads = input.threads ?? 1;
  if (!Number.isFinite(minSilenceMs) || minSilenceMs < 0 || !Number.isFinite(maxSpeechMs) || maxSpeechMs <= 0) {
    throw new CaptureConfigError("Silero VAD duration settings are invalid");
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new CaptureConfigError("Silero VAD threshold must be between 0 and 1");
  }
  if (!Number.isInteger(threads) || threads <= 0) {
    throw new CaptureConfigError("Silero VAD threads must be a positive integer");
  }
  return {
    config: {
      sileroVad: {
        model: expandTilde(input.modelPath),
        threshold,
        minSpeechDuration: input.minSpeechMs / 1_000,
        minSilenceDuration: minSilenceMs / 1_000,
        maxSpeechDuration: maxSpeechMs / 1_000,
        windowSize: 512,
      },
      sampleRate: 16_000,
      debug: false,
      numThreads: threads,
    },
    bufferSeconds: 60,
  };
}

export function resolveSherpaExport(module: unknown): SherpaOnnxModule | null {
  const candidates = [module, (module as { default?: unknown } | null)?.default];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && typeof (candidate as SherpaOnnxModule).Vad === "function") {
      return candidate as SherpaOnnxModule;
    }
  }
  return null;
}

export async function loadSherpaOnnx(
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<SherpaOnnxModule> {
  // Computed specifier keeps the optional sherpa-onnx-node peer out of the static
  // dependency graph so the package builds and runs without it installed.
  const specifier = "sherpa-onnx-" + "node";
  let module: unknown;
  try {
    module = await importModule(specifier);
  } catch (error) {
    // A genuinely absent package surfaces as ERR_MODULE_NOT_FOUND naming the
    // specifier as a package, with no require stack. An installed-but-broken
    // package (missing native .node, dlopen failure) has a different code
    // and/or a require stack, so it must NOT be reported as "not installed".
    const err = error as NodeJS.ErrnoException & { requireStack?: unknown };
    const message = error instanceof Error ? error.message : "";
    const packageMissing =
      err.code === "ERR_MODULE_NOT_FOUND" &&
      err.requireStack === undefined &&
      message.includes(`package '${specifier}'`);
    if (packageMissing) {
      throw new CaptureConfigError(
        "Silero VAD requires optional dependency sherpa-onnx-node; install it before enabling VAD",
      );
    }
    // Installed but unusable. Report that distinctly, but keep the message
    // operator-safe: never echo the raw error (it can leak absolute native
    // library paths), per the CaptureConfigError contract.
    throw new CaptureConfigError(
      "Silero VAD could not load the installed sherpa-onnx-node native runtime; verify its native build and shared-library dependencies",
    );
  }
  const resolved = resolveSherpaExport(module);
  if (!resolved) {
    throw new CaptureConfigError("sherpa-onnx-node does not expose the Vad API required by capture-audio");
  }
  return resolved;
}

export async function createSileroVad(
  input: SileroVadInput,
  load: () => Promise<SherpaOnnxModule> = loadSherpaOnnx,
): Promise<unknown> {
  const { config, bufferSeconds } = sileroVadConfig(input);
  const { Vad } = await load();
  return new Vad(config, bufferSeconds);
}
