// ---------------------------------------------------------------------------
// `remnic capture audio <subcommand>` passthrough (issue #1897)
// ---------------------------------------------------------------------------
//
// `@remnic/capture-audio` is an à-la-carte optional package: installing the
// CLI alone never pulls it in. This dispatcher forwards
// `remnic capture audio <sub> [args...]` to the package's `runCapture`,
// loaded lazily via a computed-specifier dynamic import so the bundler
// leaves it as a runtime call. When the package is absent we surface a
// clean install hint (AGENTS.md §44 / #1897 AC), never a bare
// MODULE_NOT_FOUND.

import { isSpecifierNotFoundError } from "./optional-module-loader.js";

const SPECIFIER = "@remnic/" + "capture-audio";

export const INSTALL_HINT =
  "`remnic capture audio` requires the optional @remnic/capture-audio package. " +
  "Install it with: npm install @remnic/capture-audio";

const USAGE =
  "usage: remnic capture audio <init|start|stop|status|devices|logs|download-model|janitor|enroll-self> [options]";

/** Shape of the optional package this dispatcher forwards to. */
export interface CaptureAudioModule {
  runCapture(io: {
    argv: string[];
    env?: NodeJS.ProcessEnv;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  }): Promise<number>;
}

export interface CaptureDispatchIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Injectable loader (tests supply present/absent modules). */
  loadCaptureAudio?: () => Promise<CaptureAudioModule>;
}

/** Map a dynamic-import failure to the install hint (missing package) or rethrow. */
export function translateCaptureLoadError(err: unknown): Error {
  if (isSpecifierNotFoundError(err, SPECIFIER)) return new Error(INSTALL_HINT);
  return err instanceof Error ? err : new Error(String(err));
}

async function defaultLoadCaptureAudio(): Promise<CaptureAudioModule> {
  try {
    return (await import(SPECIFIER)) as unknown as CaptureAudioModule;
  } catch (err) {
    throw translateCaptureLoadError(err);
  }
}

/**
 * `remnic capture <rest...>`. Only the `audio` subgroup exists today; it
 * forwards the remaining argv to the capture-audio CLI. Returns a process
 * exit code (0 success, 2 usage/install error).
 */
export async function cmdCapture(rest: string[], io: CaptureDispatchIO): Promise<number> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    io.stdout(USAGE);
    return rest.length === 0 ? 2 : 0;
  }
  if (rest[0] !== "audio") {
    io.stderr(`unknown capture subgroup '${rest[0]}'. ${USAGE}`);
    return 2;
  }
  const forwarded = rest.slice(1);
  let mod: CaptureAudioModule;
  try {
    mod = await (io.loadCaptureAudio ?? defaultLoadCaptureAudio)();
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 2;
  }
  return mod.runCapture({ argv: forwarded, stdout: io.stdout, stderr: io.stderr });
}
