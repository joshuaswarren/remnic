import type { ExternalWikiCollectionRoot, ExternalWikiCollectionStatus } from "./external-wiki-collection.js";
import type { SearchExecutionOptions } from "./search/port.js";

export interface ExternalWikiCollectionRefreshTarget {
  refresh(
    roots: readonly ExternalWikiCollectionRoot[],
    execution?: SearchExecutionOptions
  ): Promise<ExternalWikiCollectionStatus[]>;
}

export interface ExternalWikiCollectionTimers {
  schedule(callback: () => void, intervalMs: number): object;
  cancel(handle: object): void;
}

export interface ExternalWikiCollectionRegistrarOptions {
  target: ExternalWikiCollectionRefreshTarget;
  getRoots: () => readonly ExternalWikiCollectionRoot[];
  intervalMs: number;
  timers?: ExternalWikiCollectionTimers;
}

const defaultTimers: ExternalWikiCollectionTimers = {
  schedule(callback, intervalMs) {
    const handle = setInterval(callback, intervalMs);
    handle.unref();
    return handle;
  },
  cancel(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export class ExternalWikiCollectionRegistrar {
  private readonly timers: ExternalWikiCollectionTimers;
  private timer: object | null = null;
  private controller: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = true;
  private parentSignal: AbortSignal | null = null;
  private parentAbortListener: (() => void) | null = null;

  constructor(private readonly options: ExternalWikiCollectionRegistrarOptions) {
    this.timers = options.timers ?? defaultTimers;
  }

  async register(signal?: AbortSignal): Promise<void> {
    await this.dispose();
    if (signal?.aborted) return;

    this.disposed = false;
    this.controller = new AbortController();
    if (signal) {
      this.parentSignal = signal;
      this.parentAbortListener = () => this.controller?.abort();
      signal.addEventListener("abort", this.parentAbortListener, { once: true });
    }

    await this.refreshNow();
    if (this.disposed || this.controller.signal.aborted) return;
    this.timer = this.timers.schedule(() => {
      void this.refreshNow().catch(() => undefined);
    }, this.options.intervalMs);
  }

  async refreshNow(): Promise<void> {
    if (this.disposed || this.controller?.signal.aborted) return;
    if (this.inFlight) return this.inFlight;

    const execution = this.controller ? { signal: this.controller.signal } : undefined;
    const running = this.options.target.refresh(this.options.getRoots(), execution).then(() => undefined);
    this.inFlight = running;
    const clearInFlight = () => {
      if (this.inFlight === running) this.inFlight = null;
    };
    void running.then(clearInFlight, clearInFlight);
    return running;
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) {
      this.timers.cancel(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    if (this.parentSignal && this.parentAbortListener) {
      this.parentSignal.removeEventListener("abort", this.parentAbortListener);
    }
    this.parentSignal = null;
    this.parentAbortListener = null;
    await this.waitForIdle();
    this.controller = null;
  }
}
