import { UsageError, parseAudioArgs } from "./args.mjs";
import { audioCapture } from "./audio.mjs";
import { listDevices, pwDump } from "./pipewire.mjs";

const SUBCOMMANDS = ["audio-capture", "device-enumerate"];

async function deviceEnumerate() {
  process.stdout.write(`${JSON.stringify(listDevices(await pwDump()))}\n`);
  return 0;
}

/** Run one helper subcommand; returns the process exit status (0 ok, 1 failed, 2 bad command line). */
export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === "audio-capture") return await audioCapture(parseAudioArgs(rest));
    if (command === "device-enumerate") return await deviceEnumerate();
    throw new UsageError(`unknown subcommand ${command ?? "(none)"}; this helper has ${SUBCOMMANDS.join(" and ")}`);
  } catch (error) {
    process.stderr.write(`remnic-capture-helper: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
