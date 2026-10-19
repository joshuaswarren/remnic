/**
 * Child-process entry for the scheduled memory-projection rebuild.
 *
 * The daemon forks this file so the corpus and lifecycle ledger are allocated
 * in a fresh heap. Invoke only with `--remnic-projection-rebuild-runner`.
 * Arguments are the memory directory, default namespace, and an ISO timestamp.
 * Do not put secrets, passphrases, or secure-store unlock material on argv
 * or in the environment — an encrypted store rebuilds in the parent instead.
 */
import { initLogger, log } from "../logger.js";
import { rebuildMemoryProjection } from "./rebuild-memory-projection.js";

export const PROJECTION_REBUILD_RUNNER_FLAG = "--remnic-projection-rebuild-runner";

export interface ProjectionRebuildRunnerSuccess {
  ok: true;
  currentRows: number;
  timelineRows: number;
  entityMentionRows: number;
}

interface ProjectionRebuildRunnerFailure {
  ok: false;
  error: string;
}

function runnerArgs(): { memoryDir: string; defaultNamespace: string; now: Date } {
  const index = process.argv.indexOf(PROJECTION_REBUILD_RUNNER_FLAG);
  const memoryDir = index >= 0 ? process.argv[index + 1] : undefined;
  const defaultNamespace = index >= 0 ? process.argv[index + 2] : undefined;
  const nowIso = index >= 0 ? process.argv[index + 3] : undefined;
  if (!memoryDir || !defaultNamespace || !nowIso) {
    throw new Error(
      "projection rebuild runner requires memoryDir, defaultNamespace, and now",
    );
  }
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`projection rebuild runner now is not a timestamp: ${nowIso}`);
  }
  return { memoryDir, defaultNamespace, now };
}

function send(message: ProjectionRebuildRunnerSuccess | ProjectionRebuildRunnerFailure): Promise<void> {
  if (typeof process.send !== "function") {
    throw new Error("projection rebuild runner requires an IPC channel");
  }
  const sendMessage = process.send.bind(process);
  return new Promise((resolve, reject) => {
    sendMessage(message, (err) => (err ? reject(err) : resolve()));
  });
}

async function main(): Promise<void> {
  initLogger();
  const { memoryDir, defaultNamespace, now } = runnerArgs();
  const result = await rebuildMemoryProjection({
    memoryDir,
    defaultNamespace,
    dryRun: false,
    now,
  });
  await send({
    ok: true,
    currentRows: result.currentRows,
    timelineRows: result.timelineRows,
    entityMentionRows: result.entityMentionRows,
  });
}

const invokedAsRunner = process.argv.includes(PROJECTION_REBUILD_RUNNER_FLAG);
if (invokedAsRunner) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`projection rebuild runner failed: ${error}`);
      send({ ok: false, error }).then(
        () => process.exit(1),
        () => process.exit(1),
      );
    },
  );
}
