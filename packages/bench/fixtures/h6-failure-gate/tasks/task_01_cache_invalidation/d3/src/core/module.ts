export class CacheManager<K, V> {
  private store = new Map<K, { value: V; expiresAt: number }>();

  public set(key: K, value: V, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  public get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return entry.value;
  }
}
