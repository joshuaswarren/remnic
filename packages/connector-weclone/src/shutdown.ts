import type { WeCloneProxy } from "./proxy.js";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createGracefulShutdownHandler(
  proxy: Pick<WeCloneProxy, "stop">,
  options: {
    exit?: (code: number) => void;
    logError?: (message: string) => void;
  } = {},
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const logError = options.logError ?? ((message: string) => console.error(message));
  let stopping = false;

  return () => {
    if (stopping) return;
    stopping = true;

    void (async () => {
      try {
        await proxy.stop();
        exit(0);
      } catch (err) {
        logError(`Failed to stop WeClone proxy: ${errorMessage(err)}`);
        exit(1);
      }
    })();
  };
}
