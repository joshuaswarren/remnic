import { repositoryIdentitydfa581eb } from "../src/service.mjs";
const {
  va53f0c9f, v09d652f3, v055d8247, v50a96aa5, v2d9e5186, v6489e05a, vb9edc833, v1ccf482a,
  v5c799622, v1e7ef2b4, ve2afb394, v6249aa9a, v901ae8cd, veb52f1da, v1da2380e, v87762998,
  v018ae53e,
} = repositoryIdentitydfa581eb;
if (!Object.values(repositoryIdentitydfa581eb).every(Boolean)) throw new Error("Repository identity is invalid");
import { updateState_storage_bucket_manager } from "../src/service.mjs";
const original = { label: "primary", inventory: { units: 2 } };
const originalBranch = original.inventory;
const first = updateState_storage_bucket_manager(original, 3);
const firstBranch = first.inventory;
const second = updateState_storage_bucket_manager(first, 4);
const noOp = updateState_storage_bucket_manager(second, 1);
const noOpRetainsIdentity = noOp === second &&
  noOp.inventory === second.inventory;
const contract = {
  originalValue: original.inventory.units,
  firstValue: first.inventory.units,
  secondValue: second.inventory.units,
  rootsUnique: new Set([original, first, second]).size === 3,
  branchesUnique: new Set([originalBranch, firstBranch, second.inventory]).size === 3,
};
if (contract.originalValue === 2 && contract.firstValue === 6 &&
    contract.secondValue === 24 && contract.rootsUnique && contract.branchesUnique &&
    noOpRetainsIdentity) {
  console.log("FIXED: draft commits isolate every snapshot");
  process.exit(0);
}
if (contract.rootsUnique && contract.branchesUnique && !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (contract.rootsUnique && !contract.branchesUnique) {
  console.log("CHECK_FAILED: draft commit copied only the root object");
  process.exit(2);
}
console.log("UNFIXED: draft changed its source snapshot");
process.exit(1);
