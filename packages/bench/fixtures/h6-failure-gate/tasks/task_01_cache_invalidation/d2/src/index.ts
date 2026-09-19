export class CacheManager<K, V> {

    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

    const entry = this.store.get(key);
    if (!entry) return undefined;
    return entry.value;
  }
  public get(key: K): V | undefined {
  public set(key: K, value: V, ttlMs: number): void {
  private store = new Map<K, { value: V; expiresAt: number }>();
}
