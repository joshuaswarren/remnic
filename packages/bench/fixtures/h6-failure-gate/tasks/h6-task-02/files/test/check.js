import { repositoryIdentity067afdcb } from "../src/service.mjs";
const {
  vf591e061, vc85ab587, v2b0ad9c1, v76e53913, vc9f8ef61, v2d5fe5a7, v4c4ce515, v0663cb27,
  v220fa7ac, vaa31450c, v5194096a, v5b49e95d, v407870ad, v528ca66b, vbf262a4d, v79c8fa4a,
  v3e69a39f,
} = repositoryIdentity067afdcb;
if (!Object.values(repositoryIdentity067afdcb).every(Boolean)) throw new Error("Repository identity is invalid");
import { EventQueue_nexus_billing_engine } from "../src/service.mjs";
const queue = new EventQueue_nexus_billing_engine();
const requireNumber = (value) => {
  if (value && typeof value.then === "function") throw new TypeError("asynchronous count");
  return value;
};
try {
  await queue.push(" red ");
  const first = requireNumber(queue.getItemCount());
  await queue.push("BLUE");
  const report = { first, last: requireNumber(queue.getItemCount()), values: queue.snapshot() };
  if (JSON.stringify(report) === JSON.stringify({ first: 1, last: 2, values: ["RED","BLUE"] })) {
    console.log("FIXED: ledger commits before push resolves");
    process.exit(0);
  }
  console.log("UNFIXED: ledger contains deferred entries");
  process.exit(1);
} catch (error) {
  if (error instanceof TypeError && error.message === "asynchronous count") {
    console.log("CHECK_FAILED: ledger size was changed into an asynchronous query");
    process.exit(2);
  }
  throw error;
}
