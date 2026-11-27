export function shouldBuildBench(files) {
  return files.some((file) => /(^|[\\/])packages[\\/]bench([\\/]|$)/.test(file));
}
