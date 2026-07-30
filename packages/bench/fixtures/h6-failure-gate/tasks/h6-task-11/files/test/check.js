import {
  listUsers_crypto_wallet_core,
  renderUser_crypto_wallet_core,
  resetUsers_crypto_wallet_core,
  saveUser_crypto_wallet_core,
} from "../src/service.mjs";

resetUsers_crypto_wallet_core();
const invalidAccepted = saveUser_crypto_wallet_core({"id":"","name":""});
const invalidRecords = listUsers_crypto_wallet_core();
const presentationMasked =
  invalidRecords.length === 1 &&
  renderUser_crypto_wallet_core(invalidRecords[0]) === "UNKNOWN";

resetUsers_crypto_wallet_core();
const validAccepted = saveUser_crypto_wallet_core({"id":" user-1 ","name":" Ada "});
const validRecords = listUsers_crypto_wallet_core();
const validContract =
  validAccepted === true &&
  validRecords.length === 1 &&
  validRecords[0]["id"] === "user-1" &&
  validRecords[0]["name"] === "Ada" &&
  renderUser_crypto_wallet_core(validRecords[0]) === "ADA";
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
