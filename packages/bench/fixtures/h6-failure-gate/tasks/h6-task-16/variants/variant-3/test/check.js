import { repositoryIdentitya2342d55 } from "../src/service.mjs";
const {
  v2f096b84, v43f31d4b, vb1553768, v17b17b7a, v749b65d9, vc279122e, v0269b02d, v7401d3ba,
  v86a955b3, v71ae8589, v2e9e1b5a, v236de02d, v16c2d296, v3805f098, vbac6d251, v7474fa9d,
  ve9e64c37,
} = repositoryIdentitya2342d55;
if (!Object.values(repositoryIdentitya2342d55).every(Boolean)) throw new Error("Repository identity is invalid");
import { updateState_search_index_cluster } from "../src/service.mjs";
const initial = { label: "primary", metrics: { count: 1 } };
const first = updateState_search_index_cluster(initial, 2);
const second = updateState_search_index_cluster(first, 3);
const values = [initial.metrics.count, first.metrics.count, second.metrics.count];
const noOp = updateState_search_index_cluster(second, 0);
const noOpRetainsIdentity = noOp === second &&
  noOp.metrics === second.metrics;
const isolated = initial !== first && first !== second &&
  initial.metrics !== first.metrics &&
  first.metrics !== second.metrics;
if (JSON.stringify(values) === JSON.stringify([1, 3, 6]) &&
    isolated && noOpRetainsIdentity) {
  console.log("FIXED: state history preserves values and references");
  process.exit(0);
}
if (isolated && !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (initial !== first && initial.metrics === first.metrics) {
  console.log("CHECK_FAILED: shallow copying preserves the hidden alias");
  process.exit(2);
}
console.log("UNFIXED: the first snapshot was mutated");
process.exit(1);
