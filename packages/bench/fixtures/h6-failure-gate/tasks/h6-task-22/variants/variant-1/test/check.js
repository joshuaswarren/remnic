import {
  calculate_audit_logger_stream,
  resetCache_audit_logger_stream,
} from "../src/service.mjs";

resetCache_audit_logger_stream();
const values = [2,4,-3].map((value) => calculate_audit_logger_stream(value));
const expected = [4,16,9];
const formulaUpdated = values[0] === expected[0];
const cacheVariesByInput = values.every((value, index) => value === expected[index]);
const repeatStable = calculate_audit_logger_stream(2) === expected[0];

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
