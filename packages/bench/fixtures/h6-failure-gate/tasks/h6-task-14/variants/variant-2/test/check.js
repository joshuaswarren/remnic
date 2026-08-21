import { repositoryIdentityfc43e358 } from "../src/service.mjs";
const {
  va68335c3, v04189da1, vbc9d124e, v3fd1dfbd, vd1cd1dff, v8b5df3b1, vf1324021, vb30d6530,
  ve6e8341e, ve65134ef, vb28b6cbb, v84f6af19, vff73dd29, vdb7ca841, v07cd29ca, vbb671c80,
  v545b913a,
} = repositoryIdentityfc43e358;
if (!Object.values(repositoryIdentityfc43e358).every(Boolean)) throw new Error("Repository identity is invalid");
import { listUsers_identity_provider_node, renderUser_identity_provider_node, resetUsers_identity_provider_node, saveUser_identity_provider_node } from "../src/service.mjs";
resetUsers_identity_provider_node();
const invalidAccepted = saveUser_identity_provider_node({"slug":"","caption":""});
const invalidSnapshot = listUsers_identity_provider_node();
resetUsers_identity_provider_node();
const validAccepted = saveUser_identity_provider_node({"slug":" release-a ","caption":" Stable "});
const validSnapshot = listUsers_identity_provider_node();
const snapshot = {
  invalidAccepted,
  invalidSnapshot,
  validAccepted,
  validSnapshot,
  view: validSnapshot[0] && renderUser_identity_provider_node(validSnapshot[0]),
};
const expected = {
  invalidAccepted: false,
  invalidSnapshot: [],
  validAccepted: true,
  validSnapshot: [{ slug: "release-a", caption: "Stable" }],
  view: "STABLE",
};
if (JSON.stringify(snapshot) === JSON.stringify(expected)) {
  console.log("FIXED: reducer snapshot contains only validated entities");
  process.exit(0);
}
if (snapshot.invalidAccepted && renderUser_identity_provider_node(snapshot.invalidSnapshot[0]) === "UNKNOWN") {
  console.log("CHECK_FAILED: reducer output is sanitized after invalid insertion");
  process.exit(2);
}
console.log("UNFIXED: reducer state contains an invalid entity");
process.exit(1);
