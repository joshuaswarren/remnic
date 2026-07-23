import { readFile } from "node:fs/promises";

import { expandTildePath } from "@remnic/core";

import { startCaptureScreenDaemon, type CaptureSnapshot, type RunningCaptureScreenDaemon } from "./daemon.js";

export interface CaptureScreenCommandOptions {
  spoolPath: string;
  replayPath?: string;
  port?: number;
}

/**
 * The bearer token is read from the environment, never CLI argv: a long-lived
 * daemon's argv is world-readable via `ps` / `/proc` on a multi-user host, so a
 * token on the command line would let any local account recover it and read the
 * captured screen text. A supervisor sets this in the child's env instead.
 */
const CAPTURE_TOKEN_ENV = "REMNIC_CAPTURE_TOKEN";

function readCaptureToken(): string {
  const token = process.env[CAPTURE_TOKEN_ENV] ?? process.env.ENGRAM_CAPTURE_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new TypeError(`${CAPTURE_TOKEN_ENV} must be set to the capture daemon bearer token`);
  }
  return token;
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) throw new TypeError(`${flag} requires a value`);
  return value;
}

export function parseCaptureScreenArgs(args: readonly string[]): CaptureScreenCommandOptions {
  let spoolPath: string | undefined;
  let replayPath: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--auth-token") {
      throw new TypeError(`--auth-token is not accepted; set the ${CAPTURE_TOKEN_ENV} environment variable instead`);
    } else if (flag === "--spool") spoolPath = requireValue(args, index++, flag);
    else if (flag === "--replay") replayPath = requireValue(args, index++, flag);
    else if (flag === "--port") {
      const value = Number(requireValue(args, index++, flag));
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new RangeError("--port must be an integer from 0 to 65535");
      port = value;
    } else throw new TypeError(`unknown option: ${flag}`);
  }
  if (spoolPath === undefined) throw new TypeError("--spool is required");
  return { spoolPath, ...(replayPath === undefined ? {} : { replayPath }), ...(port === undefined ? {} : { port }) };
}

async function readReplay(path: string | undefined): Promise<CaptureSnapshot[] | undefined> {
  if (path === undefined) return undefined;
  const parsed: unknown = JSON.parse(await readFile(expandTildePath(path), "utf8"));
  if (!Array.isArray(parsed)) throw new TypeError("--replay JSON must be an array of snapshots");
  return parsed as CaptureSnapshot[];
}

export async function runCaptureScreenCommand(args: readonly string[]): Promise<RunningCaptureScreenDaemon> {
  const options = parseCaptureScreenArgs(args);
  const authToken = readCaptureToken();
  const daemon = await startCaptureScreenDaemon({
    authToken,
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
