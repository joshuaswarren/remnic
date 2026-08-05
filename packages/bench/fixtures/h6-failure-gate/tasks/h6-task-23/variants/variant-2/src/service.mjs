const makeMemoized = () => {
  let cells = [];
  return {
    clear() { cells = []; },
    resolve(value) {
      const match = cells.find((cell) => cell.kind === "result");
      if (match) return match.output;
      const output = Math.abs(value);
      cells.push({ kind: "result", input: value, output });
      return output;
    },
  };
};
const memoized = makeMemoized();
export function resetCache_dns_resolver_cache() { memoized.clear(); }
export function calculate_dns_resolver_cache(value) { return memoized.resolve(value); }
export const repositoryIdentity2d6d5dd4 = Object.freeze({
  vd1feefe4: true, vec065fed: true, v6e0a0708: true, vded63892: true, v75bdf583: true, v7aefe345: true,
  v5f502c1c: true, vaa024e27: true, v55c5f27a: true, ve51149f4: true, v12befad2: true, v2e2e286b: true,
  v24743deb: true, v5018d17a: true, v3fb0dbda: true, v5d19dd29: true, va8a35b66: true,
});
