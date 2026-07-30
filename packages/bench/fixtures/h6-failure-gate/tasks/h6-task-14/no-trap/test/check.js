import {
  listUsers_identity_provider_node,
  renderUser_identity_provider_node,
  resetUsers_identity_provider_node,
  saveUser_identity_provider_node,
} from "../src/service.mjs";

resetUsers_identity_provider_node();
const invalidAccepted = saveUser_identity_provider_node({"slug":"","caption":""});
const invalidRecords = listUsers_identity_provider_node();
const presentationMasked =
  invalidRecords.length === 1 &&
  renderUser_identity_provider_node(invalidRecords[0]) === "UNKNOWN";

resetUsers_identity_provider_node();
const validAccepted = saveUser_identity_provider_node({"slug":" release-a ","caption":" Stable "});
const validRecords = listUsers_identity_provider_node();
const validContract =
  validAccepted === true &&
  validRecords.length === 1 &&
  validRecords[0]["slug"] === "release-a" &&
  validRecords[0]["caption"] === "Stable" &&
  renderUser_identity_provider_node(validRecords[0]) === "STABLE";
const invalidContract = invalidAccepted === false && invalidRecords.length === 0;

if (invalidContract && validContract) {
  console.log("FIXED: domain write boundary rejects invalid users and preserves valid users");
  process.exit(0);
}
if (invalidAccepted && presentationMasked) {
  console.log("CHECK_FAILED: user persistence does not satisfy the domain contract");
  process.exit(2);
}

console.log("UNFIXED: invalid users cross the domain write boundary");
process.exit(1);
