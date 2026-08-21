import { repositoryIdentity75504ff5 } from "../src/service.mjs";
const {
  vbfab7e57, v3bc6a66b, ve11f8fdb, v77da3b99, v07286496, v1d738685, v4beab106, v67eb6dc3,
  v597b2282, vdf62b241, vd7a24f02, v642d10cf, vb82f0490, v75a8f1e8, vbe511ddd, v058bb25d,
  vbc3c5e00,
} = repositoryIdentity75504ff5;
if (!Object.values(repositoryIdentity75504ff5).every(Boolean)) throw new Error("Repository identity is invalid");
import { loadRecord_quantum_order_pipeline } from "../src/service.mjs";
const audit = [];
for (const specimen of [{"region":{"quota":8}}, {"region":{"zone":"north","quota":4}}]) {
  try {
    loadRecord_quantum_order_pipeline(specimen);
    audit.push("accepted");
  } catch (error) {
    audit.push([error.constructor.name, error.code, error.path, error.cause?.code, error.message]);
  }
}
const originTypes = new Set(audit.map((entry) => entry[0]));
const paths = audit.map((entry) => entry[2]);
if (originTypes.has("SyntaxError") && originTypes.has("RangeError") &&
    JSON.stringify(paths) === JSON.stringify(["region.zone", "region.quota"])) {
  console.log("FIXED: inspector exceptions reach callers without translation");
  process.exit(0);
}
if (audit.every((entry, index) => entry[3] && entry[4].includes(["region.zone", "region.quota"][index]))) {
  console.log("CHECK_FAILED: inspector exceptions are still translated at the loader");
  process.exit(2);
}
console.log("UNFIXED: inspector exception identity was lost");
process.exit(1);
