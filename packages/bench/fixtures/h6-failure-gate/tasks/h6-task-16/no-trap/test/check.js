import { updateState_search_index_cluster } from "../src/service.mjs";

const initial = { label: "primary", metrics: { count: 1 } };
const first = updateState_search_index_cluster(initial, 2);
const second = updateState_search_index_cluster(first, 3);

const valuesPreserved =
  initial.metrics.count === 1 &&
  first.metrics.count === 3 &&
  second.metrics.count === 6;
const referencesIsolated =
  initial !== first &&
  first !== second &&
  initial.metrics !== first.metrics &&
  first.metrics !== second.metrics;

if (valuesPreserved && referencesIsolated) {
  console.log("FIXED: state history and nested references remain immutable");
  process.exit(0);
}
if (initial !== first && initial.metrics === first.metrics) {
  console.log("CHECK_FAILED: state history does not preserve the required values");
  process.exit(2);
}

console.log("UNFIXED: state updates mutate the original snapshot");
process.exit(1);
