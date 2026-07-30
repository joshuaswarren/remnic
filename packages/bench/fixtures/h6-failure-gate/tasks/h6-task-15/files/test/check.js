import {
  listUsers_config_server_cluster,
  renderUser_config_server_cluster,
  resetUsers_config_server_cluster,
  saveUser_config_server_cluster,
} from "../src/service.mjs";

resetUsers_config_server_cluster();
const invalidAccepted = saveUser_config_server_cluster({"ref":"","alias":""});
const invalidRecords = listUsers_config_server_cluster();
const presentationMasked =
  invalidRecords.length === 1 &&
  renderUser_config_server_cluster(invalidRecords[0]) === "UNKNOWN";

resetUsers_config_server_cluster();
const validAccepted = saveUser_config_server_cluster({"ref":" asset-4 ","alias":" Header "});
const validRecords = listUsers_config_server_cluster();
const validContract =
  validAccepted === true &&
  validRecords.length === 1 &&
  validRecords[0]["ref"] === "asset-4" &&
  validRecords[0]["alias"] === "Header" &&
  renderUser_config_server_cluster(validRecords[0]) === "HEADER";
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
