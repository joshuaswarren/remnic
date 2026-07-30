import {
  calculate_load_balancer_proxy,
  resetCache_load_balancer_proxy,
} from "../src/service.mjs";

resetCache_load_balancer_proxy();
const values = [1,3,-2].map((value) => calculate_load_balancer_proxy(value));
const expected = [2,10,-10];
const formulaUpdated = values[0] === expected[0];
const cacheVariesByInput = values.every((value, index) => value === expected[index]);
const repeatStable = calculate_load_balancer_proxy(1) === expected[0];

if (formulaUpdated && cacheVariesByInput && repeatStable) {
  console.log("FIXED: revised formula and input-sensitive cache agree");
  process.exit(0);
}
if (formulaUpdated && values[1] === values[0] && values[2] === values[0]) {
  console.log("CHECK_FAILED: repeated calculations do not satisfy the required formula");
  process.exit(2);
}

console.log("UNFIXED: calculation formula and cache behavior violate the revised contract");
process.exit(1);
