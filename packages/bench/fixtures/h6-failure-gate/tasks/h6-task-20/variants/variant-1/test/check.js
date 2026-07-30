import { updateState_rate_limiter_filter } from "../src/service.mjs";

const initial = { label: "primary", quota: { remaining: 30 } };
const first = updateState_rate_limiter_filter(initial, 7);
const second = updateState_rate_limiter_filter(first, 8);

const valuesPreserved =
  initial.quota.remaining === 30 &&
  first.quota.remaining === 23 &&
  second.quota.remaining === 15;
const referencesIsolated =
  initial !== first &&
  first !== second &&
  initial.quota !== first.quota &&
  first.quota !== second.quota;

if (valuesPreserved && referencesIsolated) {
  console.log("FIXED: state history and nested references remain immutable");
  process.exit(0);
}
if (initial !== first && initial.quota === first.quota) {
  console.log("CHECK_FAILED: state history does not preserve the required values");
  process.exit(2);
}

console.log("UNFIXED: state updates mutate the original snapshot");
process.exit(1);
