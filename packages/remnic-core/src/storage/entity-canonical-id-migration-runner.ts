export class EntityCanonicalIdMigrationRunner {
  private inFlight: Promise<void> | null = null;
  private directoriesInitialized = false;
  private migrationComplete = false;
  private completedFingerprint: string | null = null;

  public constructor(
    private readonly canRun: () => boolean,
    private readonly runMigration: () => Promise<string | void>,
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
    let fingerprintAtStart = await this.readFingerprint();
    if (this.migrationComplete && fingerprintAtStart === this.completedFingerprint) return;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const completionFingerprint = await this.runMigration();
      const fingerprintAfterMigration = await this.readFingerprint();
      const fingerprintAfterStabilityRead = await this.readFingerprint();
      const returnedFingerprint =
        typeof completionFingerprint === "string" ? completionFingerprint : fingerprintAfterMigration;
      if (
        returnedFingerprint === fingerprintAfterMigration
        && fingerprintAfterMigration === fingerprintAfterStabilityRead
        && (
          typeof completionFingerprint === "string"
          || fingerprintAfterMigration === fingerprintAtStart
        )
      ) {
        this.migrationComplete = true;
        this.completedFingerprint = fingerprintAfterStabilityRead;
        return;
      }
      fingerprintAtStart = fingerprintAfterStabilityRead;
    }

    this.migrationComplete = false;
    this.completedFingerprint = null;
    throw new Error("Entity canonical-id migration fingerprint changed while migration was completing; retry migration.");
  }

  private clearInFlight(migration: Promise<void>): void {
    if (this.inFlight === migration) this.inFlight = null;
  }
}
