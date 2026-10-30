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

  /**
   * First half of deferred startup: when waiting, ensure the migration runs;
   * when deferring, pre-read the entity entries the store serves instead and
   * let the migration start later (finishBegin detaches it).
   */
  public async begin(wait: boolean, entitiesDir: string): Promise<void> {
    if (wait) {
      await this.ensure();
      return;
    }
    const { readSafeEntityEntries } = await import("./entity-canonical-id-migration.js");
    await readSafeEntityEntries(entitiesDir);
  }

  /**
   * Second half: return the directory-initialized barrier when waiting, or
   * detach it with a warning when the caller deferred the migration.
   */
  public finishBegin(wait: boolean): Promise<void> {
    const barrier = this.markDirectoriesInitialized();
    if (wait) return barrier;
    // Thrown rejections are Error-or-primitive; the message extractor
    // handles both without asserting a shape.
    const describeDeferredFailure = (failure: Error | string): string =>
      failure instanceof Error ? failure.message : failure;
    void barrier.catch(describeDeferredFailureAndWarn);
    function describeDeferredFailureAndWarn(failure: Error | string): void {
      console.warn(`entity canonical-id migration deferred at startup failed: ${describeDeferredFailure(failure)}`);
    }
    return Promise.resolve();
  }

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

  public async drain(): Promise<void> {
    while (this.inFlight) await this.inFlight.catch(() => undefined);
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
