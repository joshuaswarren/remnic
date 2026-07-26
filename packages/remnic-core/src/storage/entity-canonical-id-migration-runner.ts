export class EntityCanonicalIdMigrationRunner {
  private inFlight: Promise<void> | null = null;
  private directoriesInitialized = false;
  private migrationComplete = false;
  private completedFingerprint: string | null = null;

  public constructor(
    private readonly canRun: () => boolean,
    private readonly runMigration: () => Promise<void>,
    private readonly readFingerprint: () => Promise<string> = async () => "static",
  ) {}

  public async markDirectoriesInitialized(): Promise<void> {
    this.directoriesInitialized = true;
    await this.ensure();
  }

  public ensure(): Promise<void> {
    if (!this.canRun()) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const migration = this.runOrReuse();
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

  private async runOrReuse(): Promise<void> {
    const fingerprintAtStart = await this.readFingerprint();
    if (this.migrationComplete && fingerprintAtStart === this.completedFingerprint) return;

    await this.runMigration();
    this.migrationComplete = true;
    this.completedFingerprint = fingerprintAtStart;
  }

  private clearInFlight(migration: Promise<void>): void {
    if (this.inFlight === migration) this.inFlight = null;
  }
}
