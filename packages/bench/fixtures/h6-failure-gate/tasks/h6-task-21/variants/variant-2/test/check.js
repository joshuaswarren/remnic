import {
  calculate_feature_flag_service,
  resetCache_feature_flag_service,
} from "../src/service.mjs";

resetCache_feature_flag_service();
const values = [2,3,-1].map((value) => calculate_feature_flag_service(value));
const expected = [7,10,-2];
const formulaUpdated = values[0] === expected[0];
const cacheVariesByInput = values.every((value, index) => value === expected[index]);
const repeatStable = calculate_feature_flag_service(2) === expected[0];

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
