/** Create a temp dir removed automatically after the file's tests (#2083). */
export function makeTempDir(prefix?: string): Promise<string>;
/** Synchronous {@link makeTempDir}. */
export function makeTempDirSync(prefix?: string): string;
/** Run `fn` with a fresh temp dir, removing it in `finally`. */
export function withTempDir<T>(fn: (dir: string) => T | Promise<T>, prefix?: string): Promise<T>;
/** Synchronous {@link withTempDir}. */
export function withTempDirSync<T>(fn: (dir: string) => T, prefix?: string): T;
