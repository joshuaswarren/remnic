import { execFile } from "node:child_process";

const DUMP_TIMEOUT_MS = 10_000;
const DUMP_MAX_BYTES = 16 * 1024 * 1024;
const SOURCE_CLASSES = new Set(["Audio/Source", "Audio/Source/Virtual"]);
const SINK_CLASSES = new Set(["Audio/Sink"]);

/** `pw-dump` parsed to its object array. Rejects with one plain line. */
export function pwDump() {
  return new Promise((resolve, reject) => {
    execFile("pw-dump", [], { timeout: DUMP_TIMEOUT_MS, maxBuffer: DUMP_MAX_BYTES }, (error, stdout) => {
      if (error?.code === "ENOENT") return reject(new Error("pw-dump was not found; install the pipewire package"));
      if (error) return reject(new Error(`could not read the PipeWire device list: ${error.message}`));
      try {
        const objects = JSON.parse(stdout);
        if (!Array.isArray(objects)) throw new Error("not an array");
        resolve(objects);
      } catch (failure) {
        reject(new Error(`could not read the PipeWire device list: ${failure.message}`));
      }
    });
  });
}

function defaultName(objects, key) {
  const metadata = objects.find((o) => o.type === "PipeWire:Interface:Metadata" && o.props?.["metadata.name"] === "default");
  const entry = metadata?.metadata?.find((m) => m.key === key);
  const value = decode(entry?.value);
  return value?.name ? String(value.name) : null;
}

/** A metadata value is a JSON document in a string, or already an object; anything else decodes to itself. */
function decode(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The names of the default microphone and the default sink; null where PipeWire names none. */
export function defaultDevices(objects) {
  return { source: defaultName(objects, "default.audio.source"), sink: defaultName(objects, "default.audio.sink") };
}

/** `device-enumerate` payload: sources as `input`, sinks as `output`, in PipeWire's order. */
export function listDevices(objects) {
  const defaults = defaultDevices(objects);
  const devices = [];
  for (const node of objects) {
    const props = node.type === "PipeWire:Interface:Node" ? node.info?.props : undefined;
    const mediaClass = props?.["media.class"];
    const kind = SOURCE_CLASSES.has(mediaClass) ? "input" : SINK_CLASSES.has(mediaClass) ? "output" : null;
    const id = props?.["node.name"];
    if (!kind || !id) continue;
    const name = props["node.description"] ?? props["node.nick"] ?? id;
    const wanted = kind === "input" ? defaults.source : defaults.sink;
    devices.push({ id, name, kind, isDefault: id === wanted });
  }
  return { devices };
}
