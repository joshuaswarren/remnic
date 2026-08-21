import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { scanSignals } from "./signal.js";
import { log } from "./logger.js";
import type { PluginConfig } from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

export type BootstrapResult = {
  sessionsScanned: number;
  turnsProcessed: number;
  highSignalTurns: number;
  memoriesCreated: number;
  skipped: number;
};

export type BootstrapOptions = {
  dryRun?: boolean;
  sessionsDir?: string;
  limit?: number;
  since?: Date;
};

type BootstrapEntry = {
  role: string;
  content: string;
  timestamp: string;
  sessionKey?: string;
};

export class BootstrapEngine {
  constructor(private config: PluginConfig, private orchestrator: Orchestrator) {}

  async run(options: BootstrapOptions): Promise<BootstrapResult> {
    const dryRun = options.dryRun === true;
    const since = options.since ?? new Date(0);
    const end = new Date();
    const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);

    const sessions = await this.resolveSessions(options.sessionsDir, since, end);
    const selected = sessions.slice(0, Number.isFinite(limit) ? limit : sessions.length);

    const beforeCount = dryRun ? 0 : (await this.orchestrator.storage.readAllMemories()).length;
    let turnsProcessed = 0;
    let highSignalTurns = 0;
    let skipped = 0;

    for (const session of selected) {
      for (const entry of session.entries) {
        if (entry.role !== "user") continue;
        turnsProcessed += 1;

        const content = typeof entry.content === "string" ? entry.content.trim() : "";
        if (!content) {
          skipped += 1;
          continue;
        }

        const signal = scanSignals(content, this.config.highSignalPatterns);
        if (signal.level !== "high") {
          skipped += 1;
          continue;
        }

        highSignalTurns += 1;
        if (!dryRun) {
          await this.orchestrator.processTurn("user", content, session.sessionKey);
        }
      }
    }

    let memoriesCreated = 0;
    if (!dryRun && highSignalTurns > 0) {
      await this.orchestrator.waitForExtractionIdle();
      const afterCount = (await this.orchestrator.storage.readAllMemories()).length;
      memoriesCreated = Math.max(0, afterCount - beforeCount);
    }

    const result: BootstrapResult = {
      sessionsScanned: selected.length,
      turnsProcessed,
      highSignalTurns,
      memoriesCreated,
      skipped,
    };
    log.info(
      `bootstrap complete: sessions=${result.sessionsScanned}, turns=${result.turnsProcessed}, high=${result.highSignalTurns}, created=${result.memoriesCreated}, skipped=${result.skipped}, dryRun=${dryRun}`,
    );
    return result;
  }

  private async resolveSessions(
    sessionsDir: string | undefined,
    since: Date,
    until: Date,
  ): Promise<Array<{ sessionKey: string; entries: BootstrapEntry[] }>> {
    if (sessionsDir && sessionsDir.trim().length > 0) {
      return this.readSessionsFromDir(sessionsDir, since, until);
    }

    const keys = await this.orchestrator.transcript.listSessionKeys();
    const sessions: Array<{ sessionKey: string; entries: BootstrapEntry[] }> = [];
    for (const key of keys) {
      const entries = await this.orchestrator.transcript.readRange(
        since.toISOString(),
        until.toISOString(),
        key,
      );
      if (entries.length > 0) {
        sessions.push({ sessionKey: key, entries });
      }
    }
    return sessions;
  }

  private async readSessionsFromDir(
    baseDir: string,
    since: Date,
    until: Date,
  ): Promise<Array<{ sessionKey: string; entries: BootstrapEntry[] }>> {
    const files = await this.listJsonlFiles(baseDir);
    const bySession = new Map<string, BootstrapEntry[]>();

    for (const filePath of files) {
      let raw = "";
      try {
        raw = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = new Date(String(parsed?.timestamp ?? ""));
        if (Number.isNaN(ts.getTime())) continue;
        if (ts < since || ts > until) continue;
        const role = String(parsed?.role ?? "");
        const content = typeof parsed?.content === "string" ? parsed.content : "";
        if (!role || !content) continue;
        const sessionKey = typeof parsed?.sessionKey === "string" && parsed.sessionKey.length > 0
          ? parsed.sessionKey
          : path.relative(baseDir, filePath);
        const list = bySession.get(sessionKey) ?? [];
        list.push({
          role,
          content,
          timestamp: ts.toISOString(),
          sessionKey,
        });
        bySession.set(sessionKey, list);
      }
    }

    return Array.from(bySession.entries()).map(([sessionKey, entries]) => ({
      sessionKey,
      entries: entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    }));
  }

  private async listJsonlFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.listJsonlFiles(full)));
      } else if (entry.isFile() && full.endsWith(".jsonl")) {
        out.push(full);
      }
    }
    return out;
  }
}

