export class EntityCanonicalIdMigrationRunner {
  private complete = false;
  private inFlight: Promise<void> | null = null;
  private directoriesInitialized = false;

  public constructor(
    private readonly canRun: () => boolean,
    private readonly runMigration: () => Promise<void>,
  ) {}

  public async markDirectoriesInitialized(): Promise<void> {
    this.directoriesInitialized = true;
    await this.ensure();
  }

  public ensure(): Promise<void> {
    if (this.complete || !this.canRun()) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const migration = this.runMigration();
    this.inFlight = migration;
    void migration.then(
      () => this.clearInFlight(migration),
      () => this.clearInFlight(migration),
    );
    return migration;
  }

  public triggerAfterUnlock(): Promise<void> {
    if (!this.directoriesInitialized) return Promise.resolve();
    return this.ensure();
  }

  public markComplete(): void {
    this.complete = true;
  }

  private clearInFlight(migration: Promise<void>): void {
    if (this.inFlight === migration) this.inFlight = null;
  }
}
