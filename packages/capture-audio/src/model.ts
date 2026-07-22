import { createWriteStream, existsSync } from "node:fs";
import { link, mkdir, rm } from "node:fs/promises";
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

export function whisperModelUrl(model: string): string {
  const file = MODEL_FILES[model];
  if (!file) {
    throw new CaptureConfigError(`unknown Whisper model '${model}'; expected one of ${Object.keys(MODEL_FILES).join(", ")}`);
  }
  return `${MODEL_REPOSITORY}/${file}`;
}

export async function downloadWhisperModel(input: ModelDownloadInput): Promise<ModelDownloadResult> {
  const url = whisperModelUrl(input.model);
  const filename = new URL(url).pathname.split("/").at(-1);
  if (!filename) throw new CaptureConfigError("Whisper model URL has no filename");

  await mkdir(input.directory, { recursive: true });
  const destination = path.join(input.directory, filename);
  if (existsSync(destination)) return { path: destination, downloaded: false };

  const response = await (input.fetch ?? ((value) => fetch(value)))(url);
  if (!response.ok || !response.body) {
    throw new CaptureConfigError(`failed to download ${input.model}: HTTP ${response.status}`);
  }

  const temporary = path.join(input.directory, `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await pipeline(responseBodyToReadable(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await link(temporary, destination);
    await rm(temporary);
    return { path: destination, downloaded: true };
  } catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: destination, downloaded: false };
    }
    throw error;
  }
}
