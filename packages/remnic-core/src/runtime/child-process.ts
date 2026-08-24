import crossSpawn from "cross-spawn";

type ProcessOptions = Record<string, unknown>;
type ProcessStream = {
  destroyed?: boolean;
  destroy: () => void;
  end: (chunk?: string | Buffer, callback?: (error?: Error | null) => void) => void;
  on: (event: string, listener: (...args: any[]) => void) => ProcessStream;
  once: (event: string, listener: (...args: any[]) => void) => ProcessStream;
  setEncoding: (encoding: BufferEncoding) => void;
  write: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => boolean;
};
type ProcessResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
};

type SpawnApi = {
  (command: string, args?: readonly string[], options?: ProcessOptions): CommandChildProcess;
  sync: (command: string, args: readonly string[], options: ProcessOptions) => ProcessResult;
};

const spawnApi = crossSpawn as unknown as SpawnApi;

export type CommandChildProcess = {
  exitCode?: number | null;
  killed?: boolean;
  pid?: number;
  stderr?: ProcessStream | null;
  stdin?: ProcessStream | null;
  stdout?: ProcessStream | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => CommandChildProcess;
  once: (event: string, listener: (...args: any[]) => void) => CommandChildProcess;
};

export function launchProcess(
  command: string,
  args: string[],
  options?: ProcessOptions,
): CommandChildProcess {
  return spawnApi(command, args, options);
}

export function launchProcessSync(
  command: string,
  args: string[],
  options: ProcessOptions,
): ProcessResult {
  return spawnApi.sync(command, args, options);
}
