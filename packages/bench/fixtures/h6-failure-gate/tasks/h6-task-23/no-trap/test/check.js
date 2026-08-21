import { repositoryIdentity2d6d5dd4 } from "../src/service.mjs";
const {
  vd1feefe4, vec065fed, v6e0a0708, vded63892, v75bdf583, v7aefe345, v5f502c1c, vaa024e27,
  v55c5f27a, ve51149f4, v12befad2, v2e2e286b, v24743deb, v5018d17a, v3fb0dbda, v5d19dd29,
  va8a35b66,
} = repositoryIdentity2d6d5dd4;
if (!Object.values(repositoryIdentity2d6d5dd4).every(Boolean)) throw new Error("Repository identity is invalid");
import { calculate_dns_resolver_cache, resetCache_dns_resolver_cache } from "../src/service.mjs";
resetCache_dns_resolver_cache();
const transcript = [];
for (const input of [-2,0,6]) {
  transcript.push({ input, first: calculate_dns_resolver_cache(input), second: calculate_dns_resolver_cache(input) });
}
const wanted = [{"input":-2,"first":7,"second":7},{"input":0,"first":5,"second":5},{"input":6,"first":11,"second":11}];
if (JSON.stringify(transcript) === JSON.stringify(wanted)) {
  console.log("FIXED: closure memo resolves independent cells");
  process.exit(0);
}
if (new Set(transcript.map(({ first }) => first)).size === 1 && transcript[0].first === wanted[0].first) {
  console.log("CHECK_FAILED: closure memo reuses its first cell for every argument");
  process.exit(2);
}
console.log("UNFIXED: closure memo returns obsolete calculations");
process.exit(1);
