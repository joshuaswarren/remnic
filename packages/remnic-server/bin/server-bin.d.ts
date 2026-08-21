// Type surface for the source-controlled plain-JS server bin wrapper. Declares
// exactly the options the wrapper reads so callers (tests) are type-checked
// without a build step. Keep in sync with server-bin.js.
export interface RunServerBinOptions {
  argv?: string[];
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exit?: (code: number) => void;
  loadCliMain?: () => Promise<{ cliMain: (argv: string[]) => Promise<void> | void }>;
}

export function shouldPrintHelpWithoutCli(argv: string[]): boolean;
export function runServerBin(commandName: string, options?: RunServerBinOptions): Promise<void>;
