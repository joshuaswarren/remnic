import type { TestContext } from "node:test";

export const CANARY: "TRANSIENT VAULT COVER CANARY 4826";

interface TestDesktop {
  dir: string;
  env: NodeJS.ProcessEnv;
  wrapper: string;
  calls(name: string): string[];
  stop(): void;
}

export function transientDesktop(context: TestContext, mode: string): Promise<TestDesktop>;
export function runOcr(desktop: TestDesktop): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;
