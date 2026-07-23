import { createWriteStream, lstatSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { CaptureConfigError } from "./errors.js";

const MODEL_FILES: Record<string, string> = {
  base: "ggml-base.bin",
  small: "ggml-small.bin",
  "large-v3-turbo-q5_0": "ggml-large-v3-turbo-q5_0.bin",
};

const MODEL_REPOSITORY = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

type ModelFetch = (url: string) => Promise<Response>;

export interface ModelDownloadInput {
  model: string;
  directory: string;
  fetch?: ModelFetch;
}

export interface ModelDownloadResult {
  path: string;
  downloaded: boolean;
}

function responseBodyToReadable(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  return new Readable({
    read() {
      void reader
        .read()
        .then(({ done, value }) => this.push(done ? null : Buffer.from(value)))
        .catch((error: unknown) => this.destroy(error as Error));
    },
  });
}

function existingFile(destination: string): boolean {
  let entry;
  try {
    entry = statSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // statSync follows symlinks, so ENOENT is either no directory entry at
    // all or a dangling symlink. lstatSync tells them apart: if it succeeds,
    // a broken symlink occupies the path and must be cleared, not silently
    // treated as absent (a later rename/link would fail on it).
    try {
      lstatSync(destination);
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw linkError;
    }
    throw new CaptureConfigError(`Whisper model path is a broken symlink: ${destination}; remove it and retry`);
  }
  if (!entry.isFile()) {
    throw new CaptureConfigError(`Whisper model path exists but is not a regular file: ${destination}`);
  }
  return true;
}

export function whisperModelUrl(model: string): string {
  if (!Object.hasOwn(MODEL_FILES, model)) {
    throw new CaptureConfigError(`unknown Whisper model '${model}'; expected one of ${Object.keys(MODEL_FILES).join(", ")}`);
  }
  const file = MODEL_FILES[model];
  return `${MODEL_REPOSITORY}/${file}`;
}

export async function downloadWhisperModel(input: ModelDownloadInput): Promise<ModelDownloadResult> {
  const url = whisperModelUrl(input.model);
  const filename = new URL(url).pathname.split("/").at(-1);
  if (!filename) throw new CaptureConfigError("Whisper model URL has no filename");

  await mkdir(input.directory, { recursive: true });
  const destination = path.join(input.directory, filename);
  if (existingFile(destination)) return { path: destination, downloaded: false };

  let response;
  try {
    response = await (input.fetch ?? ((value) => fetch(value)))(url);
  } catch {
    throw new CaptureConfigError(
      `failed to download ${input.model}: the network request to Hugging Face failed (check connectivity/proxy/DNS)`,
    );
  }
  if (!response.ok || !response.body) {
    throw new CaptureConfigError(`failed to download ${input.model}: HTTP ${response.status}`);
  }

  const temporary = path.join(input.directory, `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await pipeline(responseBodyToReadable(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    // Atomic same-directory rename: works on filesystems without hard-link
    // support (FAT32/exFAT, some network mounts), unlike link()+rm().
    await rename(temporary, destination);
    return { path: destination, downloaded: true };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
