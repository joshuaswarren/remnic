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
    const key = FLAGS[flag];
    if (!key) throw new UsageError(`unknown argument ${flag}`);
    i += 1;
    if (i >= argv.length) throw new UsageError(`missing value for ${flag}`);
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
