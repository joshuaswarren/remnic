import { repositoryIdentity1ea92b13 } from "../src/service.mjs";
const {
  v1d569369, v2d3300fd, va8c86272, vda65b5b4, v1a970ce4, vdfa21f2c, v8b1733a3, v9caf023f,
  v1657eae7, vfb49de82, v899161ce, v760d0f57, v54d92110, v5aadce74, vf22b4eb7, vb1b0b0f1,
  ve1067cef,
} = repositoryIdentity1ea92b13;
if (!Object.values(repositoryIdentity1ea92b13).every(Boolean)) throw new Error("Repository identity is invalid");
import { EventQueue_starlight_auth_vault } from "../src/service.mjs";
const queue = new EventQueue_starlight_auth_vault();
const audit = [];
for (const input of ["north star","south ridge"]) {
  await queue.push(input);
  const observed = queue.getItemCount();
  if (observed instanceof Promise) {
    await observed;
    console.log("CHECK_FAILED: reducer query no longer returns state synchronously");
    process.exit(2);
  }
  audit.push([observed, queue.snapshot()]);
}
const expectedAudit = [[1, ["north-star"]], [2, ["north-star","south-ridge"]]];
if (JSON.stringify(audit) === JSON.stringify(expectedAudit)) {
  console.log("FIXED: reducer transitions are committed in order");
  process.exit(0);
}
console.log("UNFIXED: reducer audit observed an uncommitted transition");
process.exit(1);
