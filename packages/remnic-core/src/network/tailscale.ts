import { stat } from "node:fs/promises";
import { launchProcess } from "../runtime/child-process.js";

export interface TailscaleCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type TailscaleCommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<TailscaleCommandResult>;

export interface TailscaleStatus {
  available: boolean;
  running: boolean;
  backendState?: string;
  version?: string;
  selfHostname?: string;
  selfIp?: string;
}

export interface TailscaleSyncOptions {
  sourceDir: string;
  destination: string;
  delete?: boolean;
  dryRun?: boolean;
  extraArgs?: string[];
}

export interface TailscaleHelperOptions {
  tailscaleBinary?: string;
  rsyncBinary?: string;
  timeoutMs?: number;
  runner?: TailscaleCommandRunner;
}

interface TailscaleStatusJson {
  BackendState?: string;
  Version?: string;
  Self?: {
    HostName?: string;
    TailscaleIPs?: string[];
  };
}

export class TailscaleHelper {
  private readonly tailscaleBinary: string;
  private readonly rsyncBinary: string;
  private readonly timeoutMs: number;
  private readonly runner: TailscaleCommandRunner;

  constructor(options: TailscaleHelperOptions = {}) {
    this.tailscaleBinary = options.tailscaleBinary ?? "tailscale";
    this.rsyncBinary = options.rsyncBinary ?? "rsync";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.runner = options.runner ?? defaultCommandRunner;
  }

  async isAvailable(): Promise<boolean> {
    const result = await this.runner(this.tailscaleBinary, ["version"], { timeoutMs: this.timeoutMs });
    return result.code === 0;
  }

  async status(): Promise<TailscaleStatus> {
    const available = await this.isAvailable();
    if (!available) {
      return { available: false, running: false };
    }

    const result = await this.runner(this.tailscaleBinary, ["status", "--json"], { timeoutMs: this.timeoutMs });
    if (result.code !== 0) {
      return { available: true, running: false };
    }

    let parsed: TailscaleStatusJson;
    try {
      parsed = JSON.parse(result.stdout) as TailscaleStatusJson;
    } catch {
      throw new Error("tailscale status returned invalid JSON");
    }

    const backendState = parsed.BackendState ?? "";
    return {
      available: true,
      running: backendState === "Running",
      backendState,
      version: parsed.Version,
      selfHostname: parsed.Self?.HostName,
      selfIp: parsed.Self?.TailscaleIPs?.[0],
    };
  }

  async syncDirectory(options: TailscaleSyncOptions): Promise<void> {
    await assertReadableDirectory(options.sourceDir);

    const tailscaleStatus = await this.status();
    if (!tailscaleStatus.available) {
      throw new Error("tailscale is not installed or not available in PATH");
    }
    if (!tailscaleStatus.running) {
      throw new Error("tailscale daemon is not running");
    }

    const args: string[] = ["-az"];
    if (options.delete) args.push("--delete");
    if (options.dryRun) args.push("--dry-run");
    if (options.extraArgs?.length) args.push(...options.extraArgs);

    const sourceWithTrailingSlash = options.sourceDir.endsWith("/") ? options.sourceDir : `${options.sourceDir}/`;
    args.push(sourceWithTrailingSlash, options.destination);

    const result = await this.runner(this.rsyncBinary, args);
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(stderr ? `rsync failed: ${stderr}` : "rsync failed");
    }
  }
}

async function assertReadableDirectory(dir: string): Promise<void> {
  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw new Error(`sourceDir must be a directory: ${dir}`);
  }
}

const defaultCommandRunner: TailscaleCommandRunner = (command, args, options) => {
  return new Promise((resolve) => {
    const child = launchProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      resolve({ code: 1, stdout: "", stderr: "command pipes unavailable" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeoutMs = options?.timeoutMs;
    const timeout = typeof timeoutMs === "number" && timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          resolve({
            code: 124,
            stdout,
            stderr: stderr || "command timed out",
          });
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
};
