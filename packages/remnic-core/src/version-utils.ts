export type VersionTriple = readonly [number, number, number];

export function compareVersions(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}
