import { readFile } from "node:fs/promises";

import { expandTildePath } from "@remnic/core";

import { startCaptureScreenDaemon, type CaptureSnapshot, type RunningCaptureScreenDaemon } from "./daemon.js";

export interface CaptureScreenCommandOptions {
  authToken: string;
  spoolPath: string;
  replayPath?: string;
  port?: number;
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) throw new TypeError(`${flag} requires a value`);
  return value;
}

export function parseCaptureScreenArgs(args: readonly string[]): CaptureScreenCommandOptions {
  let authToken: string | undefined;
  let spoolPath: string | undefined;
  let replayPath: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--auth-token") authToken = requireValue(args, index++, flag);
    else if (flag === "--spool") spoolPath = requireValue(args, index++, flag);
    else if (flag === "--replay") replayPath = requireValue(args, index++, flag);
    else if (flag === "--port") {
      const value = Number(requireValue(args, index++, flag));
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new RangeError("--port must be an integer from 0 to 65535");
      port = value;
    } else throw new TypeError(`unknown option: ${flag}`);
  }
  if (authToken === undefined) throw new TypeError("--auth-token is required");
  if (spoolPath === undefined) throw new TypeError("--spool is required");
  return { authToken, spoolPath, ...(replayPath === undefined ? {} : { replayPath }), ...(port === undefined ? {} : { port }) };
}

async function readReplay(path: string | undefined): Promise<CaptureSnapshot[] | undefined> {
  if (path === undefined) return undefined;
  const parsed: unknown = JSON.parse(await readFile(expandTildePath(path), "utf8"));
  if (!Array.isArray(parsed)) throw new TypeError("--replay JSON must be an array of snapshots");
  return parsed as CaptureSnapshot[];
}

export async function runCaptureScreenCommand(args: readonly string[]): Promise<RunningCaptureScreenDaemon> {
  const options = parseCaptureScreenArgs(args);
  const daemon = await startCaptureScreenDaemon({
    authToken: options.authToken,
    spoolPath: expandTildePath(options.spoolPath),
    replay: await readReplay(options.replayPath),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  try {
    return await daemon.start();
  } catch (error) {
    await daemon.close();
    throw error;
  }
}
