/** A command line the helper refuses; main() prints the message and exits 2. */
export class UsageError extends Error {}

export const CHANNELS = ["mic", "system", "both"];
const DEFAULT_CHUNK_SECONDS = 30;
const FLAGS = { "--out": "out", "--chunk-seconds": "chunkSeconds", "--channel": "channel", "--device": "device" };

/**
 * Parse `audio-capture` flags the way the macOS helper does:
 * `--channel mic|system|both --chunk-seconds N --out <dir> [--device <id>]`.
 */
export function parseAudioArgs(argv) {
  const given = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = Object.hasOwn(FLAGS, flag) ? FLAGS[flag] : null;
    if (!key) throw new UsageError(`unknown argument ${flag}`);
    i += 1;
    if (i >= argv.length || Object.hasOwn(FLAGS, argv[i])) throw new UsageError(`missing value for ${flag}`);
    given[key] = argv[i];
  }
  if (given.channel === undefined) throw new UsageError("--channel is required");
  if (!CHANNELS.includes(given.channel)) throw new UsageError(`invalid channel ${given.channel}; use mic, system or both`);
  if (given.out === undefined) throw new UsageError("--out is required");
  const chunkSeconds = given.chunkSeconds === undefined ? DEFAULT_CHUNK_SECONDS : Number(given.chunkSeconds);
  if (!Number.isInteger(chunkSeconds) || chunkSeconds <= 0) {
    throw new UsageError("--chunk-seconds must be a positive whole number");
  }
  return { channel: given.channel, chunkSeconds, out: given.out, device: given.device ?? null };
}

function wholeNumber(text, flag) {
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) throw new UsageError(`${flag} must be a positive whole number`);
  return value;
}

function valueOf(argv, i, flag) {
  if (i >= argv.length) throw new UsageError(`missing value for ${flag}`);
  return argv[i];
}

/**
 * `ax-snapshot [--frontmost | --pid N | --window ID] [--window-only] [--max-nodes N]`. `--window-only` asks for
 * the window's app, title, id and address and no tree, so the caller can apply its deny list before any read.
 */
export function parseAxArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--frontmost") continue;
    if (flag === "--window-only") parsed.windowOnly = true;
    else if (flag === "--pid") parsed.pid = wholeNumber(valueOf(argv, (i += 1), flag), flag);
    else if (flag === "--window") parsed.windowId = valueOf(argv, (i += 1), flag);
    else if (flag === "--max-nodes") parsed.maxNodes = wholeNumber(valueOf(argv, (i += 1), flag), flag);
    else throw new UsageError(`unknown argument ${flag}`);
  }
  if (parsed.pid !== undefined && parsed.windowId !== undefined) {
    throw new UsageError("--pid and --window are mutually exclusive");
  }
  return parsed;
}

/** `ocr-window [--frontmost | --window ID]`. */
export function parseOcrArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--frontmost") continue;
    if (flag === "--window") parsed.windowId = valueOf(argv, (i += 1), flag);
    else throw new UsageError(`unknown argument ${flag}`);
  }
  return parsed;
}
