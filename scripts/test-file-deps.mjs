/**
 * Decide which optional workspace packages `scripts/test-file.mjs` must
 * build. Building `@remnic/bench` on every targeted test run fails in a
 * fresh worktree when bench DTS cannot emit, even if the test never
 * imports bench.
 */
export function shouldBuildBench(files) {
  return files.some((file) => /(^|[\\/])packages[\\/]bench([\\/]|$)/.test(file));
}
